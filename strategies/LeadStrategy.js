/**
 * LeadStrategy.js
 * v2.0 [KALMAN FILTER + LEADER IMBALANCE + DRIFT PROTECTION]
 * * Concept:
 * 1. Prediction: Driven by Binance BookTicker (via market_listener type 'B')
 * 2. Correction: Driven by Delta Public Trades (via 'all_trades')
 * 3. Synchronization: Uses LOCAL ARRIVAL TIME to manage uncertainty.
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- KALMAN PARAMETERS ---
        // Process Noise (Q): How much we trust the Leader's move (High = Follow Leader Aggressively)
        this.Q = 0.00005; 
        // Measurement Noise (R): How much we trust the Lagger's LTP (High = Ignore Noise/Bounce)
        this.R = 0.0005;  
        // Correlation (Beta): 1.0 = Perfect Lock. 
        this.BETA = 1.0;

        // --- TRADING TRIGGERS ---
        this.ENTRY_THRESHOLD = 0.0006; // 0.06% Divergence ( Conservative)
        this.PROFIT_MARGIN = 0.0003;   // 0.03% Markup
        this.IMBALANCE_FILTER = 0.35;  // Requires 35% Order Book Imbalance to confirm
        this.COOLDOWN_MS = 400;        

        // --- STATE ---
        this.filters = {};
        this.lastTriggerTime = {};
        
        // Asset Config
        this.assets = {
            'XRP': { deltaId: 14969, precision: 4 },
            'BTC': { deltaId: 27,    precision: 1 },
            'ETH': { deltaId: 299,   precision: 2 },
            'SOL': { deltaId: 417,   precision: 3 }
        };

        this.logger.info(`[LeadStrategy] Loaded. Q:${this.Q} R:${this.R}`);
    }

    initFilter(asset, initialPrice) {
        this.filters[asset] = {
            x: initialPrice,       // The "Hidden" True Price
            P: 1.0,                // Error Covariance (Uncertainty)
            lastLeader: initialPrice,
            lastUpdateT: Date.now(),
            initialized: true
        };
    }

    /**
     * PREDICTION STEP (Driven by Binance)
     * Aligned with trader.js 'onDepthUpdate' call
     */
    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;

        // Parse Binance Data
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const bidQty  = parseFloat(depth.bids[0][1]);
        const askQty  = parseFloat(depth.asks[0][1]);
        const leaderMid = (bestBid + bestAsk) / 2;
        const now = Date.now();

        // Init if missing
        if (!this.filters[asset]) {
            this.initFilter(asset, leaderMid);
            return;
        }

        const filter = this.filters[asset];

        // 1. STALENESS CHECK (Drift Protection)
        // If we haven't seen data for 2 seconds, reset uncertainty to High
        if (now - filter.lastUpdateT > 2000) {
            filter.P = 1.0; 
        }

        // 2. KALMAN PREDICTION
        // Project State Forward: NewEst = OldEst + (LeaderChange * Beta)
        const leaderDelta = leaderMid - filter.lastLeader;
        filter.x = filter.x + (leaderDelta * this.BETA);
        
        // Update Uncertainty
        filter.P = filter.P + this.Q;
        
        // Update Memory
        filter.lastLeader = leaderMid;
        filter.lastUpdateT = now;

        // 3. CALCULATE METRICS
        const divergence = (leaderMid - filter.x) / filter.x; // % Diff
        const imbalance = (bidQty - askQty) / (bidQty + askQty); // -1 to 1

        // 4. CHECK TRIGGER
        if (Math.abs(divergence) > this.ENTRY_THRESHOLD) {
            await this.tryExecute(asset, divergence, imbalance, filter.x);
        }
    }

    /**
     * CORRECTION STEP (Driven by Delta Trades)
     * Requires 'all_trades' in trader.js
     */
    onLaggerTrade(trade) {
        const rawSymbol = trade.symbol || trade.product_symbol;
        // Map "XRPUSD" -> "XRP"
        const asset = Object.keys(this.assets).find(k => rawSymbol.startsWith(k));
        
        if (!asset || !this.filters[asset]) return;

        const tradePrice = parseFloat(trade.price);
        const filter = this.filters[asset];

        // KALMAN CORRECTION
        // K = P / (P + R)
        const K = filter.P / (filter.P + this.R);
        
        // Correction: Move Estimate towards the Trade Price
        filter.x = filter.x + K * (tradePrice - filter.x);
        
        // Reduce Uncertainty
        filter.P = (1 - K) * filter.P;

        // Debug Log (Occasional)
        if (Math.random() < 0.01) {
            this.logger.info(`[Kalman] ${asset} Trade:${tradePrice} Est:${filter.x.toFixed(4)} Gap:${(filter.x - tradePrice).toFixed(4)}`);
        }
    }

    /**
     * EXECUTION LOGIC (Blind Limit IOC)
     */
    async tryExecute(asset, divergence, imbalance, fairValue) {
        // Cooldown
        const now = Date.now();
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;

        // Check Open Position (Don't double up)
        if (this.bot.hasOpenPosition(asset)) return;

        const spec = this.assets[asset];
        let side = null;
        let limitPrice = 0;

        // BUY SIGNAL: Leader is Higher AND Book supports it
        if (divergence > 0 && imbalance > this.IMBALANCE_FILTER) {
            side = 'buy';
            limitPrice = fairValue * (1 - this.PROFIT_MARGIN);
        } 
        // SELL SIGNAL: Leader is Lower AND Book supports it
        else if (divergence < 0 && imbalance < -this.IMBALANCE_FILTER) {
            side = 'sell';
            limitPrice = fairValue * (1 + this.PROFIT_MARGIN);
        }

        if (side) {
            this.lastTriggerTime[asset] = now;
            
            // Format Price
            const pScale = Math.pow(10, spec.precision);
            const finalPrice = (Math.floor(limitPrice * pScale) / pScale).toFixed(spec.precision);

            const payload = {
                product_id: spec.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "10",
                order_type: 'limit_order',
                limit_price: finalPrice,
                time_in_force: 'ioc', // Sniping
                client_order_id: `k_${now}`
            };

            this.logger.info(`[Sniper] 🔫 ${asset} ${side.toUpperCase()} | Div:${(divergence*100).toFixed(3)}% | OBI:${imbalance.toFixed(2)} | Target:${finalPrice}`);
            
            await this.bot.placeOrder(payload);
        }
    }

    getName() { return "LeadStrategy (Kalman v2)"; }
}

module.exports = LeadStrategy;
  
