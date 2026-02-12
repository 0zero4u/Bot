/**
 * ============================================================================
 * LEAD STRATEGY: PURE MOMENTUM (VELOCITY + IMBALANCE)
 * Version: Simple v2.0
 * * Logic:
 * 1. Ignore Delta Price for triggering.
 * 2. Monitor Binance (Leader) exclusively.
 * 3. TRIGGER: If Binance Price moves > 0.03% in ~30ms.
 * 4. FILTER: Check Imbalance > 0.6 (60%) on the side of the move.
 * 5. EXECUTE: Market Order on Delta.
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.MOVE_THRESHOLD = 0.0003;     // 0.03% price change
        this.TIME_LOOKBACK_MS = 30;       // Compare vs price 30ms ago
        this.IMBALANCE_RATIO = 0.60;      // 60% Order Book Support
        this.COOLDOWN_MS = 1000;          // 1s cooldown after firing

        // --- ASSET SPECS ---
        // We only need the Delta Product ID to place orders.
        this.assets = {
            'XRP': { deltaId: 14969 }, 
            'BTC': { deltaId: 27 },    
            'ETH': { deltaId: 299 },
            'SOL': { deltaId: 417 }
        };

        // --- STATE ---
        // History: Stores recent ticks to compare 30ms ago
        // Structure: { 'BTC': [ { price: 50000, t: 17000... }, ... ] }
        this.priceHistory = {};
        
        // Cooldown Tracker
        this.lastTriggerTime = {};
        
        // Latest Stats (For Heartbeat Logging)
        this.latestStats = {};

        // Initialize State Containers
        Object.keys(this.assets).forEach(a => {
            this.priceHistory[a] = [];
            this.latestStats[a] = { change: 0, imbalance: 0.5, price: 0 };
        });

        this.logger.info(`[LeadStrategy Momentum] Loaded.`);
        this.logger.info(`> Logic: Move > ${this.MOVE_THRESHOLD*100}% in ${this.TIME_LOOKBACK_MS}ms+ | Imbalance > ${this.IMBALANCE_RATIO}`);
        
        this.startHeartbeat();
    }

    /**
     * 🟢 HEARTBEAT LOGGER (10s)
     * Shows the velocity of the market and if criteria are being met.
     */
    startHeartbeat() {
        setInterval(() => {
            this.logger.info(`--- ⚡ MARKET VELOCITY SNAPSHOT (10s) ⚡ ---`);
            
            Object.keys(this.assets).forEach(asset => {
                const stats = this.latestStats[asset];
                
                // Formatting
                const changePct = (stats.change * 100).toFixed(4);
                const imb = stats.imbalance.toFixed(2);
                const p = stats.price.toFixed(2);

                let status = "💤 STABLE";
                if (Math.abs(stats.change) > (this.MOVE_THRESHOLD * 0.5)) status = "🌊 HIGH ACTIVITY";
                if (Math.abs(stats.change) > this.MOVE_THRESHOLD) status = "🔥 THRESHOLD HIT";

                this.logger.info(
                    `[${asset}] ${status} | 30ms Move: ${changePct}% (Req ${this.MOVE_THRESHOLD*100}%) | Imb: ${imb} | Price: ${p}`
                );
            });
            this.logger.info(`----------------------------------------------`);
        }, 10000);
    }

    /**
     * Main Data Ingestion (From Binance Low Latency Stream)
     */
    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;
        
        const now = Date.now();

        // 1. Extract Current Metrics
        const bid = parseFloat(depth.bids[0][0]);
        const bidQty = parseFloat(depth.bids[0][1]);
        const ask = parseFloat(depth.asks[0][0]);
        const askQty = parseFloat(depth.asks[0][1]);

        const currentPrice = (bid + ask) / 2;
        const totalQty = bidQty + askQty;
        
        // Imbalance Ratios
        const bidRatio = bidQty / totalQty; 
        const askRatio = askQty / totalQty;

        // 2. Manage History (Point-to-Point, No Rolling Window)
        const history = this.priceHistory[asset];
        
        // Add current tick
        history.push({ p: currentPrice, t: now });

        // Prune old data (> 200ms) to keep array small and fast
        // We only need to look back 30ms, so 200ms buffer is plenty safe.
        if (history.length > 50) { // Rough cap to prevent memory leaks
             const cutoff = now - 200;
             while(history.length > 0 && history[0].t < cutoff) {
                 history.shift();
             }
        }

        // 3. Find Comparison Tick (~30ms ago)
        // We want the newest tick that is OLDER than (Now - 30ms).
        // Iterate backwards or just find()
        const targetTime = now - this.TIME_LOOKBACK_MS;
        
        // Find the specific tick that crosses the 30ms threshold
        // We look for the first tick in our buffer that is <= targetTime
        // Since array is sorted by time (pushed), we can look from start.
        let pastTick = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].t <= targetTime) {
                pastTick = history[i];
                break; // Found the most recent tick that satisfies "30ms ago"
            }
        }

        // If we don't have enough history yet (bot just started), skip.
        if (!pastTick) return;

        // 4. Calculate Velocity (Move %)
        const priceChangePct = (currentPrice - pastTick.p) / pastTick.p;

        // Update stats for heartbeat
        this.latestStats[asset] = {
            change: priceChangePct,
            imbalance: (priceChangePct > 0 ? bidRatio : askRatio), // Log the relevant side
            price: currentPrice
        };

        // 5. Check Triggers
        if (Math.abs(priceChangePct) > this.MOVE_THRESHOLD) {
            
            let side = null;

            // --- BUY SCENARIO ---
            // Price shot UP (> 0.03%) AND Order Book is Heavy on Bids (> 60%)
            if (priceChangePct > 0 && bidRatio >= this.IMBALANCE_RATIO) {
                side = 'buy';
            }
            
            // --- SELL SCENARIO ---
            // Price shot DOWN (<-0.03%) AND Order Book is Heavy on Asks (> 60%)
            else if (priceChangePct < 0 && askRatio >= this.IMBALANCE_RATIO) {
                side = 'sell';
            }

            // 6. Execute
            if (side) {
                this.logger.info(`[SIGNAL ${asset}] 🚀 VELOCITY DETECTED!`);
                this.logger.info(`> Move: ${(priceChangePct*100).toFixed(4)}% in ${now - pastTick.t}ms`);
                this.logger.info(`> Imbalance: ${(side==='buy'?bidRatio:askRatio).toFixed(2)} Support`);
                
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

        this.logger.info(`[Sniper] 🔫 FIRE ${asset} ${side.toUpperCase()} (Follow Binance Move)`);
        await this.bot.placeOrder(payload);
    }

    // --- Unused / Optional Logic ---
    onLaggerTrade(trade) {
        // We explicitly ignore Delta trades for triggering now.
        // Logic is purely Leader-driven.
    }

    onPositionClose(asset) {
        // Reset or log if needed
    }

    getName() { return "LeadStrategy (Velocity 30ms)"; }
}

module.exports = LeadStrategy;
            
