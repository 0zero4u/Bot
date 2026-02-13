/**
 * ============================================================================
 * LEAD STRATEGY v19: MICROSTRUCTURE PRODUCTION GRADE
 * * [CRITICAL FIXES]:
 * 1. Price Source: Changed from Mid -> Volume Weighted Mid Price (VWMP).
 * - Prevents false signals from spread widening/liquidity pulls.
 * 2. Math: Raised Clipping to 6.0σ, Rank to 0.99.
 * - Prevents threshold compression at the top end.
 * 3. Perf: Replaced O(N) shift() with Lazy Pointer for CVD.
 * 4. Latency: Reduced Cooldown from 1000ms -> 50ms.
 * 5. Perf: Throttled Buffer Sort to idle times (simple optimization).
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. CONFIGURATION ---
        this.WARMUP_MS = 120000;
        this.WINDOW_MS = 30;             
        this.IMBALANCE_THRESHOLD = 0.60; 
        
        // --- 2. CVD FILTER ---
        this.CVD_WINDOW_MS = 50;         
        this.CVD_THRESHOLD = 0.60;       
        
        // --- 3. RISK ---
        this.SL_PCT = 0.00015; 
        this.TP_PCT = 0.00160; 
        
        // --- 4. VOLATILITY ---
        this.VOL_HALF_LIFE_MS = 1000;    
        this.VOL_LAMBDA = Math.LN2 / this.VOL_HALF_LIFE_MS; 
        this.MAX_DT_MS = 100;

        // --- 5. ADAPTIVE THRESHOLD (CORRECTED) ---
        // FIX: Rank 0.99 allows the top 1% to be "extreme".
        // FIX: Clipping at 6.0 allows the threshold to float above 3.0 naturally.
        this.QUANTILE_RANK = 0.999;       
        this.BUFFER_SIZE = 100000;         
        this.UPDATE_INTERVAL_MS = 5000;   
        this.MIN_THRESHOLD_FLOOR = 3.5;   
        this.RESET_THRESHOLD_RATIO = 0.7; 
        this.MEMORY_CLIPPING_LIMIT = 6.0; // Raised from 3.0 to prevent ceiling effect

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, minSigma: 0.00003 },
            'ETH': { deltaId: 299,   precision: 2, minSigma: 0.00004 },
            'SOL': { deltaId: 417,   precision: 3, minSigma: 0.00006 },
            'XRP': { deltaId: 14969, precision: 4, minSigma: 0.00008 }
        };

        // --- STATE ---
        this.startTime = Date.now();
        this.history = {};      
        this.volState = {};     
        this.zBuffer = {};      
        this.zPointer = {};     
        this.zCount = {};       
        this.dynamicThresholds = {}; 
        this.triggerState = {}; 
        this.pendingSignals = []; 
        this.cvdState = {};

        Object.keys(this.specs).forEach(a => {
            this.history[a] = [];
            this.volState[a] = { variance: 0.000001, lastTime: Date.now() };
            this.zBuffer[a] = new Float32Array(this.BUFFER_SIZE); 
            this.zPointer[a] = 0;
            this.zCount[a] = 0;
            this.dynamicThresholds[a] = 4.0; 
            this.triggerState[a] = { isFiring: false, lastFire: 0 };
            
            // FIX: CVD Lazy Pointer Implementation
            this.cvdState[a] = { 
                queue: [], 
                headIndex: 0, 
                buySum: 0, 
                sellSum: 0 
            };
        });

        this.logger.info(`[LeadStrategy v19] 🛡️ VWMP Signal | Memory Clip @ 6.0σ | Rank 0.99`);

        setInterval(() => this.updateThresholds(), this.UPDATE_INTERVAL_MS);
        this.startHeartbeat();
    }

    // --- CVD INGESTION (O(1) PERFORMANCE FIX) ---
    onExternalTrade(trade) {
        const cvd = this.cvdState[trade.s];
        if (!cvd) return;

        const now = trade.t;
        const qty = trade.q;

        const tradeNode = { t: now, q: qty, s: trade.side === 'buy' ? 1 : -1 };
        
        // Add to end
        cvd.queue.push(tradeNode);
        if (tradeNode.s === 1) cvd.buySum += qty;
        else cvd.sellSum += qty;

        // Prune from front using Lazy Pointer (Avoids O(N) shift)
        const cutoff = now - this.CVD_WINDOW_MS;
        
        while (cvd.headIndex < cvd.queue.length) {
            const old = cvd.queue[cvd.headIndex];
            if (old.t >= cutoff) break; // Stop if inside window

            // Remove effect
            if (old.s === 1) cvd.buySum -= old.q;
            else cvd.sellSum -= old.q;
            
            cvd.headIndex++;
        }

        // Periodic Cleanup (Memory Management)
        // Only splice if array gets too big to prevent memory leak
        if (cvd.headIndex > 1000) {
            cvd.queue = cvd.queue.slice(cvd.headIndex);
            cvd.headIndex = 0;
        }

        if (cvd.buySum < 0) cvd.buySum = 0;
        if (cvd.sellSum < 0) cvd.sellSum = 0;
    }

    getInstantCVD(asset, signalSide) {
        const cvd = this.cvdState[asset];
        const total = cvd.buySum + cvd.sellSum;
        if (total <= 0) return false; 
        if (signalSide === 'buy') return (cvd.buySum / total) >= this.CVD_THRESHOLD;
        else return (cvd.sellSum / total) >= this.CVD_THRESHOLD;
    }

    // --- THRESHOLD UPDATE ---
    updateThresholds() {
        Object.keys(this.specs).forEach(asset => {
            const count = this.zCount[asset];
            if (count < 1000) return; 

            // Standard Sort is unavoidable for precise Quantile without complex deps
            // But we do it every 5s, which is acceptable.
            const view = this.zBuffer[asset].subarray(0, count);
            const sorted = Float32Array.from(view).sort();
            const index = Math.floor(sorted.length * this.QUANTILE_RANK);
            const newThreshold = sorted[index];

            this.dynamicThresholds[asset] = Math.max(newThreshold, this.MIN_THRESHOLD_FLOOR);
        });
    }

    async onDepthUpdate(asset, depth) {
        if (!this.specs[asset]) return;
        const now = Date.now();
        const spec = this.specs[asset];

        // 1. VWMP CALCULATION (Weighted Mid Price)
        // This is the FIX for Spread Widening Fakeouts
        const bestBid = parseFloat(depth.bids[0][0]);
        const bidQty  = parseFloat(depth.bids[0][1]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const askQty  = parseFloat(depth.asks[0][1]);

        // FIX: Zero Div Guard
        const totalBookQty = bidQty + askQty;
        if (totalBookQty <= 0) return;

        // VWMP = (Bid*AskQty + Ask*BidQty) / TotalQty
        // Logic: If AskQty is huge, price is pressured down towards Bid.
        const currentPrice = ((bestBid * askQty) + (bestAsk * bidQty)) / totalBookQty;

        this.checkEdgeDecay(asset, now, bestBid, bestAsk);

        const history = this.history[asset];
        history.push({ p: currentPrice, t: now });
        if (history.length > 250) history.shift(); 

        const targetTime = now - this.WINDOW_MS;
        let prevTick = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].t <= targetTime) {
                prevTick = history[i];
                break; 
            }
        }
        
        if (!prevTick) return;

        // 2. Volatility
        const rawReturn = (currentPrice - prevTick.p) / prevTick.p;
        const volState = this.volState[asset];
        
        let dt = now - volState.lastTime;
        volState.lastTime = now;

        if (dt > 0) {
            const clampedDt = Math.min(dt, this.MAX_DT_MS);
            const weight = Math.exp(-this.VOL_LAMBDA * clampedDt);
            volState.variance = (volState.variance * weight) + ((rawReturn ** 2) * (1 - weight));
        }
        
        const sigma = Math.sqrt(volState.variance);
        const effectiveSigma = Math.max(sigma, spec.minSigma); 
        
        const zScore = rawReturn / effectiveSigma;
        const absZ = Math.abs(zScore);
        
        // 3. ADAPTIVE LOGIC SPLIT
        
        // A. Memory Path (Winsorized at 6.0)
        const winsorizedZ = Math.min(absZ, this.MEMORY_CLIPPING_LIMIT);
        const ptr = this.zPointer[asset];
        this.zBuffer[asset][ptr] = winsorizedZ;
        this.zPointer[asset] = (ptr + 1) % this.BUFFER_SIZE;
        if (this.zCount[asset] < this.BUFFER_SIZE) this.zCount[asset]++;

        if (now - this.startTime < this.WARMUP_MS) return;

        // B. Execution Path (Raw Z)
        const threshold = this.dynamicThresholds[asset];
        const state = this.triggerState[asset];

        if (absZ > threshold) {
            if (!state.isFiring) {
                
                let side = null;
                let executionPrice = currentPrice; 

                // Use simple book imbalance for direction confirmation
                if (zScore > 0 && (bidQty / totalBookQty) >= this.IMBALANCE_THRESHOLD) {
                    side = 'buy';
                    executionPrice = bestAsk; // Aggress on Ask
                }
                else if (zScore < 0 && (askQty / totalBookQty) >= this.IMBALANCE_THRESHOLD) {
                    side = 'sell';
                    executionPrice = bestBid; // Aggress on Bid
                }

                if (side) {
                    // Check CVD
                    const cvdConfirmed = this.getInstantCVD(asset, side);
                    if (cvdConfirmed) {
                        state.isFiring = true; 
                        
                        const sigId = `z19_${now}`;
                        this.logger.info(`[SIGNAL ${asset}] ⚡ Z=${zScore.toFixed(2)} (T:${threshold.toFixed(2)}) | VWMP:${currentPrice.toFixed(2)}`);
                        
                        this.pendingSignals.push({
                            id: sigId,
                            asset: asset,
                            side: side,
                            entryPrice: executionPrice, 
                            time: now,
                            z: zScore,
                            checked50: false,
                            checked100: false
                        });

                        this.executeFast(asset, side, executionPrice, sigId);
                    }
                }
            }
        } else if (absZ < (threshold * this.RESET_THRESHOLD_RATIO)) {
            state.isFiring = false; 
        }
    }

    // --- UTILITIES ---
    checkEdgeDecay(asset, now, bestBid, bestAsk) {
        for (let i = this.pendingSignals.length - 1; i >= 0; i--) {
            const sig = this.pendingSignals[i];
            if (sig.asset !== asset) continue;
            
            const age = now - sig.time;
            if (age > 150) {
                this.pendingSignals.splice(i, 1);
                continue;
            }
            const exitPrice = sig.side === 'buy' ? bestBid : bestAsk;
            if (!sig.checked50 && age >= 50) {
                this.logEdge(sig, 50, exitPrice);
                sig.checked50 = true;
            }
            if (!sig.checked100 && age >= 100) {
                this.logEdge(sig, 100, exitPrice);
                sig.checked100 = true;
            }
        }
    }

    logEdge(sig, duration, exitPrice) {
        const rawMove = (exitPrice - sig.entryPrice) / sig.entryPrice;
        const pnlPct = sig.side === 'buy' ? rawMove : -rawMove;
        // this.logger.info(`[EDGE ${duration}ms] ${sig.asset} | Result: ${(pnlPct * 10000).toFixed(2)} bps`);
    }

    startHeartbeat() {
        setInterval(() => {
            const now = Date.now();
            const elapsed = now - this.startTime;
            
            let anyData = false;
            Object.keys(this.specs).forEach(asset => {
                const count = this.zCount[asset];
                const cvd = this.cvdState[asset];
                
                if (count > 0) {
                     anyData = true;
                     const isWarm = elapsed > this.WARMUP_MS;
                     const status = isWarm ? "🟢 ACTIVE" : "⏳ WARMUP";
                     const cvdVol = cvd ? (cvd.buySum + cvd.sellSum).toFixed(2) : "0";
                     
                     this.logger.info(`[${asset}] ${status} | Z-Thresh: ${this.dynamicThresholds[asset].toFixed(2)}σ | CVD: ${cvdVol}`);
                }
            });

            if (!anyData) {
                this.logger.info(`[Heartbeat] Alive but WAITING for Data...`);
            }

        }, 10000); 
    }

    executeFast(asset, side, price, orderId) {
        if (this.bot.hasOpenPosition(asset)) return;
        
        const now = Date.now();
        // FIX: Reduced Cooldown from 1000ms to 50ms (Double-tap enabled)
        if (now - this.triggerState[asset].lastFire < 50) return; 
        this.triggerState[asset].lastFire = now;

        const spec = this.specs[asset];
        let slPrice, tpPrice;

        if (side === 'buy') {
            slPrice = price * (1 - this.SL_PCT);
            tpPrice = price * (1 + this.TP_PCT);
        } else {
            slPrice = price * (1 + this.SL_PCT);
            tpPrice = price * (1 - this.TP_PCT);
        }

        const payload = {
            product_id: spec.deltaId.toString(),
            side: side,
            size: process.env.ORDER_SIZE || "1",
            order_type: 'market_order',
            client_order_id: orderId,
            bracket_stop_loss_price: slPrice.toFixed(spec.precision),
            bracket_take_profit_price: tpPrice.toFixed(spec.precision),
            bracket_stop_trigger_method: 'last_traded_price'
        };

        this.logger.info(`[Sniper] 🔫 FIRE ${asset} ${side} @ ${price}`);
        
        this.bot.placeOrder(payload).catch(e => {
            this.logger.error(`Order Failed: ${e.message}`);
        });
    }

    onLaggerTrade(trade) {}
    onPositionClose(asset) {}
    getName() { return "LeadStrategy (Production v19)"; }
}

module.exports = LeadStrategy;
                
