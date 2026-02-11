/**
 * TickStrategy.js
 * v7.2 [ALIGNED]
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
        this.WARMUP_TICKS = 100; // Adjusted for safer startup

        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};
        
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            // Ensure symbol matches what comes from market_listener (no _USDT)
            const cleanSymbol = symbol.replace('_USDT', '');
            if (MASTER_CONFIG[cleanSymbol]) {
                this.assets[cleanSymbol] = {
                    config: MASTER_CONFIG[cleanSymbol],
                    obiMean: 0,
                    obiVariance: 0,
                    obiCount: 0,
                    currentRegime: 0, 
                    midPrice: 0,      
                    avgSpread: 0,     
                    lastZ: 0,   
                    lastLogTime: 0 
                };
            }
        });
    }

    getName() {
        return "TickStrategy v7.2";
    }

    // Called when a position closes (added to Trader.js logic)
    onPositionClose(symbol) {
        if (this.assets[symbol]) {
            this.assets[symbol].currentRegime = 0;
            this.logger.info(`[STRATEGY] ${symbol} Position Closed -> Regime Reset.`);
        }
    }

    async execute(data) {
        if (!data || !data.type) return;
        try {
            if (data.type === 'depthUpdate') {
                // market_listener sends 's' as cleaned symbol (e.g., 'XRP')
                // but we run replace just in case.
                const cleanSymbol = data.s.replace('_USDT', '');
                await this.onDepthUpdate(cleanSymbol, data);
            } 
        } catch (e) {
            this.logger.error(`[STRATEGY] Execution Error: ${e.message}`);
        }
    }

    calcNormalizedVol(levels, midPrice, tickSize) {
        let weightedTotal = 0;
        const limit = Math.min(levels.length, 10); 

        for (let i = 0; i < limit; i++) {
            const price = parseFloat(levels[i][0]);
            const size = parseFloat(levels[i][1]);
            
            if (isNaN(size) || isNaN(price)) continue;

            const dist = Math.abs(price - midPrice);
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

        const midPrice = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;
        asset.midPrice = midPrice;

        if (asset.avgSpread === 0) asset.avgSpread = spread;
        else asset.avgSpread = (asset.avgSpread * 0.99) + (spread * 0.01);

        const wBidVol = this.calcNormalizedVol(depth.bids, midPrice, asset.config.tickSize);
        const wAskVol = this.calcNormalizedVol(depth.asks, midPrice, asset.config.tickSize);

        if (wBidVol + wAskVol === 0) return;

        const currentOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        // --- Welford Updates ---
        if (asset.obiCount === 0) {
            asset.obiMean = currentOBI;
            asset.obiVariance = 0;
            asset.obiCount = 1;
        } else {
            const delta = currentOBI - asset.obiMean;
            asset.obiMean = asset.obiMean + (this.WELFORD_ALPHA * delta);
            asset.obiVariance = (1 - this.WELFORD_ALPHA) * (asset.obiVariance + this.WELFORD_ALPHA * delta * delta);
            asset.obiCount++;
        }

        if (asset.obiCount < this.WARMUP_TICKS) return;

        const stdDev = Math.sqrt(asset.obiVariance);
        const effectiveStdDev = Math.max(stdDev, this.MIN_NOISE_FLOOR);
        const zScore = (currentOBI - asset.obiMean) / effectiveStdDev;

        const now = Date.now();
        if (now - asset.lastLogTime > 4000) {
            this.logger.info(`[HEARTBEAT] ${symbol} | Z: ${zScore.toFixed(2)} | OBI: ${currentOBI.toFixed(3)} | Vol: ${effectiveStdDev.toFixed(4)}`);
            asset.lastLogTime = now;
        }

        this.handleRegime(symbol, zScore, spread, asset.avgSpread, currentOBI);
        asset.lastZ = zScore; 
    }

    handleRegime(symbol, zScore, spread, avgSpread, currentOBI) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);

        let dynamicEntry = this.ENTRY_Z;
        if (spread > avgSpread * 2) {
             dynamicEntry = this.ENTRY_Z * 1.5;
        }

        if (asset.currentRegime === 0) {
            if (absZ > dynamicEntry) {
                asset.currentRegime = 1;
                const side = zScore > 0 ? 'buy' : 'sell';
                this.logger.info(`[SNIPER] ${symbol} ${side.toUpperCase()} | Z: ${zScore.toFixed(2)} (Req: ${dynamicEntry.toFixed(1)})`);
                this.executeTrade(symbol, side, spread, currentOBI);
            }
        } else {
            if (absZ < this.EXIT_Z) {
                asset.currentRegime = 0;
                this.logger.info(`[COOLDOWN] ${symbol} | Z-Score normalized.`);
            }
        }
    }

    async executeTrade(symbol, side, spread, obiSignal) {
        if (this.bot.isOrderInProgress) return;
        
        // This now calls the ALIAS method we added to trader.js
        const pos = this.bot.getPosition(symbol);
        
        // If pos is true (meaning open position exists), we abort.
        // trader.js uses boolean, so checking `if (pos)` is sufficient.
        if (pos) return;

        try {
            const asset = this.assets[symbol];
            const price = asset.midPrice;
            
            const halfSpread = spread / 2;
            const fairValueOffset = halfSpread * obiSignal; 
            let limitPrice = price + fairValueOffset;

            if (side === 'buy') limitPrice += asset.config.tickSize;
            else limitPrice -= asset.config.tickSize;

            limitPrice = parseFloat(limitPrice.toFixed(asset.config.precision));

            let trail = spread * 2.5; 
            const minTrail = asset.config.tickSize * 5;
            if (trail < minTrail) trail = minTrail;
            
            if (side === 'buy') trail = -trail;
            
            // Client Order ID for Latency Tracking
            const clientOid = `${symbol}_${Date.now()}`;

            await this.bot.placeOrder({
                product_id: asset.config.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc', 
                limit_price: limitPrice.toString(),
                bracket_trail_amount: trail.toFixed(asset.config.precision),
                bracket_stop_trigger_method: 'mark_price',
                client_order_id: clientOid
            });

            this.logger.info(`[EXECUTE] ${side} @ ${limitPrice} | OBI: ${obiSignal.toFixed(2)}`);

        } catch (e) {
            this.logger.error(`[EXEC_ERROR] ${symbol}: ${e.message}`);
        }
    }
}

module.exports = TickStrategy;
            
