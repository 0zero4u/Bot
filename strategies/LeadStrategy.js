/**
 * ============================================================================
 * LEAD STRATEGY: VELOCITY + TRAILING STOP (v5.0 Corrected)
 * 1. Logic: Move > 0.03% in 50ms + 60% Imbalance
 * 2. Exit: Trailing Stop 0.02% (Calculated via Precision)
 * 3. Safety: Async Lock + Random OID + Cooldown
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.MOVE_THRESHOLD = 0.00025;     // 0.03% price change required
        this.TIME_LOOKBACK_MS = 30;        // Compare vs price 50ms ago
        this.IMBALANCE_RATIO = 0.60;       // 60% Order Book Support required
        this.COOLDOWN_MS = 1000;           // 1s cooldown after firing
        this.TRAILING_PERCENT = 0.02;      // 0.02% Trailing Stop

        // --- ASSET SPECS (Copied Precision from MicroStrategy) ---
        this.assets = {
            'XRP': { deltaId: 14969, precision: 4 }, 
            'BTC': { deltaId: 27,    precision: 1 },    
            'ETH': { deltaId: 299,   precision: 2 },
            'SOL': { deltaId: 417,   precision: 3 }
        };

        // --- STATE ---
        this.priceHistory = {};
        this.lastTriggerTime = {};
        this.latestStats = {};

        // Initialize State
        Object.keys(this.assets).forEach(a => {
            this.priceHistory[a] = [];
            this.lastTriggerTime[a] = 0;
            this.latestStats[a] = { change: 0, imbalance: 0.5, price: 0 };
        });

        this.logger.info(`[LeadStrategy] Loaded (v5.0). 0.02% Trailing Stop Active.`);
        this.startHeartbeat();
    }

    startHeartbeat() {
        setInterval(() => {
            Object.keys(this.assets).forEach(asset => {
                const stats = this.latestStats[asset];
                if (stats.price <= 0) return; 

                const price = stats.price.toFixed(4);
                const changePct = (stats.change * 100).toFixed(4);
                const imb = stats.imbalance.toFixed(2);
                
                let status = "攄 STABLE";
                if (Math.abs(stats.change) > (this.MOVE_THRESHOLD * 0.5)) status = "穴 ACTIVITY";
                if (Math.abs(stats.change) > this.MOVE_THRESHOLD) status = "櫨 TRIGGER ZONE";

                this.logger.info(`[${asset}] ${status} | Price: ${price} | Move: ${changePct}% | Imb: ${imb}`);
            });
        }, 10000);
    }

    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;
        const now = Date.now();

        // 1. Parse Data
        const bid = parseFloat(depth.bids[0][0]);
        const bidQty = parseFloat(depth.bids[0][1]);
        const ask = parseFloat(depth.asks[0][0]);
        const askQty = parseFloat(depth.asks[0][1]);

        const currentPrice = (bid + ask) / 2;
        const totalQty = bidQty + askQty;
        const bidRatio = bidQty / totalQty; 
        const askRatio = askQty / totalQty;

        // 2. Manage History
        const history = this.priceHistory[asset];
        history.push({ p: currentPrice, t: now });

        if (history.length > 50) {
             const cutoff = now - 200;
             while(history.length > 0 && history[0].t < cutoff) history.shift();
        }

        // 3. Find Comparison Tick
        const targetTime = now - this.TIME_LOOKBACK_MS;
        let pastTick = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].t <= targetTime) {
                pastTick = history[i];
                break;
            }
        }

        if (!pastTick) {
            this.latestStats[asset] = { change: 0, imbalance: 0.5, price: currentPrice };
            return;
        }

        // 4. Calculate Stats
        const priceChangePct = (currentPrice - pastTick.p) / pastTick.p;
        const relevantImbalance = priceChangePct >= 0 ? bidRatio : askRatio;

        this.latestStats[asset] = {
            change: priceChangePct,
            imbalance: relevantImbalance,
            price: currentPrice
        };

        // 5. Check Triggers
        if (Math.abs(priceChangePct) > this.MOVE_THRESHOLD) {
            let side = null;
            if (priceChangePct > 0 && bidRatio >= this.IMBALANCE_RATIO) side = 'buy';
            else if (priceChangePct < 0 && askRatio >= this.IMBALANCE_RATIO) side = 'sell';

            if (side) {
                await this.tryExecute(asset, side, currentPrice);
            }
        }
    }

    async tryExecute(asset, side, price) {
        const now = Date.now();

        // [SAFETY 1] Cooldown Check
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        
        // [SAFETY 2] Overlap Lock (CRITICAL ADDITION)
        if (this.bot.isOrderInProgress) return;
        
        // [SAFETY 3] Existing Position Check
        if (this.bot.hasOpenPosition(asset)) return;

        // Set Locks
        this.lastTriggerTime[asset] = now;
        this.bot.isOrderInProgress = true; // Lock the bot

        try {
            const spec = this.assets[asset];

            // --- TRAILING STOP LOGIC (From MicroStrategy) ---
            // 1. Calculate Distance
            let trailDistance = price * (this.TRAILING_PERCENT / 100);
            
            // 2. Enforce Tick Size
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDistance < tickSize) trailDistance = tickSize;

            // 3. Format String
            const trailAmount = trailDistance.toFixed(spec.precision);

            // 4. Generate Robust ID
            const clientOid = `vel_${now}_${Math.floor(Math.random() * 1000)}`;

            const payload = {
                product_id: spec.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'market_order',
                client_order_id: clientOid,
                // Bracket Parameters
                bracket_trail_amount: trailAmount,
                bracket_stop_trigger_method: 'last_traded_price' 
            };

            this.logger.info(`[Sniper] 鉢 FIRE ${asset} ${side.toUpperCase()} @ ${price} | Trail: ${trailAmount}`);
            await this.bot.placeOrder(payload);

        } catch (e) {
            this.logger.error(`[EXEC ERROR] ${e.message}`);
        } finally {
            // [CRITICAL] Release Lock
            this.bot.isOrderInProgress = false;
        }
    }

    onLaggerTrade(trade) {}
    
    // Reset timer immediately on close so we can re-enter
    onPositionClose(asset) {
        this.lastTriggerTime[asset] = 0;
        this.logger.info(`[LeadStrategy] ${asset} Closed. Cooldown Reset.`);
    }
    
    getName() { return "LeadStrategy (Velocity + Trail)"; }
}

module.exports = LeadStrategy;
                
