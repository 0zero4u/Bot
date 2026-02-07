// FastStrategy.js
// v1.5 - [Microstructure] Gravity-Alpha with 30s Heartbeat Logging

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- Model Configuration ---
        this.OBI_WINDOW = 100;           // Rolling window for Z-Score
        this.Z_THRESHOLD = 1.1;          // Min Z-Score required to trigger
        this.SHIFT_THRESHOLD = 0.5;      // Min Tick Shift required
        this.MIN_CONF_FIRE = 0.40;       // Minimum 40% confidence to execute
        this.LOCK_DURATION_MS = 1500;    // Execution cooldown
        
        // --- Log Frequency Config ---
        this.LOG_HEARTBEAT_MS = 30000;   // 30s status update if no order fires

        // Asset Master Config
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

    getName() { return "FastStrategy (Gravity-Alpha v1.5)"; }

    /**
     * @param {string} symbol 
     * @param {object} depth - { bids: [["p","q"],...], asks: [["p","q"],...] }
     */
    async onDepthUpdate(symbol, depth) {
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;

        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // 1. DATA SUMMATION (Top 5 Levels)
            let bidQty = 0, askQty = 0, sumBidPQ = 0, sumAskPQ = 0;

            for (let i = 0; i < 5; i++) {
                const bP = parseFloat(depth.bids[i][0]);
                const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]);
                const aQ = parseFloat(depth.asks[i][1]);

                bidQty += bQ;
                askQty += aQ;
                sumBidPQ += (bP * bQ);
                sumAskPQ += (aP * aQ);
            }

            const bestBid = parseFloat(depth.bids[0][0]);
            const bestAsk = parseFloat(depth.asks[0][0]);
            const midPrice = (bestBid + bestAsk) / 2;

            // 2. MATHEMATICAL FEATURES
            const obi = (bidQty - askQty) / (bidQty + askQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            const obiZ = this.calculateZScore(asset.history.obi);
            const dOBI = obi - asset.history.prevOBI;
            
            // Micro-Price & Gravity (Tick Delta)
            const microPrice = ((bidQty * bestAsk) + (askQty * bestBid)) / (bidQty + askQty);
            const pWD = (sumBidPQ + sumAskPQ) / (bidQty + askQty);
            const wdShift = (pWD - midPrice) / asset.config.tickSize;
            const tickDelta = wdShift * asset.config.tickSize;

            // 3. CONFIDENCE & VOLATILITY PENALTY
            const c_obiZ = Math.min(Math.abs(obiZ) / 2.2, 1.0);
            const c_mom = Math.min(Math.abs(dOBI) / 0.1, 1.0);
            const c_shift = Math.min(Math.abs(wdShift) / 2.0, 1.0);
            
            let rawConf = (c_obiZ * 0.5) + (c_mom * 0.25) + (c_shift * 0.25);
            
            // Adjust confidence based on real-time volatility
            const vol = this.bot.volatility_estimate || 0.001;
            const volPenalty = Math.max(0.3, 1.0 - (vol * 150));
            const finalConfidence = rawConf * volPenalty;

            // 4. THROTTLED LOGGING (30s Heartbeat)
            const shouldFire = (finalConfidence >= this.MIN_CONF_FIRE) && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS);
            const isHeartbeat = (now - asset.lastLogTime > this.LOG_HEARTBEAT_MS);

            if (shouldFire || isHeartbeat) {
                this.logger.info(
                    `[Model] ${symbol} | Z:${obiZ.toFixed(2)} | dOBI:${dOBI.toFixed(3)} | ` +
                    `WDS:${wdShift.toFixed(2)} | TickDelta:${tickDelta.toFixed(6)} | ` +
                    `MicroP:${microPrice.toFixed(4)} | Conf:${(finalConfidence * 100).toFixed(1)}%`
                );
                asset.lastLogTime = now;
            }

            // 5. TRIGGER & EXECUTION
            let side = null;
            if (shouldFire) {
                if (obiZ > this.Z_THRESHOLD && dOBI > 0 && wdShift > this.SHIFT_THRESHOLD) side = 'buy';
                else if (obiZ < -this.Z_THRESHOLD && dOBI < 0 && wdShift < -this.SHIFT_THRESHOLD) side = 'sell';
            }

            if (side) {
                asset.lastTriggerTime = now;
                
                this.logger.info(
                    `[Micro-Alpha] 🔫 FIRE: ${side.toUpperCase()} ${symbol} | ` +
                    `Conf: ${(finalConfidence * 100).toFixed(1)}% | ` +
                    `Size: ${parseFloat(this.bot.config.orderSize).toFixed(2)} | ` +
                    `Price: ${midPrice.toFixed(4)}`
                );
                
                await this.executeMicroTrade(symbol, side, midPrice, asset.config.deltaId, finalConfidence);
            }

            // History Update
            asset.history.prevOBI = obi;
            asset.history.prevAskQty = askQty;
            asset.history.prevBidQty = bidQty;

        } catch (e) {
            this.logger.error(`[FastStrategy] Model Error: ${e.message}`);
        }
    }

    calculateZScore(values) {
        if (values.length < 20) return 0;
        const n = values.length;
        const mean = values.reduce((a, b) => a + b) / n;
        const std = Math.sqrt(values.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n);
        return std === 0 ? 0 : (values[n - 1] - mean) / std;
    }

    async executeMicroTrade(asset, side, price, productId, confidence) {
        this.isOrderInProgress = true;
        this.bot.isOrderInProgress = true;
        try {
            // size is fixed to configured ORDER_SIZE to ensure API compatibility
            const size = parseFloat(this.bot.config.orderSize).toFixed(2);
            const aggression = this.bot.config.priceAggressionOffset || 0.02;
            const limitPrice = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100)).toFixed(4);
            
            const orderData = {
                product_id: productId.toString(),
                size: size,
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice,
                time_in_force: 'ioc',
                bracket_stop_loss_price: (side === 'buy' ? limitPrice * (1 - this.slPercent/100) : limitPrice * (1 + this.slPercent/100)).toFixed(4),
                bracket_stop_trigger_method: 'mark_price'
            };

            await this.bot.placeOrder(orderData);
        } finally {
            this.isOrderInProgress = false;
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
                           
