/**
 * TickStrategy.js
 * v9.2 [PERCENTAGE TRAIL NORMALIZED]
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY PARAMETERS ---
        this.DECAY_ALPHA = 0.5;
        this.WELFORD_ALPHA = 0.02;
        this.ENTRY_Z = 3.3;
        this.EXIT_Z = 0.5;
        this.MIN_NOISE_FLOOR = 0.05;
        this.WARMUP_TICKS = 600; 
        
        // --- RISK SETTINGS (NORMALIZED) ---
        // 0.02% = 0.0002. Example: BTC 96000 * 0.0002 = $19.2 trail
        this.TRAIL_PERCENT = 0.0002; 

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
                    obiVariance: 0,
                    obiCount: 0,
                    currentRegime: 0,
                    regimeSide: null,
                    midPrice: 0,
                    avgSpread: 0,
                    lastZ: 0,
                    lastLogTime: 0
                };
            }
        });
    }

    getName() {
        return "TickStrategy v9.2 (Percentage Trail)";
    }

    onPositionClose(symbol) {
        if (this.assets[symbol]) {
            this.assets[symbol].currentRegime = 0;
            this.assets[symbol].regimeSide = null;
            this.logger.info(`[STRATEGY] ${symbol} Position Closed -> Regime Reset.`);
        }
    }

    async execute(data) {
        if (!data || !data.type) return;
        try {
            if (data.type === 'depthUpdate') {
                const cleanSymbol = data.s.replace('_USDT', '');
                await this.onDepthUpdate(cleanSymbol, data);
            }
        } catch (e) {
            this.logger.error(`[STRATEGY] Execution Error: ${e.message}`);
        }
    }

    calcNormalizedVol(levels, pureMidPrice, tickSize) {
        let weightedTotal = 0;
        const limit = Math.min(levels.length, 10);

        for (let i = 0; i < limit; i++) {
            const price = parseFloat(levels[i][0]);
            const size = parseFloat(levels[i][1]);
            if (isNaN(size) || isNaN(price)) continue;

            const dist = Math.abs(price - pureMidPrice);
            const ticksAway = dist / tickSize;
            const weight = Math.exp(-this.DECAY_ALPHA * ticksAway);

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
        if (bestBid >= bestAsk) return;

        const bestBidSize = parseFloat(depth.bids[0][1]);
        const bestAskSize = parseFloat(depth.asks[0][1]);

        const pureMid = (bestBid + bestAsk) / 2;
        const microprice = (bestAsk * bestBidSize + bestBid * bestAskSize) / (bestBidSize + bestAskSize);
        const spread = bestAsk - bestBid;
        
        asset.midPrice = microprice; 

        if (asset.avgSpread === 0) asset.avgSpread = spread;
        else asset.avgSpread = (asset.avgSpread * 0.99) + (spread * 0.01);

        const wBidVol = this.calcNormalizedVol(depth.bids, pureMid, asset.config.tickSize);
        const wAskVol = this.calcNormalizedVol(depth.asks, pureMid, asset.config.tickSize);

        if (wBidVol + wAskVol === 0) return;

        const currentOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        if (asset.obiCount === 0) {
            asset.obiMean = currentOBI;
            asset.obiVariance = 0;
            asset.obiCount = 1;
        } else {
            const delta = currentOBI - asset.obiMean;
            asset.obiMean += this.WELFORD_ALPHA * delta;
            
            asset.obiVariance =
                (1 - this.WELFORD_ALPHA) * asset.obiVariance +
                this.WELFORD_ALPHA * delta * delta;

            asset.obiCount++;
        }

        if (asset.obiCount < this.WARMUP_TICKS) {
            if (asset.obiCount % 50 === 0) {
                this.logger.info(`[WARMUP] ${symbol} Gathering Data: ${asset.obiCount}/${this.WARMUP_TICKS}`);
            }
            return;
        }

        const stdDev = Math.sqrt(asset.obiVariance);
        const effectiveStdDev = Math.max(stdDev, this.MIN_NOISE_FLOOR);
        const zScore = (currentOBI - asset.obiMean) / effectiveStdDev;

        const now = Date.now();
        if (now - asset.lastLogTime > 4000) {
            this.logger.info(
                `[HEARTBEAT] ${symbol} | Z: ${zScore.toFixed(2)} | OBI: ${currentOBI.toFixed(3)} | Vol: ${effectiveStdDev.toFixed(4)}`
            );
            asset.lastLogTime = now;
        }

        this.handleRegime(symbol, zScore, spread, asset.avgSpread, currentOBI, bestBid, bestAsk);
        asset.lastZ = zScore;
    }

    handleRegime(symbol, zScore, spread, avgSpread, currentOBI, bestBid, bestAsk) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);

        let dynamicEntry = this.ENTRY_Z;
        if (spread > avgSpread * 2) {
            dynamicEntry = this.ENTRY_Z * 1.5;
        }

        const signFlipped = asset.lastZ !== 0 && Math.sign(zScore) !== Math.sign(asset.lastZ);

        if (asset.currentRegime === 0) {
            if (absZ > dynamicEntry) {
                const side = zScore > 0 ? 'buy' : 'sell';

                asset.currentRegime = 1;
                asset.regimeSide = side;

                this.logger.info(`[SNIPER] ${symbol} ${side.toUpperCase()} | Z: ${zScore.toFixed(2)}`);
                this.executeTrade(symbol, side, bestBid, bestAsk, spread);
            }
        } else {
            if (absZ < this.EXIT_Z || signFlipped) {
                asset.currentRegime = 0;
                asset.regimeSide = null;
                this.logger.info(`[COOLDOWN] ${symbol} | Regime Reset (Exit or Flip)`);
            }
        }
    }

    async executeTrade(symbol, side, bestBid, bestAsk, spread) {
        if (this.bot.isOrderInProgress) return;
        if (this.bot.hasOpenPosition(symbol)) return;

        try {
            const asset = this.assets[symbol];
            const clientOid = `${symbol}_${Date.now()}`;
            
            // --- PERCENTAGE BASED NORMALIZATION ---
            // Estimate entry price (Market Order)
            const executionPrice = side === 'buy' ? bestAsk : bestBid;
            
            // Calculate raw trail distance based on 0.02% of price
            let rawTrail = executionPrice * this.TRAIL_PERCENT; 
            
            // Round to nearest valid Tick Size (Ceiling to avoid "0" on super low volatility)
            // Example: XRP 2.50 * 0.0002 = 0.0005. tickSize is 0.0001. Result 0.0005.
            let trail = Math.ceil(rawTrail / asset.config.tickSize) * asset.config.tickSize;

            // Safety: Ensure we never go below 1 tick or a safe minimum
            const minSafeTrail = asset.config.tickSize * 2; 
            if (trail < minSafeTrail) trail = minSafeTrail;

            const trailAmount = trail.toFixed(asset.config.precision);
            
            this.bot.recordOrderPunch(clientOid);

            await this.bot.placeOrder({
                product_id: asset.config.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'market_order', 
                time_in_force: 'ioc', 
                client_order_id: clientOid,
                bracket_trail_amount: trailAmount, // Normalized 0.02%
                bracket_stop_trigger_method: 'mark_price'
            });

            this.logger.info(`[EXECUTE] ${side.toUpperCase()} MARKET | Trail: ${trailAmount} (${(this.TRAIL_PERCENT*100).toFixed(3)}%)`);

        } catch (e) {
            this.logger.error(`[EXEC_ERROR] ${symbol}: ${e.message}`);
        }
    }
}

module.exports = TickStrategy;
                    
