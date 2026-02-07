// FastStrategy.js
// v1.9.0 - [FIX] Bracket Position Conflict & Anti-Spam

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // Configuration
        this.OBI_WINDOW = 100;
        this.Z_THRESHOLD = 1.1;
        this.SHIFT_THRESHOLD = 0.5;
        this.MIN_CONF_FIRE = 0.40;
        this.LOCK_DURATION_MS = 1500;
        this.LOG_HEARTBEAT_MS = 30000; 
        
        // Anti-Spam: cooldown if we get an error
        this.lastErrorTime = 0;
        this.ERROR_COOLDOWN_MS = 5000; 

        // MASTER CONFIG
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, tickSize: 0.0001, lotSize: 1,     precision: 4, sizeDecimals: 0 },
            'BTC': { deltaId: 27,    tickSize: 0.1,    lotSize: 0.001, precision: 1, sizeDecimals: 3 },
            'ETH': { deltaId: 299,   tickSize: 0.01,   lotSize: 0.01,  precision: 2, sizeDecimals: 2 }
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

    getName() { return "FastStrategy (Bracket-Fix v1.9)"; }

    async onDepthUpdate(symbol, depth) {
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;
        if (Date.now() - this.lastErrorTime < this.ERROR_COOLDOWN_MS) return;

        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // --- DATA PROCESSING ---
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

            // --- SIGNAL MATH ---
            const obi = (bidQty - askQty) / (bidQty + askQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            const obiZ = this.calculateZScore(asset.history.obi);
            const dOBI = obi - asset.history.prevOBI;
            const wdShift = ((sumBidPQ + sumAskPQ) / (bidQty + askQty) - midPrice) / asset.config.tickSize;

            // --- CONFIDENCE ---
            let rawConf = (Math.min(Math.abs(obiZ) / 2.2, 1.0) * 0.5) + (Math.min(Math.abs(dOBI) / 0.1, 1.0) * 0.25) + (Math.min(Math.abs(wdShift) / 2.0, 1.0) * 0.25);
            const finalConfidence = rawConf * 0.8; 

            if (now - asset.lastLogTime > this.LOG_HEARTBEAT_MS) {
                this.logger.info(`[Heartbeat] ${symbol} | Z:${obiZ.toFixed(2)} | Conf:${(finalConfidence * 100).toFixed(1)}%`);
                asset.lastLogTime = now;
            }

            const shouldFire = (finalConfidence >= this.MIN_CONF_FIRE) && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS);

            if (shouldFire) {
                let side = null;
                if (obiZ > this.Z_THRESHOLD && dOBI > 0 && wdShift > this.SHIFT_THRESHOLD) side = 'buy';
                else if (obiZ < -this.Z_THRESHOLD && dOBI < 0 && wdShift < -this.SHIFT_THRESHOLD) side = 'sell';

                if (side) {
                    asset.lastTriggerTime = now;
                    this.logger.info(`[Micro-Alpha] 🔫 FIRE: ${side.toUpperCase()} ${symbol} | Conf: ${(finalConfidence * 100).toFixed(1)}%`);
                    await this.executeMicroTrade(symbol, side, midPrice, asset.config);
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

    async executeMicroTrade(symbol, side, price, assetConfig) {
        this.isOrderInProgress = true; 
        this.bot.isOrderInProgress = true;
        
        try {
            // 1. Calculate Size
            const rawSize = parseFloat(this.bot.config.orderSize);
            let calculatedSize = Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize;
            
            const sizeStr = calculatedSize.toFixed(assetConfig.sizeDecimals);

            // 2. Calculate Prices
            const aggression = this.bot.config.priceAggressionOffset || 0.02;
            const limitPriceNum = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100));
            const limitPriceStr = limitPriceNum.toFixed(assetConfig.precision);

            const slPriceNum = (side === 'buy' ? limitPriceNum * (1 - this.slPercent/100) : limitPriceNum * (1 + this.slPercent/100));
            const slPriceStr = slPriceNum.toFixed(assetConfig.precision);

            // 3. Construct Payload
            const orderData = {
                product_id: assetConfig.deltaId.toString(),
                size: sizeStr,
                side: side,
                order_type: 'limit_order',
                limit_price: limitPriceStr,
                time_in_force: 'ioc',
                bracket_stop_loss_price: slPriceStr,
                bracket_stop_trigger_method: 'mark_price'
            };

            // --- CRITICAL FIX: REMOVE BRACKET IF POSITION EXISTS ---
            // If we already have a position, the API rejects new brackets with code "bracket_order_position_exists"
            if (this.bot.hasOpenPosition) {
                this.logger.info(`[Strategy] Open Position detected! Removing Bracket Params to prevent 400 Error.`);
                delete orderData.bracket_stop_loss_price;
                delete orderData.bracket_stop_trigger_method;
            }

            this.logger.info(`[Order Payload] ${symbol} -> ${JSON.stringify(orderData)}`);
            await this.bot.placeOrder(orderData);
            
        } catch (err) {
            // 4. Handle Error & TRIGGER COOLDOWN
            this.lastErrorTime = Date.now();
            this.logger.warn(`[Strategy Error] ${symbol}: ${err.message}. Pausing for 5s.`);
        } finally {
            this.isOrderInProgress = false; 
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
            
