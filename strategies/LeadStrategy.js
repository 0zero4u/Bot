/**
 * LeadStrategy.js
 * Version: 11.0 [ROBUST SIGMA FLOOR + ANCHOR TRUST]
 * * CRITICAL FIXES:
 * 1. SIGMA FLOOR (Anti-Smugness):
 * - Problem: In calm markets, P -> 0. Sigma becomes tiny. 1 tick moves trigger Z > 2.0.
 * - Fix: Sigma = Math.max(2 * TickSize, sqrt(P + LastAnchorR)).
 * - Result: We never trigger on noise smaller than the minimum spread.
 * 2. ANCHOR TRUST:
 * - Problem: Z-Score used generic BASE_R.
 * - Fix: We store the 'dynamicR' of the Last Anchor Trade.
 * - Result: If Anchor was a Whale (Low R), we trigger sooner. If Anchor was Dust (High R), we wait for larger divergence.
 */

class TimeWindowStats {
    constructor(windowMs = 10000) { 
        this.windowMs = windowMs;
        this.data = []; 
    }
    add(x, y) {
        const now = Date.now();
        this.data.push({ x, y, t: now });
        while (this.data.length > 0 && (now - this.data[0].t > this.windowMs)) {
            this.data.shift();
        }
    }
    getBeta() {
        const n = this.data.length;
        if (n < 5) return 1.0; 
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
            const p = this.data[i];
            sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x;
        }
        const meanX = sumX / n; const meanY = sumY / n;
        let varX = 0, covXY = 0;
        for (let i = 0; i < n; i++) {
            const p = this.data[i];
            covXY += (p.x - meanX) * (p.y - meanY);
            varX += (p.x - meanX) * (p.x - meanX);
        }
        if (varX < 1e-9) return 1.0;
        let beta = covXY / varX;
        return Math.max(0.8, Math.min(1.2, beta));
    }
}

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- FILTER PARAMETERS ---
        this.BASE_Q = 0.0000001; 
        this.BASE_R = 0.001;  
        this.Q_SCALER = 50000; 
        this.VAR_EMA_ALPHA = 0.05;

        // --- STATISTICAL TRIGGERS ---
        this.Z_THRESHOLD = 2.0; 
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

        this.logger.info(`[LeadStrategy v11.0] Robust Sigma Floor & Anchor Trust.`);
    }

    initFilter(asset, initialPrice) {
        const tickSize = Math.pow(10, -this.assets[asset].precision);

        this.filters[asset] = {
            x: initialPrice,             
            P: 0.001,                    
            lastLeader: initialPrice,    
            
            // Adaptive State
            innovationVar: 0, 
            dynamicQ: this.BASE_Q,

            // Anchor States
            leaderAtLastTrade: initialPrice,
            laggerAtLastTrade: initialPrice,
            lastAnchorR: this.BASE_R, // [NEW] Trust level of the current anchor
            
            // Micro-Bounce Config
            tickSize: tickSize,
            bounceThreshold: tickSize * 2, 
            
            lastUpdateT: Date.now(),
            beta: 1.0 
        };
        this.stats[asset] = new TimeWindowStats(10000); 
    }

    /**
     * PREDICTION STEP (Binance)
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
        
        let dt = (now - filter.lastUpdateT) / 1000;
        if (dt < 0) dt = 0; if (dt > 5) dt = 5;

        const incrementalLeaderMove = leaderMid - filter.lastLeader;
        filter.x = filter.x + (incrementalLeaderMove * filter.beta);
        filter.P = filter.P + (filter.dynamicQ * dt);

        filter.lastLeader = leaderMid;
        filter.lastUpdateT = now;

        // 3. ROBUST Z-SCORE SIGNAL
        const referencePrice = filter.laggerAtLastTrade;
        if (referencePrice === 0) return;

        const diff = filter.x - referencePrice;

        // SIGMA CALCULATION [USER FIX]
        // 1. Use lastAnchorR (Trust the specific trade we anchor to)
        // 2. Floor the Sigma at 2x Tick Size to prevent "Smugness"
        const calculatedSigma = Math.sqrt(filter.P + filter.lastAnchorR);
        const minSigma = filter.tickSize * 2; // Hard floor (Spread Proxy)
        
        const effectiveSigma = Math.max(minSigma, calculatedSigma);

        const zScore = diff / effectiveSigma;

        if (Math.abs(zScore) > this.Z_THRESHOLD) {
            await this.tryExecute(asset, zScore, filter.x, referencePrice);
        }
    }

    /**
     * CORRECTION STEP (Delta Trade)
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
        const effectiveSize = Math.max(1, tradeSize);
        const dynamicR = this.BASE_R / Math.sqrt(effectiveSize);

        // 2. Micro-Bounce Rejection
        const moveSize = Math.abs(tradePrice - filter.laggerAtLastTrade);
        const isSignificant = moveSize >= filter.bounceThreshold;

        if (isSignificant) {
            const deltaLagger = tradePrice - filter.laggerAtLastTrade;
            const deltaLeader = filter.lastLeader - filter.leaderAtLastTrade;
            
            stat.add(deltaLeader, deltaLagger);
            filter.beta = stat.getBeta();

            // UPDATE ANCHOR & TRUST
            filter.laggerAtLastTrade = tradePrice;
            filter.leaderAtLastTrade = filter.lastLeader;
            filter.lastAnchorR = dynamicR; // Store the R of this anchor
        } 

        // 3. Kalman Update (Always absorb info)
        const K = filter.P / (filter.P + dynamicR);
        const innovation = tradePrice - filter.x; 

        filter.x = filter.x + K * innovation;
        filter.P = (1 - K) * filter.P;

        // 4. Adaptive Q
        const rawErrorSq = (innovation * innovation) / (tradePrice * tradePrice);
        filter.innovationVar = (1 - this.VAR_EMA_ALPHA) * filter.innovationVar + (this.VAR_EMA_ALPHA * rawErrorSq);
        filter.dynamicQ = this.BASE_Q * (1 + (filter.innovationVar * this.Q_SCALER));

        if (Math.random() < 0.05) {
            const sigma = Math.sqrt(filter.P + dynamicR);
            const z = innovation / sigma;
            this.logger.info(`[Kalman] ${asset} β:${filter.beta.toFixed(3)} | Z_inov:${z.toFixed(2)} | Sig:${isSignificant?'Y':'n'}`);
        }
    }

    async tryExecute(asset, zScore, fairValue, referencePrice) {
        const now = Date.now();
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        if (this.bot.hasOpenPosition(asset)) return;

        const spec = this.assets[asset];
        let side = null;
        let limitPrice = 0;

        // Z-Score triggers
        if (zScore > this.Z_THRESHOLD) {
            side = 'buy';
            limitPrice = referencePrice * (1 + this.PROFIT_MARGIN); 
        } else if (zScore < -this.Z_THRESHOLD) {
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
            
            this.logger.info(`[Sniper] 🔫 ${asset} ${side.toUpperCase()} | Z:${zScore.toFixed(2)} | Ref:${referencePrice}`);
            await this.bot.placeOrder(payload);
        }
    }

    getName() { return "LeadStrategy (Sigma Floor v11.0)"; }
    onPositionClose(asset) {}
}

module.exports = LeadStrategy;
            
