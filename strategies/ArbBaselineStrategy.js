/**
 * ArbBaselineStrategy.js
 * Latency Arbitrage with Rolling Baseline
 * - Binance trades via Rust BinanceTradeListener
 * - Delta trades via onLaggerTrade
 * - Signal when divergence > baseline + threshold
 */

class ArbBaselineStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        this.BASELINE_WINDOW = 120000;
        this.THRESHOLD = 0.0007;
        this.FEE = 0.0005;

        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');

        targets.forEach(symbol => {
            this.assets[symbol] = {
                binancePrice: null,
                deltaPrice: null,
                divergenceHistory: [],
                signalActive: false,
                lastSignalTime: 0
            };
        });

        this.stats = { signals: 0 };
        this.logger.info(`[ArbBaseline] Loaded | Threshold: ${this.THRESHOLD * 100}% | Baseline: ${this.BASELINE_WINDOW / 1000}s`);
    }

    getName() { return "ArbBaselineStrategy"; }

    async start() {
        this.logger.info(`[ArbBaseline] 🟢 Ready. Waiting for Binance trades from Rust listener...`);
    }

    onBinanceTrade(update) {
        const symbol = update.s;
        const data = this.assets[symbol];
        if (!data) return;

        data.binancePrice = update.p;
        this.checkSignal(symbol);
    }

    onLaggerTrade(trade) {
        if (!trade.symbol) return;

        const symbol = Object.keys(this.assets).find(k => trade.symbol.includes(k));
        if (!symbol) return;

        const data = this.assets[symbol];
        data.deltaPrice = parseFloat(trade.price);
        this.checkSignal(symbol);
    }

    getBaseline(symbol) {
        const data = this.assets[symbol];
        const now = Date.now();
        const cutoff = now - this.BASELINE_WINDOW;

        data.divergenceHistory = data.divergenceHistory.filter(d => d.ts > cutoff);

        if (data.divergenceHistory.length < 10) return null;

        const sum = data.divergenceHistory.reduce((acc, d) => acc + d.divergence, 0);
        return sum / data.divergenceHistory.length;
    }

    checkSignal(symbol) {
        const data = this.assets[symbol];

        if (!data.binancePrice || !data.deltaPrice || data.binancePrice === 0) return;

        const divergence = Math.abs(data.binancePrice - data.deltaPrice) / data.binancePrice;
        data.divergenceHistory.push({ ts: Date.now(), divergence });

        const baseline = this.getBaseline(symbol);
        if (baseline === null) return;

        const aboveBaseline = divergence - baseline;
        const aboveThreshold = aboveBaseline >= this.THRESHOLD;

        if (aboveThreshold && !data.signalActive) {
            const side = data.binancePrice > data.deltaPrice ? 'buy' : 'sell';
            const profit = (divergence - this.FEE) * 100;

            this.logger.info(`[ArbBaseline] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
            this.logger.info(`  Binance: ${data.binancePrice} | Delta: ${data.deltaPrice}`);
            this.logger.info(`  Divergence: ${(divergence * 100).toFixed(4)}% | Baseline: ${(baseline * 100).toFixed(4)}%`);
            this.logger.info(`  Above baseline: ${(aboveBaseline * 100).toFixed(4)}% | Profit: ${profit.toFixed(4)}%`);

            this.executeTrade(symbol, side);
            data.signalActive = true;
            data.lastSignalTime = Date.now();
            this.stats.signals++;

        } else if (!aboveThreshold && data.signalActive) {
            data.signalActive = false;
        }
    }

    async executeTrade(symbol, side) {
        const specs = {
            'BTC': { deltaId: 27, lot: 0.002 },
            'ETH': { deltaId: 299, lot: 0.02 },
            'XRP': { deltaId: 14969, lot: 20 },
            'SOL': { deltaId: 417, lot: 0.2 }
        };

        const spec = specs[symbol];
        if (!spec) return;

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

    onExchange1Quote(msg) {}
    onDepthUpdate(update) {}
}

module.exports = ArbBaselineStrategy;
