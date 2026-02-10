/**
 * TickStrategy.js
 * v5.5 [FIXED] - Aligned Product ID & Config with Standard Strategies
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY PARAMETERS ---
        this.ENTRY_Z = 1.5;          // Z-score trigger (Lowered for testing)
        this.EXIT_Z = 0.5;           
        this.MIN_NOISE_FLOOR = 0.05; 
        this.WARMUP_TICKS = 100;     
        
        // --- IDW PARAMS ---
        this.GAMMA = 100;            
        this.BETA = 1;               

        // --- MASTER CONFIGURATION (Aligned with other strategies) ---
        // This ensures we always have the correct ID and precision for each asset.
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        // --- ASSET STATE ---
        this.assets = {};
        
        // Load targets from env or default
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        
        targets.forEach(symbol => {
            // Normalize symbol (remove _USDT if present)
            const cleanSymbol = symbol.replace('_USDT', '');
            
            if (MASTER_CONFIG[cleanSymbol]) {
                this.assets[cleanSymbol] = {
                    config: MASTER_CONFIG[cleanSymbol], // Store static config here
                    obiMean: 0,
                    obiM2: 0,
                    obiCount: 0,
                    currentRegime: 0, 
                    midPrice: 0,      
                    lastZ: 0,   
                    lastLogTime: 0 
                };
            } else {
                this.logger.warn(`[STRATEGY] Warning: No config found for ${cleanSymbol}`);
            }
        });
    }

    /**
     * Router method required by trader.js
     */
    async execute(data) {
        if (!data || !data.type) return;

        try {
            if (data.type === 'depthUpdate') {
                // Ensure we strip '_USDT' to match our asset keys
                const cleanSymbol = data.s.replace('_USDT', '');
                await this.onDepthUpdate(cleanSymbol, data);
            } 
        } catch (e) {
            this.logger.error(`[STRATEGY] Execution Error: ${e.message}`);
        }
    }

    calcWeightedVol(levels, midPrice) {
        let weightedTotal = 0;
        const limit = Math.min(levels.length, 10); 

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
        if (!asset) return;

        if (!depth.bids || !depth.asks || depth.bids.length === 0 || depth.asks.length === 0) return;
        
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const midPrice = (bestBid + bestAsk) / 2;

        if (!midPrice || bestBid >= bestAsk) return; 

        // [CRITICAL] Store MidPrice for execution
        asset.midPrice = midPrice;

        // 1. Fusion Logic
        const wBidVol = this.calcWeightedVol(depth.bids, midPrice);
        const wAskVol = this.calcWeightedVol(depth.asks, midPrice);

        if (wBidVol + wAskVol === 0) return;

        // 2. Deep OBI Calculation
        const currentDeepOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        // 3. Welford's Algorithm
        asset.obiCount++;
        const delta = currentDeepOBI - asset.obiMean;
        asset.obiMean += delta / asset.obiCount;
        const delta2 = currentDeepOBI - asset.obiMean;
        asset.obiM2 += delta * delta2;

        if (asset.obiCount < this.WARMUP_TICKS) return;

        // 4. Z-Score
        const variance = asset.obiM2 / (asset.obiCount - 1);
        const stdDev = Math.sqrt(variance);
        const effectiveStdDev = Math.max(stdDev, this.MIN_NOISE_FLOOR);
        const zScore = (currentDeepOBI - asset.obiMean) / effectiveStdDev;

        // Heartbeat
        const now = Date.now();
        if (now - asset.lastLogTime > 4000) {
            const regimeStr = asset.currentRegime === 1 ? 'ACTIVE' : 'IDLE';
            this.logger.info(`[HEARTBEAT] ${symbol} | Z: ${zScore.toFixed(2)} | MidPrice: ${midPrice.toFixed(2)} | Regime: ${regimeStr}`);
            asset.lastLogTime = now;
        }

        this.handleRegimeShift(symbol, zScore, asset.lastZ);
        asset.lastZ = zScore; 
    }

    handleRegimeShift(symbol, zScore, lastZ) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);
        const absLastZ = Math.abs(lastZ);

        if (asset.currentRegime === 0) {
            if (absZ > this.ENTRY_Z) {
                if (absZ < absLastZ) return; 

                asset.currentRegime = 1;
                const side = zScore > 0 ? 'buy' : 'sell';
                this.logger.info(`[REGIME_CHANGE] IDLE -> ACTIVE | Z: ${zScore.toFixed(2)} | Side: ${side}`);
                this.executeTrade(symbol, side, zScore);
            }
        } else {
            if (absZ < this.EXIT_Z) {
                asset.currentRegime = 0;
                this.logger.info(`[REGIME_CHANGE] ACTIVE -> IDLE | Z: ${zScore.toFixed(2)}`);
            }
        }
    }

    async executeTrade(symbol, side, score) {
        const asset = this.assets[symbol];
        
        if (this.bot.isOrderInProgress) return;
        
        const pos = this.bot.getPosition(symbol);
        if (pos && ((side === 'buy' && pos > 0) || (side === 'sell' && pos < 0))) {
            return; 
        }

        try {
            // --- 1. GET CONFIG (Clean & Aligned) ---
            const config = asset.config;
            if (!config || !config.deltaId) {
                this.logger.error(`[CONFIG_ERROR] No ID for ${symbol}`);
                return;
            }

            // --- 2. GET PRICE ---
            const price = asset.midPrice;
            if (!price) {
                this.logger.warn(`[SKIP] Signal high but no MidPrice for ${symbol}`);
                return;
            }

            // --- 3. CALCULATE LIMITS ---
            // Aggressive limit: +/- 0.05%
            const limitPrice = side === 'buy' ? price * 1.0005 : price * 0.9995;
            
            // Trailing Stop: +/- 0.05%
            let trail = price * 0.0005; 
            if (side === 'buy') trail = -trail; 

            // --- 4. EXECUTE ---
            await this.bot.placeOrder({
                product_id: config.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc', 
                limit_price: limitPrice.toFixed(config.precision),
                bracket_trail_amount: trail.toFixed(config.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

            this.logger.info(`[EXECUTE] ${side.toUpperCase()} ${symbol} | Z: ${score.toFixed(2)} | MidPrice: ${price}`);
        } catch (e) {
            this.logger.error(`[EXEC_ERROR] ${symbol}: ${e.message}`);
        }
    }
}

module.exports = TickStrategy;
            
