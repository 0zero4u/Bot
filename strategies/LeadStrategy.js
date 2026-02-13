/**
 * ============================================================================
 * LEAD STRATEGY v16: HYBRID (ALIGNED)
 * * Base Logic: 30ms Rolling Window Return
 * * Filter: Zero-Latency CVD Accumulator (Active)
 * * Status: Heartbeat visible every 10s
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. CONFIGURATION ---
        this.WARMUP_MS = 100000;         
        this.WINDOW_MS = 30;             
        this.IMBALANCE_THRESHOLD = 0.60; 
        
        // --- 2. CVD FILTER CONFIG ---
        this.CVD_WINDOW_MS = 100;        
        this.CVD_THRESHOLD = 0.60;       
        
        // --- 3. RISK MANAGEMENT ---
        this.SL_PCT = 0.00015; 
        this.TP_PCT = 0.00160; 
        
        // --- 4. VOLATILITY CONFIG ---
        this.VOL_HALF_LIFE_MS = 1000;    
        this.VOL_LAMBDA = Math.LN2 / this.VOL_HALF_LIFE_MS; 
        this.MAX_DT_MS = 100;

        // --- 5. ADAPTIVE THRESHOLD ---
        this.QUANTILE_RANK = 0.9995;      
        this.BUFFER_SIZE = 200000;        
        this.UPDATE_INTERVAL_MS = 1500;  
        this.MIN_THRESHOLD_FLOOR = 3.0;  
        this.RESET_THRESHOLD_RATIO = 0.8; 

        // --- MASTER CONFIG ---
        this.specs = {
            'BTC': { deltaId: 27,    precision: 1 },
            'ETH': { deltaId: 299,   precision: 2 },
            'SOL': { deltaId: 417,   precision: 3 },
            'XRP': { deltaId: 14969, precision: 4 }
        };

        // --- STATE INITIALIZATION ---
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
            this.dynamicThresholds[a] = 5.0; 
            this.triggerState[a] = { isFiring: false, lastFire: 0 };
            
            // CVD State Init
            this.cvdState[a] = {
                queue: [],
                buySum: 0,
                sellSum: 0
            };
        });

        this.logger.info(`[LeadStrategy v16] 🛡️ Ready. Waiting for Data...`);

        setInterval(() => this.updateThresholds(), this.UPDATE_INTERVAL_MS);
        this.startHeartbeat();
    }

    // ============================================================
    // PART 1: CVD INGESTION (Now actively fed by Trader)
    // ============================================================
    onExternalTrade(trade) {
        const cvd = this.cvdState[trade.s];
        if (!cvd) return;

        const now = trade.t;
        const qty = trade.q;

        // 1. Add to Accumulator
        if (trade.side === 'buy') {
            cvd.buySum += qty;
            cvd.queue.push({ t: now, q: qty, s: 1 });
        } else {
            cvd.sellSum += qty;
            cvd.queue.push({ t: now, q: qty, s: -1 });
        }

        // 2. Prune Old Trades (Rolling Window)
        const cutoff = now - this.CVD_WINDOW_MS;
        while (cvd.queue.length > 0 && cvd.queue[0].t < cutoff) {
            const old = cvd.queue.shift();
            if (old.s === 1) cvd.buySum -= old.q;
            else cvd.sellSum -= old.q;
        }
        
        // 3. Float Safety
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

    // ============================================================
    // PART 2: CORE LOGIC
    // ============================================================
    updateThresholds() {
        Object.keys(this.specs).forEach(asset => {
            const count = this.zCount[asset];
            if (count < 500) return; 

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
        
        // 1. Price Calculation
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const currentPrice = (bestBid + bestAsk) / 2; 

        this.checkEdgeDecay(asset, now, currentPrice);

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

        // 4. Volatility Calculation
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
        const effectiveSigma = Math.max(sigma, 0.00005); 
        
        const zScore = rawReturn / effectiveSigma;
        const absZ = Math.abs(zScore);
        
        // 5. Update Z-Score Buffer
        const ptr = this.zPointer[asset];
        this.zBuffer[asset][ptr] = absZ;
        this.zPointer[asset] = (ptr + 1) % this.BUFFER_SIZE;
        if (this.zCount[asset] < this.BUFFER_SIZE) this.zCount[asset]++;

        if (now - this.startTime < this.WARMUP_MS) return;

        // 6. TRIGGER LOGIC
        const threshold = this.dynamicThresholds[asset];
        const state = this.triggerState[asset];

        if (absZ > threshold) {
            if (!state.isFiring) {
                
                const bidQty = parseFloat(depth.bids[0][1]);
                const askQty = parseFloat(depth.asks[0][1]);
                const totalQty = bidQty + askQty;

                let side = null;
                let executionPrice = currentPrice; 

                // A. Check Direction & Book Imbalance
                if (zScore > 0 && (bidQty / totalQty) >= this.IMBALANCE_THRESHOLD) {
                    side = 'buy';
                    executionPrice = bestAsk; 
                }
                else if (zScore < 0 && (askQty / totalQty) >= this.IMBALANCE_THRESHOLD) {
                    side = 'sell';
                    executionPrice = bestBid; 
                }

                if (side) {
                    // B. Check CVD Filter
                    const cvdConfirmed = this.getInstantCVD(asset, side);
                    
                    if (cvdConfirmed) {
                        state.isFiring = true; 
                        
                        const sigId = `z16_${now}`;
                        this.logger.info(`[SIGNAL ${asset}] ⚡ IMPULSE! Z=${zScore.toFixed(2)} | CVD: OK ✅`);
                        
                        this.pendingSignals.push({
                            id: sigId,
                            asset: asset,
                            side: side,
                            entryPrice: currentPrice, 
                            time: now,
                            z: zScore,
                            checked50: false,
                            checked100: false
                        });

                        await this.tryExecute(asset, side, executionPrice, sigId);
                    }
                }
            }
        } else if (absZ < (threshold * this.RESET_THRESHOLD_RATIO)) {
            state.isFiring = false; 
        }
    }

    // ============================================================
    // PART 3: UTILITIES & EXECUTION
    // ============================================================
    checkEdgeDecay(asset, now, currentPrice) {
        for (let i = this.pendingSignals.length - 1; i >= 0; i--) {
            const sig = this.pendingSignals[i];
            if (sig.asset !== asset) continue;
            
            const age = now - sig.time;
            if (age > 150) {
                this.pendingSignals.splice(i, 1);
                continue;
            }

            if (!sig.checked50 && age >= 50) {
                this.logEdge(sig, 50, currentPrice);
                sig.checked50 = true;
            }
            if (!sig.checked100 && age >= 100) {
                this.logEdge(sig, 100, currentPrice);
                sig.checked100 = true;
            }
        }
    }

    logEdge(sig, duration, currentPrice) {
        const rawMove = (currentPrice - sig.entryPrice) / sig.entryPrice;
        const pnlPct = sig.side === 'buy' ? rawMove : -rawMove;
        // Optional: Enable to see trade performance in logs
        // const icon = pnlPct > 0 ? '🟢' : '🔴';
        // this.logger.info(`[EDGE ${duration}ms] ${icon} ${sig.asset} | Result: ${(pnlPct * 10000).toFixed(2)} bps`);
    }

    startHeartbeat() {
        setInterval(() => {
            const now = Date.now();
            const elapsed = now - this.startTime;
            const isWarmingUp = elapsed < this.WARMUP_MS;
            
            let anyData = false;
            
            Object.keys(this.specs).forEach(asset => {
                const count = this.zCount[asset];
                const cvd = this.cvdState[asset];
                
                // Only log if we have data OR to show we are alive but waiting
                if (count > 0) {
                     anyData = true;
                     let status = isWarmingUp ? `⏳ WARMUP` : "🟢 ACTIVE";
                     const vol = Math.sqrt(this.volState[asset].variance);
                     const cvdVol = cvd ? (cvd.buySum + cvd.sellSum).toFixed(2) : "0";
                     
                     this.logger.info(`[${asset}] ${status} | Z-Thresh: ${this.dynamicThresholds[asset].toFixed(2)}σ | CVD Vol: ${cvdVol}`);
                }
            });

            if (!anyData) {
                this.logger.info(`[Heartbeat] Alive but WAITING for Data... (Check Market Listener Connection)`);
            }

        }, 10000); // 10s Heartbeat
    }

    async tryExecute(asset, side, price, orderId) {
        if (this.bot.hasOpenPosition(asset)) return;
        const now = Date.now();
        
        if (now - this.triggerState[asset].lastFire < 1000) return; 
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
        
        try {
            await this.bot.placeOrder(payload);
        } catch(e) {
            this.logger.error(`Order Failed: ${e.message}`);
        }
    }

    onLaggerTrade(trade) {}
    onPositionClose(asset) {}
    getName() { return "LeadStrategy (Hybrid v16)"; }
}

module.exports = LeadStrategy;
            
