// FastStrategy.js
// v1.6.2 - [FIX] Precision & Data Typing to resolve 400 Bad Request
// - Added: Rounding logic for specific asset lot sizes
// - Added: String casting for all API-bound numeric fields
// - Fixed: High-frequency log spam

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
        
        this.LOG_HEARTBEAT_MS = 30000; 
        
        /**
         * MASTER_CONFIG Documentation:
         * tickSize: Minimum price increment.
         * lotSize: Minimum quantity increment. (XRP = 1, BTC = 0.001, etc.)
         * precision: Number of decimals for the limit price.
         */
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, tickSize: 0.0001, lotSize: 1, precision: 4 },
            'BTC': { deltaId: 27,    tickSize: 0.1,    lotSize: 0.001, precision: 1 },
            'ETH': { deltaId: 299,   tickSize: 0.01,   lotSize: 0.01, precision: 2 }
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

    getName() { return "FastStrategy (Precision-Fixed v1.6.2)"; }

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
            const wdShift = ((sumBidPQ + sumAskPQ) / (bidQty + askQty) - midPrice) / asset.config.tickSize;

            // 3. CONFIDENCE
            let rawConf = (Math.min(Math.abs(obiZ) / 2.2, 1.0) * 0.5) + (Math.min(Math.abs(dOBI) / 0.1, 1.0) * 0.25) + (Math.min(Math.abs(wdShift) / 2.0, 1.0) * 0.25);
            const finalConfidence = rawConf * 0.8; // Normalized

            // 4. LOGGING (Heartbeat)
            if (now - asset.lastLogTime > this.LOG_HEARTBEAT_MS) {
                this.logger.info(`[Heartbeat] ${symbol} | Z:${obiZ.toFixed(2)} | Conf:${(finalConfidence * 100).toFixed(1)}%`);
                asset.lastLogTime = now;
            }

            // 5. TRIGGER
            const shouldFire = (finalConfidence >= this.MIN_CONF_FIRE) && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS);

            if (shouldFire) {
                let side = null;
                if (obiZ > this.Z_THRESHOLD && dOBI > 0 && wdShift > this.SHIFT_THRESHOLD) side = 'buy';
                else if (obiZ < -this.Z_THRESHOLD && dOBI < 0 && wdShift < -this.SHIFT_THRESHOLD) side = 'sell';

                if (side) {
                    asset.lastTriggerTime = now;
                    this.logger.info(`[Micro-Alpha] 🔫 FIRE: ${side.toUpperCase()} ${symbol} | Conf: ${(finalConfidence * 100).toFixed(1)}%`);
                    await this.executeMicroTrade(symbol, side, midPrice, asset.config, finalConfidence);
                }
            }

            asset.history.prevOBI = obi;

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

    /**
     * Documentation for executeMicroTrade:
     * - size: Rounded down to the nearest multiple of asset.lotSize to avoid 400 errors.
     * - price: Formatted to asset.precision decimals.
     * - strings: All numeric values sent as strings to comply with Delta API v2.
     */
    async executeMicroTrade(symbol, side, price, assetConfig, confidence) {
        this.isOrderInProgress = true; 
        this.bot.isOrderInProgress = true;
        
        try {
            // A. Calculate Size based on Lot Size (Avoids "0.42 XRP" error)
            const rawSize = parseFloat(this.bot.config.orderSize);
            const size = (Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize).toString();

            // B. Apply Aggression and Format Price Precision
            const aggression = this.bot.config.priceAggressionOffset || 0.02;
            const limitPriceNum = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100));
            const limitPrice = limitPriceNum.toFixed(assetConfig.precision);

            // C. Stop Loss Calculation and Formatting
            const slPriceNum = (side === 'buy' ? limitPriceNum * (1 - this.slPercent/100) : limitPriceNum * (1 + this.slPercent/100));
            const slPrice = slPriceNum.toFixed(assetConfig.precision);

            const orderData = {
                product_id: assetConfig.deltaId.toString(), // Must be String
                size: size,                                 // Must be String & Whole Number for XRP
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice,                    // Must be String
                time_in_force: 'ioc',
                bracket_stop_loss_price: slPrice,           // Must be String
                bracket_stop_trigger_method: 'mark_price'
            };

            this.logger.debug(`[Order Debug] ${symbol} payload: ${JSON.stringify(orderData)}`);
            await this.bot.placeOrder(orderData);
            
        } catch (err) {
            this.logger.error(`[Execution Error] ${symbol}: ${err.message}`);
        } finally {
            this.isOrderInProgress = false; 
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
