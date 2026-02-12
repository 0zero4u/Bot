/**
 * ============================================================================
 * LEAD STRATEGY v11: FINAL REFINEMENT
 * * Fixes: zCount clamping (Log hygiene).
 * * Verified: Ring Buffer Set Theory (Validates O(1) insertion).
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.WARMUP_MS = 60000;
        this.WINDOW_MS = 30;             
        this.IMBALANCE_THRESHOLD = 0.30; 
        
        // --- VOLATILITY CONFIG (Time Based) ---
        this.VOL_HALF_LIFE_MS = 1000;    
        this.VOL_LAMBDA = Math.LN2 / this.VOL_HALF_LIFE_MS; 
        this.MAX_DT_MS = 100; // Clamp prevents volatility collapse on lag

        // --- ADAPTIVE THRESHOLD ---
        this.QUANTILE_RANK = 0.9995;      
        this.BUFFER_SIZE = 30000;        
        this.UPDATE_INTERVAL_MS = 3000;  
        this.MIN_THRESHOLD_FLOOR = 4.0;  
        this.RESET_THRESHOLD_RATIO = 0.8; 

        this.assets = {
            'XRP': { deltaId: 14969 }, 
            'BTC': { deltaId: 27 },    
            'ETH': { deltaId: 299 },
            'SOL': { deltaId: 417 }
        };

        // --- STATE ---
        this.startTime = Date.now();
        this.history = {};      
        this.volState = {};     
        
        // Ring Buffers
        this.zBuffer = {};      
        this.zPointer = {};     
        this.zCount = {};       
        
        this.dynamicThresholds = {}; 
        this.triggerState = {}; 
        this.pendingSignals = []; 

        // Init
        Object.keys(this.assets).forEach(a => {
            this.history[a] = [];
            this.volState[a] = { variance: 0.000001, lastTime: Date.now() };
            
            this.zBuffer[a] = new Float32Array(this.BUFFER_SIZE); 
            this.zPointer[a] = 0;
            this.zCount[a] = 0;

            this.dynamicThresholds[a] = 5.0; 
            this.triggerState[a] = { isFiring: false, lastFire: 0 };
        });

        this.logger.info(`[LeadStrategy v11] 🛡️ Ready. Buffer: ${this.BUFFER_SIZE} ticks.`);

        setInterval(() => this.updateThresholds(), this.UPDATE_INTERVAL_MS);
        this.startHeartbeat();
    }

    /**
     * 🐢 Update Thresholds
     * Mathematical Note:
     * A Ring Buffer of size N, once full, ALWAYS contains exactly the last N items.
     * The order (chronological vs wrapped) DOES NOT affect the Percentile/Quantile.
     * We do NOT need to reconstruct the array. Sorting the raw buffer is valid.
     */
    updateThresholds() {
        Object.keys(this.assets).forEach(asset => {
            const count = this.zCount[asset];
            if (count < 500) return; 

            // If count < BUFFER_SIZE, we take 0..count
            // If count == BUFFER_SIZE, we take 0..BUFFER_SIZE (Whole Array)
            // Note: zCount is now clamped, so it never exceeds BUFFER_SIZE
            const view = this.zBuffer[asset].subarray(0, count);
            
            // Create copy to sort (Float32Array.sort is optimized)
            const sorted = Float32Array.from(view).sort();
            
            const index = Math.floor(sorted.length * this.QUANTILE_RANK);
            const newThreshold = sorted[index];

            this.dynamicThresholds[asset] = Math.max(newThreshold, this.MIN_THRESHOLD_FLOOR);
        });
    }

    startHeartbeat() {
        setInterval(() => {
            const now = Date.now();
            const elapsed = now - this.startTime;
            const isWarmingUp = elapsed < this.WARMUP_MS;
            
            Object.keys(this.assets).forEach(asset => {
                if (this.zCount[asset] > 0) {
                     let status = isWarmingUp ? `⏳ WARMUP` : "🟢 ACTIVE";
                     const vol = Math.sqrt(this.volState[asset].variance);
                     
                     this.logger.info(
                        `[${asset}] ${status} | Z-Thresh: ${this.dynamicThresholds[asset].toFixed(2)}σ | Vol: ${(vol*100).toFixed(4)}% | N=${this.zCount[asset]}`
                    );
                }
            });
        }, 5000); 
    }

    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;
        const now = Date.now();
        const currentPrice = (parseFloat(depth.bids[0][0]) + parseFloat(depth.asks[0][0])) / 2;

        this.checkEdgeDecay(asset, now, currentPrice);

        // --- HISTORY MANIPULATION ---
        const history = this.history[asset];
        history.push({ p: currentPrice, t: now });
        if (history.length > 250) history.shift(); 

        // Scan backwards (Linear Scan - Fast for N=250)
        const targetTime = now - this.WINDOW_MS;
        let prevTick = null;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].t <= targetTime) {
                prevTick = history[i];
                break; // Found it, stop scanning
            }
        }
        
        // If we don't have enough history yet, exit
        if (!prevTick) return;

        // --- TIME-BASED VOLATILITY ---
        const rawReturn = (currentPrice - prevTick.p) / prevTick.p;
        const volState = this.volState[asset];
        
        let dt = now - volState.lastTime;
        volState.lastTime = now;

        if (dt > 0) {
            // Clamp DT to prevent Volatility Collapse
            const clampedDt = Math.min(dt, this.MAX_DT_MS);
            const weight = Math.exp(-this.VOL_LAMBDA * clampedDt);
            volState.variance = (volState.variance * weight) + ((rawReturn ** 2) * (1 - weight));
        }
        
        const sigma = Math.sqrt(volState.variance);
        const effectiveSigma = Math.max(sigma, 0.00005); 
        
        const zScore = rawReturn / effectiveSigma;
        const absZ = Math.abs(zScore);
        
        // --- RING BUFFER WRITE ---
        const ptr = this.zPointer[asset];
        this.zBuffer[asset][ptr] = absZ;
        
        // Advance Pointer
        this.zPointer[asset] = (ptr + 1) % this.BUFFER_SIZE;
        
        // Clamp Count (Fixes "N never stops increasing")
        if (this.zCount[asset] < this.BUFFER_SIZE) {
            this.zCount[asset]++;
        }

        if (now - this.startTime < this.WARMUP_MS) return;

        // --- TRIGGER LOGIC ---
        const threshold = this.dynamicThresholds[asset];
        const state = this.triggerState[asset];

        if (absZ > threshold) {
            if (!state.isFiring) {
                state.isFiring = true; 
                
                const bidQty = parseFloat(depth.bids[0][1]);
                const askQty = parseFloat(depth.asks[0][1]);
                const totalQty = bidQty + askQty;

                let side = null;
                if (zScore > 0 && (bidQty / totalQty) >= this.IMBALANCE_THRESHOLD) side = 'buy';
                else if (zScore < 0 && (askQty / totalQty) >= this.IMBALANCE_THRESHOLD) side = 'sell';

                if (side) {
                    const sigId = `z11_${now}`;
                    this.logger.info(`[SIGNAL ${asset}] ⚡ IMPULSE! Z=${zScore.toFixed(2)} > ${threshold.toFixed(2)}`);
                    
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

                    await this.tryExecute(asset, side, currentPrice, sigId);
                }
            }
        } else if (absZ < (threshold * this.RESET_THRESHOLD_RATIO)) {
            state.isFiring = false; 
        }
    }

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
        const icon = pnlPct > 0 ? '🟢' : '🔴';
        this.logger.info(`[EDGE ${duration}ms] ${icon} ${sig.asset} | Z: ${sig.z.toFixed(1)} | Result: ${(pnlPct * 10000).toFixed(2)} bps`);
    }

    async tryExecute(asset, side, price, orderId) {
        if (this.bot.hasOpenPosition(asset)) return;
        const now = Date.now();
        if (now - this.triggerState[asset].lastFire < 1000) return; 
        this.triggerState[asset].lastFire = now;

        const spec = this.assets[asset];
        const payload = {
            product_id: spec.deltaId.toString(),
            side: side,
            size: process.env.ORDER_SIZE || "1",
            order_type: 'market_order',
            client_order_id: orderId
        };
        this.logger.info(`[Sniper] 🔫 FIRE ${asset} ${side.toUpperCase()} @ ${price}`);
        
        try {
            await this.bot.placeOrder(payload);
        } catch(e) {
            this.logger.error(`Order Failed: ${e.message}`);
        }
    }

    // --- INTERFACE METHODS ---
    onLaggerTrade(trade) {}
    onPositionClose(asset) {}
    getName() { return "LeadStrategy (Velocity v11)"; }
}

module.exports = LeadStrategy;
                                          
