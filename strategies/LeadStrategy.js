/**
 * ============================================================================
 * LEAD STRATEGY (LEADER-LAGGER ARBITRAGE)
 * Version: 13.0 [FINAL PRODUCTION - MARKET TAKER]
 * ============================================================================
 * * CORE LOGIC:
 * This strategy uses a Kalman Filter to predict the "Fair Price" of an asset 
 * on Delta Exchange (Lagger) based on real-time price movements on Binance (Leader).
 * * KEY MECHANISMS:
 * 1. PREDICTION (Binance):
 * - Ingests 'BookTicker' (Best Bid/Ask) from Binance.
 * - Updates Kalman Filter state (x = Price, P = Covariance).
 * * 2. CORRECTION (Delta):
 * - Ingests 'All Trades' from Delta.
 * - Calculates "Innovation" (Difference between Predicted & Actual).
 * - Updates Filter State based on "Trust" (Dynamic R).
 * * 3. TRIGGER (Z-Score + Sigma Floor):
 * - Calculates Z-Score = (Predicted - Actual) / Sigma.
 * - SAFETY: Sigma is floored at (2 * TickSize).
 * Example: BTC Tick is 0.50. Minimum gap required is 1.00 USD.
 * This prevents the bot from trading on tiny noise ($0.10) that looks like signal.
 * * 4. EXECUTION (Market Taker):
 * - Uses Market Orders for immediate execution.
 * - Removes Limit Price and IOC params to ensure Taker fill.
 * * ============================================================================
 */

/**
 * Helper Class: TimeWindowStats
 * Tracks the correlation (Beta) between Leader and Lagger moves over a sliding window.
 * This allows the model to adapt if the correlation breaks down (e.g., during API lag).
 */
class TimeWindowStats {
    constructor(windowMs = 5000) { 
        this.windowMs = windowMs;
        this.data = []; 
    }

    /**
     * Adds a data point (LeaderMove, LaggerMove)
     * @param {number} x - Change in Leader Price
     * @param {number} y - Change in Lagger Price
     */
    add(x, y) {
        const now = Date.now();
        this.data.push({ x, y, t: now });
        // Prune old data outside the time window
        while (this.data.length > 0 && (now - this.data[0].t > this.windowMs)) {
            this.data.shift();
        }
    }

    /**
     * Calculates Beta (Slope of regression)
     * Returns 1.0 if insufficient data. Clamped between 0.8 and 1.2 for safety.
     */
    getBeta() {
        const n = this.data.length;
        if (n < 5) return 1.0; 
        
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
            const p = this.data[i];
            sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x;
        }
        
        const meanX = sumX / n; 
        const meanY = sumY / n;
        let varX = 0, covXY = 0;
        
        for (let i = 0; i < n; i++) {
            const p = this.data[i];
            covXY += (p.x - meanX) * (p.y - meanY);
            varX += (p.x - meanX) * (p.x - meanX);
        }
        
        if (varX < 1e-9) return 1.0;
        
        let beta = covXY / varX;
        // Safety Clamp: Don't let the model assume >1.2x leverage or <0.8x damping
        return Math.max(0.8, Math.min(1.2, beta));
    }
}

class LeadStrategy {
    /**
     * @param {Object} bot - The main TradingBot instance (access to logger, client)
     */
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- KALMAN FILTER HYPERPARAMETERS ---
        this.BASE_Q = 0.0000001;    // Process Noise (How "jittery" is the true price?)
        this.BASE_R = 0.001;        // Measurement Noise (How much do we trust a generic trade?)
        this.Q_SCALER = 50000;      // Scaling factor for adaptive Q based on error variance
        this.VAR_EMA_ALPHA = 0.05;  // Smoothing factor for variance estimation

        // --- TRIGGER THRESHOLDS ---
        this.Z_THRESHOLD = 2.0;     // Statistical deviation required to trigger
        this.COOLDOWN_MS = 200;     // Minimum time between orders for the same asset

