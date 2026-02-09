/**
 * TickStrategy.js
 * v3.1 – [PRODUCTION] Signed Hawkes, Trade-Causal, O(1) Memory
 * Alignments:
 * 1. Trade OBI (Paper: Strongest Causal Signal)
 * 2. PLFF/MTF (Paper: Best Noise Filter)
 * 3. Log-Normal Intensity (Fix: Whale Protection)
 * 4. Welford's Algorithm (Fix: O(1) Performance)
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- PARAMETERS ---
        this.PLFF_THRESHOLD_MS = 20;     // Paper: Modification Time Filter (MTF)
        this.HAWKES_DECAY = 5.0;         // Decay factor for intensity memory
        this.MIN_CAUSAL_Z = 2.0;         // Trigger Threshold (Sigma)
        this.CLEANUP_INTERVAL_MS = 5000; // Garbage Collection interval

        // --- ASSET STATE ---
        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');

        targets.forEach(symbol => {
            this.assets[symbol] = {
                // PLFF State
                levelTimestamps: new Map(),

                // Order Book State (Welford's Online Stats)
                filteredObi: 0,
                obiMean: 0,
                obiM2: 0, // Sum of squares for variance
                obiCount: 0,
                currentRegime: 0,
                lastDepthUpdate: 0,

                // Trade State (Hawkes Process)
                buyIntensity: 0,
                sellIntensity: 0,
                lastTradeUpdate: 0,
                tradeObi: 0.5,
                lastPrice: 0,

                // Execution Flags
                lastTriggerTime: 0,
                lastCleanupTime: 0,
                isOrderInProgress: false
            };
        });

        // Exchange Specs (Delta Exchange)
        this.specs = {
            'BTC': { deltaId: 27, precision: 1 },
            'ETH': { deltaId: 299, precision: 2 },
            'XRP': { deltaId: 14969, precision: 4 },
            'SOL': { deltaId: 4654, precision: 2 }
        };
    }

    getName() {
        return "TickStrategy v3.1 (Causal-Hawkes)";
    }

    // --------------------------------------------------
    // 1. TRADE UPDATES (The "Spark") - O(1)
    // --------------------------------------------------
    async onTradeUpdate(symbol, trade) {
        const asset = this.assets[symbol];
        if (!asset) return;

        const now = Date.now();
        
        // A. Decay Intensity based on time passed since last TRADE
        // This mimics the "Memory" of the market fading over time
        const dt = (now - asset.lastTradeUpdate) / 1000; // Seconds
        if (dt > 0) {
            const decay = Math.exp(-this.HAWKES_DECAY * dt);
            asset.buyIntensity *= decay;
            asset.sellIntensity *= decay;
        }
        
        asset.lastTradeUpdate = now;
        asset.lastPrice = parseFloat(trade.p);

        // B. Add New Intensity (Log-Normal)
        // Insight: A 1,000,000 contract trade is not 1,000,000x more important than a 1 contract trade.
        // We use Math.log to dampen "Whale" spikes while keeping them significant.
        const impact = Math.log(1 + parseFloat(trade.q)); 
        const weight = trade.is_taker ? 1.0 : 0.5; // Taker trades drive price

        if (trade.side === 'buy') asset.buyIntensity += impact * weight;
        else asset.sellIntensity += impact * weight;

        // C. Update Trade OBI (The "Aggressor" Ratio)
        const total = asset.buyIntensity + asset.sellIntensity;
        asset.tradeObi = total > 1e-6 ? (asset.buyIntensity / total) : 0.5;

        // Check for Snipe Opportunity immediately
        await this.checkTrigger(symbol, asset, now);
    }

    // --------------------------------------------------
    // 2. DEPTH UPDATES (The "Fuel") - O(1)
    // --------------------------------------------------
    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        const now = Date.now();
        asset.lastDepthUpdate = now;

        // A. Apply PLFF (MTF)
        // Filters out "Flickering" liquidity (Noise)
        const validBids = this.applyPLFF(asset, depth.bids, now);
        const validAsks = this.applyPLFF(asset, depth.asks, now);

        // B. Calculate Filtered OBI
        let bVol = 0, aVol = 0;
        if (validBids) for (const x of validBids) bVol += parseFloat(x[1]);
        if (validAsks) for (const x of validAsks) aVol += parseFloat(x[1]);

        if (bVol + aVol > 0) {
            asset.filteredObi = (bVol - aVol) / (bVol + aVol);
        }

        // C. Update Regime (Welford's Algorithm)
        // Updates Mean/StdDev instantly without looping through history
        this.updateRegime(asset);

        // D. Periodic Cleanup (Garbage Collection)
        if (now - asset.lastCleanupTime > this.CLEANUP_INTERVAL_MS) {
            this.pruneMap(asset, now);
        }

        await this.checkTrigger(symbol, asset, now);
    }

    // --------------------------------------------------
    // 3. TRIGGER LOGIC (The "Snipe")
    // --------------------------------------------------
    async checkTrigger(symbol, asset, now) {
        if (asset.isOrderInProgress) return;
        if (now - asset.lastTriggerTime < 2000) return; // 2s Cooldown
        
        // Safety: Don't trade if book data is stale (>100ms)
        if (now - asset.lastDepthUpdate > 100) return; 

        // Get Hawkes Z-Score (How abnormal is the current trade flow?)
        const zScore = this.calculateHawkesZ(asset, now);

        // Filter: Must be a statistically significant burst
        if (zScore < this.MIN_CAUSAL_Z) return;

        let side = null;

        // CONFLUENCE STRATEGY:
        // 1. Regime (Book) says "Pressure is building"
        // 2. Trades (Flow) say "Aggressors are attacking"
        if (asset.currentRegime >= 1 && asset.tradeObi > 0.6) side = 'buy';
        else if (asset.currentRegime <= -1 && asset.tradeObi < 0.4) side = 'sell';

        if (side) {
            await this.executeTrade(symbol, side, zScore);
            asset.lastTriggerTime = now;
        }
    }

    // --------------------------------------------------
    // MATH HELPERS
    // --------------------------------------------------
    calculateHawkesZ(asset, now) {
        // Project decay to current millisecond
        const dt = (now - asset.lastTradeUpdate) / 1000;
        const decay = Math.exp(-this.HAWKES_DECAY * dt);
        
        const currBuy = asset.buyIntensity * decay;
        const currSell = asset.sellIntensity * decay;
        const netIntensity = currBuy - currSell;
        
        // Normalize by Total Intensity (Volatility Proxy)
        const totalIntensity = currBuy + currSell + 1.0; 
        const zRaw = netIntensity / Math.sqrt(totalIntensity);
        
        return Math.abs(zRaw);
    }

    updateRegime(asset) {
        // Welford's Online Algorithm for Variance
        const x = asset.filteredObi;
        asset.obiCount++;
        
        const delta = x - asset.obiMean;
        asset.obiMean += delta / asset.obiCount;
        const delta2 = x - asset.obiMean; 
        asset.obiM2 += delta * delta2;

        if (asset.obiCount < 50) return; // Warmup

        const variance = asset.obiM2 / (asset.obiCount - 1);
        const std = Math.sqrt(variance);
        
        if (std < 0.0001) return; // Ignore flat markets

        const z = (x - asset.obiMean) / std;

        // Discretized Regimes
        if (z > 1.2) asset.currentRegime = 2;       // Strong Buy Pressure
        else if (z > 0.5) asset.currentRegime = 1;  // Mild Buy
        else if (z < -1.2) asset.currentRegime = -2;// Strong Sell Pressure
        else if (z < -0.5) asset.currentRegime = -1;// Mild Sell
        else asset.currentRegime = 0;
    }

    // --------------------------------------------------
    // PLFF (Modification Time Filter)
    // --------------------------------------------------
    applyPLFF(asset, levels, now) {
        if (!levels) return [];

        return levels.filter(([priceStr]) => {
            const price = parseFloat(priceStr);
            const last = asset.levelTimestamps.get(price) || 0;
            
            // Logic: If update is too soon (e.g. 5ms after last one), ignore it.
            // This filters out HFT flickering/noise.
            if (now - last > this.PLFF_THRESHOLD_MS) {
                asset.levelTimestamps.set(price, now);
                return true;
            }
            return false;
        });
    }

    pruneMap(asset, now) {
        // Cleanup old timestamps to prevent Memory Leak
        // Only runs every 5 seconds
        for (const [p, t] of asset.levelTimestamps) {
            if (now - t > 10000) { 
                asset.levelTimestamps.delete(p);
            }
        }
        asset.lastCleanupTime = now;
    }

    // --------------------------------------------------
    // EXECUTION
    // --------------------------------------------------
    async executeTrade(symbol, side, score) {
        const asset = this.assets[symbol];
        asset.isOrderInProgress = true;

        try {
            const spec = this.specs[symbol];
            
            // Use last trade price, fallback to Mark Price
            const price = asset.lastPrice > 0 ? asset.lastPrice : (this.bot.getMarkPrice ? this.bot.getMarkPrice(symbol) : 0);
            
            if (!price) throw new Error("No Price Data");

            // Aggressive IOC Entry
            const limit = side === 'buy' ? price * 1.0005 : price * 0.9995;

            // Signed Trailing Stop
            let trail = price * 0.0005; // 0.05%
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

            this.logger.info(`[EXEC] ${side} ${symbol} | Z-Score:${score.toFixed(2)} | TradeObi:${asset.tradeObi.toFixed(2)}`);

        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            asset.isOrderInProgress = false;
        }
    }
}

module.exports = TickStrategy;
    
