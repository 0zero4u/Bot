
/**
 * TickStrategy.js
 * v8.1 [CORRECTED & SAFE]
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY PARAMETERS ---
        this.DECAY_ALPHA = 0.5;
        this.WELFORD_ALPHA = 0.02;
        this.ENTRY_Z = 2.5;
        this.EXIT_Z = 0.5;
        this.MIN_NOISE_FLOOR = 0.05;
        this.WARMUP_TICKS = 1000; 

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
        return "TickStrategy v8.1";
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

    // [FIX 1] Use Pure MidPrice for Distance to prevent Feedback Loop
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

        // Standard Mid (For Math)
        const pureMid = (bestBid + bestAsk) / 2;
        
        // Microprice (For Signal)
        const microprice =
            (bestAsk * bestBidSize + bestBid * bestAskSize) /
            (bestBidSize + bestAskSize);

        const spread = bestAsk - bestBid;
        asset.midPrice = microprice; // Store microprice for display/logging

        if (asset.avgSpread === 0) asset.avgSpread = spread;
        else asset.avgSpread = (asset.avgSpread * 0.99) + (spread * 0.01);

        // [FIX 1 Applied] Pass pureMid, not microprice
        const wBidVol = this.calcNormalizedVol(depth.bids, pureMid, asset.config.tickSize);
        const wAskVol = this.calcNormalizedVol(depth.asks, pureMid, asset.config.tickSize);

        if (wBidVol + wAskVol === 0) return;

        const currentOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        // --- FIXED EMA VARIANCE UPDATE ---
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

        if (asset.obiCount < this.WARMUP_TICKS) return;

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

        const signFlipped =
            asset.lastZ !== 0 &&
            Math.sign(zScore) !== Math.sign(asset.lastZ);

        if (asset.currentRegime === 0) {
            if (absZ > dynamicEntry) {
                const side = zScore > 0 ? 'buy' : 'sell';

                asset.currentRegime = 1;
                asset.regimeSide = side;

                this.logger.info(
                    `[SNIPER] ${symbol} ${side.toUpperCase()} | Z: ${zScore.toFixed(2)}`
                );

                this.executeTrade(symbol, side, bestBid, bestAsk, spread);
            }
        } else {
            if (absZ < this.EXIT_Z || signFlipped) {
                asset.currentRegime = 0;
                asset.regimeSide = null;

                this.logger.info(
                    `[COOLDOWN] ${symbol} | Regime Reset (Exit or Flip)`
                );
            }
        }
    }

    async executeTrade(symbol, side, bestBid, bestAsk, spread) {
        if (this.bot.isOrderInProgress) return;

        const pos = this.bot.getPosition(symbol);
        if (pos) return;

        try {
            const asset = this.assets[symbol];
            const clientOid = `${symbol}_${Date.now()}`;

            // AGGRESSIVE LIMIT ORDER
            let limitPrice;
            if (side === 'buy') {
                limitPrice = bestAsk + (asset.config.tickSize * 5); 
            } else {
                limitPrice = bestBid - (asset.config.tickSize * 5);
            }
            
            limitPrice = parseFloat(limitPrice.toFixed(asset.config.precision));

            let trail = spread * 3; 
            const minTrail = asset.config.tickSize * 10;
            if (trail < minTrail) trail = minTrail;
            if (side === 'buy') trail = -trail; 

            await this.bot.placeOrder({
                product_id: asset.config.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc', 
                limit_price: limitPrice.toString(),
                client_order_id: clientOid,
                bracket_trail_amount: trail.toFixed(asset.config.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

            this.logger.info(`[EXECUTE] ${side.toUpperCase()} AGGRESSIVE LIMIT @ ${limitPrice}`);

        } catch (e) {
            this.logger.error(`[EXEC_ERROR] ${symbol}: ${e.message}`);
        }
    }
}

module.exports = TickStrategy;
            
