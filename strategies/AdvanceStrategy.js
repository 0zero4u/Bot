/**
 * AdvanceStrategy.js
 * v71.0 - INSTITUTIONAL FINAL [ALIGNED]
 * Features: Winsorized Stats, Dominance Burst, PROPORTIONAL LAG TRACKER
 * Updates:
 * - Aligned with Trader v68 interface (onDepthUpdate, onLaggerTrade)
 * - Added onPositionClose & getName
 * - Fixed Execution Payload strictness
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
        
        // Z-SCORE SETTINGS
        this.Z_SCORE_THRESHOLD = 2.2;    
        this.MIN_GAP_THRESHOLD = 0.0002; 
        
        // BURST SETTINGS
        this.MIN_BURST_VELOCITY = 0.0001; 
        this.DOMINANCE_RATIO = 0.7;       

        // LAG TRACKER SETTINGS
        this.LAG_CATCHUP_RATIO = 0.5; // Delta must close 50% of the Binance gap to count as "reacted"

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
                    initialized: false
                };
            }
        });

        this.localInPosition = false;
        this.logger.info(`[Strategy] Loaded V71 (Aligned Interface)`);
    }

    // --- REQUIRED INTERFACE METHODS ---

    getName() {
        return "AdvanceStrategy (V71 Institutional)";
    }

    async start() {
        this.logger.info('[Strategy] Active.');
    }

    /**
     * Called by Trader.js when a position is closed.
     * Resets locks to allow immediate re-entry if conditions persist.
     */
    onPositionClose(asset) {
        this.localInPosition = false;
        if (this.assets[asset]) {
            this.assets[asset].lockedUntil = 0; // Reset lock
            this.assets[asset].pendingBurst = null; // Reset pending patterns
            this.logger.info(`[Strategy] ${asset} Position Closed. Resetting locks.`);
        }
    }

    /**
     * Called by Trader.js when 'all_trades' arrives (Delta Lagger Feed)
     */
    onLaggerTrade(trade) {
        const price = parseFloat(trade.price);
        // Map symbol (e.g., BTCUSD -> BTC)
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
        
        // Extract Best Bid/Ask from payload formatted by trader.js
        // depthPayload = { bids: [[p, q]], asks: [[p, q]] }
        const bb = parseFloat(depthPayload.bids[0][0]);
        const ba = parseFloat(depthPayload.asks[0][0]);

        // Construct standard object for internal logic
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
        if (this.localInPosition || this.bot.isOrderInProgress) return;
        
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
        const { stdDev } = assetData.gapStats.getStats();
        const dynamicThreshold = Math.max(
            this.MIN_GAP_THRESHOLD, 
            this.Z_SCORE_THRESHOLD * stdDev
        );

        const rawGap = (midPrice - assetData.deltaPrice) / assetData.deltaPrice;
        const adjustedGap = rawGap - assetData.emaBasis;

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
        } else {
            // Stats update (Winsorized)
            if (Math.abs(adjustedGap) < dynamicThreshold * 2.0) {
                assetData.gapStats.add(adjustedGap, 3.0); 
            }
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

            // Calculate Trail
            const trailValue = delPrice * (this.TRAILING_PERCENT / 100);
            const trailFixed = trailValue.toFixed(spec.precision);

            // [ALIGNED] Payload matches MicroStrategy strictness
            const payload = { 
                product_id: spec.deltaId.toString(), 
                size: spec.lot.toString(), 
                side: side, 
                order_type: 'market_order',              
                bracket_trail_amount: trailFixed, 
                // Using mark_price for trail trigger is safer and standard in MicroStrategy
                bracket_stop_trigger_method: 'mark_price', 
                client_order_id: clientOid
            };
            
            const startT = Date.now();
            const orderResult = await this.bot.placeOrder(payload);
            const latency = Date.now() - startT;

            if (orderResult && orderResult.success) {
                 this.logger.info(`[Sniper] 🎯 FILLED ${asset} | Latency: ${latency}ms | Trail: ${trailFixed}`);
                 // Don't clear localInPosition immediately; wait for onPositionClose or timeout
                 setTimeout(() => { this.localInPosition = false; }, this.LOCK_DURATION_MS);
            } else {
                this.logger.error(`[Sniper] 💨 MISS: ${orderResult ? orderResult.error : 'Unknown'}`);
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
                
