// strategies/AdvanceStrategy.js
// Version 10.0.0 - Multi-Exchange Parallel Volatility (The "Sniper" Logic)

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- ASSET CONFIGURATION ---
        // We track 3 assets across multiple exchanges independently.
        this.assets = {
            'BTC': { 
                deltaId: 27,   // Delta BTC-PERP ID
                deltaHistory: [], 
                sources: {}    // Will store: { 'BINANCE': [], 'OKX': [], ... }
            },
            'ETH': { 
                deltaId: 54,   // Delta ETH-PERP ID
                deltaHistory: [], 
                sources: {} 
            },
            'SOL': { 
                deltaId: 300,  // Delta SOL-PERP ID
                deltaHistory: [], 
                sources: {} 
            }
        };

        // --- LEARNING PHASE STATE ---
        this.windowSizeMs = 5 * 60 * 1000; // 5 Minute Sliding Window
        this.startTime = Date.now();
        this.isWarmup = true;
        
        // This represents the "Noise Floor" of the market.
        // We learn the maximum normal gap during warmup.
        this.baselineGap = 0; 

        // --- TRADING STATE ---
        this.lastOrderTime = 0;
        this.lockedAsset = null;
        this.position = null;
        
        // Minimum ticks needed to calculate a spike (Reduced for speed)
        this.minHistoryPoints = 5; 
    }

    getName() { return "AdvanceStrategy (Multi-Exchange)"; }

    /**
     * 1. INGEST MARKET PRICE (The "Leader" Signal)
     * Called whenever market_listener sends a trade update.
     * 
     * @param {string} asset - 'BTC', 'ETH', or 'SOL'
     * @param {number} price - The raw price (e.g., 89500.50)
     * @param {string} source - The exchange name (e.g., 'BINANCE', 'OKX')
     */
    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        // 1. SAFETY LOCK: If we are in a trade or cooldown, ignore everything.
        if (this.isLockedOut()) return;
        
        const now = Date.now();
        const assetData = this.assets[asset];
        
        // Safety check: Ignore assets we don't know
        if (!assetData) return;

        // --- 2. INITIALIZE SOURCE BUCKET ---
        // If this is the first time hearing from 'GATE' or 'OKX', create their bucket.
        if (!assetData.sources[source]) {
            assetData.sources[source] = [];
        }

        // --- 3. CHECK WARMUP STATUS ---
        // If 5 minutes have passed, we switch from Learning to Active
        if (this.isWarmup && (now - this.startTime > this.windowSizeMs)) {
            this.isWarmup = false;
            this.logger.info(`[AdvanceStrategy] *** WARMUP COMPLETE ***`);
            this.logger.info(`[AdvanceStrategy] System is now ACTIVE.`);
            this.logger.info(`[AdvanceStrategy] Learned Volatility Threshold: ${this.baselineGap.toFixed(4)}%`);
        }

        // --- 4. DATA INGESTION (Source Specific) ---
        // We only add this price to the specific exchange bucket.
        // This prevents "Jumping" prices between exchanges from looking like volatility.
        this.updateHistory(assetData.sources[source], price, now);

        // Need enough data points to calculate a spike
        if (assetData.sources[source].length < this.minHistoryPoints) return;
        if (assetData.deltaHistory.length < this.minHistoryPoints) return;

        // --- 5. CALCULATE RELATIVE SPIKES ---
        
        // A. Market Spike (Self-Comparison)
        // Did OKX just move relative to OKX 5 minutes ago?
        const marketStats = this.calculateSpikeStats(assetData.sources[source], price);
        
        // B. Delta Spike (Self-Comparison)
        // Did Delta just move relative to Delta 5 minutes ago?
        // We use the last known Delta price from the OrderBook updates.
        const currentDeltaPrice = assetData.deltaHistory[assetData.deltaHistory.length - 1].p;
        const deltaStats = this.calculateSpikeStats(assetData.deltaHistory, currentDeltaPrice);

        // --- 6. CALCULATE THE "GAP" (Arbitrage Opportunity) ---
        let gap = 0;
        let direction = null;

        if (marketStats.direction === 'up') {
            // Market Pumped. We want to BUY Delta if it hasn't moved yet.
            // Gap = Market Move % - Delta Move %
            gap = marketStats.changePct - deltaStats.changePct;
            direction = 'buy';
        } else {
            // Market Dumped. We want to SELL Delta if it hasn't dropped yet.
            // Gap = Abs(Market) - Abs(Delta)
            gap = Math.abs(marketStats.changePct) - Math.abs(deltaStats.changePct);
            direction = 'sell';
        }

        // Filter negative gaps (If Delta moved MORE than the Market, there is no arb)
        if (gap < 0) gap = 0;

        // --- 7. DECISION LOGIC (Warmup vs Active) ---
        if (this.isWarmup) {
            // LEARNING PHASE: Record the "Noise".
            // We want to know what the normal wiggling looks like so we don't trade on it.
            if (gap > this.baselineGap) {
                this.baselineGap = gap;
                // Optional: Log learning progress
                // this.logger.debug(`[Learning] New Max Noise on ${source}/${asset}: ${gap.toFixed(4)}%`);
            }
        } else {
            // ACTIVE PHASE: Execution
            // If the current gap is STRICTLY larger than our learned baseline, we fleet.
            if (gap > this.baselineGap) {
                this.logger.info(`[AdvanceStrategy] *** ANOMALY DETECTED on ${asset} via ${source} ***`);
                this.logger.info(`Gap (${gap.toFixed(4)}%) > Baseline (${this.baselineGap.toFixed(4)}%)`);
                this.logger.info(`Market Move: ${marketStats.changePct.toFixed(4)}% | Delta Move: ${deltaStats.changePct.toFixed(4)}%`);
                
                // Execute immediately on the FIRST signal
                await this.executeTrade(asset, direction, assetData.deltaId);
            }
        }
    }

    /**
     * Called by Trader when Delta WS sends L1 update.
     * We need this to know where Delta price is relative to itself.
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

    /**
     * Adds a price to history and removes items older than windowSize.
     */
    updateHistory(historyArray, price, now) {
        historyArray.push({ t: now, p: price });
        // Sliding Window: Remove items older than 5 minutes
        const cutoff = now - this.windowSizeMs;
        while (historyArray.length > 0 && historyArray[0].t < cutoff) {
            historyArray.shift();
        }
    }

    /**
     * Calculates the % move from the Min or Max within the window.
     * Returns: { direction: 'up'|'down', changePct: number }
     */
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
            // We are closer to the top, so we calculate gain from bottom
            const change = ((currentPrice - min) / min) * 100;
            return { direction: 'up', changePct: change };
        } else {
            // We are closer to the bottom, so we calculate loss from top
            const change = ((currentPrice - max) / max) * 100;
            return { direction: 'down', changePct: -Math.abs(change) };
        }
    }

    /**
     * Prevents overtrading. 
     * 1. If we have a position -> Locked.
     * 2. If we just traded < 5 mins ago -> Locked.
     */
    isLockedOut() {
        if (this.position) return true; // Already holding a position
        const elapsed = Date.now() - this.lastOrderTime;
        // Lockout lasts for the window size (5 mins)
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
                size: this.bot.config.orderSize, 
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice.toString(),
                time_in_force: 'ioc' // Immediate execution or cancel (Fleeting)
            };

            this.logger.info(`[AdvanceStrategy] FLEETING ${side.toUpperCase()} on ${asset}`, orderData);
            
            const response = await this.bot.placeOrder(orderData);
            
            if (response.result) {
                this.logger.info(`[AdvanceStrategy] Order Placed Successfully. Entering Cooldown.`);
                this.lastOrderTime = Date.now();
            } else {
                this.logger.error(`[AdvanceStrategy] Order rejected/failed: ${JSON.stringify(response)}`);
            }
        } catch (e) {
            this.logger.error(`[AdvanceStrategy] Execution Failed: ${e.message}`);
            // Note: We do NOT reset lockedAsset here immediately, allowing logic to settle.
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
