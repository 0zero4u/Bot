/**
 * TickStrategy.js
 * v5.0 [HYBRID] - Deep Fusion & Momentum Gating
 * * CORE LOGIC:
 * 1. WEIGHTING: Uses Inverse Distance Weighting (from OrderBookPressure) to filter deep spoofs.
 * 2. SIGNAL: Uses Welford's Online Algorithm to track Z-Score (StdDev) of the Order Book Imbalance.
 * 3. EXECUTION: Enters on High Z-Score ONLY if Momentum is increasing (Zero-Latency Gate).
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY PARAMETERS ---
        this.ENTRY_Z = 4.0;         // Z-score trigger to enter Active Regime
        this.EXIT_Z = 2.0;          // Z-score hysteresis to return to Idle
        this.MIN_NOISE_FLOOR = 0.05; // Prevents Z-score explosion in flat markets
        this.WARMUP_TICKS = 100;    // Minimum samples before trading
        
        // --- DISTANCE WEIGHTING PARAMS (From OrderBookPressure) ---
        // Formula: w = 1 / (GAMMA * distance + BETA)
        this.GAMMA = 100;           // High gamma = heavily penalizes distance
        this.BETA = 1;              // Base weight

        // --- ASSET STATE ---
        this.assets = {};
        this.specs = {}; // Set by trader.js on init
        
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            this.assets[symbol] = {
                // Welford State (Statistical History)
                obiMean: 0,
                obiM2: 0,
                obiCount: 0,
                
                // Regime & Signal State
                currentRegime: 0, 
                lastPrice: 0,
                lastZ: 0,   // NEW: Tracks previous tick's Z-score for Momentum Gating
                isOrderInProgress: false
            };
        });
    }

    /**
     * Calculates volume weighted by DISTANCE from mid-price.
     * Replaces old Rank-based decay.
     * @param {Array} levels - Order book levels [[price, size], ...]
     * @param {Number} midPrice - Current mid price
     */
    calcWeightedVol(levels, midPrice) {
        let weightedTotal = 0;
        const limit = Math.min(levels.length, 10); // Process top 10 levels

        for (let i = 0; i < limit; i++) {
            const price = parseFloat(levels[i][0]);
            const size = parseFloat(levels[i][1]);
            
            if (isNaN(size) || isNaN(price)) continue;

            // Calculate Distance % from Mid Price
            const d = Math.abs(price - midPrice) / midPrice;
            
            // Inverse Decay: The further away, the lower the weight
            // w(d) = 1 / (100 * d + 1)
            const weight = 1 / (this.GAMMA * d + this.BETA);
            
            weightedTotal += size * weight;
        }
        return weightedTotal;
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        // 0. Validation & Mid-Price Calculation
        if (!depth.bids || !depth.asks || depth.bids.length === 0 || depth.asks.length === 0) return;
        
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const midPrice = (bestBid + bestAsk) / 2;

        if (!midPrice || bestBid >= bestAsk) return; // Ignore crossed books

        // 1. Calculate Weighted Volumes (The Fusion Logic)
        const wBidVol = this.calcWeightedVol(depth.bids, midPrice);
        const wAskVol = this.calcWeightedVol(depth.asks, midPrice);

        if (wBidVol + wAskVol === 0) return;

        // 2. Deep OBI Calculation (Directional Signal)
        const currentDeepOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        // 3. Update Welford's Algorithm (Moving Stats)
        asset.obiCount++;
        const delta = currentDeepOBI - asset.obiMean;
        asset.obiMean += delta / asset.obiCount;
        const delta2 = currentDeepOBI - asset.obiMean;
        asset.obiM2 += delta * delta2;

        // 4. Warmup Check
        if (asset.obiCount < this.WARMUP_TICKS) return;

        // 5. Calculate Standardized Signal (Z-Score)
        const variance = asset.obiM2 / (asset.obiCount - 1);
        const stdDev = Math.sqrt(variance);
        
        // Apply Noise Floor: prevents dividing by a near-zero stdDev
        const effectiveStdDev = Math.max(stdDev, this.MIN_NOISE_FLOOR);
        const zScore = (currentDeepOBI - asset.obiMean) / effectiveStdDev;

        // 6. Regime Logic with Momentum Gating
        // Pass the current Z AND the previous Z (stored in asset.lastZ)
        this.handleRegimeShift(symbol, zScore, asset.lastZ);

        // 7. Store State for Next Tick
        asset.lastZ = zScore; 
    }

    handleRegimeShift(symbol, zScore, lastZ) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);
        const absLastZ = Math.abs(lastZ);

        if (asset.currentRegime === 0) {
            // --- IDLE -> ACTIVE LOGIC ---
            if (absZ > this.ENTRY_Z) {
                
                // MOMENTUM GATE:
                // If the signal is fading (Current Z < Previous Z), DO NOT ENTER.
                // We only want to catch the "expansion" phase of the move.
                if (absZ < absLastZ) {
                    // Optional: Debug log for skipped trades
                    // this.logger.debug(`[GATE] Skipped Fading Signal: ${zScore.toFixed(2)} < ${lastZ.toFixed(2)}`);
                    return; 
                }

                // If we pass the gate, Enter Regime
                asset.currentRegime = 1;
                const side = zScore > 0 ? 'buy' : 'sell';
                this.logger.info(`[REGIME_CHANGE] IDLE -> ACTIVE | Z: ${zScore.toFixed(2)} (Growing) | Side: ${side}`);
                this.executeTrade(symbol, side, zScore);
            }
        } else {
            // --- ACTIVE -> IDLE LOGIC ---
            // Exit regime if signal drops below Hysteresis threshold
            if (absZ < this.EXIT_Z) {
                asset.currentRegime = 0;
                this.logger.info(`[REGIME_CHANGE] ACTIVE -> IDLE | Z: ${zScore.toFixed(2)}`);
            }
        }
    }

    async onTradeUpdate(symbol, trade) {
        const asset = this.assets[symbol];
        if (asset) asset.lastPrice = parseFloat(trade.p);
    }

    async executeTrade(symbol, side, score) {
        const asset = this.assets[symbol];
        
        // 1. Position & Lock Checks
        if (this.bot.isOrderInProgress) return;
        
        // Check if we already have a position in the same direction
        const pos = this.bot.getPosition(symbol);
        if (pos && ((side === 'buy' && pos > 0) || (side === 'sell' && pos < 0))) {
            return; 
        }

        try {
            const spec = this.specs[symbol];
            const price = asset.lastPrice;
            if (!price) return;

            // 2. Pricing & Trailing Stop Logic
            // Aggressive entry: mid-spread or slightly crossing
            const limitPrice = side === 'buy' ? price * 1.0005 : price * 0.9995;
            
            // Trailing Stop: 0.05% trail
            let trail = price * 0.0005; 
            if (side === 'buy') trail = -trail; // Buy trails upwards (negative offset)

            // 3. Order Placement
            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc', // Immediate or Cancel
                limit_price: limitPrice.toFixed(spec.precision),
                bracket_trail_amount: trail.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

            this.logger.info(`[EXECUTE] ${side.toUpperCase()} ${symbol} | Z: ${score.toFixed(2)} | Price: ${price}`);
        } catch (e) {
            this.logger.error(`[EXEC_ERROR] ${symbol}: ${e.message}`);
        }
    }
}

module.exports = TickStrategy;
            
