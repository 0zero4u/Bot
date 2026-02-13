/**
 * AdvanceStrategy.js
 * v74.0 - [FIX: Bracket Order Position Exists]
 * Updates:
 * - NOW CHECKS bot.hasOpenPosition(asset) before firing.
 * - Prevents "bracket_order_position_exists" error.
 * - Keeps Negative Trail fix for Buys.
 */

class RollingStats {
    constructor(windowSize = 50) {
        this.size = windowSize;
        this.values = [];
    }

    add(val, limitSigma = 3) {
        const stats = this.getStats();
        let safeVal = val;
        // Winsorization: Clamp outliers to 3 stdDevs to prevent regime destruction
        if (stats.stdDev > 0) {
            const upper = stats.mean + (limitSigma * stats.stdDev);
            const lower = stats.mean - (limitSigma * stats.stdDev);
            safeVal = Math.max(Math.min(val, upper), lower);
        }
        this.values.push(safeVal);
        if (this.values.length > this.size) this.values.shift();
    }

    getStats() {
        if (this.values.length < 5) return { mean: 0, stdDev: 0 }; 
        const mean = this.values.reduce((a, b) => a + b, 0) / this.values.length;
        const variance = this.values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / this.values.length;
        return { mean, stdDev: Math.sqrt(variance) };
    }
}

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.BURST_WINDOW_MS = 60;       
        this.WARMUP_MS = 30000; // 30 Seconds
        
        // Z-SCORE SETTINGS
        this.Z_SCORE_THRESHOLD = 2.2;    
        this.MIN_GAP_THRESHOLD = 0.0004; 
        
        // BURST SETTINGS
        this.MIN_BURST_VELOCITY = 0.0001; 
        this.DOMINANCE_RATIO = 0.7;       

        // LAG TRACKER SETTINGS
        this.LAG_CATCHUP_RATIO = 0.5;

        // TRAILING STOP
        this.TRAILING_PERCENT = 0.1; 
        this.LOCK_DURATION_MS = 500;    

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: 0.001 },
            'ETH': { deltaId: 299,   precision: 2, lot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 1 },
            'SOL': { deltaId: 417,   precision: 3, lot: 0.1 }
        };

        // Initialize Assets
        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        this.assets = {};
        
        targets.forEach(symbol => {
            if (this.specs[symbol]) {
                this.assets[symbol] = {
                    deltaId: this.specs[symbol].deltaId,
                    deltaPrice: 0,       
                    deltaLastUpdate: 0,
                    binanceMid: 0,
                    binanceBuffer: [], 
                    lockedUntil: 0,
                    
                    // LAG TRACKING STATE
                    pendingBurst: null, 
                    
                    // STATS ENGINE
                    gapStats: new RollingStats(60), 
                    emaBasis: 0,
                    initialized: false,
                    lastLogTime: 0
                };
            }
        });

        this.localInPosition = false;
        this.warmupUntil = 0; // Set in start()
        this.heartbeatInterval = null;
        
        this.logger.info(`[Strategy] Loaded V74 (Position Aware)`);
    }

    // --- REQUIRED INTERFACE METHODS ---

    getName() {
        return "AdvanceStrategy (V74 Institutional)";
    }

    async start() {
        this.warmupUntil = Date.now() + this.WARMUP_MS;
        this.logger.info(`[Strategy] ⏳ WARMUP STARTED. Execution locked for 30s (Until: ${new Date(this.warmupUntil).toLocaleTimeString()})`);
        
        // Start Heartbeat Logger
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
                if (!a.initialized) {
                    this.logger.info(`[${key}] Waiting for data...`);
                    return;
                }

                const stats = a.gapStats.getStats();
                const rawGap = (a.binanceMid - a.deltaPrice) / (a.deltaPrice || 1);
                const adjGap = rawGap - a.emaBasis;
                const zScore = stats.stdDev > 0 ? (adjGap / stats.stdDev) : 0;
                
                this.logger.info(
                    `[${key}] ` +
                    `Δ:$${a.deltaPrice} | B:$${a.binanceMid.toFixed(2)} | ` +
                    `Basis:${(a.emaBasis*100).toFixed(4)}% | ` +
                    `Gap:${(adjGap*100).toFixed(4)}% (Z:${zScore.toFixed(2)}) | ` +
                    `Burst:${a.pendingBurst ? (a.pendingBurst.dir > 0 ? 'UP' : 'DOWN') : 'None'}`
                );
            });
            this.logger.info(`=================================================\n`);
        }, 10000); // 10 Seconds
    }

    /**
     * Called by Trader.js when a position is closed.
     */
    onPositionClose(asset) {
        this.localInPosition = false;
        if (this.assets[asset]) {
            this.assets[asset].lockedUntil = 0;
            this.assets[asset].pendingBurst = null;
            this.logger.info(`[Strategy] ${asset} Position Closed. Resetting locks.`);
        }
    }

    /**
     * Called by Trader.js when 'all_trades' arrives (Delta Lagger Feed)
     */
    onLaggerTrade(trade) {
        const price = parseFloat(trade.price);
        const asset = Object.keys(this.assets).find(k => trade.symbol && trade.symbol.includes(k));
        
        if (asset) {
            this.onDeltaUpdate(asset, price);
        }
    }

    /**
     * Called by Trader.js when 'B' type (Binance Fast Feed) arrives
     */
    onDepthUpdate(asset, depthPayload) {
        if (!this.assets[asset]) return;
        
        const bb = parseFloat(depthPayload.bids[0][0]);
        const ba = parseFloat(depthPayload.asks[0][0]);

        const updateData = {
            s: asset,
            bb: bb,
            ba: ba
        };

        this.onPriceUpdate(updateData);
    }

    // --- INTERNAL LOGIC ---

    onDeltaUpdate(asset, price) {
        const assetData = this.assets[asset];
        if (!assetData) return;

        assetData.deltaPrice = price;
        assetData.deltaLastUpdate = Date.now();
        assetData.initialized = true;

        // 1. UPDATE BASIS (Slow Drift)
        if (assetData.binanceMid > 0) {
            const currentDiff = (assetData.binanceMid - price) / price;
            // Slow EMA to track structural basis
            assetData.emaBasis = (assetData.emaBasis === 0) 
                ? currentDiff 
                : (assetData.emaBasis * 0.95) + (currentDiff * 0.05);
            
            // 2. CHECK LAG CLOSURE
            this.checkLagClosure(asset, price);
        }
    }

    checkLagClosure(asset, currentDeltaPrice) {
        const data = this.assets[asset];
        if (!data.pendingBurst) return;

        const burst = data.pendingBurst;
        const elapsed = Date.now() - burst.t;

        if (elapsed > 2000) {
            data.pendingBurst = null;
            return;
        }

        const deltaMove = (currentDeltaPrice - burst.deltaStart);
        const deltaPct = deltaMove / burst.deltaStart;
        
        let catchUpRatio = 0;
        
        if (burst.dir === 1 && deltaPct > 0) {
            catchUpRatio = deltaPct / burst.binBurstSize;
        } else if (burst.dir === -1 && deltaPct < 0) {
            catchUpRatio = deltaPct / burst.binBurstSize; 
        }

        if (catchUpRatio >= this.LAG_CATCHUP_RATIO) {
            this.logLag(asset, elapsed, catchUpRatio);
            data.pendingBurst = null; 
        }
    }

    logLag(asset, ms, ratio) {
        if (ms > 50 || Math.random() < 0.1) {
            this.logger.info(`[LagTracker] ${asset} caught up ${(ratio*100).toFixed(0)}% in ${ms}ms`);
        }
    }

    async onPriceUpdate(data) {
        const asset = data.s; 
        
        // --- ⚡ CRITICAL FIX: CHECK REAL EXCHANGE POSITION ---
        // If the bot holds a position on the exchange, DO NOT fire.
        if (this.localInPosition || this.bot.isOrderInProgress) return;
        
        // Safely check bot.hasOpenPosition if it exists
        if (this.bot.hasOpenPosition && this.bot.hasOpenPosition(asset)) {
            // (Optional) Log sparingly if needed, or just return silently
            return;
        }

        const assetData = this.assets[asset];
        if (!assetData || !assetData.initialized) return;

        const now = Date.now();
        if (now < assetData.lockedUntil) return;

        const midPrice = (data.bb + data.ba) / 2;
        assetData.binanceMid = midPrice;

        assetData.binanceBuffer.push({ p: midPrice, t: now });
        while (assetData.binanceBuffer.length > 0 && (now - assetData.binanceBuffer[0].t > this.BURST_WINDOW_MS)) {
            assetData.binanceBuffer.shift();
        }

        // --- STATS UPDATE (Always run, even in Warmup) ---
        // This ensures that when warmup ends, we have valid stdDev
        const rawGap = (midPrice - assetData.deltaPrice) / assetData.deltaPrice;
        const adjustedGap = rawGap - assetData.emaBasis;
        
        // Feed the stats engine
        const { stdDev } = assetData.gapStats.getStats();
        const dynamicThreshold = Math.max(
            this.MIN_GAP_THRESHOLD, 
            this.Z_SCORE_THRESHOLD * stdDev
        );

        // Only add to stats if not in an extreme event (simple filtering)
        if (Math.abs(adjustedGap) < dynamicThreshold * 2.0) {
            assetData.gapStats.add(adjustedGap, 3.0); 
        }

        // --- EXECUTION CHECK (Blocked during Warmup) ---
        if (now < this.warmupUntil) return;
        if (assetData.binanceBuffer.length < 3) return;

        // --- BURST ANALYSIS ---
        const buffer = assetData.binanceBuffer;
        const startPrice = buffer[0].p;
        let maxP = -Infinity, minP = Infinity;
        
        for (let b of buffer) {
            if (b.p > maxP) maxP = b.p;
            if (b.p < minP) minP = b.p;
        }

        const upImpulse = maxP - startPrice;
        const downImpulse = startPrice - minP;
        const totalRange = upImpulse + downImpulse;

        // --- LAG TRACKER REGISTRATION ---
        if (!assetData.pendingBurst) {
            const burstThreshold = this.MIN_BURST_VELOCITY * startPrice * 2.0; 
            
            if (upImpulse > burstThreshold) {
                assetData.pendingBurst = { 
                    t: now, 
                    dir: 1, 
                    deltaStart: assetData.deltaPrice,
                    binBurstSize: upImpulse / startPrice 
                };
            } else if (downImpulse > burstThreshold) {
                assetData.pendingBurst = { 
                    t: now, 
                    dir: -1, 
                    deltaStart: assetData.deltaPrice,
                    binBurstSize: -(downImpulse / startPrice) 
                };
            }
        }

        // --- TRADING LOGIC ---
        let direction = null;

        if (Math.abs(adjustedGap) > dynamicThreshold) {
            if (adjustedGap > 0) { // BUY
                const dominance = upImpulse / (totalRange || 1);
                const retracement = (maxP - midPrice) / (upImpulse || 1);
                
                if (dominance > this.DOMINANCE_RATIO && 
                    upImpulse > this.MIN_BURST_VELOCITY * startPrice &&
                    retracement < 0.3) {
                    direction = 'buy';
                }
            } else { // SELL
                const dominance = downImpulse / (totalRange || 1);
                const retracement = (midPrice - minP) / (downImpulse || 1);

                if (dominance > this.DOMINANCE_RATIO && 
                    downImpulse > this.MIN_BURST_VELOCITY * startPrice &&
                    retracement < 0.3) {
                    direction = 'sell';
                }
            }
        }

        if (direction) {
            await this.executeSniper(asset, direction, midPrice, assetData.deltaPrice, adjustedGap, dynamicThreshold);
        }
    }

    async executeSniper(asset, side, binPrice, delPrice, gap, thresholdUsed) {
        this.localInPosition = true;
        this.bot.isOrderInProgress = true;
        const spec = this.specs[asset];

        try {
            this.assets[asset].lockedUntil = Date.now() + this.LOCK_DURATION_MS;
            const clientOid = `adv_${Date.now()}`;
            
            this.logger.info(`[Sniper] ⚡ TRIGGER ${asset} ${side.toUpperCase()} | Gap: ${(gap*100).toFixed(4)}% | Thresh: ${(thresholdUsed*100).toFixed(4)}%`);

            // --- ⚡ HANDLE TRAILING STOP SIGN ---
            // Buy Order: Stop is BELOW price (Negative Offset)
            // Sell Order: Stop is ABOVE price (Positive Offset)
            let trailValue = delPrice * (this.TRAILING_PERCENT / 100);
            
            if (side === 'buy') {
                trailValue = -Math.abs(trailValue); // MUST BE NEGATIVE FOR BUY
            } else {
                trailValue = Math.abs(trailValue);  // MUST BE POSITIVE FOR SELL
            }
            
            const trailFixed = trailValue.toFixed(spec.precision);

            const payload = { 
                product_id: spec.deltaId.toString(), 
                size: spec.lot.toString(), 
                side: side, 
                order_type: 'market_order',              
                bracket_trail_amount: trailFixed, 
                bracket_stop_trigger_method: 'mark_price', 
                client_order_id: clientOid
            };
            
            const startT = Date.now();
            const orderResult = await this.bot.placeOrder(payload);
            const latency = Date.now() - startT;

            if (orderResult && orderResult.success) {
                 this.logger.info(`[Sniper] 🎯 FILLED ${asset} | Latency: ${latency}ms | Trail: ${trailFixed}`);
                 setTimeout(() => { this.localInPosition = false; }, this.LOCK_DURATION_MS);
            } else {
                this.logger.error(`[Sniper] 💨 MISS: ${orderResult ? (orderResult.error ? JSON.stringify(orderResult.error) : 'Unknown Error') : 'No Result'}`);
                this.localInPosition = false; 
            }

        } catch (error) {
            this.logger.error(`[Sniper] ❌ EXEC FAIL: ${error.message}`);
            this.localInPosition = false; 
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = AdvanceStrategy;
            
