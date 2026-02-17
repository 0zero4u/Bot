/**
 * TickStrategy.js
 * v12.1 - AUTO-CALIBRATED HARMONIC ARCHITECTURE
 * * * QUANT IMPROVEMENTS:
 * 1. Auto-Tuner: Converts "Minutes" -> "HFT Ticks" based on 400 TPS.
 * 2. Contrast: 1m Fast / 15m Slow for max Regime sensitivity.
 * 3. Sniper Mode: Base Z-Score = 3.0 (Top 0.1% signals).
 * 4. Microprice Vector: Confirms OBI direction with weighted price.
 * 5. Dynamic Warmup: Fast-Start math eliminates long wait times.
 * * * * LOGGING UPDATES (v12.1):
 * 1. Added getName() interface.
 * 2. Added Glass Box Heartbeat (5s interval) for state visibility.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. HUMAN CONFIGURATION (EDIT THIS) ---
        
        // How fast is the data? (Rust/Delta average is ~400 updates/sec)
        const EXPECTED_TPS = 400; 

        // Strategy Windows (In Minutes)
        // 1 Minute Fast Window = Sharp reaction to immediate liquidity gaps
        const FAST_WINDOW_MINS = 1;   
        // 15 Minute Slow Window = Stable baseline to measure "True Normality"
        const SLOW_WINDOW_MINS = 15;  

        
        // --- 2. AUTOMATIC QUANT TRANSLATION (DO NOT EDIT) ---
        
        // Convert Minutes -> Seconds -> Ticks
        this.FAST_TICKS = FAST_WINDOW_MINS * 60 * EXPECTED_TPS;
        this.SLOW_TICKS = SLOW_WINDOW_MINS * 60 * EXPECTED_TPS;

        // Calculate Alphas (1 / N) for Welford's Algorithm
        this.ALPHA_FAST = 1 / this.FAST_TICKS;
        this.ALPHA_SLOW = 1 / this.SLOW_TICKS;
        
        // Automatic Warmup: Wait exactly as long as the Fast Window to ensure valid variance
        this.WARMUP_TICKS = this.FAST_TICKS; 

        // Log the translated values for verification
        this.logger.info(`[STRATEGY INIT] Auto-Tuned for ${EXPECTED_TPS} TPS`);
        this.logger.info(`[STRATEGY INIT] Fast Window: ${FAST_WINDOW_MINS}m -> ${this.FAST_TICKS} ticks (Alpha: ${this.ALPHA_FAST.toFixed(8)})`);
        this.logger.info(`[STRATEGY INIT] Slow Window: ${SLOW_WINDOW_MINS}m -> ${this.SLOW_TICKS} ticks (Alpha: ${this.ALPHA_SLOW.toFixed(8)})`);


        // --- 3. CORE PARAMETERS ---
        
        // Base Z-Score (Aggressive 3.0 for Top 0.1% signals)
        // We only trade "Sniper" entries.
        this.BASE_ENTRY_Z = 3.0; 
        
        // Risk Settings (Preserved from original)
        this.TRAILING_PERCENT = 0.02; 

        // Exchange Config
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};
        
        // Initialize State
        for (const [symbol, details] of Object.entries(MASTER_CONFIG)) {
            this.assets[symbol] = {
                // Dual Welford States
                obiMean: 0,
                fastObiVar: 0,
                slowObiVar: 0,
                
                // Counters
                tickCounter: 0,
                
                // Regime Tracking
                regimeRatio: 1.0,
                
                // Order State
                currentRegime: 0, // 0=Neutral, 1=Long, -1=Short
                
                ...details
            };
        }
    }

    // --- INTERFACE METHODS (FIXED) ---

    getName() {
        return 'TickStrategy (v12.1 GlassBox)';
    }

    async start() {
        this.logger.info(`[STRATEGY START] TickStrategy Engine Active.`);
        
        // --- GLASS BOX HEARTBEAT ---
        // Logs internal state every 5 seconds so we know what the algo is "thinking"
        setInterval(() => {
            this.logHeartbeat();
        }, 5000);
    }

    logHeartbeat() {
        // Build a concise log line for each asset to monitor convergence
        for (const symbol in this.assets) {
            const asset = this.assets[symbol];
            
            // Skip logging if data hasn't started flowing
            if (asset.tickCounter === 0) continue;

            const fastVol = Math.sqrt(asset.fastObiVar).toFixed(5);
            const slowVol = Math.sqrt(asset.slowObiVar).toFixed(5);
            const mean = asset.obiMean.toFixed(4);
            const ratio = asset.regimeRatio.toFixed(2);
            const warmupPct = Math.min((asset.tickCounter / this.WARMUP_TICKS) * 100, 100).toFixed(1);

            this.logger.info(
                `[💓 HB] ${symbol} | Ticks: ${asset.tickCounter} (${warmupPct}%) | ` +
                `Mean: ${mean} | Vol(F/S): ${fastVol}/${slowVol} | Ratio: ${ratio}x | ` +
                `Regime: ${asset.currentRegime}`
            );
        }
    }

    /**
     * Main Tick Processor
     * Called by the Bot on every Level 1 update
     */
    async onDepthUpdate(depth) {
        const { symbol, bestBid, bestAsk, bestBidSize, bestAskSize } = depth;
        
        // Safety check for unknown assets
        if (!this.assets[symbol]) return;
        
        const asset = this.assets[symbol];

        // 0. STATE SYNC
        // If the bot says we have no position, unlock the strategy
        if (!this.bot.activePositions[symbol]) {
            asset.currentRegime = 0;
        }

        // 1. DATA INGESTION & CALCULATIONS
        asset.tickCounter++;
        const midPrice = (bestBid + bestAsk) / 2;
        const totalVol = bestBidSize + bestAskSize;
        
        // Prevent division by zero
        if (totalVol === 0) return;

        // OBI (Order Book Imbalance)
        // Range: -1.0 (Full Sell Pressure) to 1.0 (Full Buy Pressure)
        const obi = (bestBidSize - bestAskSize) / totalVol;

        // Microprice (Weighted Mid-Price)
        // Formula: (Ask * BidSize + Bid * AskSize) / Total
        // This tells us the "Center of Gravity" of the order book.
        const microPrice = (bestAsk * bestBidSize + bestBid * bestAskSize) / totalVol;

        // 2. DUAL WELFORD PROCESSOR (The Brain)
        
        // FAST START LOGIC:
        // During warmup, the Slow Alpha is too slow (it expects 15 mins of data).
        // We force it to adapt instantly by using 1/N until it catches up to the target Alpha.
        const dynamicSlowAlpha = Math.max(this.ALPHA_SLOW, 1 / asset.tickCounter);

        const delta = obi - asset.obiMean;
        
        // Update Mean (Center of Gravity)
        asset.obiMean += dynamicSlowAlpha * delta;

        // Update Variances (Skip tick 1 to avoid zero-variance artifacts)
        if (asset.tickCounter > 1) {
            // Update Fast Variance (Immediate Noise - 1 Minute)
            asset.fastObiVar = (1 - this.ALPHA_FAST) * (asset.fastObiVar + this.ALPHA_FAST * delta * delta);
            
            // Update Slow Variance (Baseline Noise - 15 Minutes)
            // We use dynamicSlowAlpha here too, ensuring the baseline establishes quickly
            asset.slowObiVar = (1 - dynamicSlowAlpha) * (asset.slowObiVar + dynamicSlowAlpha * delta * delta);
        }

        // 3. WARMUP GATE (Auto-Calculated)
        // We do not trade until the Fast Window (1 Minute) is fully populated.
        if (asset.tickCounter < this.WARMUP_TICKS) {
            // Log progress every 5000 ticks (approx 12s) to reduce log spam
            // (The Heartbeat handles visibility now, but we keep this for specific milestone logging)
            if (asset.tickCounter % 5000 === 0) {
                 this.logger.debug(`[WARMUP] ${symbol}: ${asset.tickCounter}/${this.WARMUP_TICKS} ticks`);
            }
            return; 
        }

        // 4. REGIME CALCULATION (The Harmony)
        const fastVol = Math.sqrt(asset.fastObiVar);
        const slowVol = Math.sqrt(asset.slowObiVar);
        
        // Regime Ratio = Current Noise / Normal Noise
        // Ratio > 1.0 = Volatility Expanding (Chaos)
        // Ratio < 1.0 = Volatility Compressing (Quiet)
        // Guard against zero division
        asset.regimeRatio = (slowVol > 1e-9) ? (fastVol / slowVol) : 1.0;
        
        // Clamp Ratio: 0.5x to 3.0x
        // If market is 3x more volatile than normal, we require 3x stronger signal.
        const dynamicScaler = Math.min(Math.max(asset.regimeRatio, 0.5), 3.0);

        // 5. SIGNAL GENERATION
        // Calculate Z-Score using Fast Volatility (Current Market State)
        const zScore = (fastVol > 1e-9) ? (obi - asset.obiMean) / fastVol : 0;
        
        // Dynamic Entry Threshold
        // Example: Base 3.0 * Scaler 1.0 = 3.0 (Required Z)
        // Example: Base 3.0 * Scaler 2.0 = 6.0 (Required Z during chaos)
        const requiredZ = this.BASE_ENTRY_Z * dynamicScaler;

        // Microprice Confirmation (Vector Alignment)
        // If OBI > 0 (Buy pressure), Microprice should be > MidPrice
        // This filters out "Thin Walls" where volume is high but value is low.
        const isMicroUp = microPrice > midPrice;
        const isMicroDown = microPrice < midPrice;

        // 6. EXECUTION LOGIC
        // Only trade if we are Neutral (Regime 0) and not currently managing a position
        if (asset.currentRegime === 0 && !this.bot.activePositions[symbol]) {
            
            // BUY SIGNAL
            if (zScore > requiredZ && isMicroUp) {
                this.logger.info(`[SIGNAL BUY] ${symbol} | Z: ${zScore.toFixed(2)} > ${requiredZ.toFixed(2)} | Ratio: ${dynamicScaler.toFixed(2)} | MicroPrice: OK`);
                await this.executeTrade(symbol, 'buy', midPrice);
            } 
            // SELL SIGNAL
            else if (zScore < -requiredZ && isMicroDown) {
                this.logger.info(`[SIGNAL SELL] ${symbol} | Z: ${zScore.toFixed(2)} < -${requiredZ.toFixed(2)} | Ratio: ${dynamicScaler.toFixed(2)} | MicroPrice: OK`);
                await this.executeTrade(symbol, 'sell', midPrice);
            }
        }
    }

    async executeTrade(symbol, side, entryPrice) {
        const asset = this.assets[symbol];
        
        // Lock the asset to prevent double entry
        asset.currentRegime = (side === 'buy') ? 1 : -1;

        // Calculate size (Standard logic)
        const size = this.bot.config.orderSize || 100; 

        // --- TRAILING STOP LOGIC ---
        // Calculate the Trailing Stop Amount based on the static percentage
        const trailAmount = entryPrice * (this.TRAILING_PERCENT / 100);
        
        // Format to correct precision for the exchange
        const finalTrail = trailAmount.toFixed(asset.precision);
        
        const clientOid = `TICK_${Date.now()}`;

        try {
            this.logger.info(`[EXEC] ${symbol} ${side.toUpperCase()} @ ${entryPrice} | Trail: ${finalTrail} (${this.TRAILING_PERCENT}%)`);

            const payload = {
                product_id: asset.deltaId,
                size: size,
                side: side,
                order_type: 'market_order',
                client_order_id: clientOid,
                
                // --- SAFETY + PROFIT MECHANISM ---
                bracket_trail_amount: finalTrail.toString(), 
                bracket_stop_trigger_method: 'last_traded_price' 
            };

            const result = await this.bot.placeOrder(payload);

            if (result && result.success) {
                this.logger.info(`[FILLED] ${symbol} ${side} | OrderID: ${result.id}`);
            } else {
                // FIX: Handle "Position Exists" specifically
                const errorStr = JSON.stringify(result || {});
                if (errorStr.includes("bracket_order_position_exists")) {
                    this.logger.warn(`[STRATEGY] ${symbol} Entry Rejected: Position already exists. Syncing state.`);
                    this.bot.activePositions[symbol] = true; // Force local state sync
                    // We leave asset.currentRegime locked so we don't spam
                } else {
                    this.logger.error(`[ORDER FAIL] ${symbol} ${side} | ${errorStr}`);
                    asset.currentRegime = 0; // Reset on genuine failure
                }
            }

        } catch (error) {
            this.logger.error(`[EXEC EXCEPTION] ${error.message}`);
            asset.currentRegime = 0;
        }
    }
}

module.exports = TickStrategy;
                                       
