// strategies/AdvanceStrategy.js
// Version 13.0.0 - Hard SL Integration using Average Fill Price

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969 },
            'BTC': { deltaId: 27 },
            'ETH': { deltaId: 299 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(asset => {
            if (MASTER_CONFIG[asset]) {
                this.assets[asset] = {
                    deltaId: MASTER_CONFIG[asset].deltaId,
                    deltaHistory: [],
                    gapHistory: [],
                    sources: {} 
                };
            }
        });

        this.windowSizeMs = 2 * 60 * 1000;
        this.lockDurationMs = 10000;
        this.isWarmup = true;
        this.startTime = Date.now();

        // --- TRADING STATE ---
        this.lastOrderTime = 0;
        this.position = null; 
        this.entryPrice = 0; 
        this.slPercent = 0.1; // Increased to 0.6% as discussed for better "breathing room"
    }

    getName() { return "AdvanceStrategy (Hard SL + Avg Fill)"; }

    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        const now = Date.now();
        const assetData = this.assets[asset];
        if (!assetData || this.isLockedOut()) return;

        // Populate History
        if (!assetData.sources[source]) assetData.sources[source] = [];
        this.updateHistory(assetData.sources[source], price, now);

        if (this.isWarmup && (now - this.startTime > this.windowSizeMs)) {
            this.isWarmup = false;
            this.logger.info(`[AdvanceStrategy] *** ACTIVE ***`);
        }

        if (this.isWarmup || assetData.sources[source].length < 2 || assetData.deltaHistory.length < 2) return;

        // Gap Calculation
        const marketStats = this.calculateSpikeStats(assetData.sources[source], price);
        const currentDeltaPrice = assetData.deltaHistory[assetData.deltaHistory.length - 1].p;
        const deltaStats = this.calculateSpikeStats(assetData.deltaHistory, currentDeltaPrice);

        let gap = marketStats.direction === 'up' 
            ? marketStats.changePct - deltaStats.changePct 
            : Math.abs(marketStats.changePct) - Math.abs(deltaStats.changePct);
        
        if (gap < 0) gap = 0;

        // Sliding Window Logic
        const cutoff = now - this.windowSizeMs;
        while (assetData.gapHistory.length > 0 && assetData.gapHistory[0].t < cutoff) assetData.gapHistory.shift();
        
        let rollingMax = 0.05; 
        for (const item of assetData.gapHistory) { if (item.v > rollingMax) rollingMax = item.v; }

        // TRIGGER
        if (gap > (rollingMax * 1.01)) {
            this.logger.info(`[AdvanceStrategy] ⚡ Trigger: Gap ${gap.toFixed(4)}% > Max ${rollingMax.toFixed(4)}%`);
            await this.executeTrade(asset, marketStats.direction === 'up' ? 'buy' : 'sell', assetData.deltaId);
        }

        assetData.gapHistory.push({ t: now, v: gap });
    }

    // --- EXECUTION WITH HARD SL ---

    async executeTrade(asset, side, productId) {
        this.bot.isOrderInProgress = true;
        try {
            // 1. Send Market Order to Delta
            const orderData = {
                product_id: productId.toString(),
                size: this.bot.config.orderSize.toString(),
                side: side,
                order_type: 'market_order' 
            };
            
            this.lastOrderTime = Date.now();
            const response = await this.bot.placeOrder(orderData);

            // 2. Extract REAL Entry Price from Response
            // Delta India API usually returns this in response.average_fill_price
            const realFillPrice = parseFloat(response.average_fill_price || response.price || 0);

            if (realFillPrice > 0) {
                this.entryPrice = realFillPrice;
                this.logger.info(`[EXECUTION] Filled at ${realFillPrice}. Calculating Hard SL...`);

                // 3. Calculate SL Price (Exchange-side trigger)
                const slOffset = realFillPrice * (this.slPercent / 100);
                const stopPrice = side === 'buy' ? (realFillPrice - slOffset) : (realFillPrice + slOffset);

                // 4. Place the Hard Stop Market Order
                const stopPayload = {
                    product_id: productId.toString(),
                    size: orderData.size,
                    side: side === 'buy' ? 'sell' : 'buy',
                    order_type: 'stop_market_order',
                    stop_price: stopPrice.toFixed(4) // Round to 4 decimals for XRP/BTC/ETH
                };

                // Fire and forget the SL order (background task)
                this.bot.placeOrder(stopPayload).then(() => {
                    this.logger.info(`[PROTECTION] 🛡️ Hard Stop placed on Delta at ${stopPrice.toFixed(4)}`);
                }).catch(err => {
                    this.logger.error(`[CRITICAL] Hard SL placement failed: ${err.message}`);
                });

            } else {
                this.logger.warn(`[EXECUTION] Order placed but average_fill_price was missing in response.`);
            }

        } catch (e) {
            this.logger.error(`Entry Failed: ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    isLockedOut() {
        if (this.position) return true;
        if (this.lastOrderTime === 0) return false;
        return (Date.now() - this.lastOrderTime) < this.lockDurationMs;
    }

    onPositionUpdate(pos) {
        if (parseFloat(pos.size) !== 0) {
            this.position = pos;
            if (this.entryPrice === 0 && pos.entry_price) {
                this.entryPrice = parseFloat(pos.entry_price);
            }
        } else {
            this.position = null;
            this.entryPrice = 0;
        }
    }

    onOrderBookUpdate(symbol, price) {
        const asset = Object.keys(this.assets).find(a => symbol.startsWith(a));
        if (asset) this.updateHistory(this.assets[asset].deltaHistory, price, Date.now());
    }

    updateHistory(array, p, t) {
        array.push({ p, t });
        const cutoff = t - this.windowSizeMs;
        while (array.length > 0 && array[0].t < cutoff) array.shift();
    }

    calculateSpikeStats(history, currentPrice) {
        let min = Math.min(...history.map(h => h.p));
        let max = Math.max(...history.map(h => h.p));
        if (Math.abs(currentPrice - min) > Math.abs(currentPrice - max)) {
            return { direction: 'up', changePct: ((currentPrice - min) / min) * 100 };
        } else {
            return { direction: 'down', changePct: -((max - currentPrice) / max) * 100 };
        }
    }
}

module.exports = AdvanceStrategy;
                    
