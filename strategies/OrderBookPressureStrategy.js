/**
 * OrderBookPressureStrategy.js
 * Optimized for Gate.io Feed (Pre-processed Snapshots)
 * * CORE THESIS (Stanford Survey Section 6):
 * If demand (bid queue) > supply (ask queue) -> Price Up.
 */

class OrderBookPressureStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- PAPER HYPERPARAMETERS (Section 6.2) ---
        // Snapshot interval 't' used to avoid high-frequency noise
        this.INTERVAL_T_MS = 2000;    
        
        // Number of order book levels to calculate pressure (8 tested well)
        this.L = 8;                   
        
        // Inverse Decay parameters: w(d) = 1 / (gamma * d + beta)
        this.GAMMA = 100;             
        this.BETA = 1;                
        
        // --- SIGNAL LOGIC (Section 6.2) ---
        // Absolute pressure threshold (theta_p)
        this.THETA_P = 0.35;          
        
        // --- EXECUTION PARAMS (Section 6.3) ---
        this.TP_BPS = 0.0050;         // 50 basis points (0.5%)
        this.SL_BPS = 0.0100;         // 100 basis points (1.0%)

        // Internal State
        this.snapshots = [];          // Buffer for [It-2, It-1, It]
        this.lastSnapshotTime = 0;
        this.isOrderInProgress = false;

        // Asset Specifics
        this.specs = {
            'BTC': { deltaId: 27, precision: 1, lot: 0.001 },
            'ETH': { deltaId: 299, precision: 2, lot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 1 }
        };
    }

    getName() { return "OrderBookPressure (Gate.io v6.1)"; }

    /**
     * Entry point for depth updates
     * Expects Normalized Snapshot: { bids: [[p,s],...], asks: [[p,s],...] }
     */
    async onDepthUpdate(symbol, depth) {
        if (this.isOrderInProgress || this.bot.hasOpenPosition) return;

        // 0. Data Validation
        if (!depth.bids || !depth.asks || depth.bids.length === 0 || depth.asks.length === 0) return;

        const now = Date.now();
        // Snapshots must be separated by 't' seconds to filter noise
        if (now - this.lastSnapshotTime < this.INTERVAL_T_MS) return;

        // 1. Calculate Mid-Market Price
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        
        // Gate.io safety: ensure we don't have a crossed book or zero data
        if (!bestBid || !bestAsk || bestBid >= bestAsk) return;
        
        const mid = (bestBid + bestAsk) / 2;

        // 2. Calculate Weighted Queues (Qb and Qa)
        const Qb = this.calcWeightedSum(depth.bids, mid);
        const Qa = this.calcWeightedSum(depth.asks, mid);

        // 3. Compute Imbalance (It) using Lipton formula
        if (Qb + Qa === 0) return;
        const It = (Qb - Qa) / (Qb + Qa);

        // 4. Manage 3-Snapshot Momentum Buffer
        this.snapshots.push(It);
        if (this.snapshots.length > 3) this.snapshots.shift();
        this.lastSnapshotTime = now;

        // 5. Evaluate for Signal if buffer is full
        if (this.snapshots.length === 3) {
            await this.evaluateSignal(symbol, depth);
        }
    }

    /**
     * Implements Equation 4: w(d) = 1 / (gamma * d + beta)
     */
    calcWeightedSum(levels, mid) {
        let sum = 0;
        // Use min of L or available levels
        const depthLevels = Math.min(levels.length, this.L);
        
        for (let i = 0; i < depthLevels; i++) {
            const price = parseFloat(levels[i][0]);
            const qty = parseFloat(levels[i][1]);
            
            // Safety
            if (isNaN(price) || isNaN(qty)) continue;

            const d = Math.abs(price - mid) / mid; // Percentage distance
            const w = 1 / (this.GAMMA * d + this.BETA);
            sum += (qty * w);
        }
        return sum;
    }

    async evaluateSignal(symbol, depth) {
        const [iPrev2, iPrev1, iCurr] = this.snapshots;
        let side = null;

        // BUY: Pressure > Threshold AND Increasing/Sustaining
        if (iCurr > this.THETA_P && iCurr >= iPrev1 && iPrev1 >= iPrev2) {
            side = 'buy';
        } 
        // SELL: Pressure < -Threshold AND Decreasing
        else if (iCurr < -this.THETA_P && iCurr <= iPrev1 && iPrev1 <= iPrev2) {
            side = 'sell';
        }

        if (side) {
            this.logger.info(`[GATE_SIGNAL] ${side.toUpperCase()} | Pressure: ${iCurr.toFixed(4)} | P1: ${iPrev1.toFixed(4)}`);
            await this.executePaperStrategy(symbol, side, depth, iCurr);
        }
    }

    async executePaperStrategy(symbol, side, depth, strength) {
        this.isOrderInProgress = true;
        this.bot.isOrderInProgress = true;

        try {
            const spec = this.specs[symbol];
            if (!spec) {
                this.logger.warn(`Unknown Asset Spec: ${symbol}`);
                return;
            }

            const bestBid = parseFloat(depth.bids[0][0]);
            const bestAsk = parseFloat(depth.asks[0][0]);
            const entryPrice = side === 'buy' ? bestAsk : bestBid;
            
            // Dynamic sizing proportional to signal strength
            const baseSize = parseFloat(this.bot.config.orderSize);
            const sizeMult = 1 + (Math.abs(strength) - this.THETA_P);
            const rawSize = baseSize * sizeMult;
            
            // Round to Lot Size
            const size = (Math.floor(rawSize / spec.lot) * spec.lot).toString();

            // Calculate TP (+50bps) and SL (-100bps)
            const tp = side === 'buy' ? entryPrice * (1 + this.TP_BPS) : entryPrice * (1 - this.TP_BPS);
            const sl = side === 'buy' ? entryPrice * (1 - this.SL_BPS) : entryPrice * (1 + this.SL_BPS);

            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                size: size,
                side: side,
                order_type: 'limit_order', 
                time_in_force: 'ioc', // Immediate or Cancel (Taker)
                limit_price: entryPrice.toFixed(spec.precision),
                bracket_take_profit_price: tp.toFixed(spec.precision),
                bracket_stop_loss_price: sl.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

            this.snapshots = []; // Reset snapshots after trade
        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.isOrderInProgress = false;
            this.bot.isOrderInProgress = false;
        }
    }

    onPositionUpdate(pos) { /* Interface Boilerplate */ }
    async onPriceUpdate(price) { /* Replaced by onDepthUpdate logic */ }
}

module.exports = OrderBookPressureStrategy;
