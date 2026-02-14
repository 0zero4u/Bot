/**
 * AdvanceStrategy.js
 * v78.1 - [PURE ARBITRAGE MODE - TIME-WEIGHTED EMV + TP & STATE FIX]
 * Updates:
 * - ADDED: 0.06% Take profit bracket calculation.
 * - FIXED: Removed localInPosition blind-spots. Relies on true WS position state.
 */

class TimeWeightedEMV {
    constructor(timeWindowMs = 20) { 
        this.timeWindow = timeWindowMs;
        this.mean = 0;
        this.variance = 0;
        this.count = 0;
        this.lastTimestamp = 0;
    }

    add(val, timestamp, limitSigma = 2) {
        let safeVal = val;
        
        if (this.count > 1 && this.variance > 0) {
            const stdDev = Math.sqrt(this.variance);
            const upper = this.mean + (limitSigma * stdDev);
            const lower = this.mean - (limitSigma * stdDev);
            safeVal = Math.max(Math.min(val, upper), lower);
        }

        if (this.count === 0) {
            this.mean = safeVal;
            this.variance = 0;
            this.lastTimestamp = timestamp;
            this.count++;
            return;
        }

        const dt = Math.max(0, timestamp - this.lastTimestamp);
        this.lastTimestamp = timestamp;

        const alpha = 1 - Math.exp(-dt / this.timeWindow);

        const diff = safeVal - this.mean;
        this.mean += alpha * diff;
        this.variance = (1 - alpha) * (this.variance + alpha * diff * diff);
        
        this.count++;
    }

