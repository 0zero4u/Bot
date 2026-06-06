const fs = require('fs');

class ArbBaselineStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        this.BASELINE_WINDOW = 180000;
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

        this.COOLDOWN_MS = 30000;
        this.stats = { signals: 0, binanceTrades: 0, deltaTrades: 0 };
        this.openOrders = {};

        this.symbolIndex = new Map();
        Object.keys(this.assets).forEach(k => {
            this.symbolIndex.set(k, k);
            this.symbolIndex.set(k + 'USD', k);
            this.symbolIndex.set(k + 'USDT', k);
            this.symbolIndex.set(k + '-USD', k);
            this.symbolIndex.set(k + '-PERP', k);
        });

        this.csvStream = fs.createWriteStream('/home/arshhtripathi/Bot/prices.csv', { flags: 'a' });
        this.csvStream.write('timestamp,binance,delta,divergence,baseline,above_baseline,signal\n');

        this.logger.info(`[ArbBaseline] Loaded | Threshold: ${this.THRESHOLD * 100}% | Baseline: ${this.BASELINE_WINDOW / 1000}s | Cooldown: ${this.COOLDOWN_MS / 1000}s`);
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
            const aboveBaseline = baseline ? divergence - baseline : 0;
            const signal = data.signalActive ? 1 : 0;

            this.csvStream.write(`${Date.now()},${data.binancePrice},${data.deltaPrice},${divergence.toFixed(6)},${baseline ? baseline.toFixed(6) : ''},${aboveBaseline.toFixed(6)},${signal}\n`);
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

        const symbol = this.symbolIndex.get(trade.symbol) ||
            Object.keys(this.assets).find(k => trade.symbol.includes(k));
        if (!symbol) return;

        const data = this.assets[symbol];
        data.deltaPrice = parseFloat(trade.price);
        this.stats.deltaTrades++;
        if (this.stats.deltaTrades % 10 === 0) {
            this.logger.info(`[ArbBaseline] Delta trades: ${this.stats.deltaTrades} | Price: ${data.deltaPrice}`);
        }
        this.checkSignal(symbol);
    }

    onOrderUpdate(order) {
        this.logger.info(`[ArbBaseline] ORDER: ${order.action} | state=${order.state} | reason=${order.reason} | side=${order.side} | filled=${order.average_fill_price}`);

        if (order.action === 'create' && order.state === 'open') {
            this.openOrders[order.order_id] = order;
        }

        if (order.state === 'closed' && order.reason === 'fill') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (!symbol) return;

            if (order.side === 'sell' && this.bot.activePositions[symbol]) {
                this.logger.info(`[ArbBaseline] ✅ POSITION CLOSED: ${symbol} | exit_price=${order.average_fill_price}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;
                delete this.openOrders[order.order_id];
            }
        }

        if (order.reason === 'stop_trigger') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (symbol) {
                this.logger.info(`[ArbBaseline] 🛑 STOP TRIGGERED: ${symbol}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;
            }
        }
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

        if (!data.binancePrice || !data.deltaPrice || data.binancePrice === 0) {
            this.logger.info(`[DEBUG] Missing prices: binance=${data.binancePrice} delta=${data.deltaPrice}`);
            return;
        }

        const divergence = Math.abs(data.binancePrice - data.deltaPrice) / data.binancePrice;
        data.divergenceHistory.push({ ts: Date.now(), divergence });

        const baseline = this.getBaseline(symbol);
        const historyLen = data.divergenceHistory.length;

        if (baseline === null) {
            this.logger.info(`[DEBUG] No baseline yet: history=${historyLen}/10`);
            return;
        }

        const aboveBaseline = divergence - baseline;
        const aboveThreshold = aboveBaseline >= this.THRESHOLD;
        const cooldownActive = Date.now() - data.lastSignalTime < this.COOLDOWN_MS;

        this.logger.info(`[DEBUG] ${symbol}: div=${(divergence*100).toFixed(4)}% base=${(baseline*100).toFixed(4)}% above=${(aboveBaseline*100).toFixed(4)}% thresh=${this.THRESHOLD*100}% | signal=${data.signalActive} cooldown=${cooldownActive} hist=${historyLen}`);

        if (aboveThreshold && !data.signalActive && !cooldownActive) {
            const side = data.deltaPrice > data.binancePrice ? 'buy' : 'sell';
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
            this.logger.info(`[ArbBaseline] Signal deactivated: divergence dropped below threshold`);
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
        const trailPercent = 0.0003;
        const trailAbs = (entryPrice * trailPercent).toFixed(spec.precision);
        const trailAmount = side === 'buy' ? trailAbs : `-${trailAbs}`;

        const limitPrice = side === 'buy'
            ? (entryPrice * (1 + OFFSET)).toFixed(spec.precision)
            : (entryPrice * (1 - OFFSET)).toFixed(spec.precision);

        this.logger.info(`[ArbBaseline] POSITION LOCK: ${symbol} = true`);
        this.bot.activePositions[symbol] = true;

        const payload = {
            product_id: spec.deltaId.toString(),
            size: "1",
            side: side,
            order_type: 'limit_order',
            limit_price: limitPrice,
            time_in_force: 'ioc',
            bracket_trail_amount: trailAmount,
            bracket_stop_trigger_method: "last_traded_price",
            client_order_id: `arb_${Date.now()}`
        };

        try {
            const stopPrice = side === 'sell' ? entryPrice + parseFloat(trailAbs) : entryPrice - parseFloat(trailAbs);
            this.logger.info(`[ArbBaseline] ENTRY: ${side} 1 ${symbol} @ ${entryPrice}`);
            this.logger.info(`[ArbBaseline] LIMIT: ${limitPrice} (offset: ${(OFFSET * 100).toFixed(2)}%)`);
            this.logger.info(`[ArbBaseline] TRAIL: ${trailAmount} (${(trailPercent * 100).toFixed(1)}%)`);
            this.logger.info(`[ArbBaseline] STOP: ${stopPrice.toFixed(spec.precision)}`);
            const result = await this.bot.placeOrder(payload);

            if (result && result.success) {
                this.logger.info(`[ArbBaseline] ✅ ORDER PLACED: ${symbol} ${side} | Trail: ${trailAmount}`);
                if (result.result?.id) {
                    this.openOrders[result.result.id] = { symbol, side, entryPrice };
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
