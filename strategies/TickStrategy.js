/**
 * TickStrategy.js
 * v6.1 [NORMALIZED CLIFF]
 * Use Tick-Based Decay to ensure identical behavior on BTC & XRP.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY PARAMETERS ---
        // ALPHA controls the steepness per TICK, not per percentage.
        // 0.2 = Gentle Slope (Depth matters)
        // 0.5 = Sharp Cliff (Scalping / Sniping)
        // 0.8 = Best Bid/Ask Only
        this.ALPHA = 0.5;
        
        this.ENTRY_Z = 2.0;          
        this.EXIT_Z = 0.5;           
        this.MIN_NOISE_FLOOR = 0.05; 
        this.WARMUP_TICKS = 50;      
        
        // --- MASTER CONFIGURATION ---
        // We use 'tickSize' to normalize the distance
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};
        
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            const cleanSymbol = symbol.replace('_USDT', '');
            if (MASTER_CONFIG[cleanSymbol]) {
                this.assets[cleanSymbol] = {
                    config: MASTER_CONFIG[cleanSymbol],
                    obiMean: 0,
                    obiM2: 0,
                    obiCount: 0,
                    currentRegime: 0,
                    midPrice: 0,      
                    lastZ: 0,   
                    lastLogTime: 0 
                };
            }
        });
    }

    async execute(data) {
        if (data && data.type === 'depthUpdate') {
            const cleanSymbol = data.s.replace('_USDT', '');
            await this.onDepthUpdate(cleanSymbol, data);
        }
    }

    /**
     * NORMALIZED EXPONENTIAL DECAY
     * w = e^(-alpha * ticks_away)
     */
    calcNormalizedVol(levels, midPrice, tickSize) {
        let weightedTotal = 0;
        const limit = Math.min(levels.length, 10); 

        for (let i = 0; i < limit; i++) {
            const price = parseFloat(levels[i][0]);
            const size = parseFloat(levels[i][1]);
            
            if (isNaN(size) || isNaN(price)) continue;

            // 1. Calculate Absolute Distance
            const dist = Math.abs(price - midPrice);

            // 2. Normalize to Ticks (How many steps away?)
            // e.g. XRP: Dist 0.0002 / Tick 0.0001 = 2 ticks away
            const ticksAway = dist / tickSize;

            // 3. Apply Normalized Decay
            // Level 1 (~0.5 ticks) -> e^-0.25 = 0.77
            // Level 10 (~10 ticks) -> e^-5.0 = 0.006 (Ignored)
            const weight = Math.exp(-this.ALPHA * ticksAway);
            
            weightedTotal += size * weight;
        }
        return weightedTotal;
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        if (!depth.bids.length || !depth.asks.length) return;
        
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const midPrice = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;

        if (bestBid >= bestAsk) return; 

        asset.midPrice = midPrice;

        // --- 1. Normalized Volume Calculation ---
        // Pass tickSize to the calculator
        const wBidVol = this.calcNormalizedVol(depth.bids, midPrice, asset.config.tickSize);
        const wAskVol = this.calcNormalizedVol(depth.asks, midPrice, asset.config.tickSize);

        if (wBidVol + wAskVol === 0) return;

        // --- 2. Signal Generation ---
        const currentOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        // --- 3. Welford's Stats ---
        asset.obiCount++;
        const delta = currentOBI - asset.obiMean;
        asset.obiMean += delta / asset.obiCount;
        const delta2 = currentOBI - asset.obiMean;
        asset.obiM2 += delta * delta2;

        if (asset.obiCount < this.WARMUP_TICKS) return;

        const variance = asset.obiM2 / (asset.obiCount - 1);
        const stdDev = Math.sqrt(variance);
        const effectiveStdDev = Math.max(stdDev, this.MIN_NOISE_FLOOR);
        const zScore = (currentOBI - asset.obiMean) / effectiveStdDev;

        // Heartbeat
        const now = Date.now();
        if (now - asset.lastLogTime > 4000) {
            this.logger.info(`[HEARTBEAT] ${symbol} | Z: ${zScore.toFixed(2)} | OBI: ${currentOBI.toFixed(3)}`);
            asset.lastLogTime = now;
        }

        this.handleRegime(symbol, zScore, spread);
    }

    handleRegime(symbol, zScore, spread) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);

        if (asset.currentRegime === 0) {
            if (absZ > this.ENTRY_Z) {
                asset.currentRegime = 1;
                const side = zScore > 0 ? 'buy' : 'sell';
                this.logger.info(`[CLIFF_ENTRY] ${symbol} ${side} | Z: ${zScore.toFixed(2)}`);
                this.executeTrade(symbol, side, spread);
            }
        } else {
            if (absZ < this.EXIT_Z) {
                asset.currentRegime = 0;
                this.logger.info(`[RESET] ${symbol} Z-Score normalized.`);
            }
        }
    }

    async executeTrade(symbol, side, spread) {
        if (this.bot.isOrderInProgress) return;
        const pos = this.bot.getPosition(symbol);
        if (pos && pos !== 0) return;

        try {
            const asset = this.assets[symbol];
            const price = asset.midPrice;
            
            // Smart Limit: 20% into the spread (Aggressive Maker)
            const offset = spread * 0.2; 
            let limitPrice = side === 'buy' ? price + offset : price - offset;
            limitPrice = parseFloat(limitPrice.toFixed(asset.config.precision));

            // Tight Trailing Stop for Sniper Mode
            let trail = spread * 2.5; 
            if (side === 'buy') trail = -trail;

            await this.bot.placeOrder({
                product_id: asset.config.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc', 
                limit_price: limitPrice.toString(),
                bracket_trail_amount: trail.toFixed(asset.config.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

        } catch (e) {
            this.logger.error(`[EXEC_ERROR] ${symbol}: ${e.message}`);
        }
    }
}

module.exports = TickStrategy;
                                               
