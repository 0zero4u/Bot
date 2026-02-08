/**
 * TickStrategy.js - High-Frequency Trading (HFT) Bot
 * Optimized Version v1.0.6
 * * * KEY UPDATES:
 * 1. FIX: Directional trailing stop (Negative for Buy, Positive for Sell).
 * 2. SL: 6-tick exchange-side trailing stop loss.
 * 3. LOGIC: Hawkes Causal Coherence + Price-Level Frequency Filter (PLFF).
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- RESEARCH-DRIVEN PARAMETERS ---
        this.PLFF_THRESHOLD_MS = 20;      
        this.OBI_HISTORY_SIZE = 10000;    
        this.HEARTBEAT_INTERVAL = 5000;   
        
        // --- HAWKES CAUSAL PARAMETERS ---
        this.HAWKES_DECAY = 5.0;          
        this.MIN_CAUSAL_SCORE = 30.0;      
        this.MIN_TRADE_OBI = 0.85;        

        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(asset => {
            this.assets[asset] = {
                levelTimestamps: new Map(), 
                obiHistory: [],             
                recentTrades: [],           
                lastHeartbeat: 0,
                lastTriggerTime: 0,
                currentRegime: 0,
                currentPercentile: 0,
                filteredObi: 0
            };
        });

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: 0.001 },
            'ETH': { deltaId: 299,   precision: 2, lot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 1 }
        };
    }

    getName() { return "TickStrategy (Hawkes + Fixed Trail)"; }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        const now = Date.now();

        // A. Price-Level Frequency Filter (PLFF)
        const validBids = this.applyPLFF(asset, depth.bids, now);
        const validAsks = this.applyPLFF(asset, depth.asks, now);

        // B. Calculate Filtered OBI
        const bVol = validBids.reduce((s, l) => s + parseFloat(l[1]), 0);
        const aVol = validAsks.reduce((s, l) => s + parseFloat(l[1]), 0);
        
        if (bVol + aVol === 0) return;
        asset.filteredObi = (bVol - aVol) / (bVol + aVol);

        // C. Update Dynamic Quantile Regimes
        this.updateRegimeState(asset);

        // D. Heartbeat Logging
        if (now - asset.lastHeartbeat > this.HEARTBEAT_INTERVAL) {
            const metrics = this.calculateHawkesCausality(asset, now);
            this.logPayload(symbol, asset, "HEARTBEAT", now, null, metrics);
            asset.lastHeartbeat = now;
        }

        // E. Trigger Evaluation
        if (Math.abs(asset.currentRegime) >= 2) {
            await this.evaluateCausalSnipe(symbol, asset, now);
        }
    }

    onPriceUpdate(symbol, price, source) {
        const asset = this.assets[symbol];
        if (asset) {
            asset.recentTrades.push({ t: Date.now(), p: parseFloat(price) });
            if (asset.recentTrades.length > 100) asset.recentTrades.shift();
        }
    }

    applyPLFF(asset, levels, now) {
        return levels.filter(level => {
            const price = level[0];
            const lastUpdate = asset.levelTimestamps.get(price) || 0;
            const diff = now - lastUpdate;
            
            if (diff > this.PLFF_THRESHOLD_MS) {
                asset.levelTimestamps.set(price, now);
                return true;
            }
            return false; 
        });
    }

    updateRegimeState(asset) {
        const history = asset.obiHistory;
        history.push(asset.filteredObi);
        if (history.length > this.OBI_HISTORY_SIZE) history.shift();
        if (history.length < 50) return;

        const sorted = [...history].sort((a, b) => a - b);
        const rank = sorted.filter(v => v < asset.filteredObi).length;
        asset.currentPercentile = (rank / sorted.length) * 100;

        if (asset.currentPercentile >= 90) asset.currentRegime = 2;       
        else if (asset.currentPercentile >= 75) asset.currentRegime = 1;  
        else if (asset.currentPercentile <= 10) asset.currentRegime = -2; 
        else if (asset.currentPercentile <= 25) asset.currentRegime = -1; 
        else asset.currentRegime = 0;                                    
    }

    calculateHawkesCausality(asset, now) {
        let intensity = 0;
        let up = 0, down = 0;
        const window = asset.recentTrades.filter(t => now - t.t < 1000);

        for (let i = 1; i < window.length; i++) {
            const deltaT = (now - window[i].t) / 1000;
            intensity += Math.exp(-this.HAWKES_DECAY * deltaT);
            
            if (window[i].p > window[i-1].p) up++;
            else if (window[i].p < window[i-1].p) down++;
        }
        return { 
            causalScore: intensity, 
            tradeObi: (up + down) > 0 ? (up - down) / (up + down) : 0 
        };
    }

    async evaluateCausalSnipe(symbol, asset, now) {
        if (this.bot.hasOpenPosition || this.bot.isOrderInProgress) return;
        if (now - asset.lastTriggerTime < 2000) return;

        const metrics = this.calculateHawkesCausality(asset, now);

        let side = null;
        if (asset.currentRegime === 2 && metrics.causalScore > this.MIN_CAUSAL_SCORE && metrics.tradeObi > this.MIN_TRADE_OBI) {
            side = 'buy';
        } else if (asset.currentRegime === -2 && metrics.causalScore > this.MIN_CAUSAL_SCORE && metrics.tradeObi < -this.MIN_TRADE_OBI) {
            side = 'sell';
        }

        if (side) {
            asset.lastTriggerTime = now;
            this.logPayload(symbol, asset, "TICK_TRIGGER", now, side, metrics);
            await this.executeSnipe(symbol, asset, side);
        }
    }

    async executeSnipe(symbol, asset, side) {
        this.bot.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];
            const lastPrice = asset.recentTrades[asset.recentTrades.length - 1]?.p;
            if (!lastPrice) return;

            // 1. Calculate 6-tick distance
            const tickSize = 1 / Math.pow(10, spec.precision);
            let trailAmount = 6 * tickSize;

            // 2. APPLY DIRECTIONAL SIGN
            // Buy: Negative (must drop from peak to trigger)
            // Sell: Positive (must rise from valley to trigger)
            if (side === 'buy') {
                trailAmount = -trailAmount;
            }

            const limit = side === 'buy' ? lastPrice * 1.0005 : lastPrice * 0.9995;

            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                size: process.env.ORDER_SIZE || "1",
                side,
                order_type: 'limit_order',
                time_in_force: 'ioc',
                limit_price: limit.toFixed(spec.precision),
                // Fixed trail with correct directional sign
                bracket_trail_amount: trailAmount.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            });
        } catch (e) { 
            this.logger.error(`[EXEC_FAIL] ${e.message}`); 
        } finally { 
            this.bot.isOrderInProgress = false; 
        }
    }

    logPayload(symbol, asset, type, now, side, metrics) {
        const payload = {
            timestamp: new Date(now).toISOString(),
            event: type,
            asset: symbol,
            regime: `${asset.currentRegime} (p: ${asset.currentPercentile.toFixed(1)}%)`,
            filtered_obi: asset.filteredObi.toFixed(4),
            causal_coherence_score: metrics.causalScore.toFixed(2),
            trade_obi: metrics.tradeObi.toFixed(4)
        };
        if (side) payload.side = side.toUpperCase();
        this.logger.info(`[TICK-STRAT] ${JSON.stringify(payload)}`);
    }
}

module.exports = TickStrategy;
        
