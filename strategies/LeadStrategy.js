/**
 * ============================================================================
 * LEAD STRATEGY: VELOCITY + TRAILING STOP
 * v8.0 [FIXED: HISTORY AMNESIA + LOCKING + TRAIL LOGIC]
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.MOVE_THRESHOLD = 0.00030;     // 0.03% price change required
        this.TIME_LOOKBACK_MS = 30;        // Compare vs price 50ms ago
        this.IMBALANCE_RATIO = 0.53;       // 60% Order Book Support required
        this.COOLDOWN_MS = 1000;           // 1s cooldown after firing
        this.TRAILING_PERCENT = 0.02;      // 0.02% Trailing Stop

        // --- ASSET SPECS ---
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

        Object.keys(this.assets).forEach(a => {
            this.priceHistory[a] = [];
            this.lastTriggerTime[a] = 0;
            this.latestStats[a] = { change: 0, imbalance: 0.5, price: 0 };
        });

        this.logger.info(`[LeadStrategy] Loaded v8.0 (History Fix). 0.02% Trail.`);
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
                
                let status = "[STABLE]";
                if (Math.abs(stats.change) > (this.MOVE_THRESHOLD * 0.5)) status = "[ACTIVITY]";
                if (Math.abs(stats.change) > this.MOVE_THRESHOLD) status = "[TRIGGER ZONE]";

                this.logger.info(`[${asset}] ${status} | Price: ${price} | Move: ${changePct}% | Imb: ${imb}`);
            });
        }, 10000);
    }

    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;
        const now = Date.now();

        const bid = parseFloat(depth.bids[0][0]);
        const bidQty = parseFloat(depth.bids[0][1]);
        const ask = parseFloat(depth.asks[0][0]);
        const askQty = parseFloat(depth.asks[0][1]);

        const currentPrice = (bid + ask) / 2;
        const totalQty = bidQty + askQty;
        const bidRatio = bidQty / totalQty; 
        const askRatio = askQty / totalQty;

        const history = this.priceHistory[asset];
        history.push({ p: currentPrice, t: now });

        // [CRITICAL FIX] Memory Retention
        // Keep 2000ms of history to handle slow feed updates (prevents 0% move errors)
        if (history.length > 200) { 
             const cutoff = now - 2000; 
             while(history.length > 10 && history[0].t < cutoff) history.shift();
        }

        const targetTime = now - this.TIME_LOOKBACK_MS;
        let pastTick = null;
        
        // Find the tick closest to (but not newer than) targetTime
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

        const priceChangePct = (currentPrice - pastTick.p) / pastTick.p;
        const relevantImbalance = priceChangePct >= 0 ? bidRatio : askRatio;

        this.latestStats[asset] = {
            change: priceChangePct,
            imbalance: relevantImbalance,
            price: currentPrice
        };

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

        // 1. Cooldown & Position Check
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        if (this.bot.hasOpenPosition(asset)) return;
        
        // 2. Lock Check (Prevents multiple orders firing at once)
        if (this.bot.isOrderInProgress) return;

        // 3. Set Lock
        this.lastTriggerTime[asset] = now;
        this.bot.isOrderInProgress = true; 

        try {
            const spec = this.assets[asset];

            // 4. Trailing Stop Calculation
            let trailDistance = price * (this.TRAILING_PERCENT / 100);
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDistance < tickSize) trailDistance = tickSize;
            
            // Format for API
            const trailAmount = trailDistance.toFixed(spec.precision);
            const clientOid = `vel_${now}_${Math.floor(Math.random() * 1000)}`;

            const payload = {
                product_id: spec.deltaId.toString(),
                side: side,
                size: (process.env.ORDER_SIZE || "1").toString(),
                order_type: 'market_order',
                client_order_id: clientOid,
                bracket_trail_amount: trailAmount,
                bracket_stop_trigger_method: 'last_traded_price' 
            };

            this.logger.info(`[Sniper] FIRE ${asset} ${side.toUpperCase()} @ ${price} | Trail: ${trailAmount}`);
            await this.bot.placeOrder(payload);

        } catch (e) {
            this.logger.error(`[EXEC ERROR] ${e.message}`);
        } finally {
            // 5. Release Lock
            this.bot.isOrderInProgress = false;
        }
    }

    onPositionClose(asset) {
        this.lastTriggerTime[asset] = 0;
        this.logger.info(`[LeadStrategy] ${asset} Closed. Cooldown Reset.`);
    }
    
    getName() { return "LeadStrategy (History Fixed)"; }
}

module.exports = LeadStrategy;
                               
