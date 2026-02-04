// strategies/AdvanceStrategy.js
// Version 11.0.2 - ADDED: Heartbeat Logging for visibility

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. MASTER ASSET METADATA (USDT / LINEAR IDS) ---
        // CRITICAL: Ensure these IDs match the LINEAR (USDT) contracts on Delta.
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
                    deltaHistory: [],
                    sources: {} 
                };
                this.logger.info(`[AdvanceStrategy] Enabled Asset: ${asset}USDT (ID: ${this.assets[asset].deltaId})`);
            } else {
                this.logger.warn(`[AdvanceStrategy] Warning: Configured asset ${asset} not found in Master Config.`);
            }
        });

        // --- LEARNING PHASE STATE ---
        this.windowSizeMs = 2 * 60 * 1000; // 2 Minute Sliding Window
        this.startTime = Date.now();
        this.isWarmup = true;
        
        this.baselineGap = 0; 

        // --- TRADING STATE ---
        this.lastOrderTime = 0;
        this.lockedAsset = null;
        this.position = null;
        
        this.minHistoryPoints = 2; 
    }

    getName() { return "AdvanceStrategy (USDT Linear)"; }

    /**
     * 1. INGEST MARKET PRICE (The "Leader" Signal)
     * Called whenever market_listener sends a trade update.
     */
    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        // 1. SAFETY LOCK
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
            this.logger.info(`[AdvanceStrategy] System is now ACTIVE.`);
            this.logger.info(`[AdvanceStrategy] Learned Volatility Threshold: ${this.baselineGap.toFixed(4)}%`);
        }

        // --- 4. DATA INGESTION ---
        this.updateHistory(assetData.sources[source], price, now);

        if (assetData.sources[source].length < this.minHistoryPoints) return;
        if (assetData.deltaHistory.length < this.minHistoryPoints) return;

        // --- 5. CALCULATE RELATIVE SPIKES ---
        
        // A. Market Spike (Self-Comparison)
        const marketStats = this.calculateSpikeStats(assetData.sources[source], price);
        
        // B. Delta Spike (Self-Comparison)
        const currentDeltaPrice = assetData.deltaHistory[assetData.deltaHistory.length - 1].p;
        const deltaStats = this.calculateSpikeStats(assetData.deltaHistory, currentDeltaPrice);

        // --- 6. CALCULATE THE "GAP" ---
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

        // --- 7. DECISION LOGIC ---
        if (this.isWarmup) {
            // LEARNING PHASE
            if (gap > this.baselineGap) {
                this.baselineGap = gap;
            }
        } else {
            // [NEW] DEBUG PULSE: Log heartbeat to confirm math is running
            // Logs if gap is > 50% of threshold OR 5% random chance
            if (gap > (this.baselineGap * 0.5) || Math.random() < 0.05) {
                this.logger.info(`[Strategy Pulse] ${asset} | Gap: ${gap.toFixed(4)}% | Threshold: ${this.baselineGap.toFixed(4)}% | Dir: ${direction}`);
            }

            // ACTIVE PHASE
            if (gap > this.baselineGap) {
                this.logger.info(`[AdvanceStrategy] *** ANOMALY DETECTED on ${asset} via ${source} ***`);
                this.logger.info(`Gap (${gap.toFixed(4)}%) > Baseline (${this.baselineGap.toFixed(4)}%)`);
                this.logger.info(`Market Move: ${marketStats.changePct.toFixed(4)}% | Delta Move: ${deltaStats.changePct.toFixed(4)}%`);
                
                await this.executeTrade(asset, direction, assetData.deltaId);
            }
        }
    }

    /**
     * Called by Trader when Delta WS sends L1 update.
     */
    onOrderBookUpdate(symbol, price) {
        // DYNAMIC LOOKUP: Check which of our active assets matches this symbol
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

    isLockedOut() {
        if (this.position) return true;
        const elapsed = Date.now() - this.lastOrderTime;
        return elapsed < this.windowSizeMs && this.lastOrderTime !== 0; 
    }

    async executeTrade(asset, side, productId) {
        this.bot.isOrderInProgress = true;
        this.lockedAsset = asset;
        
        try {
            const book = this.bot.getOrderBook(asset);
            if (!book) throw new Error('Orderbook not ready');

            const bestPrice = side === 'buy' ? parseFloat(book.asks[0][0]) : parseFloat(book.bids[0][0]);
            const offset = this.bot.config.priceAggressionOffset;
            const limitPrice = side === 'buy' ? bestPrice + offset : bestPrice - offset;

            const orderData = {
                product_id: productId.toString(), 
                size: this.bot.config.orderSize, 
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice.toString(),
                time_in_force: 'ioc' 
            };

            this.logger.info(`[AdvanceStrategy] FLEETING ${side.toUpperCase()} on ${asset}`, orderData);
            
            this.lastOrderTime = Date.now(); 

            const response = await this.bot.placeOrder(orderData);
            
            if (response.result) {
                this.logger.info(`[AdvanceStrategy] Order Placed Successfully. Entering Cooldown.`);
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
                                                                                       
