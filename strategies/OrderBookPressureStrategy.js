/**
 * OrderBookPressureStrategy.js
 * * CORE THESIS (Stanford Survey Section 6):
 * If demand (bid queue) is significantly greater than supply (ask queue), 
 * [span_4](start_span)price is expected to increase in the short term, and vice versa[span_4](end_span).
 * * IDENTICAL PAPER IMPLEMENTATION:
 * 1. [span_5](start_span)FILTRATION: De-weights orders further from mid-price using Inverse Decay[span_5](end_span).
 * 2. [span_6](start_span)[span_7](start_span)MOMENTUM: Requires 3 snapshots (It, It-1, It-2) to confirm pressure[span_6](end_span)[span_7](end_span).
 * 3. [span_8](start_span)EXECUTION: Asymmetric 50bps Take Profit and 100bps Stop Loss[span_8](end_span).
 */

class OrderBookPressureStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- PAPER HYPERPARAMETERS (Section 6.2) ---
        [span_9](start_span)[span_10](start_span)// Snapshot interval 't' used to avoid high-frequency noise[span_9](end_span)[span_10](end_span)
        this.INTERVAL_T_MS = 2000;    
        
        [span_11](start_span)[span_12](start_span)// Number of order book levels to calculate pressure (8 tested well)[span_11](end_span)[span_12](end_span)
        this.L = 8;                   
        
        [span_13](start_span)// Inverse Decay parameters: w(d) = 1 / (gamma * d + beta)[span_13](end_span)
        this.GAMMA = 100;             
        this.BETA = 1;                
        
        // --- SIGNAL LOGIC (Section 6.2) ---
        [span_14](start_span)// Absolute pressure threshold (theta_p)[span_14](end_span)
        this.THETA_P = 0.35;          
        
        // --- EXECUTION PARAMS (Section 6.3) ---
        [span_15](start_span)// Asymmetric risk/reward used in successful paper trials[span_15](end_span)
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

    getName() { return "OrderBookPressure (Paper v6.0)"; }

    /**
     * Entry point for depth updates (L2 Order Book)
     */
    async onDepthUpdate(symbol, depth) {
        if (this.isOrderInProgress || this.bot.hasOpenPosition) return;

        const now = Date.now();
        [span_16](start_span)[span_17](start_span)// Snapshots must be separated by 't' seconds to filter noise[span_16](end_span)[span_17](end_span)
        if (now - this.lastSnapshotTime < this.INTERVAL_T_MS) return;

        // 1. Calculate Mid-Market Price
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const mid = (bestBid + bestAsk) / 2;

        [span_18](start_span)[span_19](start_span)// 2. Calculate Weighted Queues (Qb and Qa)[span_18](end_span)[span_19](end_span)
        const Qb = this.calcWeightedSum(depth.bids, mid);
        const Qa = this.calcWeightedSum(depth.asks, mid);

        [span_20](start_span)[span_21](start_span)// 3. Compute Imbalance (It) using Lipton formula[span_20](end_span)[span_21](end_span)
        if (Qb + Qa === 0) return;
        const It = (Qb - Qa) / (Qb + Qa);

        [span_22](start_span)[span_23](start_span)// 4. Manage 3-Snapshot Momentum Buffer[span_22](end_span)[span_23](end_span)
        this.snapshots.push(It);
        if (this.snapshots.length > 3) this.snapshots.shift();
        this.lastSnapshotTime = now;

        // 5. Evaluate for Signal if buffer is full
        if (this.snapshots.length === 3) {
            await this.evaluateSignal(symbol, depth);
        }
    }

    /**
     * Implements Equation 4 (Section 6.2): w(d) = 1 / (gamma * d + beta)
     * [span_24](start_span)De-weights liquidity further from the spread[span_24](end_span).
     */
    calcWeightedSum(levels, mid) {
        let sum = 0;
        for (let i = 0; i < Math.min(levels.length, this.L); i++) {
            const price = parseFloat(levels[i][0]);
            const qty = parseFloat(levels[i][1]);
            const d = Math.abs(price - mid) / mid; // Percentage distance
            
            const w = 1 / (this.GAMMA * d + this.BETA);
            sum += (qty * w);
        }
        return sum;
    }

    /**
     * [span_25](start_span)[span_26](start_span)Validates Signal based on Pressure Threshold and Momentum[span_25](end_span)[span_26](end_span).
     */
    async evaluateSignal(symbol, depth) {
        const [iPrev2, iPrev1, iCurr] = this.snapshots;
        let side = null;

        [span_27](start_span)// BUY: Current pressure > threshold AND increasing/sustaining[span_27](end_span)
        if (iCurr > this.THETA_P && iCurr >= iPrev1 && iPrev1 >= iPrev2) {
            side = 'buy';
        } 
        [span_28](start_span)// SELL: Current pressure < -threshold AND decreasing (more negative)[span_28](end_span)
        else if (iCurr < -this.THETA_P && iCurr <= iPrev1 && iPrev1 <= iPrev2) {
            side = 'sell';
        }

        if (side) {
            this.logger.info(`[PAPER_SIGNAL] ${side.toUpperCase()} firing. It: ${iCurr.toFixed(4)}`);
            await this.executePaperStrategy(symbol, side, depth, iCurr);
        }
    }

    /**
     * [span_29](start_span)Strategy Execution (Section 6.3): Market entry with proportional sizing[span_29](end_span).
     */
    async executePaperStrategy(symbol, side, depth, strength) {
        this.isOrderInProgress = true;
        this.bot.isOrderInProgress = true;

        try {
            const spec = this.specs[symbol];
            const bestBid = parseFloat(depth.bids[0][0]);
            const bestAsk = parseFloat(depth.asks[0][0]);
            const entryPrice = side === 'buy' ? bestAsk : bestBid;
            
            [span_30](start_span)// Dynamic sizing proportional to signal strength[span_30](end_span)
            const baseSize = parseFloat(this.bot.config.orderSize);
            const sizeMult = 1 + (Math.abs(strength) - this.THETA_P);
            const size = (Math.floor((baseSize * sizeMult) / spec.lot) * spec.lot).toString();

            [span_31](start_span)// Calculate TP (+50bps) and SL (-100bps)[span_31](end_span)
            const tp = side === 'buy' ? entryPrice * (1 + this.TP_BPS) : entryPrice * (1 - this.TP_BPS);
            const sl = side === 'buy' ? entryPrice * (1 - this.SL_BPS) : entryPrice * (1 + this.SL_BPS);

            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                size: size,
                side: side,
                [span_32](start_span)order_type: 'limit_order', // Aggressive IOC to mimic market[span_32](end_span)
                time_in_force: 'ioc',
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
  
