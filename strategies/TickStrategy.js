/**
 * TickStrategy.js
 * v4.0 [PRODUCTION] - Deep Fusion & Depth-Weighted Stability
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- PARAMETERS ---
        this.DECAY_RATE = 0.5;      // Higher = Focus on top of book (0.5 = aggressive)
        this.ENTRY_Z = 4.0;         // Z-score to enter Active Regime
        this.EXIT_Z = 2.0;          // Z-score to return to Idle (Hysteresis)
        this.MIN_NOISE_FLOOR = 0.05; // Prevents Z-score explosion in flat markets
        this.WARMUP_TICKS = 100;    // Minimum samples before trading
        
        // --- ASSET STATE ---
        this.assets = {};
        this.specs = {}; // Set by trader.js on init
        
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            this.assets[symbol] = {
                // Welford State
                obiMean: 0,
                obiM2: 0,
                obiCount: 0,
                
                // Regime State
                currentRegime: 0, 
                lastPrice: 0,
                isOrderInProgress: false
            };
        });
    }

    /**
     * Exponentially weights volume by depth level.
     * Level 0 = 100%, Level 1 = 60%, Level 2 = 36%...
     */
    calcWeightedVol(levels) {
        let weightedTotal = 0;
        const limit = Math.min(levels.length, 10); // Process top 10 levels

        for (let i = 0; i < limit; i++) {
            const item = levels[i];
            const size = parseFloat(Array.isArray(item) ? item[1] : item.s);
            if (isNaN(size)) continue;

            const weight = Math.exp(-this.DECAY_RATE * i);
            weightedTotal += size * weight;
        }
        return weightedTotal;
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        // 1. Calculate Weighted Volumes (The Fusion)
        const wBidVol = this.calcWeightedVol(depth.bids);
        const wAskVol = this.calcWeightedVol(depth.asks);

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

        // 6. Regime Logic with Hysteresis (Prevents Flipping)
        this.handleRegimeShift(symbol, zScore);
    }

    handleRegimeShift(symbol, zScore) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);

        if (asset.currentRegime === 0) {
            // IDLE -> ACTIVE
            if (absZ > this.ENTRY_Z) {
                asset.currentRegime = 1;
                const side = zScore > 0 ? 'buy' : 'sell';
                this.logger.info(`[REGIME_CHANGE] IDLE -> ACTIVE | Z: ${zScore.toFixed(2)} | Side: ${side}`);
                this.executeTrade(symbol, side, zScore);
            }
        } else {
            // ACTIVE -> IDLE
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
            const limitPrice = side === 'buy' ? price * 1.0005 : price * 0.9995;
            let trail = price * 0.0005; // 0.05% trail
            if (side === 'buy') trail = -trail; // Buy trails upwards (negative offset)

            // 3. Order Placement
            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc',
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
        