        // --- ASSET SPECIFICATIONS (VERIFIED) ---
        // tickSize: The MINIMUM price increment on Delta.
        //           This is CRITICAL for the "Sigma Floor" check.
        this.assets = {
            'XRP': { 
                deltaId: 14969, 
                precision: 4, 
                tickSize: 0.0001 // Standard XRP tick
            }, 
            'BTC': { 
                deltaId: 27,    
                precision: 1, 
                tickSize: 0.5    // FIXED: Delta BTC moves in 0.5 steps
            },    
            'ETH': { 
                deltaId: 299,   
                precision: 2, 
                tickSize: 0.05   // Safe estimate for Delta ETH contracts
            },
            'SOL': { 
                deltaId: 417,   
                precision: 3, 
                tickSize: 0.01   // Updated standard for SOL
            }
        };

        this.filters = {};          // Stores Kalman state per asset
        this.stats = {};            // Stores Beta stats per asset
        this.lastTriggerTime = {};  // Stores last execution timestamp

        this.logger.info(`[LeadStrategy v13.0] Initialized: Market Taker | BTC Tick: 0.5`);
    }

    /**
     * Initializes the Kalman Filter for a specific asset.
     * Called automatically when the first price update is received.
     */
    initFilter(asset, initialPrice) {
        const spec = this.assets[asset];
        // Fail-safe: If tickSize missing, derive from precision
        const tickSize = spec.tickSize || Math.pow(10, -spec.precision);

        this.filters[asset] = {
            // State Vectors
            x: initialPrice,             // The estimated "Fair Price"
            P: 0.001,                    // Covariance (Uncertainty)
            
            // Previous Data (for diffs)
            lastLeader: initialPrice,    
            leaderAtLastTrade: initialPrice,
            laggerAtLastTrade: initialPrice,

            // Adaptive Params
            innovationVar: 0, 
            dynamicQ: this.BASE_Q,
            lastAnchorR: this.BASE_R,    // "Trust" level of the last trade

            // Configuration
            tickSize: tickSize,
            bounceThreshold: tickSize * 2, // Minimum move to consider "Significant"
            
            // Timing
            lastUpdateT: Date.now(),
            beta: 1.0 
        };
        this.stats[asset] = new TimeWindowStats(10000); 
    }

    /**
     * [STEP 1] PREDICTION UPDATE
     * Called when market_listener.js sends a Binance BookTicker update.
     * Use: Updates the "Fair Price" (x) based on Leader movement.
     */
    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;

        // 1. Calculate Mid-Price from Binance
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const leaderMid = (bestBid + bestAsk) / 2;
        const now = Date.now();

        // 2. Initialize if new
        if (!this.filters[asset]) {
            this.initFilter(asset, leaderMid);
            return;
        }

        const filter = this.filters[asset];
        
        // 3. Time Step Calculation (dt)
        let dt = (now - filter.lastUpdateT) / 1000;
        if (dt < 0) dt = 0; if (dt > 5) dt = 5; // Clamp to avoid massive jumps on reconnect

        // 4. Predict State (Kalman Extrapolation)
        const incrementalLeaderMove = leaderMid - filter.lastLeader;
        
        // x(t) = x(t-1) + (LeaderMove * Beta)
        filter.x = filter.x + (incrementalLeaderMove * filter.beta);
        // P(t) = P(t-1) + Q * dt
        filter.P = filter.P + (filter.dynamicQ * dt);

        filter.lastLeader = leaderMid;
        filter.lastUpdateT = now;

        // 5. CHECK FOR TRIGGER
        // We only trigger if we have a valid reference price (Last Lagger Trade)
        const referencePrice = filter.laggerAtLastTrade;
        if (referencePrice === 0) return; // Wait for at least 1 trade on Delta

        const diff = filter.x - referencePrice;

        // --- SIGMA FLOOR LOGIC (Robustness) ---
        // Calculated Sigma based on mathematical covariance
        const calculatedSigma = Math.sqrt(filter.P + filter.lastAnchorR);
        
        // SIGMA FLOOR: Minimum Noise Threshold
        // We require the gap to be at least 2 ticks to trade.
        // BTC: Tick 0.5 -> Floor 1.0 USD
        // XRP: Tick 0.0001 -> Floor 0.0002 USD
        const minSigma = filter.tickSize * 2; 
        
        const effectiveSigma = Math.max(minSigma, calculatedSigma);

        // Z-Score: How many Sigmas are we away from fair value?
        const zScore = diff / effectiveSigma;

        if (Math.abs(zScore) > this.Z_THRESHOLD) {
            await this.tryExecute(asset, zScore, filter.x, referencePrice);
        }
    }

    /**
     * [STEP 2] CORRECTION UPDATE
     * Called when trader.js receives a trade from Delta Exchange.
     * Use: Corrects the model to realign with the actual market price on Delta.
     */
    onLaggerTrade(trade) {
        const rawSymbol = trade.symbol || trade.product_symbol;
        if (!rawSymbol) return;
        const asset = Object.keys(this.assets).find(k => rawSymbol.startsWith(k));
        if (!asset || !this.filters[asset]) return;

        const tradePrice = parseFloat(trade.price);
        const tradeSize = parseFloat(trade.size || 0);
        if (isNaN(tradePrice)) return;

        const filter = this.filters[asset];
        const stat = this.stats[asset];

        // 1. Calculate Dynamic R (Whale Trust)
        // Larger trades = Lower R (We trust them more, they move the price)
        const effectiveSize = Math.max(1, tradeSize);
        const dynamicR = this.BASE_R / Math.sqrt(effectiveSize);

        // 2. Beta Update & Anchor Reset
        // Only update the anchor if the price actually moved > 2 ticks.
        // This ignores "painting the tape" or tiny wash trades.
        const moveSize = Math.abs(tradePrice - filter.laggerAtLastTrade);
        const isSignificant = moveSize >= filter.bounceThreshold;

        if (isSignificant) {
            const deltaLagger = tradePrice - filter.laggerAtLastTrade;
            const deltaLeader = filter.lastLeader - filter.leaderAtLastTrade;
            
            stat.add(deltaLeader, deltaLagger);
            filter.beta = stat.getBeta();

            // Set new Anchor
            filter.laggerAtLastTrade = tradePrice;
            filter.leaderAtLastTrade = filter.lastLeader;
            filter.lastAnchorR = dynamicR;
        } 

        // 3. Kalman Correction (Standard)
        const K = filter.P / (filter.P + dynamicR); // Kalman Gain
        const innovation = tradePrice - filter.x;   // Error

        filter.x = filter.x + K * innovation;       // Corrected Price
        filter.P = (1 - K) * filter.P;              // Reduced Uncertainty

        // 4. Adaptive Q (Process Noise Adjustment)
        // If our model is consistently wrong, increase Q to make it more responsive.
        const rawErrorSq = (innovation * innovation) / (tradePrice * tradePrice);
        filter.innovationVar = (1 - this.VAR_EMA_ALPHA) * filter.innovationVar + (this.VAR_EMA_ALPHA * rawErrorSq);
        filter.dynamicQ = this.BASE_Q * (1 + (filter.innovationVar * this.Q_SCALER));
    }

    /**
     * [STEP 3] EXECUTION
     * Places a Market Order if triggers are met.
     */
    async tryExecute(asset, zScore, fairValue, referencePrice) {
        const now = Date.now();

        // Guard: Cooldown (Prevent machine-gunning)
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        
        // Guard: Position Check (Only 1 open position per asset)
        if (this.bot.hasOpenPosition(asset)) return;

        const spec = this.assets[asset];
        let side = null;

        // Determine Direction
        if (zScore > this.Z_THRESHOLD) {
            side = 'buy'; // Fair Value > Market Price -> Undervalued -> Buy
        } else if (zScore < -this.Z_THRESHOLD) {
            side = 'sell'; // Fair Value < Market Price -> Overvalued -> Sell
        }

        if (side) {
            this.lastTriggerTime[asset] = now;
            
            // Construct Payload for Market Order (Taker)
            const payload = {
                product_id: spec.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "10", // Default contract size
                order_type: 'market_order',           // <--- TAKER MODE
                client_order_id: `k_${now}`           // Unique ID for tracking
            };
            
            // Note: limit_price and time_in_force are NOT required for market orders.
            
            this.logger.info(`[Sniper] 🔫 ${asset} ${side.toUpperCase()} (MKT) | Z:${zScore.toFixed(2)} | Gap:${(fairValue - referencePrice).toFixed(spec.precision)}`);
            
            await this.bot.placeOrder(payload);
        }
    }

    getName() { return "LeadStrategy (Sigma v13.0 - Market)"; }
    
    // Optional callback if needed later
    onPositionClose(asset) {}
}

module.exports = LeadStrategy;
            
