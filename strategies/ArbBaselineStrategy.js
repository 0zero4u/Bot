/**
 * ArbBaselineStrategy.js
 * 
 * Latency Arbitrage with Rolling Baseline
 * - Binance trades (fast) via own WebSocket
 * - Delta trades (slow) via onLaggerTrade
 * - Signal when divergence > baseline + threshold
 */

const WebSocket = require('ws');

class ArbBaselineStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // Config
        this.BASELINE_WINDOW = 120000; // 2 minutes in ms
        this.THRESHOLD = 0.0007;       // 0.07% above baseline
        this.FEE = 0.0005;             // 0.05% round trip

        // State per asset
        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');

        targets.forEach(symbol => {
            this.assets[symbol] = {
                binancePrice: null,
                deltaPrice: null,
                divergenceHistory: [], // {ts, divergence}
                signalActive: false,
                lastSignalTime: 0
            };
        });

        this.stats = { signals: 0, divergenceAvg: 0 };
        this.logger.info(`[ArbBaseline] Loaded | Threshold: ${this.THRESHOLD * 100}% | Baseline: ${this.BASELINE_WINDOW / 1000}s`);
    }

    getName() { return "ArbBaselineStrategy"; }

    async start() {
        this.logger.info(`[ArbBaseline] Starting Binance trade feed...`);
        this.connectBinance();
    }

    connectBinance() {
        // Connect to Binance trades for each asset
        Object.keys(this.assets).forEach(symbol => {
            const wsUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}usdt@trade`;
            this.logger.info(`[ArbBaseline] Connecting Binance: ${wsUrl}`);

            const ws = new WebSocket(wsUrl);

            ws.on('open', () => {
                this.logger.info(`[ArbBaseline] ✅ Binance ${symbol} connected`);
            });

            ws.on('message', (data) => {
                try {
                    const trade = JSON.parse(data);
                    const price = parseFloat(trade.p);
                    this.onBinanceTrade(symbol, price);
                } catch (e) {
                    // Ignore parse errors
                }
            });

            ws.on('error', (err) => {
                this.logger.error(`[ArbBaseline] Binance ${symbol} error: ${err.message}`);
            });

            ws.on('close', () => {
                this.logger.warn(`[ArbBaseline] Binance ${symbol} disconnected. Reconnecting...`);
                setTimeout(() => this.connectBinance(), 5000);
            });
        });
    }

    onBinanceTrade(symbol, price) {
        const data = this.assets[symbol];
        if (!data) return;

        data.binancePrice = price;
        this.checkSignal(symbol);
    }

    // Called by trader.js when Delta trade arrives
    onLaggerTrade(trade) {
        if (!trade.symbol) return;

        const symbol = Object.keys(this.assets).find(k => trade.symbol.includes(k));
        if (!symbol) return;

        const price = parseFloat(trade.price);
        const data = this.assets[symbol];
        data.deltaPrice = price;
        this.checkSignal(symbol);
    }

    getBaseline(symbol) {
        const data = this.assets[symbol];
        const now = Date.now();
        const cutoff = now - this.BASELINE_WINDOW;

        // Remove old entries
        data.divergenceHistory = data.divergenceHistory.filter(d => d.ts > cutoff);

        // Need minimum data points
        if (data.divergenceHistory.length < 10) return null;

        // Calculate average
        const sum = data.divergenceHistory.reduce((acc, d) => acc + d.divergence, 0);
        return sum / data.divergenceHistory.length;
    }

    checkSignal(symbol) {
        const data = this.assets[symbol];
        const spec = this.bot.strategy?.specs?.[symbol] || { deltaId: 14969, precision: 4, lot: 20 };

        if (!data.binancePrice || !data.deltaPrice || data.binancePrice === 0) return;

        // Calculate divergence
        const divergence = Math.abs(data.binancePrice - data.deltaPrice) / data.binancePrice;

        // Add to history
        data.divergenceHistory.push({ ts: Date.now(), divergence });

        // Get baseline
        const baseline = this.getBaseline(symbol);
        if (baseline === null) return; // Still warming up

        // Check threshold
        const aboveBaseline = divergence - baseline;
        const aboveThreshold = aboveBaseline >= this.THRESHOLD;

        // Edge-triggered signal
        if (aboveThreshold && !data.signalActive) {
            const side = data.binancePrice > data.deltaPrice ? 'buy' : 'sell';
            const profit = (divergence - this.FEE) * 100;

            this.logger.info(`[ArbBaseline] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
            this.logger.info(`  Binance: ${data.binancePrice} | Delta: ${data.deltaPrice}`);
            this.logger.info(`  Divergence: ${(divergence * 100).toFixed(4)}% | Baseline: ${(baseline * 100).toFixed(4)}%`);
            this.logger.info(`  Above baseline: ${(aboveBaseline * 100).toFixed(4)}% | Profit: ${profit.toFixed(4)}%`);

            this.executeTrade(symbol, side, data.deltaPrice);
            data.signalActive = true;
            data.lastSignalTime = Date.now();
            this.stats.signals++;

        } else if (!aboveThreshold && data.signalActive) {
            data.signalActive = false;
        }
    }

    async executeTrade(symbol, side, price) {
        const specs = {
            'BTC': { deltaId: 27, precision: 1, lot: 0.002 },
            'ETH': { deltaId: 299, precision: 2, lot: 0.02 },
            'XRP': { deltaId: 14969, precision: 4, lot: 20 },
            'SOL': { deltaId: 417, precision: 3, lot: 0.2 }
        };

        const spec = specs[symbol];
        if (!spec) {
            this.logger.error(`[ArbBaseline] No spec for ${symbol}`);
            return;
        }

        // Check if already in position
        if (this.bot.hasOpenPosition(symbol)) {
            this.logger.info(`[ArbBaseline] Skip ${symbol} - already in position`);
            return;
        }

        const payload = {
            product_id: spec.deltaId.toString(),
            size: spec.lot.toString(),
            side: side,
            order_type: 'market_order',
            client_order_id: `arb_${Date.now()}`
        };

        try {
            this.logger.info(`[ArbBaseline] Placing order: ${side} ${spec.lot} ${symbol} @ market`);
            const result = await this.bot.placeOrder(payload);

            if (result && result.success) {
                this.logger.info(`[ArbBaseline] ✅ ORDER FILLED: ${symbol} ${side}`);
            } else {
                this.logger.error(`[ArbBaseline] ❌ ORDER FAILED: ${JSON.stringify(result)}`);
            }
        } catch (error) {
            this.logger.error(`[ArbBaseline] ❌ ORDER ERROR: ${error.message}`);
        }
    }

    // Not used but required by interface
    onExchange1Quote(msg) {}
    onDepthUpdate(update) {}
}

module.exports = ArbBaselineStrategy;
