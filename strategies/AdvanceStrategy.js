// strategies/AdvanceStrategy.js
// Version 12.2.0 - Signal-Based Emergency Exit (Binance Lead)

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
        this.slPercent = 0.01; // 0.01% Stop Loss
    }

    getName() { return "AdvanceStrategy (Binance-Lead Exit)"; }

    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        const now = Date.now();
        const assetData = this.assets[asset];
        if (!assetData) return;

        // ==================================================================
        // --- 1. EMERGENCY SIGNAL EXIT (The logic you asked for) ---
        // ==================================================================
        if (this.position && this.position.product_id == assetData.deltaId) {
            const side = this.position.side; // 'buy' or 'sell'
            
            // Calculate if the SIGNAL (Binance) has moved against us by 0.01%
            const priceChange = ((price - this.entryPrice) / this.entryPrice) * 100;

            let shouldExit = false;
            if (side === 'buy' && priceChange <= -this.slPercent) shouldExit = true;
            if (side === 'sell' && priceChange >= this.slPercent) shouldExit = true;

            if (shouldExit) {
                this.logger.warn(`[EMERGENCY EXIT] Signal ${source} hit SL (${priceChange.toFixed(4)}%). Exiting Market.`);
                await this.closePositionMarket(asset, assetData.deltaId);
                return; // Exit early
            }
        }

        // ==================================================================
        // --- 2. ENTRY LOGIC (Standard Gap Analysis) ---
        // ==================================================================
        if (this.isLockedOut()) return;

        if (!assetData.sources[source]) assetData.sources[source] = [];
        this.updateHistory(assetData.sources[source], price, now);

        // Check Warmup
        if (this.isWarmup && (now - this.startTime > this.windowSizeMs)) {
            this.isWarmup = false;
            this.logger.info(`[AdvanceStrategy] *** ACTIVE ***`);
        }

        if (this.isWarmup || assetData.sources[source].length < 2 || assetData.deltaHistory.length < 2) return;

        // Calculate Gaps
        const marketStats = this.calculateSpikeStats(assetData.sources[source], price);
        const currentDeltaPrice = assetData.deltaHistory[assetData.deltaHistory.length - 1].p;
        const deltaStats = this.calculateSpikeStats(assetData.deltaHistory, currentDeltaPrice);

        let gap = marketStats.direction === 'up' 
            ? marketStats.changePct - deltaStats.changePct 
            : Math.abs(marketStats.changePct) - Math.abs(deltaStats.changePct);
        
        if (gap < 0) gap = 0;

        // Sliding Window Threshold
        const cutoff = now - this.windowSizeMs;
        while (assetData.gapHistory.length > 0 && assetData.gapHistory[0].t < cutoff) assetData.gapHistory.shift();
        
        let rollingMax = 0.05; 
        for (const item of assetData.gapHistory) { if (item.v > rollingMax) rollingMax = item.v; }

        if (gap > (rollingMax * 1.01)) {
            this.entryPrice = price; // Store the Binance price at entry for the SL trigger
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
                order_type: 'market_order' // Using Market for fastest entry on spike
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
            this.position = null; // Reset local state
            this.lastOrderTime = Date.now(); // Reset 10s lockout after exit
        } catch (e) {
            this.logger.error(`Exit Failed: ${e.message}`);
        }
    }

    // Standard Helpers (updateHistory, calculateSpikeStats, isLockedOut, etc.) remain same as previous version...
    isLockedOut() {
        if (this.position) return true;
        if (this.lastOrderTime === 0) return false;
        return (Date.now() - this.lastOrderTime) < this.lockDurationMs;
    }

    onPositionUpdate(pos) {
        if (parseFloat(pos.size) !== 0) {
            this.position = pos;
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
                        
