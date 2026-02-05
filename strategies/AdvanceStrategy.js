// strategies/AdvanceStrategy.js
// Version 12.1.0 - Bracket SL (0.01%) + 10s Fixed Lockout

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. MASTER ASSET METADATA (USDT / LINEAR IDS) ---
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969 }, // User Provided ID for XRPUSDT
            'BTC': { deltaId: 27 },    // Common BTC-PERP (Linear) ID
            'ETH': { deltaId: 299 },   // Common ETH-PERP (Linear) ID
            'SOL': { deltaId: 300 }    // Common SOL-PERP (Linear) ID
        };

        // --- 2. INITIALIZE TARGETS ---
        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        
        this.assets = {};

        targets.forEach(asset => {
            if (MASTER_CONFIG[asset]) {
                this.assets[asset] = {
                    deltaId: MASTER_CONFIG[asset].deltaId,
                    deltaHistory: [], // Stores Price History
                    gapHistory: [],   // [NEW] Stores Gap History for Sliding Window
                    sources: {} 
                };
                this.logger.info(`[AdvanceStrategy] Enabled Asset: ${asset}USDT (ID: ${this.assets[asset].deltaId})`);
            } else {
                this.logger.warn(`[AdvanceStrategy] Warning: Configured asset ${asset} not found in Master Config.`);
            }
        });

        // --- LEARNING PHASE STATE ---
        this.windowSizeMs = 2 * 60 * 1000; // 2 Minute Sliding Window (Calculations)
        this.lockDurationMs = 10000;       // [NEW] 10 Second Trading Lockout
        this.startTime = Date.now();
        this.isWarmup = true;
        
        this.currentThresholdDisplay = 0; 

        // --- TRADING STATE ---
        this.lastOrderTime = 0;
        this.lockedAsset = null;
        this.position = null;
        
        this.minHistoryPoints = 2; 
    }

    getName() { return "AdvanceStrategy (Bracket SL + 10s Lock)"; }

    /**
     * 1. INGEST MARKET PRICE (The "Leader" Signal)
     */
    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        // 1. SAFETY LOCK (Updated for 10s rule)
        if (this.isLockedOut()) return;
        
        const now = Date.now();
        const assetData = this.assets[asset];
        
        if (!assetData) return;

        // --- 2. INITIALIZE SOURCE BUCKET ---
        if (!assetData.sources[source]) {
            assetData.sources[source] = [];
        }

        // --- 3. CHECK WARMUP STATUS ---
        if (this.isWarmup && (now - this.startTime > this.windowSizeMs)) {
            this.isWarmup = false;
            this.logger.info(`[AdvanceStrategy] *** WARMUP COMPLETE ***`);
            this.logger.info(`[AdvanceStrategy] System is now ACTIVE with Dynamic Sliding Window.`);
        }

        // --- 4. DATA INGESTION ---
        this.updateHistory(assetData.sources[source], price, now);

        if (assetData.sources[source].length < this.minHistoryPoints) return;
        if (assetData.deltaHistory.length < this.minHistoryPoints) return;

        // --- 5. CALCULATE RELATIVE SPIKES ---
        const marketStats = this.calculateSpikeStats(assetData.sources[source], price);
        const currentDeltaPrice = assetData.deltaHistory[assetData.deltaHistory.length - 1].p;
        const deltaStats = this.calculateSpikeStats(assetData.deltaHistory, currentDeltaPrice);

        // --- 6. CALCULATE THE CURRENT "GAP" ---
        let gap = 0;
        let direction = null;

        if (marketStats.direction === 'up') {
            gap = marketStats.changePct - deltaStats.changePct;
            direction = 'buy';
        } else {
            gap = Math.abs(marketStats.changePct) - Math.abs(deltaStats.changePct);
            direction = 'sell';
        }

        if (gap < 0) gap = 0;

        // ==================================================================
        // --- 7. SLIDING WINDOW THRESHOLD LOGIC ---
        // ==================================================================

        // A. Clean up old Gap History
        const cutoff = now - this.windowSizeMs;
        while (assetData.gapHistory.length > 0 && assetData.gapHistory[0].t < cutoff) {
            assetData.gapHistory.shift();
        }

        // B. Calculate Dynamic Threshold (Rolling Max)
        let rollingMax = 0.05; 
        
        for (const item of assetData.gapHistory) {
            if (item.v > rollingMax) {
                rollingMax = item.v;
            }
        }
        
        this.currentThresholdDisplay = rollingMax;

        // ==================================================================
        // --- 8. DECISION LOGIC ---
        // ==================================================================

        if (!this.isWarmup) {
            const triggerThreshold = rollingMax * 1.01;

            if (gap > (triggerThreshold * 0.5) || Math.random() < 0.05) {
                this.logger.info(`[Pulse] ${asset} | Gap: ${gap.toFixed(4)}% | Rolling Max (2m): ${rollingMax.toFixed(4)}% | Dir: ${direction}`);
            }

            if (gap > triggerThreshold) {
                this.logger.info(`[AdvanceStrategy] *** ANOMALY DETECTED on ${asset} via ${source} ***`);
                this.logger.info(`Gap (${gap.toFixed(4)}%) > Rolling Max (${rollingMax.toFixed(4)}%)`);
                
                await this.executeTrade(asset, direction, assetData.deltaId);
            }
        }

        // C. UPDATE HISTORY
        assetData.gapHistory.push({ t: now, v: gap });
    }

    onOrderBookUpdate(symbol, price) {
        const asset = Object.keys(this.assets).find(a => symbol.startsWith(a));
        if (asset && this.assets[asset]) {
            this.updateHistory(this.assets[asset].deltaHistory, price, Date.now());
        }
    }

    // --- HELPERS ---

    updateHistory(historyArray, price, now) {
        historyArray.push({ t: now, p: price });
        const cutoff = now - this.windowSizeMs;
        while (historyArray.length > 0 && historyArray[0].t < cutoff) {
            historyArray.shift();
        }
    }

    calculateSpikeStats(history, currentPrice) {
        let min = Infinity;
        let max = -Infinity;

        for (const item of history) {
            if (item.p < min) min = item.p;
            if (item.p > max) max = item.p;
        }

        const distToMin = Math.abs(currentPrice - min);
        const distToMax = Math.abs(currentPrice - max);

        if (distToMin > distToMax) {
            const change = ((currentPrice - min) / min) * 100;
            return { direction: 'up', changePct: change };
        } else {
            const change = ((currentPrice - max) / max) * 100;
            return { direction: 'down', changePct: -Math.abs(change) };
        }
    }

    /**
     * [UPDATED] Check Lockout Status
     * - Returns TRUE only if within 10 seconds of the last order.
     * - Does NOT check `this.position` anymore, allowing re-entry after 10s.
     */
    isLockedOut() {
        // If we have never traded, we are not locked.
        if (this.lastOrderTime === 0) return false;

        const elapsed = Date.now() - this.lastOrderTime;
        
        // Lock out if less than 10s has passed
        if (elapsed < this.lockDurationMs) {
            return true;
        }

        return false;
    }

    async executeTrade(asset, side, productId) {
        this.bot.isOrderInProgress = true;
        this.lockedAsset = asset;
        
        try {
            const book = this.bot.getOrderBook(asset);
            if (!book) throw new Error('Orderbook not ready');

            const bestPrice = side === 'buy' ? parseFloat(book.asks[0][0]) : parseFloat(book.bids[0][0]);
            
            // --- PRICE CALCULATION ---
            const aggressionPercent = this.bot.config.priceAggressionOffset; 
            const offsetAmount = bestPrice * (aggressionPercent / 100);
            
            let limitPrice = side === 'buy' ? bestPrice + offsetAmount : bestPrice - offsetAmount;
            limitPrice = parseFloat(limitPrice.toFixed(6));

            // --- [NEW] BRACKET STOP LOSS CALCULATION ---
            // 0.01% Stop Loss (fixed percentage)
            const slPercentage = 0.0001; 
            let stopLossPrice;

            if (side === 'buy') {
                // For Buy, Stop Loss is BELOW entry
                stopLossPrice = limitPrice * (1 - slPercentage);
            } else {
                // For Sell, Stop Loss is ABOVE entry
                stopLossPrice = limitPrice * (1 + slPercentage);
            }
            // Round to 6 decimals to match API requirements
            stopLossPrice = parseFloat(stopLossPrice.toFixed(6));

            const orderData = {
                product_id: productId.toString(), 
                size: this.bot.config.orderSize, 
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice.toString(),
                bracket_stop_loss_price: stopLossPrice.toString(), // [NEW] Stop Loss Trigger
                time_in_force: 'ioc' 
            };

            this.logger.info(`[AdvanceStrategy] FLEETING ${side.toUpperCase()} on ${asset} @ ${limitPrice} | SL: ${stopLossPrice}`, orderData);
            
            // Update last order time immediately to trigger the 10s lock
            this.lastOrderTime = Date.now(); 

            const response = await this.bot.placeOrder(orderData);
            
            if (response.result) {
                this.logger.info(`[AdvanceStrategy] Order Placed Successfully. 10s Lockout Active.`);
            } else {
                this.logger.error(`[AdvanceStrategy] Order rejected/failed: ${JSON.stringify(response)}`);
            }
        } catch (e) {
            this.logger.error(`[AdvanceStrategy] Execution Failed: ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    onPositionUpdate(pos) {
        if (parseFloat(pos.size) !== 0) {
            this.position = pos;
            this.logger.info(`[AdvanceStrategy] Position Active: ${pos.size} contracts.`);
        } else {
            if (this.position) this.logger.info(`[AdvanceStrategy] Position Closed.`);
            this.position = null;
        }
    }
}

module.exports = AdvanceStrategy;
                                                                     
