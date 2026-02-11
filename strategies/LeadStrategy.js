/**
 * LeadStrategy.js
 * Version: 8.0 [TIME-WINDOW BETA + SMOOTHED ADAPTIVE Q]
 * * CRITICAL UPGRADES:
 * 1. TIME-BASED BETA WINDOW:
 * - Replaced fixed trade count (20) with time window (e.g., 10 seconds).
 * - Ensures Beta represents the "Current Market Regime" regardless of volume.
 * - High Vol = High Data Density = Robust Beta.
 * 2. SMOOTHED ADAPTIVE Q:
 * - Replaced raw error feedback with EMA of Innovation Variance.
 * - Prevents Q from exploding due to single outlier trades.
 * - Q only expands if divergence is persistent.
 */

// --- UTILITY: Time-Based Rolling Statistics ---
class TimeWindowStats {
    constructor(windowMs = 10000) { // Default 10 seconds lookback
        this.windowMs = windowMs;
        this.data = []; // Stores { x, y, t }
    }

    add(x, y) {
        const now = Date.now();
        this.data.push({ x, y, t: now });

        // Prune data older than windowMs
        // Efficient enough for HFT (Array usually < 100 items)
        while (this.data.length > 0 && (now - this.data[0].t > this.windowMs)) {
            this.data.shift();
        }
    }

    getBeta() {
        const n = this.data.length;
        // If data is sparse (quiet market), return 1.0 to be safe
        if (n < 5) return 1.0; 

        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        
        for (let i = 0; i < n; i++) {
            const p = this.data[i];
            sumX += p.x;
            sumY += p.y;
            sumXY += p.x * p.y;
            sumXX += p.x * p.x;
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
        // Clamp Beta (0.8 to 1.2) - Crypto arbs are rarely outside this
        return Math.max(0.8, Math.min(1.2, beta));
    }
}

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- ADAPTIVE PARAMETERS ---
        this.BASE_Q = 0.0000001; 
        this.BASE_R = 0.001;  
        
        // Q SCALER: Multiplier for the Innovation Variance.
        // Higher = Faster adaptation to trend changes.
        this.Q_SCALER = 50000; 

        // VARIANCE EMA ALPHA: Smoothing factor for error tracking.
        // 0.05 means we need ~20 bad trades to fully shift the regime.
        // This filters out "Shot Noise" (single outliers).
        this.VAR_EMA_ALPHA = 0.05;

        // Lagger EMA: Smoothing the Divergence signal
        this.EMA_ALPHA = 0.2; 

        // --- TRADING TRIGGERS ---
        this.ENTRY_THRESHOLD = 0.0005; 
        this.PROFIT_MARGIN = 0.0003;   
        this.COOLDOWN_MS = 200;        

        this.assets = {
            'XRP': { deltaId: 14969, precision: 4 },
            'BTC': { deltaId: 27,    precision: 1 },
            'ETH': { deltaId: 299,   precision: 2 },
            'SOL': { deltaId: 417,   precision: 3 }
        };

        this.filters = {};
        this.stats = {}; 
        this.lastTriggerTime = {};

