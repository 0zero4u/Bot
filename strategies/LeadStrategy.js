/**
 * ============================================================================
 * LEAD STRATEGY (LEADER-LAGGER ARBITRAGE)
 * Version: 13.2 [HEARTBEAT + FULL PRICE LOGS]
 * ============================================================================
 */

/**
 * Helper Class: TimeWindowStats
 * Tracks the correlation (Beta) between Leader and Lagger moves over a sliding window.
 */
class TimeWindowStats {
    constructor(windowMs = 5000) { 
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
        return Math.max(0.8, Math.min(1.2, beta));
    }
}

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- KALMAN FILTER HYPERPARAMETERS ---
        this.BASE_Q = 0.0000001;    
        this.BASE_R = 0.001;        
        this.Q_SCALER = 50000;      
        this.VAR_EMA_ALPHA = 0.0005;  

        // --- TRIGGER THRESHOLDS ---
        this.Z_THRESHOLD = 0.3;     
        this.COOLDOWN_MS = 200;     

        // --- ASSET SPECIFICATIONS ---
        this.assets = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 }, 
            'BTC': { deltaId: 27, precision: 1, tickSize: 0.5 },    
            'ETH': { deltaId: 299, precision: 2, tickSize: 0.05 },
            'SOL': { deltaId: 417, precision: 3, tickSize: 0.01 }
        };

        this.filters = {};          
        this.stats = {};            
        this.lastTriggerTime = {};  

        this.logger.info(`[LeadStrategy v13.2] Initialized with Full Price Logging | BTC Tick: 0.5`);

        // START THE HEARTBEAT
        this.startHeartbeat();
    }

    /**
     * [UPDATED] HEARTBEAT LOGGER
     * Runs every 10s. Now includes LEADER, FAIR, and REF prices.
     */
    startHeartbeat() {
        setInterval(() => {
            const activeAssets = Object.keys(this.filters);
            if (activeAssets.length === 0) return;

            this.logger.info(`--- 💓 STRATEGY HEARTBEAT 💓 ---`);

            activeAssets.forEach(asset => {
                const f = this.filters[asset];
                const spec = this.assets[asset];

                // 1. Re-calculate metrics
                const gap = f.x - f.laggerAtLastTrade;
                const calculatedSigma = Math.sqrt(f.P + f.lastAnchorR);
                const minSigma = f.tickSize * 2; 
                const effectiveSigma = Math.max(minSigma, calculatedSigma);
                const zScore = gap / effectiveSigma;

                // 2. Status
                let status = "WAITING";
                if (Math.abs(zScore) > this.Z_THRESHOLD) status = "🔥🔥 TRIGGERING 🔥🔥";
                else if (Math.abs(zScore) > 1.0) status = "WATCHING (Hot)";

                // 3. Format Data
                // Leader: Binance Price | Fair: Calculated Price | Ref: Delta Last Trade
                const leaderP = f.lastLeader.toFixed(spec.precision);
                const fairP = f.x.toFixed(spec.precision);
                const refP = f.laggerAtLastTrade.toFixed(spec.precision);
                
                const gapStr = gap.toFixed(spec.precision);
                const zStr = zScore.toFixed(2);
                const sigmaStr = effectiveSigma.toFixed(spec.precision + 1);

                this.logger.info(
                    `[${asset}] ${status} | L: ${leaderP} -> Fair: ${fairP} vs Ref: ${refP} | Gap: ${gapStr} | Z: ${zStr} (Req 2.0) | Sigma: ${sigmaStr}`
                );
            });
            this.logger.info(`----------------------------------`);
        }, 10000); 
    }

    initFilter(asset, initialPrice) {
        const spec = this.assets[asset];
        const tickSize = spec.tickSize || Math.pow(10, -spec.precision);

        this.filters[asset] = {
            x: initialPrice,             
            P: 0.001,                    
            lastLeader: initialPrice,    
            leaderAtLastTrade: initialPrice,
            laggerAtLastTrade: initialPrice,
            innovationVar: 0, 
            dynamicQ: this.BASE_Q,
            lastAnchorR: this.BASE_R,    
            tickSize: tickSize,
            bounceThreshold: tickSize * 2, 
            lastUpdateT: Date.now(),
            beta: 1.0 
        };
        this.stats[asset] = new TimeWindowStats(10000); 
    }

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

        const referencePrice = filter.laggerAtLastTrade;
        if (referencePrice === 0) return; 

        const diff = filter.x - referencePrice;

        const calculatedSigma = Math.sqrt(filter.P + filter.lastAnchorR);
        const minSigma = filter.tickSize * 2; 
        const effectiveSigma = Math.max(minSigma, calculatedSigma);

        const zScore = diff / effectiveSigma;

        if (Math.abs(zScore) > this.Z_THRESHOLD) {
            await this.tryExecute(asset, zScore, filter.x, referencePrice);
        }
    }

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

        const effectiveSize = Math.max(1, tradeSize);
        const dynamicR = this.BASE_R / Math.sqrt(effectiveSize);

        const moveSize = Math.abs(tradePrice - filter.laggerAtLastTrade);
        const isSignificant = moveSize >= filter.bounceThreshold;

        if (isSignificant) {
            const deltaLagger = tradePrice - filter.laggerAtLastTrade;
            const deltaLeader = filter.lastLeader - filter.leaderAtLastTrade;
            
            stat.add(deltaLeader, deltaLagger);
            filter.beta = stat.getBeta();

            filter.laggerAtLastTrade = tradePrice;
            filter.leaderAtLastTrade = filter.lastLeader;
            filter.lastAnchorR = dynamicR;
        } 

        const K = filter.P / (filter.P + dynamicR); 
        const innovation = tradePrice - filter.x;   

        filter.x = filter.x + K * innovation;       
        filter.P = (1 - K) * filter.P;              

        const rawErrorSq = (innovation * innovation) / (tradePrice * tradePrice);
        filter.innovationVar = (1 - this.VAR_EMA_ALPHA) * filter.innovationVar + (this.VAR_EMA_ALPHA * rawErrorSq);
        filter.dynamicQ = this.BASE_Q * (1 + (filter.innovationVar * this.Q_SCALER));
    }

    async tryExecute(asset, zScore, fairValue, referencePrice) {
        const now = Date.now();

        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        if (this.bot.hasOpenPosition(asset)) return;

        const spec = this.assets[asset];
        let side = null;

        if (zScore > this.Z_THRESHOLD) {
            side = 'buy'; 
        } else if (zScore < -this.Z_THRESHOLD) {
            side = 'sell'; 
        }

        if (side) {
            this.lastTriggerTime[asset] = now;
            
            const payload = {
                product_id: spec.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1", 
                order_type: 'market_order',           
                client_order_id: `k_${now}`           
            };
            
            this.logger.info(`[Sniper] 🔫 ${asset} ${side.toUpperCase()} (MKT) | Z:${zScore.toFixed(2)} | Gap:${(fairValue - referencePrice).toFixed(spec.precision)}`);
            
            await this.bot.placeOrder(payload);
        }
    }

    getName() { return "LeadStrategy (Sigma v13.2 - Prices Logged)"; }
    onPositionClose(asset) {}
}

module.exports = LeadStrategy;
    