    getStats() {
        if (this.count < 5) return { mean: 0, stdDev: 0 }; 
        
        return { 
            mean: this.mean, 
            stdDev: Math.sqrt(this.variance) 
        };
    }
}

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- PURE ARBITRAGE CONFIGURATION ---
        this.WARMUP_MS = 20; 
        
        // Z-SCORE SETTINGS
        this.Z_SCORE_THRESHOLD = 0.05;    
        this.MIN_GAP_THRESHOLD = 0.0003; 
        
        // TRAILING STOP & TAKE PROFIT
        this.TRAILING_PERCENT = 0.03; 
        this.TP_PERCENT = 0.0006; // 0.06%
        this.LOCK_DURATION_MS = 500;    

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: 0.001 },
            'ETH': { deltaId: 299,   precision: 2, lot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 1 },
            'SOL': { deltaId: 417,   precision: 3, lot: 0.1 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        this.assets = {};
        
        targets.forEach(symbol => {
            if (this.specs[symbol]) {
                this.assets[symbol] = {
                    deltaId: this.specs[symbol].deltaId,
                    deltaPrice: 0,       
                    deltaLastUpdate: 0,
                    binanceMid: 0,
                    lockedUntil: 0,
                    gapStats: new TimeWeightedEMV(20), 
                    emaBasis: 0,
                    initialized: false
                };
            }
        });

        this.warmupUntil = 0; 
        this.heartbeatInterval = null;
        
        this.logger.info(`[Strategy] Loaded V78.1 (PURE ARBITRAGE MODE - TP & STATE FIXED)`);
    }

    getName() { return "AdvanceStrategy (V78.1 Time-Weighted EMV)"; }

    async start() {
        this.warmupUntil = Date.now() + this.WARMUP_MS;
        this.logger.info(`[Strategy] ⏳ WARMUP STARTED. Execution locked for 30s...`);
        this.startHeartbeat();
    }

    startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();
            const isWarming = now < this.warmupUntil;
            
            this.logger.info(`\n=== 🫀 STRATEGY HEARTBEAT (${isWarming ? 'WARMUP' : 'ACTIVE'}) ===`);
            Object.keys(this.assets).forEach(key => {
                const a = this.assets[key];
                if (!a.initialized) return;
                
                const stats = a.gapStats.getStats();
                const rawGap = (a.binanceMid - a.deltaPrice) / (a.deltaPrice || 1);
                const adjGap = rawGap - a.emaBasis;
                const zScore = stats.stdDev > 0 ? (adjGap / stats.stdDev) : 0;
                
                this.logger.info(`[${key}] Δ:$${a.deltaPrice} | B:$${a.binanceMid.toFixed(4)} | Basis:${(a.emaBasis*100).toFixed(4)}% | Gap:${(adjGap*100).toFixed(4)}% (Z:${zScore.toFixed(2)})`);
            });
            this.logger.info(`=================================================\n`);
        }, 10000);
    }

    onPositionClose(asset) {
        if (this.assets[asset]) {
            this.assets[asset].lockedUntil = 0;
            this.logger.info(`[Strategy] ${asset} Position Closed. Resetting locks.`);
        }
    }

    onLaggerTrade(trade) {
        const price = parseFloat(trade.price);
        const asset = Object.keys(this.assets).find(k => trade.symbol && trade.symbol.includes(k));
        if (asset) this.onDeltaUpdate(asset, price);
    }

    onDepthUpdate(asset, depthPayload) {
        if (!this.assets[asset]) return;
        const bb = parseFloat(depthPayload.bids[0][0]);
        const ba = parseFloat(depthPayload.asks[0][0]);
        this.onPriceUpdate({ s: asset, bb: bb, ba: ba });
    }

    onDeltaUpdate(asset, price) {
        const assetData = this.assets[asset];
        if (!assetData) return;

        assetData.deltaPrice = price;
        assetData.deltaLastUpdate = Date.now();
        assetData.initialized = true;

        if (assetData.binanceMid > 0) {
            const currentDiff = (assetData.binanceMid - price) / price;
            assetData.emaBasis = (assetData.emaBasis === 0) 
                ? currentDiff 
                : (assetData.emaBasis * 0.95) + (currentDiff * 0.05);
        }
    }

    async onPriceUpdate(data) {
        const asset = data.s; 
        
        // --- 1. SAFETY CHECKS ---
        if (this.bot.isOrderInProgress) return;
        if (this.bot.hasOpenPosition && this.bot.hasOpenPosition(asset)) return;

        const assetData = this.assets[asset];
        if (!assetData || !assetData.initialized) return;

        const now = Date.now();
        if (now < assetData.lockedUntil) return;

        // --- 2. GET CURRENT PRICE ---
        const midPrice = (data.bb + data.ba) / 2;
        assetData.binanceMid = midPrice;

        // --- 3. CALCULATE STATISTICAL GAP ---
        const rawGap = (midPrice - assetData.deltaPrice) / assetData.deltaPrice;
        const adjustedGap = rawGap - assetData.emaBasis;
        
        const { stdDev } = assetData.gapStats.getStats();
        const dynamicThreshold = Math.max(
            this.MIN_GAP_THRESHOLD, 
            this.Z_SCORE_THRESHOLD * stdDev
        );

        const isWarmingUp = now < this.warmupUntil;

        if (isWarmingUp || Math.abs(adjustedGap) < dynamicThreshold * 2.0) {
            assetData.gapStats.add(adjustedGap, now, 3.0); 
        }

        // --- 4. EXECUTION CHECK ---
        if (isWarmingUp) return;

        // --- 5. PURE ARBITRAGE TRIGGER ---
        let direction = null;

        if (adjustedGap > dynamicThreshold) {
            direction = 'buy';  
        } else if (adjustedGap < -dynamicThreshold) {
            direction = 'sell'; 
        }

        if (direction) {
            await this.executeSniper(asset, direction, midPrice, assetData.deltaPrice, adjustedGap, dynamicThreshold);
        }
    }

    async executeSniper(asset, side, binPrice, delPrice, gap, thresholdUsed) {
        this.bot.isOrderInProgress = true;
        const spec = this.specs[asset];

        try {
            this.assets[asset].lockedUntil = Date.now() + this.LOCK_DURATION_MS;
            const clientOid = `adv_${Date.now()}`;
            
            this.logger.info(`[Sniper] ⚡ TRIGGER ${asset} ${side.toUpperCase()} | Gap: ${(gap*100).toFixed(4)}% | Thresh: ${(thresholdUsed*100).toFixed(4)}%`);

            // --- TRAILING STOP CALCULATION ---
            let trailValue = delPrice * (this.TRAILING_PERCENT / 100);
            if (side === 'buy') {
                trailValue = -Math.abs(trailValue); 
            } else {
                trailValue = Math.abs(trailValue);
            }
            const trailFixed = trailValue.toFixed(spec.precision);

            // --- TAKE PROFIT CALCULATION ---
            let tpPrice = (side === 'buy') 
                ? delPrice * (1 + this.TP_PERCENT) 
                : delPrice * (1 - this.TP_PERCENT);
            const tpFixed = tpPrice.toFixed(spec.precision);

            const payload = { 
                product_id: spec.deltaId.toString(), 
                size: spec.lot.toString(), 
                side: side, 
                order_type: 'market_order',              
                bracket_trail_amount: trailFixed, 
                bracket_take_profit_price: tpFixed, 
                bracket_stop_trigger_method: 'mark_price', 
                client_order_id: clientOid
            };
            
            const startT = Date.now();
            const orderResult = await this.bot.placeOrder(payload);
            const latency = Date.now() - startT;

            if (orderResult && orderResult.success) {
                 this.logger.info(`[Sniper] 🎯 FILLED ${asset} | Latency: ${latency}ms | Trail: ${trailFixed} | TP: ${tpFixed}`);
            } else {
                this.logger.error(`[Sniper] 💨 MISS: ${orderResult ? (orderResult.error ? JSON.stringify(orderResult.error) : 'Unknown Error') : 'No Result'}`);
            }

        } catch (error) {
            this.logger.error(`[Sniper] ❌ EXEC FAIL: ${error.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}
module.exports = AdvanceStrategy;
                
