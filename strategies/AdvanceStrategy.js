// strategies/AdvanceStrategy.js
// Version 16.0.0 - Atomic Bracket SL (Using MomentumRider Logic)

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
        this.slPercent = 0.3; // Recommended "Sweet Spot" for 50x leverage
    }

    getName() { return "AdvanceStrategy (Atomic Bracket Fix)"; }

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

        const cutoff = now - this.windowSizeMs;
        while (assetData.gapHistory.length > 0 && assetData.gapHistory[0].t < cutoff) assetData.gapHistory.shift();
        
        let rollingMax = 0.05; 
        for (const item of assetData.gapHistory) { if (item.v > rollingMax) rollingMax = item.v; }

        if (gap > (rollingMax * 1.01)) {
            this.logger.info(`[AdvanceStrategy] ⚡ Trigger: Gap ${gap.toFixed(4)}% > Max ${rollingMax.toFixed(4)}%`);
            // We pass the current signal price to the executor
            await this.executeTrade(asset, marketStats.direction === 'up' ? 'buy' : 'sell', assetData.deltaId, price);
        }

        assetData.gapHistory.push({ t: now, v: gap });
    }

    // --- ATOMIC EXECUTION (MOMENTUM RIDER STYLE) ---
    async executeTrade(asset, side, productId, currentPrice) {
        this.bot.isOrderInProgress = true;
        try {
            // 1. Calculate SL Price using the proven offset logic
            const slOffset = currentPrice * (this.slPercent / 100);
            const stopLossPrice = side === 'buy' 
                ? (currentPrice - slOffset) 
                : (currentPrice + slOffset);

            // 2. Prepare Order with ATOMIC Bracket fields
            // Using the same field names from MomentumRiderStrategy.js
            const orderData = { 
                product_id: productId.toString(), 
                size: this.bot.config.orderSize.toString(), 
                side: side, 
                order_type: 'market_order',
                bracket_stop_loss_price: stopLossPrice.toFixed(4),
                bracket_stop_trigger_method: 'mark_price' // 'mark_price' is usually safer for 50x leverage
            };
            
            this.logger.info(`[AdvanceStrategy] 🚀 Punching Order with Atomic SL at ${stopLossPrice.toFixed(4)}`);
            this.lastOrderTime = Date.now();
            
            const response = await this.bot.placeOrder(orderData);

            if (response.result || (response.status && response.status === 'success')) {
                this.logger.info(`[AdvanceStrategy] ✅ Atomic entry order accepted by Delta.`);
            } else { 
                throw new Error("Order rejected or unexpected response: " + JSON.stringify(response)); 
            }
        } catch (error) {
            this.logger.error(`[AdvanceStrategy] ❌ Execution Failed:`, { message: error.message });
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    isLockedOut() {
        if (this.lastOrderTime === 0) return false;
        return (Date.now() - this.lastOrderTime) < this.lockDurationMs;
    }

    onPositionUpdate(pos) {
        // Strategy no longer needs to track this for SL as it's exchange-side now
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
