
class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- ASSET CONFIGURATION ---
        // We track 3 assets. 
        // IMPORTANT: Verify these Product IDs on Delta Exchange before live trading.
        this.assets = {
            'BTC': { 
                deltaId: 27,   // Delta BTC-PERP ID
                bybitHistory: [], 
                deltaHistory: [] 
            },
            'ETH': { 
                deltaId: 54,   // Delta ETH-PERP ID (Verify this!)
                bybitHistory: [], 
                deltaHistory: [] 
            },
            'SOL': { 
                deltaId: 300,  // Delta SOL-PERP ID
                bybitHistory: [], 
                deltaHistory: [] 
            }
        };

        // --- LEARNING PHASE STATE ---
        this.windowSizeMs = 5 * 60 * 1000; // 5 Minute Sliding Window
        this.startTime = Date.now();
        this.isWarmup = true;
        this.baselineGap = 0; // The "Noise Floor" learned during warmup

        // --- TRADING STATE ---
        this.lastOrderTime = 0;
        this.lockedAsset = null;
        this.position = null;
        this.minHistoryPoints = 10; // Minimum ticks needed to calculate a spike
    }

    getName() { return "AdvanceStrategy (Auto-Learn)"; }

    /**
     * 1. INGEST BYBIT PRICE (The "Leader")
     * Called whenever bybit_listener sends a trade update.
     */
    async onPriceUpdate(asset, bybitPrice) {
        // If we are locked in a trade (or cooldown), ignore signals
        if (this.isLockedOut()) return;
        
        const now = Date.now();
        const assetData = this.assets[asset];
        if (!assetData) return;

        // --- 1. CHECK WARMUP STATUS ---
        // If 5 minutes have passed, we switch from Learning to Active
        if (this.isWarmup && (now - this.startTime > this.windowSizeMs)) {
            this.isWarmup = false;
            this.logger.info(`[AdvanceStrategy] *** WARMUP COMPLETE ***`);
            this.logger.info(`[AdvanceStrategy] Learned Baseline Threshold: ${this.baselineGap.toFixed(4)}%`);
            this.logger.info(`[AdvanceStrategy] Any spike larger than this will now trigger a trade.`);
        }

        // --- 2. DATA INGESTION (Bybit) ---
        this.updateHistory(assetData.bybitHistory, bybitPrice, now);

        // Need enough data points to calculate a spike
        if (assetData.bybitHistory.length < this.minHistoryPoints) return;
        if (assetData.deltaHistory.length < this.minHistoryPoints) return;

        // --- 3. CALCULATE SPIKES (Bybit vs Delta) ---
        const bybitStats = this.calculateSpikeStats(assetData.bybitHistory, bybitPrice);
        
        // Get latest Delta price from history (Delta is the laggard)
        const currentDeltaPrice = assetData.deltaHistory[assetData.deltaHistory.length - 1].p;
        const deltaStats = this.calculateSpikeStats(assetData.deltaHistory, currentDeltaPrice);

        // --- 4. CALCULATE THE "GAP" (Arbitrage Opportunity) ---
        let gap = 0;
        let direction = null;

        if (bybitStats.direction === 'up') {
            // Bybit Pumped. We want to BUY Delta if it hasn't moved yet.
            // Gap = Bybit Move - Delta Move
            gap = bybitStats.changePct - deltaStats.changePct;
            direction = 'buy';
        } else {
            // Bybit Dumped. We want to SELL Delta if it hasn't dropped yet.
            // Gap = Abs(Bybit) - Abs(Delta)
            gap = Math.abs(bybitStats.changePct) - Math.abs(deltaStats.changePct);
            direction = 'sell';
        }

        // Filter negative gaps (If Delta moved MORE than Bybit, there is no arb)
        if (gap < 0) gap = 0;

        // --- 5. DECISION LOGIC (Warmup vs Active) ---
        if (this.isWarmup) {
            // LEARNING PHASE: Just record the max gap we see.
            // This sets the "Noise Floor" of the market.
            if (gap > this.baselineGap) {
                this.baselineGap = gap;
                // Log strictly new highs so you know it's learning
                this.logger.debug(`[AdvanceStrategy] Learning... New Max Gap found on ${asset}: ${gap.toFixed(4)}%`);
            }
        } else {
            // ACTIVE PHASE: Execution
            // If the current gap is STRICTLY larger than our learned baseline, we fleet.
            if (gap > this.baselineGap) {
                this.logger.info(`[AdvanceStrategy] *** ANOMALY DETECTED on ${asset} ***`);
                this.logger.info(`Gap (${gap.toFixed(4)}%) > Baseline (${this.baselineGap.toFixed(4)}%)`);
                
                await this.executeTrade(asset, direction, assetData.deltaId);
            }
        }
    }

    /**
     * Called by Trader when Delta WS sends L1 update
     */
    onOrderBookUpdate(symbol, price) {
        let asset = null;
        if (symbol.startsWith('BTC')) asset = 'BTC';
        else if (symbol.startsWith('ETH')) asset = 'ETH';
        else if (symbol.startsWith('SOL')) asset = 'SOL';

        if (asset && this.assets[asset]) {
            this.updateHistory(this.assets[asset].deltaHistory, price, Date.now());
        }
    }

    // --- HELPERS ---

    updateHistory(historyArray, price, now) {
        historyArray.push({ t: now, p: price });
        // Sliding Window: Remove items older than 5 minutes
        const cutoff = now - this.windowSizeMs;
        while (historyArray.length > 0 && historyArray[0].t < cutoff) {
            historyArray.shift();
        }
    }

    calculateSpikeStats(history, currentPrice) {
        let min = Infinity;
        let max = -Infinity;

        // Find High/Low in the 5-min window
        for (const item of history) {
            if (item.p < min) min = item.p;
            if (item.p > max) max = item.p;
        }

        // Determine if current price is a Pump (up from min) or Dump (down from max)
        const distToMin = Math.abs(currentPrice - min);
        const distToMax = Math.abs(currentPrice - max);

        if (distToMin > distToMax) {
            // Up Move
            const change = ((currentPrice - min) / min) * 100;
            return { direction: 'up', changePct: change };
        } else {
            // Down Move
            const change = ((currentPrice - max) / max) * 100;
            return { direction: 'down', changePct: -Math.abs(change) };
        }
    }

    isLockedOut() {
        if (this.position) return true; // Already holding a position
        const elapsed = Date.now() - this.lastOrderTime;
        // Lockout lasts for the window size (5 mins) to prevent overtrading
        // "Only one order per 5min will happen"
        return elapsed < this.windowSizeMs && this.lastOrderTime !== 0; 
    }

    async executeTrade(asset, side, productId) {
        this.bot.isOrderInProgress = true;
        this.lockedAsset = asset;
        
        try {
            const book = this.bot.getOrderBook(asset);
            if (!book) throw new Error('Orderbook not ready');

            // Aggressive "Fleet" Price (IOC)
            // We use the Best Ask + Offset for BUY, Best Bid - Offset for SELL
            const bestPrice = side === 'buy' ? parseFloat(book.asks[0][0]) : parseFloat(book.bids[0][0]);
            const offset = this.bot.config.priceAggressionOffset;
            const limitPrice = side === 'buy' ? bestPrice + offset : bestPrice - offset;

            const orderData = {
                product_id: productId,
                size: this.bot.config.orderSize, // NOTE: Check if size 1 fits all assets (BTC vs SOL)
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice.toString(),
                time_in_force: 'ioc' // Immediate execution or cancel (Fleeting)
            };

            this.logger.info(`[AdvanceStrategy] FLEETING ${side.toUpperCase()} on ${asset}`, orderData);
            
            const response = await this.bot.placeOrder(orderData);
            
            if (response.result) {
                this.logger.info(`[AdvanceStrategy] Order Placed. Locking logic for 5 mins.`);
                this.lastOrderTime = Date.now();
            } else {
                this.logger.error(`[AdvanceStrategy] Order rejected/failed: ${JSON.stringify(response)}`);
            }
        } catch (e) {
            this.logger.error(`[AdvanceStrategy] Execution Failed: ${e.message}`);
            this.lockedAsset = null; // Unlock if failed
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    onPositionUpdate(pos) {
        if (parseFloat(pos.size) !== 0) {
            this.position = pos;
            this.logger.info(`[AdvanceStrategy] Position Active: ${pos.size}`);
        } else {
            if (this.position) this.logger.info(`[AdvanceStrategy] Position Closed.`);
            this.position = null;
            // Note: lockedAsset remains set until timer expires in isLockedOut()
        }
    }
}

module.exports = AdvanceStrategy;
