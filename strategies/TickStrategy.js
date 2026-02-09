/**
 * TickStrategy.js
 * v3.6 – [PRODUCTION] Position Aware & Validated
 * Fixes: Checks bot.getPosition() before trading to avoid API errors.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- TIMING & WARMUP ---
        this.startTime = Date.now();
        this.WARMUP_PERIOD_MS = 30000;   
        this.isWarm = false;

        // --- PARAMETERS ---
        this.PLFF_THRESHOLD_MS = 20;     
        this.HAWKES_DECAY = 5.0;         
        this.MIN_CAUSAL_Z = 2.0;         
        this.MEMORY_CAP = 10000;         
        this.CLEANUP_INTERVAL_MS = 5000;

        // Internal State
        this.lastLog = 0; 

        // --- ASSET STATE ---
        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');

        targets.forEach(symbol => {
            this.assets[symbol] = {
                levelTimestamps: new Map(),
                filteredObi: 0,
                obiMean: 0,
                obiM2: 0, 
                obiCount: 0,
                currentRegime: 0,
                lastDepthUpdate: 0,
                buyIntensity: 0,
                sellIntensity: 0,
                lastTradeUpdate: Date.now(), 
                tradeObi: 0.5,
                lastPrice: 0,
                lastTriggerTime: 0,
                lastCleanupTime: 0,
                isOrderInProgress: false,
                tradeCount: 0 
            };
        });

        this.specs = {
            'BTC': { deltaId: 27, precision: 1 },
            'ETH': { deltaId: 299, precision: 2 },
            'XRP': { deltaId: 14969, precision: 4 },
            'SOL': { deltaId: 4654, precision: 2 }
        };

        this.logger.info("TickStrategy v3.6 Initialized. Waiting for Data...");
    }

    getName() { return "TickStrategy v3.6 (Position Aware)"; }

    async execute(data) {
        if (data.type === 'trade') {
            await this.onTradeUpdate(data.s, data);
        } 
        else if (data.type === 'depthUpdate' || data.type === 'bookTicker') {
            await this.onDepthUpdate(data.s, data);
        }
    }

    async onTradeUpdate(symbol, trade) {
        const asset = this.assets[symbol];
        if (!asset) return;

        asset.tradeCount++;
        const now = Date.now();
        const dt = (now - asset.lastTradeUpdate) / 1000;
        
        // Decay Intensity
        if (dt > 0) {
            const decay = Math.exp(-this.HAWKES_DECAY * dt);
            asset.buyIntensity *= decay;
            asset.sellIntensity *= decay;
        }
        
        asset.lastTradeUpdate = now;
        asset.lastPrice = parseFloat(trade.p);

        // Validation: Prevent NaN
        const quantity = parseFloat(trade.q);
        if (isNaN(quantity) || quantity <= 0) return; 

        const impact = Math.log(1 + quantity); 
        const weight = trade.is_taker ? 1.0 : 0.5;

        if (trade.side === 'buy') asset.buyIntensity += impact * weight;
        else asset.sellIntensity += impact * weight;

        const total = asset.buyIntensity + asset.sellIntensity;
        asset.tradeObi = total > 1e-6 ? (asset.buyIntensity / total) : 0.5;

        await this.checkTrigger(symbol, asset, now);
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        const now = Date.now();
        asset.lastDepthUpdate = now;

        const validBids = this.applyPLFF(asset, depth.bids, now);
        const validAsks = this.applyPLFF(asset, depth.asks, now);

        let bVol = 0, aVol = 0;
        if (validBids) for (const x of validBids) bVol += parseFloat(x[1] || 0);
        if (validAsks) for (const x of validAsks) aVol += parseFloat(x[1] || 0);

        if (bVol + aVol > 0) {
            asset.filteredObi = (bVol - aVol) / (bVol + aVol);
        }

        this.updateRegime(asset);

        if (now - asset.lastCleanupTime > this.CLEANUP_INTERVAL_MS) {
            this.pruneMap(asset, now);
        }

        await this.checkTrigger(symbol, asset, now);
    }

    async checkTrigger(symbol, asset, now) {
        if (!this.isWarm) {
            if (now - this.startTime < this.WARMUP_PERIOD_MS) return;
            this.isWarm = true;
            this.logger.info("✓ Warmup Complete. Snipe Logic Active.");
        }

        // Heartbeat Log
        if (now - (this.lastLog || 0) > 5000) {
             const currentZ = this.calculateHawkesZ(asset, now);
             this.logger.info(`[HEARTBEAT] ${symbol} | Z=${currentZ.toFixed(2)} | Regime=${asset.currentRegime} | Trades=${asset.tradeCount}`);
             this.lastLog = now;
        }

        if (asset.isOrderInProgress) return;
        if (now - asset.lastTriggerTime < 2000) return;
        
        // Safety: If data is stale (>100ms), don't trade
        if (now - asset.lastDepthUpdate > 100) return; 

        // [CRITICAL FIX] Check if Position Exists
        // If we have any position (size != 0), STOP here.
        if (this.bot.hasOpenPosition && this.bot.hasOpenPosition(symbol)) {
            return; 
        }

        const zScore = this.calculateHawkesZ(asset, now);
        if (zScore < this.MIN_CAUSAL_Z) return;

        let side = null;
        if (asset.currentRegime >= 1 && asset.tradeObi > 0.6) side = 'buy';
        else if (asset.currentRegime <= -1 && asset.tradeObi < 0.4) side = 'sell';

        if (side) {
            await this.executeTrade(symbol, side, zScore);
            asset.lastTriggerTime = now;
        }
    }

    updateRegime(asset) {
        const x = asset.filteredObi;
        if (asset.obiCount > this.MEMORY_CAP) {
            const decay = 0.999; 
            asset.obiCount *= decay;
            asset.obiM2 *= decay;
        }

        asset.obiCount++;
        const delta = x - asset.obiMean;
        asset.obiMean += delta / asset.obiCount;
        const delta2 = x - asset.obiMean; 
        asset.obiM2 += delta * delta2;

        if (asset.obiCount < 50) return; 

        const variance = asset.obiM2 / (asset.obiCount - 1);
        const std = Math.sqrt(variance);
        if (std < 0.0001) return;

        const z = (x - asset.obiMean) / std;

        if (z > 1.2) asset.currentRegime = 2;
        else if (z > 0.5) asset.currentRegime = 1;
        else if (z < -1.2) asset.currentRegime = -2;
        else if (z < -0.5) asset.currentRegime = -1;
        else asset.currentRegime = 0;
    }

    calculateHawkesZ(asset, now) {
        if (asset.tradeCount === 0) return 0.0;
        const dt = (now - asset.lastTradeUpdate) / 1000;
        const decay = Math.exp(-this.HAWKES_DECAY * dt);
        const currBuy = asset.buyIntensity * decay;
        const currSell = asset.sellIntensity * decay;
        const netIntensity = currBuy - currSell;
        const totalIntensity = currBuy + currSell + 1.0; 
        return Math.abs(netIntensity / Math.sqrt(totalIntensity));
    }

    applyPLFF(asset, levels, now) {
        if (!levels || !Array.isArray(levels)) return [];
        return levels.filter((item) => {
            const priceStr = Array.isArray(item) ? item[0] : item.p;
            if (!priceStr) return false;
            const price = parseFloat(priceStr);
            const last = asset.levelTimestamps.get(price) || 0;
            if (now - last > this.PLFF_THRESHOLD_MS) {
                asset.levelTimestamps.set(price, now);
                return true;
            }
            return false;
        });
    }

    pruneMap(asset, now) {
        for (const [p, t] of asset.levelTimestamps) {
            if (now - t > 10000) asset.levelTimestamps.delete(p);
        }
        asset.lastCleanupTime = now;
    }

    async executeTrade(symbol, side, score) {
        const asset = this.assets[symbol];
        asset.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];
            const price = asset.lastPrice > 0 ? asset.lastPrice : 0;
            
            if (!price) {
                this.logger.warn(`[EXEC_FAIL] No Price for ${symbol}`);
                return;
            }

            const limit = side === 'buy' ? price * 1.0005 : price * 0.9995;
            let trail = price * 0.0005;
            if (side === 'buy') trail = -trail;

            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc',
                limit_price: limit.toFixed(spec.precision),
                bracket_trail_amount: trail.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

            this.logger.info(`[EXEC] ${side} ${symbol} | Z=${score.toFixed(2)} | TradeObi=${asset.tradeObi.toFixed(2)}`);
        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            asset.isOrderInProgress = false;
        }
    }
}

module.exports = TickStrategy;
                