        this.logger.info(`[LeadStrategy v8.0] Time-Window Beta & Smoothed Q Loaded.`);
    }

    initFilter(asset, initialPrice) {
        this.filters[asset] = {
            x: initialPrice,             
            P: 0.001,                    
            lastLeader: initialPrice,    
            
            // Smoothed States
            laggerEMA: initialPrice, 
            innovationVar: 0, // Variance of the prediction error
            
            // Adaptive State
            dynamicQ: this.BASE_Q,

            // Snapshots
            leaderAtLastTrade: initialPrice,
            laggerAtLastTrade: initialPrice,
            
            lastUpdateT: Date.now(),
            beta: 1.0 
        };
        // Use 10-second rolling window for Beta
        this.stats[asset] = new TimeWindowStats(10000); 
    }

    /**
     * PREDICTION (Binance)
     */
    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;

        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const leaderMid = (bestBid + bestAsk) / 2;
        const now = Date.now();

        if (!this.filters[asset]) {
            this.initFilter(asset, leaderMid);
            return;
        }

        const filter = this.filters[asset];
        
        // 1. Time Scaling
        let dt = (now - filter.lastUpdateT) / 1000;
        if (dt < 0) dt = 0; if (dt > 5) dt = 5;

        // 2. Prediction (State Extrapolation)
        const incrementalLeaderMove = leaderMid - filter.lastLeader;
        filter.x = filter.x + (incrementalLeaderMove * filter.beta);
        
        // 3. Uncertainty Update (Using Smoothed Dynamic Q)
        filter.P = filter.P + (filter.dynamicQ * dt);

        filter.lastLeader = leaderMid;
        filter.lastUpdateT = now;

        // 4. Signal Check (EMA vs Fair Value)
        const referencePrice = filter.laggerEMA;
        if (referencePrice === 0) return;

        const divergence = (filter.x - referencePrice) / referencePrice;

        if (Math.abs(divergence) > this.ENTRY_THRESHOLD) {
            await this.tryExecute(asset, divergence, filter.x, referencePrice);
        }
    }

    /**
     * CORRECTION (Delta Trade)
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

        // 1. Update Lagger EMA (Signal Smoothing)
        if (filter.laggerEMA === 0) filter.laggerEMA = tradePrice;
        else {
            filter.laggerEMA = (1 - this.EMA_ALPHA) * filter.laggerEMA + (this.EMA_ALPHA * tradePrice);
        }

        // 2. Update Beta (Time-Based Window)
        const deltaLagger = tradePrice - filter.laggerAtLastTrade;
        const deltaLeader = filter.lastLeader - filter.leaderAtLastTrade;

        if (Math.abs(deltaLeader) > 1e-8 || Math.abs(deltaLagger) > 1e-8) {
            stat.add(deltaLeader, deltaLagger);
            filter.beta = stat.getBeta();
        }

        // 3. Kalman Correction
        const effectiveSize = Math.max(1, tradeSize);
        const dynamicR = this.BASE_R / Math.sqrt(effectiveSize);

        const K = filter.P / (filter.P + dynamicR);
        const innovation = tradePrice - filter.x; 

        filter.x = filter.x + K * innovation;
        filter.P = (1 - K) * filter.P;

        // 4. ADAPTIVE Q (Smoothed Variance) [USER FIX]
        // Calculate raw normalized squared error
        const rawErrorSq = (innovation * innovation) / (tradePrice * tradePrice);
        
        // Update Variance EMA
        // If rawErrorSq is high, innovationVar rises slowly.
        filter.innovationVar = (1 - this.VAR_EMA_ALPHA) * filter.innovationVar + (this.VAR_EMA_ALPHA * rawErrorSq);
        
        // Calculate Q based on SMOOTHED Variance
        filter.dynamicQ = this.BASE_Q * (1 + (filter.innovationVar * this.Q_SCALER));

        // 5. Snapshots
        filter.laggerAtLastTrade = tradePrice;
        filter.leaderAtLastTrade = filter.lastLeader; 

        if (Math.random() < 0.05) {
            this.logger.info(`[Kalman] ${asset} β:${filter.beta.toFixed(3)} | Q:${filter.dynamicQ.toExponential(2)} | Var:${filter.innovationVar.toExponential(2)}`);
        }
    }

    async tryExecute(asset, divergence, fairValue, referencePrice) {
        const now = Date.now();
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        if (this.bot.hasOpenPosition(asset)) return;

        const spec = this.assets[asset];
        let side = null;
        let limitPrice = 0;

        if (divergence > 0) {
            side = 'buy';
            limitPrice = referencePrice * (1 + this.PROFIT_MARGIN); 
        } else if (divergence < 0) {
            side = 'sell';
            limitPrice = referencePrice * (1 - this.PROFIT_MARGIN);
        }

        if (side) {
            this.lastTriggerTime[asset] = now;
            const pScale = Math.pow(10, spec.precision);
            const finalPrice = (Math.floor(limitPrice * pScale) / pScale).toFixed(spec.precision);

            const payload = {
                product_id: spec.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "10",
                order_type: 'limit_order',
                limit_price: finalPrice,
                time_in_force: 'ioc',
                client_order_id: `k_${now}`
            };
            
            this.logger.info(`[Sniper] 🔫 ${asset} ${side.toUpperCase()} | EMA:${referencePrice.toFixed(spec.precision)} | Div:${(divergence*100).toFixed(3)}%`);
            await this.bot.placeOrder(payload);
        }
    }

    getName() { return "LeadStrategy (Adaptive v8.0)"; }
    onPositionClose(asset) {}
}

module.exports = LeadStrategy;
                
