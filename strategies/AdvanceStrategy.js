
// strategies/AdvanceStrategy.js
// Version 12.3.0 - Fixed Entry Price Amnesia & Validated SL

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
        this.entryPrice = 0; // Critical Variable
        this.slPercent = 0.01; 
    }

    getName() { return "AdvanceStrategy (Persistent SL Fix)"; }

    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        const now = Date.now();
        const assetData = this.assets[asset];
        if (!assetData) return;

        // ==================================================================
        // --- 1. EMERGENCY SIGNAL EXIT (Priority High) ---
        // ==================================================================
        
        // Only run this if we have a position and it matches the current asset
        if (this.position && (this.position.product_id == assetData.deltaId || this.position.product_symbol.startsWith(asset))) {
            
            // [FIX] Self-Healing Entry Price
            // If we have a position but entryPrice is 0 (due to restart), restore it immediately.
            if (this.entryPrice === 0) {
                if (this.position.entry_price && parseFloat(this.position.entry_price) > 0) {
                    this.entryPrice = parseFloat(this.position.entry_price);
                    this.logger.warn(`[AdvanceStrategy] ⚠️ Restored Entry Price from Delta: ${this.entryPrice}`);
                } else {
                    // Last Resort: Use current price to prevent divide-by-zero, but warn user
                    this.entryPrice = price; 
                    this.logger.error(`[AdvanceStrategy] 🚨 Entry Price Missing! Resetting SL baseline to CURRENT price: ${price}`);
                }
            }

            // Perform SL Check
            const side = this.position.side;
            const priceChange = ((price - this.entryPrice) / this.entryPrice) * 100;

            let shouldExit = false;
            // Buy Position: Exit if price drops < -0.01%
            if (side === 'buy' && priceChange <= -this.slPercent) shouldExit = true;
            // Sell Position: Exit if price rises > 0.01%
            if (side === 'sell' && priceChange >= this.slPercent) shouldExit = true;

            if (shouldExit) {
                this.logger.warn(`[EMERGENCY EXIT] Signal ${source} hit SL (${priceChange.toFixed(4)}%). Exiting Market.`);
                await this.closePositionMarket(asset, assetData.deltaId);
                return; // Stop processing
            }
        }

        // ==================================================================
        // --- 2. ENTRY LOGIC (Standard Gap Analysis) ---
        // ==================================================================
        if (this.isLockedOut()) return;

        // Populate History
        if (!assetData.sources[source]) assetData.sources[source] = [];
        this.updateHistory(assetData.sources[source], price, now);

        if (this.isWarmup && (now - this.startTime > this.windowSizeMs)) {
            this.isWarmup = false;
            this.logger.info(`[AdvanceStrategy] *** ACTIVE ***`);
        }

        // Buffer Check (This is why you see Buffer 0 logs - this line prevents trading on empty history)
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
            this.entryPrice = price; // Capture Binance Price for SL
            await this.executeTrade(asset, marketStats.direction === 'up' ? 'buy' : 'sell', assetData.deltaId);
        }

        assetData.gapHistory.push({ t: now, v: gap });
    }

    // --- EXECUTION HELPERS ---

    async executeTrade(asset, side, productId) {
        this.bot.isOrderInProgress = true;
        try {
            const orderData = {
                product_id: productId.toString(),
                size: this.bot.config.orderSize,
                side: side,
                order_type: 'market_order' 
            };
            this.lastOrderTime = Date.now();
            await this.bot.placeOrder(orderData);
        } catch (e) {
            this.logger.error(`Entry Failed: ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    async closePositionMarket(asset, productId) {
        if (!this.position) return;
        try {
            const side = this.position.side === 'buy' ? 'sell' : 'buy';
            const orderData = {
                product_id: productId.toString(),
                size: Math.abs(parseFloat(this.position.size)).toString(),
                side: side,
                order_type: 'market_order'
            };
            await this.bot.placeOrder(orderData);
            this.position = null; 
            this.entryPrice = 0;
            this.lastOrderTime = Date.now(); 
        } catch (e) {
            this.logger.error(`Exit Failed: ${e.message}`);
        }
    }

    isLockedOut() {
        if (this.position) return true;
        if (this.lastOrderTime === 0) return false;
        return (Date.now() - this.lastOrderTime) < this.lockDurationMs;
    }

    onPositionUpdate(pos) {
        // [FIX] Update local state
        if (parseFloat(pos.size) !== 0) {
            this.position = pos;
            
            // If entryPrice is missing (e.g. after restart), grab it from Delta
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
            
