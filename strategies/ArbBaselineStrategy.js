const fs = require('fs');

class ArbBaselineStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        this.BASELINE_WINDOW = 180000;
        this.THRESHOLD = 0.0007;
        this.FEE = 0.0005;
        this.Z_THRESHOLD = 3.0;  // Z-score must exceed this (99.7% confidence)

        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');

        targets.forEach(symbol => {
            this.assets[symbol] = {
                binancePrice: null,
                deltaPrice: null,
                divergenceHistory: [],
                signalActive: false,
                lastSignalTime: 0,
                thresholdCrossedAt: null
            };
        });

        this.COOLDOWN_MS = 30000;
        this.stats = { signals: 0, binanceTrades: 0, deltaTrades: 0 };
        this.openOrders = {};
        this.pendingStopLoss = null;

        this.csvStream = fs.createWriteStream('/home/arshhtripathi/Bot/prices.csv', { flags: 'a' });
        this.csvStream.write('timestamp,binance,delta,divergence,baseline,above_baseline,z_score,signal\n');

        this.logger.info(`[ArbBaseline] Loaded | Threshold: ${this.THRESHOLD * 100}% | Z-Score: ${this.Z_THRESHOLD} | Baseline: ${this.BASELINE_WINDOW / 1000}s | Cooldown: ${this.COOLDOWN_MS / 1000}s`);
    }

    getName() { return "ArbBaselineStrategy"; }

    async start() {
        this.logger.info(`[ArbBaseline] 🟢 Ready`);
        this.startCsvLogging();
        this.startPositionCheck();
    }

    startPositionCheck() {
        this.logger.info(`[ArbBaseline] Starting position check (every 3s)`);
        setInterval(async () => {
            try {
                const positions = await this.bot.client.getPositions();
                const openPositions = positions.result?.filter(p => parseFloat(p.size) !== 0) || [];
                
                if (openPositions.length === 0 && Object.values(this.bot.activePositions).some(v => v)) {
                    this.logger.info(`[ArbBaseline] 🔄 POSITION CLOSED detected via API - resetting locks`);
                    Object.keys(this.bot.activePositions).forEach(symbol => {
                        if (this.bot.activePositions[symbol]) {
                            this.logger.info(`[ArbBaseline] Unlocking ${symbol}`);
                            this.bot.activePositions[symbol] = false;
                            this.assets[symbol].signalActive = false;
                        }
                    });
                }
            } catch (e) {
                this.logger.error(`[ArbBaseline] Position check error: ${e.message}`);
            }
        }, 3000);
    }

    startCsvLogging() {
        setInterval(() => {
            const symbol = Object.keys(this.assets)[0];
            const data = this.assets[symbol];
            if (!data.binancePrice || !data.deltaPrice) return;

            const divergence = Math.abs(data.binancePrice - data.deltaPrice) / data.binancePrice;
            const baseline = this.getBaseline(symbol);
            const mean = baseline ? baseline.mean : 0;
            const std = baseline ? baseline.std : 0;
            const aboveBaseline = baseline ? divergence - mean : 0;
            const zScore = std > 1e-10 ? (divergence - mean) / std : 0;
            const signal = data.signalActive ? 1 : 0;

            this.csvStream.write(`${Date.now()},${data.binancePrice},${data.deltaPrice},${divergence.toFixed(6)},${mean.toFixed(6)},${aboveBaseline.toFixed(6)},${zScore.toFixed(2)},${signal}\n`);
        }, 1000);
    }

    onBinanceTrade(update) {
        const symbol = update.s;
        const data = this.assets[symbol];
        if (!data) return;

        data.binancePrice = update.p;
        this.stats.binanceTrades++;
        if (this.stats.binanceTrades % 100 === 0) {
            this.logger.info(`[ArbBaseline] Binance trades: ${this.stats.binanceTrades} | Price: ${update.p}`);
        }
        this.checkSignal(symbol);
    }

    onLaggerTrade(trade) {
        if (!trade.symbol) return;

        const symbol = Object.keys(this.assets).find(k => trade.symbol.includes(k));
        if (!symbol) return;

        const data = this.assets[symbol];
        data.deltaPrice = parseFloat(trade.price);
        this.stats.deltaTrades++;
        this.checkSignal(symbol);
    }

    onOrderUpdate(order) {
        this.logger.info(`[ArbBaseline] ORDER: ${order.action} | state=${order.state} | reason=${order.reason} | side=${order.side} | filled=${order.average_fill_price}`);

        if (order.action === 'create' && order.state === 'open') {
            this.openOrders[order.order_id] = order;
        }

        if (order.state === 'closed' && order.reason === 'fill') {
            const symbol = Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (!symbol) return;

            if (order.side === 'sell' && this.bot.activePositions[symbol]) {
                this.logger.info(`[ArbBaseline] ✅ POSITION CLOSED: ${symbol} | exit_price=${order.average_fill_price}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;
                delete this.openOrders[order.order_id];
            }
        }

        if (order.reason === 'stop_trigger') {
            const symbol = Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (symbol) {
                this.logger.info(`[ArbBaseline] 🛑 STOP TRIGGERED: ${symbol}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;
            }
        }
    }

    onUserTrade(trade) {
        if (trade.reason !== 'normal') return;
        if (!trade.client_order_id || !trade.client_order_id.startsWith('arb_')) return;

        const symbol = Object.keys(this.assets).find(s => trade.symbol?.includes(s));
        if (!symbol) return;

        const spec = { 'BTC': { deltaId: 27, precision: 1 }, 'ETH': { deltaId: 299, precision: 2 }, 'XRP': { deltaId: 14969, precision: 4 }, 'SOL': { deltaId: 417, precision: 3 } }[symbol];
        if (!spec) return;

        if (this.pendingStopLoss && this.pendingStopLoss.symbol === symbol) {
            const fillPrice = parseFloat(trade.price);
            const entryPrice = this.pendingStopLoss.entryPrice;
            const trailPercent = 0.0003;
            const trailAbs = (fillPrice * trailPercent).toFixed(spec.precision);
            const trailAmount = this.pendingStopLoss.side === 'buy' ? `-${trailAbs}` : trailAbs;
            const stopSide = this.pendingStopLoss.side === 'buy' ? 'sell' : 'buy';

            this.logger.info(`[ArbBaseline] 🎯 FILL DETECTED: ${symbol} @ ${fillPrice}`);
            this.logger.info(`  [DEBUG] entrySide=${this.pendingStopLoss.side} | stopSide=${stopSide}`);
            this.logger.info(`  [DEBUG] entryPrice=${entryPrice} | fillPrice=${fillPrice} | diff=${(fillPrice - entryPrice).toFixed(4)}`);
            this.logger.info(`[ArbBaseline] Placing stop: side=${stopSide} trail=${trailAmount}`);

            this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                size: "1",
                side: stopSide,
                order_type: "market_order",
                stop_order_type: "stop_loss_order",
                trail_amount: trailAmount,
                stop_trigger_method: "last_traded_price",
                client_order_id: `arb_stop_${Date.now()}`
            }).then(result => {
                if (result && result.success) {
                    this.logger.info(`[ArbBaseline] ✅ STOP PLACED: ${symbol}`);
                } else {
                    this.logger.error(`[ArbBaseline] ❌ STOP FAILED: ${JSON.stringify(result)}`);
                }
            });

            this.pendingStopLoss = null;
        }
    }

    getBaseline(symbol) {
        const data = this.assets[symbol];
        const now = Date.now();
        const cutoff = now - this.BASELINE_WINDOW;

        data.divergenceHistory = data.divergenceHistory.filter(d => d.ts > cutoff);

        if (data.divergenceHistory.length < 10) return null;

        const n = data.divergenceHistory.length;
        const sum = data.divergenceHistory.reduce((acc, d) => acc + d.divergence, 0);
        const mean = sum / n;

        // Calculate standard deviation
        const sumSqDiff = data.divergenceHistory.reduce((acc, d) => acc + Math.pow(d.divergence - mean, 2), 0);
        const std = Math.sqrt(sumSqDiff / n);

        return { mean, std };
    }

    checkSignal(symbol) {
        const data = this.assets[symbol];

        if (!data.binancePrice || !data.deltaPrice || data.binancePrice === 0) return;

        const divergence = Math.abs(data.binancePrice - data.deltaPrice) / data.binancePrice;
        data.divergenceHistory.push({ ts: Date.now(), divergence });

        const baseline = this.getBaseline(symbol);
        if (baseline === null) return;

        const { mean, std } = baseline;
        const zScore = std > 1e-10 ? (divergence - mean) / std : 0;

        const aboveBaseline = divergence - mean;
        const aboveThreshold = aboveBaseline >= this.THRESHOLD;
        const zThresholdMet = Math.abs(zScore) >= this.Z_THRESHOLD;
        const cooldownActive = Date.now() - data.lastSignalTime < this.COOLDOWN_MS;
        const now = Date.now();

        if (aboveThreshold && zThresholdMet) {
            if (!data.thresholdCrossedAt) {
                data.thresholdCrossedAt = now;
            }
            const timeAboveThreshold = now - data.thresholdCrossedAt;
            const isUrgent = timeAboveThreshold <= 10;

            if (!isUrgent) {
                return;
            }

            if (!data.signalActive && !cooldownActive) {
                const deltaHigher = data.deltaPrice > data.binancePrice;
                const side = deltaHigher ? 'sell' : 'buy';
                const profit = (divergence - this.FEE) * 100;

                this.logger.info(`[ArbBaseline] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
                this.logger.info(`  Binance: ${data.binancePrice} | Delta: ${data.deltaPrice}`);
                this.logger.info(`  Divergence: ${(divergence * 100).toFixed(4)}% | Baseline: ${(mean * 100).toFixed(4)}%`);
                this.logger.info(`  Above baseline: ${(aboveBaseline * 100).toFixed(4)}% | Profit: ${profit.toFixed(4)}%`);
                this.logger.info(`  [Z-SCORE] z=${zScore.toFixed(2)} | std=${(std * 100).toFixed(4)}% | threshold=${this.Z_THRESHOLD}`);
                this.logger.info(`  [DEBUG] deltaHigher=${deltaHigher} | side=${side} | Delta-Binance=${(data.deltaPrice - data.binancePrice).toFixed(4)}`);
                this.logger.info(`  [URGENCY] timeAboveThreshold=${timeAboveThreshold}ms ✅ URGENT`);

                this.executeTrade(symbol, side);
                data.signalActive = true;
                data.lastSignalTime = now;
                this.stats.signals++;
            }
        } else {
            data.thresholdCrossedAt = null;
            if (data.signalActive) {
                data.signalActive = false;
            }
        }
    }

    async executeTrade(symbol, side) {
        const specs = {
            'BTC': { deltaId: 27, precision: 1 },
            'ETH': { deltaId: 299, precision: 2 },
            'XRP': { deltaId: 14969, precision: 4 },
            'SOL': { deltaId: 417, precision: 3 }
        };

        const spec = specs[symbol];
        if (!spec) return;

        if (this.bot.hasOpenPosition(symbol)) {
            this.logger.info(`[ArbBaseline] Skip ${symbol} - already in position`);
            return;
        }

        const data = this.assets[symbol];
        const entryPrice = data.deltaPrice;
        const OFFSET = 0.0003;

        this.logger.info(`[ArbBaseline] POSITION LOCK: ${symbol} = true`);
        this.bot.activePositions[symbol] = true;

        const payload = {
            product_id: spec.deltaId.toString(),
            size: "1",
            side: side,
            order_type: 'market_order',
            client_order_id: `arb_${Date.now()}`
        };

        try {
            this.logger.info(`[ArbBaseline] ENTRY: ${side} 1 ${symbol} MARKET`);
            this.logger.info(`  [DEBUG] Binance=${data.binancePrice} | Delta=${data.deltaPrice} | Delta-Binance=${(data.deltaPrice - data.binancePrice).toFixed(4)}`);
            
            const t0 = process.hrtime.bigint();
            const result = await this.bot.placeOrder(payload);
            const t1 = process.hrtime.bigint();
            const totalMs = Number(t1 - t0) / 1e6;
            this.logger.info(`[TIMING] placeOrder total: ${totalMs.toFixed(2)}ms`);

            if (result && result.success) {
                this.logger.info(`[ArbBaseline] ✅ ORDER PLACED: ${symbol} ${side}`);
                if (result.result?.id) {
                    this.openOrders[result.result.id] = { symbol, side, entryPrice };
                    this.pendingStopLoss = { symbol, side, entryPrice, orderId: result.result.id };
                }
            } else {
                this.logger.error(`[ArbBaseline] ❌ ORDER FAILED: ${JSON.stringify(result)}`);
                this.logger.info(`[ArbBaseline] POSITION LOCK: ${symbol} = false (order failed)`);
                this.bot.activePositions[symbol] = false;
            }
        } catch (error) {
            this.logger.error(`[ArbBaseline] ❌ ORDER ERROR: ${error.message}`);
            this.logger.info(`[ArbBaseline] POSITION LOCK: ${symbol} = false (order error)`);
            this.bot.activePositions[symbol] = false;
        }
    }

    onPositionClose(asset) {
        this.logger.info(`[ArbBaseline] POSITION CLOSED: ${asset} - resetting lock`);
        this.bot.activePositions[asset] = false;
        this.assets[asset].signalActive = false;
    }

    onExchange1Quote(msg) {}
    onDepthUpdate(update) {}
}

module.exports = ArbBaselineStrategy;
