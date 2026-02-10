/**
 * TickStrategy.js
 * v5.3 [FIXED] - Added 'execute()' Entry Point & Heartbeat
 * * CORE LOGIC:
 * 1. WEIGHTING: Uses Inverse Distance Weighting to filter deep spoofs.
 * 2. SIGNAL: Uses Welford's Online Algorithm to track Z-Score.
 * 3. EXECUTION: Enters on High Z-Score ONLY if Momentum is increasing.
 * 4. COMPATIBILITY: Added execute() to route data from trader.js.
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
        
        // --- DISTANCE WEIGHTING PARAMS ---
        this.GAMMA = 100;           
        this.BETA = 1;              

        // --- ASSET STATE ---
        this.assets = {};
        this.specs = {}; 
        
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            this.assets[symbol] = {
                // Welford State
                obiMean: 0,
                obiM2: 0,
                obiCount: 0,
                
                // Regime & Signal State
                currentRegime: 0, 
                lastPrice: 0,
                lastZ: 0,
                
                // Logging State
                lastLogTime: 0 
            };
        });
    }

    /**
     * [CRITICAL FIX] Entry Point for trader.js
     * This method routes the raw WebSocket data to the correct logic.
     */
    async execute(data) {
        if (!data) return;

        // 1. Map 'depthUpdate' or 'orderBook' to onDepthUpdate
        // Adjust 'type' string based on exactly what your market-1 process sends.
        // Common types: 'depth', 'depthUpdate', 'book', 'ticker'
        if (data.type === 'depth' || data.type === 'depthUpdate' || data.bids) {
            // If data comes wrapped (e.g. data.payload), unwrap it here
            const symbol = data.symbol || data.product_id; 
            await this.onDepthUpdate(symbol, data);
        }
        // 2. Map 'trade' to onTradeUpdate
        else if (data.type === 'trade') {
            await this.onTradeUpdate(data.symbol, data);
        }
    }

    calcWeightedVol(levels, midPrice) {
        let weightedTotal = 0;
        const limit = Math.min(levels.length, 10); // Process top 10 levels

        for (let i = 0; i < limit; i++) {
            const price = parseFloat(levels[i][0]);
            const size = parseFloat(levels[i][1]);
            
            if (isNaN(size) || isNaN(price)) continue;

            const d = Math.abs(price - midPrice) / midPrice;
            const weight = 1 / (this.GAMMA * d + this.BETA);
            weightedTotal += size * weight;
        }
        return weightedTotal;
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        
        // Auto-register asset if it's new (handles dynamic symbols)
        if (!asset) {
             // Optional: Initialize new asset state if needed
             return; 
        }

        // 0. Validation
        if (!depth.bids || !depth.asks || depth.bids.length === 0 || depth.asks.length === 0) return;
        
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const midPrice = (bestBid + bestAsk) / 2;

        if (!midPrice || bestBid >= bestAsk) return; 

        // 1. Calculate Weighted Volumes
        const wBidVol = this.calcWeightedVol(depth.bids, midPrice);
        const wAskVol = this.calcWeightedVol(depth.asks, midPrice);

        if (wBidVol + wAskVol === 0) return;

        // 2. Deep OBI Calculation
        const currentDeepOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        // 3. Update Welford's Algorithm
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
        
        const effectiveStdDev = Math.max(stdDev, this.MIN_NOISE_FLOOR);
        const zScore = (currentDeepOBI - asset.obiMean) / effectiveStdDev;

        // --- HEARTBEAT LOG (Every 4s) ---
        const now = Date.now();
        if (now - asset.lastLogTime > 4000) {
            const regimeStr = asset.currentRegime === 1 ? 'ACTIVE' : 'IDLE';
            this.logger.info(`[HEARTBEAT] ${symbol} | Z: ${zScore.toFixed(2)} | Price: ${midPrice.toFixed(2)} | Regime: ${regimeStr}`);
            asset.lastLogTime = now;
        }

        // 6. Regime Logic
        this.handleRegimeShift(symbol, zScore, asset.lastZ);

        // 7. Store State
        asset.lastZ = zScore; 
    }

    handleRegimeShift(symbol, zScore, lastZ) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);
        const absLastZ = Math.abs(lastZ);

        if (asset.currentRegime === 0) {
            // IDLE -> ACTIVE
            if (absZ > this.ENTRY_Z) {
                // Momentum Gate
                if (absZ < absLastZ) return; 

                asset.currentRegime = 1;
                const side = zScore > 0 ? 'buy' : 'sell';
                this.logger.info(`[REGIME_CHANGE] IDLE -> ACTIVE | Z: ${zScore.toFixed(2)} (Growing) | Side: ${side}`);
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
        if (asset) asset.lastPrice = parseFloat(trade.p || trade.price);
    }

    async executeTrade(symbol, side, score) {
        const asset = this.assets[symbol];
        if (this.bot.isOrderInProgress) return;
        
        const pos = this.bot.getPosition(symbol);
        if (pos && ((side === 'buy' && pos > 0) || (side === 'sell' && pos < 0))) return; 

        try {
            const spec = this.specs[symbol] || { deltaId: 14969, precision: 4 }; // Fallback
            const price = asset.lastPrice;
            if (!price) return;

            const limitPrice = side === 'buy' ? price * 1.0005 : price * 0.9995;
            let trail = price * 0.0005; 
            if (side === 'buy') trail = -trail; 

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
            
