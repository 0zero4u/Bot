
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
        this.slPercent = 0.15; // Tight Stop Loss
        
        // [LOCK] Local lock to prevent duplicate orders before WebSocket syncs
        this.localInPosition = false; 
    }

    getName() { return "AdvanceStrategy (Limit IOC + Aggression)"; }

    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        const now = Date.now();
        const assetData = this.assets[asset];
        
        // 1. Check ALL locks before even calculating gaps
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
        
        let rollingMax = 0.4; 
        for (const item of assetData.gapHistory) { if (item.v > rollingMax) rollingMax = item.v; }

        // TRIGGER
        if (gap > (rollingMax * 1.11)) {
            // [DOUBLE CHECK] Check again right before punching
            if (this.localInPosition) return; 

            this.logger.info(`[AdvanceStrategy] ⚡ Trigger: Gap ${gap.toFixed(4)}% > Max ${rollingMax.toFixed(4)}%`);
            await this.executeTrade(asset, marketStats.direction === 'up' ? 'buy' : 'sell', assetData.deltaId, price);
        }

        assetData.gapHistory.push({ t: now, v: gap });
    }

    async executeTrade(asset, side, productId, currentPrice) {
        // [LOCK] Instant lock
        this.localInPosition = true;
        this.bot.isOrderInProgress = true;
        
        try {
            // --- PRICE CALCULATION (Limit IOC + Aggression) ---
            
            // 1. Get Aggression % from config (default 0.05% if not set)
            // This ensures we cross the spread to get filled immediately
            const aggressionPercent = this.bot.config.priceAggressionOffset || 0.05;
            
            // 2. Fetch Real-Time OrderBook from Bot for precision
            const ob = this.bot.getOrderBook(asset);
            let executionPrice = currentPrice;

            // Determine base price from Order Book (Best Ask for Buy, Best Bid for Sell)
            if (side === 'buy') {
                if (ob && ob.asks && ob.asks.length > 0) {
                    executionPrice = parseFloat(ob.asks[0][0]);
                }
                // Add aggression to buy slightly higher than ask (guarantee fill)
                executionPrice = executionPrice * (1 + (aggressionPercent / 100));
            } else {
                if (ob && ob.bids && ob.bids.length > 0) {
                    executionPrice = parseFloat(ob.bids[0][0]);
                }
                // Subtract aggression to sell slightly lower than bid (guarantee fill)
                executionPrice = executionPrice * (1 - (aggressionPercent / 100));
            }

            // 3. Calculate Stop Loss based on the Execution Price
            const slOffset = executionPrice * (this.slPercent / 100);
            const stopLossPrice = side === 'buy' ? (executionPrice - slOffset) : (executionPrice + slOffset);

            const orderData = { 
                product_id: productId.toString(), 
                size: this.bot.config.orderSize.toString(), 
                side: side, 
                order_type: 'limit_order',              // <--- CHANGED to Limit
                limit_price: executionPrice.toFixed(4), // <--- Calculated Aggressive Price
                time_in_force: 'ioc',                   // <--- Immediate Or Cancel
                bracket_stop_loss_price: stopLossPrice.toFixed(4),
                bracket_stop_trigger_method: 'mark_price' // <--- Safer than last_traded_price
            };
            
            this.logger.info(`[AdvanceStrategy] 🚀 Punching IOC Order: ${side.toUpperCase()} @ ${executionPrice.toFixed(4)} (SL: ${stopLossPrice.toFixed(4)})`);
            this.lastOrderTime = Date.now();
            
            await this.bot.placeOrder(orderData);
            this.logger.info(`[AdvanceStrategy] ✅ IOC Order sent.`);

        } catch (error) {
            this.logger.error(`[AdvanceStrategy] ❌ Execution Failed:`, { message: error.message });
            // If the order fails, we unlock it so it can try again on the next signal
            this.localInPosition = false; 
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    // Centralized lock management
    isLockedOut() {
        // 1. Prevent trade if we locally think we are in a position
        if (this.localInPosition) return true;
        
        // 2. Prevent trade if a previous order is literally in flight (HTTP request hasn't returned)
        if (this.bot.isOrderInProgress) return true;

        // 3. Cooldown check
        if (this.lastOrderTime === 0) return false;
        return (Date.now() - this.lastOrderTime) < this.lockDurationMs;
    }

    // [UPDATED] Robust Position Sync to manage the lock
    onPositionUpdate(pos) {
        // Handle cases where size might be a string "0" or number 0
        const rawSize = (pos && pos.size !== undefined) ? pos.size : 0;
        const size = Math.abs(parseFloat(rawSize));
        
        if (size > 0) {
            // We are officially in a trade
            if (!this.localInPosition) {
                this.logger.info(`[AdvanceStrategy] Exchange reports position ACTIVE. Strategy Locked.`);
            }
            this.localInPosition = true;
        } else {
            // Position is closed, we can unlock for the next trade
            if (this.localInPosition) {
                this.logger.info(`[AdvanceStrategy] Exchange reports position CLOSED. Strategy Unlocked.`);
            }
            this.localInPosition = false;
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
