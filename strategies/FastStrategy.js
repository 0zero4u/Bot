// FastStrategy.js
// v1.6.1 - [Microstructure] Fixed High-Frequency Log Spam

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- Model Configuration ---
        this.OBI_WINDOW = 100;
        this.Z_THRESHOLD = 1.1;
        this.SHIFT_THRESHOLD = 0.5;
        this.MIN_CONF_FIRE = 0.40;
        this.LOCK_DURATION_MS = 1500;
        
        // --- LOG FREQUENCY CONFIG ---
        this.LOG_HEARTBEAT_MS = 30000; // Strict 30-second interval
        
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    tickSize: 0.1 },
            'ETH': { deltaId: 299,   tickSize: 0.01 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(asset => {
            if (MASTER_CONFIG[asset]) {
                this.assets[asset] = {
                    config: MASTER_CONFIG[asset],
                    history: { obi: [], prevAskQty: 0, prevBidQty: 0, prevOBI: 0 },
                    lastTriggerTime: 0,
                    lastLogTime: 0 
                };
            }
        });

        this.isOrderInProgress = false;
        this.slPercent = 0.12;
    }

    getName() { return "FastStrategy (Optimized-Log v1.6.1)"; }

    async onDepthUpdate(symbol, depth) {
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;

        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // 1. DATA SUMMATION
            let bidQty = 0, askQty = 0, sumBidPQ = 0, sumAskPQ = 0;
            for (let i = 0; i < 5; i++) {
                const bP = parseFloat(depth.bids[i][0]);
                const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]);
                const aQ = parseFloat(depth.asks[i][1]);
                bidQty += bQ; askQty += aQ;
                sumBidPQ += (bP * bQ); sumAskPQ += (aP * aQ);
            }

            const bestBid = parseFloat(depth.bids[0][0]);
            const bestAsk = parseFloat(depth.asks[0][0]);
            const midPrice = (bestBid + bestAsk) / 2;

            // 2. MODEL MATH
            const obi = (bidQty - askQty) / (bidQty + askQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            const obiZ = this.calculateZScore(asset.history.obi);
            const dOBI = obi - asset.history.prevOBI;
            const microPrice = ((bidQty * bestAsk) + (askQty * bestBid)) / (bidQty + askQty);
            const wdShift = ((sumBidPQ + sumAskPQ) / (bidQty + askQty) - midPrice) / asset.config.tickSize;
            const tickDelta = wdShift * asset.config.tickSize;

            // 3. CONFIDENCE & VOLATILITY
            let rawConf = (Math.min(Math.abs(obiZ) / 2.2, 1.0) * 0.5) + (Math.min(Math.abs(dOBI) / 0.1, 1.0) * 0.25) + (Math.min(Math.abs(wdShift) / 2.0, 1.0) * 0.25);
            const vol = this.bot.volatility_estimate || 0.001;
            const finalConfidence = rawConf * Math.max(0.3, 1.0 - (vol * 150));

            // 4. LOGGING LOGIC (HEARTBEAT ONLY)
            // Separated from Trigger to stop high-frequency logging
            if (now - asset.lastLogTime > this.LOG_HEARTBEAT_MS) {
                this.logger.info(
                    `[Heartbeat] ${symbol} | Z:${obiZ.toFixed(2)} | dOBI:${dOBI.toFixed(3)} | ` +
                    `MicroP:${microPrice.toFixed(4)} | Conf:${(finalConfidence * 100).toFixed(1)}%`
                );
                asset.lastLogTime = now;
            }

            // 5. TRIGGER EVALUATION
            const shouldFire = (finalConfidence >= this.MIN_CONF_FIRE) && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS);

            if (shouldFire) {
                let side = null;
                if (obiZ > this.Z_THRESHOLD && dOBI > 0 && wdShift > this.SHIFT_THRESHOLD) side = 'buy';
                else if (obiZ < -this.Z_THRESHOLD && dOBI < 0 && wdShift < -this.SHIFT_THRESHOLD) side = 'sell';

                if (side) {
                    asset.lastTriggerTime = now;
                    // Firing log always appears immediately
                    this.logger.info(`[Micro-Alpha] 🔫 FIRE: ${side.toUpperCase()} ${symbol} | Conf: ${(finalConfidence * 100).toFixed(1)}% | Price: ${midPrice.toFixed(4)}`);
                    await this.executeMicroTrade(symbol, side, midPrice, asset.config.deltaId, finalConfidence);
                }
            }

            asset.history.prevOBI = obi; asset.history.prevAskQty = askQty; asset.history.prevBidQty = bidQty;

        } catch (e) {
            this.logger.error(`[FastStrategy] Error: ${e.message}`);
        }
    }

    calculateZScore(values) {
        if (values.length < 20) return 0;
        const mean = values.reduce((a, b) => a + b) / values.length;
        const std = Math.sqrt(values.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / values.length);
        return std === 0 ? 0 : (values[values.length - 1] - mean) / std;
    }

    async executeMicroTrade(asset, side, price, productId, confidence) {
        this.isOrderInProgress = true; this.bot.isOrderInProgress = true;
        try {
            const size = parseFloat(this.bot.config.orderSize).toFixed(2);
            const aggression = this.bot.config.priceAggressionOffset || 0.02;
            const limitPrice = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100)).toFixed(4);
            const orderData = {
                product_id: productId.toString(), size, side, order_type: 'limit_order', limit_price: limitPrice,
                time_in_force: 'ioc', bracket_stop_loss_price: (side === 'buy' ? limitPrice * (1 - this.slPercent/100) : limitPrice * (1 + this.slPercent/100)).toFixed(4),
                bracket_stop_trigger_method: 'mark_price'
            };
            await this.bot.placeOrder(orderData);
        } finally {
            this.isOrderInProgress = false; this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
