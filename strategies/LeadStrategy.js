/**
 * ============================================================================
 * LEAD STRATEGY: PURE MOMENTUM (VELOCITY + IMBALANCE)
 * Version: Simple v3.0 [FULL VISIBILITY HEARTBEAT]
 * * Logic:
 * 1. Monitor Binance (Leader) exclusively.
 * 2. TRIGGER: If Binance Price moves > 0.03% in ~30ms.
 * 3. FILTER: Check Imbalance > 0.60 (60%) on the side of the move.
 * 4. LOGGING: 
 * - Heartbeat every 10s for ACTIVE assets only.
 * - Shows Current Price + 30ms Move % (even if 0.00%).
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.MOVE_THRESHOLD = 0.00015;     // 0.03% price change required
        this.TIME_LOOKBACK_MS = 30;       // Compare vs price 30ms ago
        this.IMBALANCE_RATIO = 0.60;      // 60% Order Book Support required
        this.COOLDOWN_MS = 1000;          // 1s cooldown after firing

        // --- ASSET SPECS ---
        this.assets = {
            'XRP': { deltaId: 14969 }, 
            'BTC': { deltaId: 27 },    
            'ETH': { deltaId: 299 },
            'SOL': { deltaId: 417 }
        };

        // --- STATE ---
        this.priceHistory = {};
        this.lastTriggerTime = {};
        
        // Latest Stats (For Heartbeat)
        this.latestStats = {};

        // Initialize State
        Object.keys(this.assets).forEach(a => {
            this.priceHistory[a] = [];
            // Initialize with price 0 so we know it's dead until data arrives
            this.latestStats[a] = { change: 0, imbalance: 0.5, price: 0 };
        });

        this.logger.info(`[LeadStrategy Momentum] Loaded.`);
        this.logger.info(`> Logic: Move > ${this.MOVE_THRESHOLD*100}% in 30ms | Imbalance > ${this.IMBALANCE_RATIO}`);
        
        this.startHeartbeat();
    }

    /**
     * 🟢 HEARTBEAT LOGGER (10s)
     * Logs the precise state of active assets so you know "everything happening".
     */
    startHeartbeat() {
        setInterval(() => {
            let activeCount = 0;

            Object.keys(this.assets).forEach(asset => {
                const stats = this.latestStats[asset];

                // 1. SKIP DEAD ASSETS
                // If price is 0, we haven't received data for this asset yet.
                if (stats.price <= 0) return; 

                activeCount++;

                // 2. Format Data
                const price = stats.price.toFixed(4); // Show 4 decimals for precision
                const changePct = (stats.change * 100).toFixed(4); // e.g. "0.0000" or "0.0421"
                const imb = stats.imbalance.toFixed(2);
                
                // 3. Determine Status Label
                let status = "💤 STABLE";
                if (Math.abs(stats.change) > (this.MOVE_THRESHOLD * 0.5)) status = "🌊 ACTIVITY";
                if (Math.abs(stats.change) > this.MOVE_THRESHOLD) status = "🔥 TRIGGER ZONE";

                // 4. Log the Line
                this.logger.info(
                    `[${asset}] ${status} | Price: ${price} | 30ms Move: ${changePct}% (Req ${this.MOVE_THRESHOLD*100}%) | Imb: ${imb}`
                );
            });

        }, 10000); // 10 seconds
    }

    /**
     * Main Data Ingestion (From Binance Low Latency Stream)
     */
    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;
        
        const now = Date.now();

        // 1. Extract Metrics
        const bid = parseFloat(depth.bids[0][0]);
        const bidQty = parseFloat(depth.bids[0][1]);
        const ask = parseFloat(depth.asks[0][0]);
        const askQty = parseFloat(depth.asks[0][1]);

        const currentPrice = (bid + ask) / 2;
        const totalQty = bidQty + askQty;
        const bidRatio = bidQty / totalQty; 
        const askRatio = askQty / totalQty;

        // 2. Manage History (30ms Buffer)
        const history = this.priceHistory[asset];
        history.push({ p: currentPrice, t: now });

        // Keep buffer small (max ~200ms worth of ticks is plenty)
        if (history.length > 50) {
             const cutoff = now - 200;
             while(history.length > 0 && history[0].t < cutoff) history.shift();
        }

        // 3. Find Comparison Tick (~30ms ago)
        const targetTime = now - this.TIME_LOOKBACK_MS;
        let pastTick = null;
        
        // Find newest tick OLDER than targetTime
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].t <= targetTime) {
                pastTick = history[i];
                break;
            }
        }

        // If no history yet, just update stats and return
        if (!pastTick) {
            this.latestStats[asset] = { change: 0, imbalance: 0.5, price: currentPrice };
            return;
        }

        // 4. Calculate Velocity
        const priceChangePct = (currentPrice - pastTick.p) / pastTick.p;
        
        // Update Stats for Heartbeat
        // We track the imbalance of the side that matters (Bid if price up, Ask if price down)
        const relevantImbalance = priceChangePct >= 0 ? bidRatio : askRatio;

        this.latestStats[asset] = {
            change: priceChangePct,
            imbalance: relevantImbalance,
            price: currentPrice
        };

        // 5. Check Triggers
        if (Math.abs(priceChangePct) > this.MOVE_THRESHOLD) {
            
            let side = null;

            // --- BUY SCENARIO ---
            // Price UP + Heavy Bids
            if (priceChangePct > 0 && bidRatio >= this.IMBALANCE_RATIO) {
                side = 'buy';
            }
            // --- SELL SCENARIO ---
            // Price DOWN + Heavy Asks
            else if (priceChangePct < 0 && askRatio >= this.IMBALANCE_RATIO) {
                side = 'sell';
            }

            // 6. Execute
            if (side) {
                this.logger.info(`[SIGNAL ${asset}] 🚀 VELOCITY DETECTED!`);
                this.logger.info(`> Move: ${(priceChangePct*100).toFixed(4)}% in ${now - pastTick.t}ms | Imb: ${relevantImbalance.toFixed(2)}`);
                await this.tryExecute(asset, side, currentPrice);
            }
        }
    }

    async tryExecute(asset, side, price) {
        const now = Date.now();
        
        // Cooldown Check
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        
        // Open Position Check
        if (this.bot.hasOpenPosition(asset)) return;

        this.lastTriggerTime[asset] = now;
        const spec = this.assets[asset];

        const payload = {
            product_id: spec.deltaId.toString(),
            side: side,
            size: process.env.ORDER_SIZE || "1",
            order_type: 'market_order',
            client_order_id: `vel_${now}`
        };

        this.logger.info(`[Sniper] 🔫 FIRE ${asset} ${side.toUpperCase()} @ ${price}`);
        await this.bot.placeOrder(payload);
    }

    // --- Unused ---
    onLaggerTrade(trade) {}
    onPositionClose(asset) {}
    getName() { return "LeadStrategy (Velocity 30ms)"; }
}

module.exports = LeadStrategy;
                         
