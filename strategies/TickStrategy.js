/**
 * TickStrategy.js
 * v12.3 - AUTO-CALIBRATED HARMONIC ARCHITECTURE (GLASS BOX)
 * * * * QUANTITATIVE LOGIC:
 * 1. Auto-Tuner: Converts "Minutes" -> "HFT Ticks" based on ~400 TPS (Rust/Delta).
 * 2. Contrast: 1m Fast Window vs 15m Slow Window for maximum Regime sensitivity.
 * 3. Sniper Mode: Base Z-Score = 3.0 (Top 0.1% signals) to reduce false positives.
 * 4. Microprice Vector: Confirms OBI direction using volume-weighted mid-price.
 * 5. Dynamic Warmup: Fast-Start math eliminates long wait times; adapts Alpha instantly.
 * * * * ARCHITECTURE:
 * - "Glass Box" Logging: Heartbeat runs every 5s to show internal math (Mean, Volatility, Ratio).
 * - Dual Welford Accumulators: Tracks Fast (Signal) and Slow (Baseline) variance efficiently.
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
        
        // Risk Settings
        this.TRAILING_PERCENT = 0.02; 

        // Exchange Config (Delta ID Mappings)
        // NOTE: Keys here must match the Normalized Symbol (e.g. 'BTC', not 'BTCUSDT')
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};
        this.seenSymbols = new Set(); // For debug logging
        
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

    /**
     * Required by TradingBot to identify the strategy.
     */
    getName() {
        return 'TickStrategy (v12.3)';
    }

    /**
     * Starts the Glass Box Heartbeat.
     * Logs internal state every 5 seconds.
     */
    async start() {
        this.logger.info(`[STRATEGY START] TickStrategy Engine Active.`);
        this.logger.info(`[STRATEGY CONFIG] Warmup Target: ${this.WARMUP_TICKS} ticks per asset.`);
        
        setInterval(() => {
            this.logHeartbeat();
        }, 5000);
    }

    /**
     * Logs the internal math state of all assets.
     * Helps visualization of "What the bot is thinking".
     */
    logHeartbeat() {
        let activeAssets = 0;

        for (const symbol in this.assets) {
            const asset = this.assets[symbol];
            
            // Skip totally dead assets
            if (asset.tickCounter === 0) continue;

            activeAssets++;

            const fastVol = Math.sqrt(asset.fastObiVar).toFixed(5);
            const slowVol = Math.sqrt(asset.slowObiVar).toFixed(5);
            const mean = asset.obiMean.toFixed(4);
            const ratio = asset.regimeRatio.toFixed(2);
            
            // Calculate Warmup Percentage
            const pct = Math.min((asset.tickCounter / this.WARMUP_TICKS) * 100, 100);
            const statusTag = (pct < 100) ? `[⏳ WARMUP ${pct.toFixed(1)}%]` : `[🟢 ACTIVE]`;

            this.logger.info(
                `${statusTag} ${symbol} | Ticks: ${asset.tickCounter} | ` +
                `Mean: ${mean} | Vol(F/S): ${fastVol}/${slowVol} | Ratio: ${ratio}x`
            );
        }

        if (activeAssets === 0) {
            // If this persists, check the "Symbol Mismatch" logs in onDepthUpdate
            this.logger.info(`[💓 HB] Waiting for market data... (No ticks mapped yet)`);
        }
    }

    /**
     * Main Tick Processor
     * Called by the Bot/Trader on every Level 1 update.
     */
    async onDepthUpdate(depth) {
        let { symbol, bestBid, bestAsk, bestBidSize, bestAskSize } = depth;
        
        // --- 0. SYMBOL NORMALIZATION & DEBUG ---
        
        // Trap: Log the FIRST time we see a raw symbol to debug mismatches
        if (!this.seenSymbols.has(symbol)) {
            this.logger.info(`[DATA INCOMING] Received Raw Symbol: '${symbol}'`);
            this.seenSymbols.add(symbol);
        }

        // Clean symbol: "BTCUSDT" -> "BTC", "XRPUSD" -> "XRP"
        const cleanSymbol = symbol.replace('USDT', '').replace('USD', '');

        // Check if we trade this asset
        if (!this.assets[cleanSymbol]) {
            // Optional: Log once if we are ignoring a symbol we might want
            // this.logger.debug(`Ignored symbol: ${symbol} -> ${cleanSymbol}`);
            return;
        }
        
        const asset = this.assets[cleanSymbol];

        // Log successful mapping ONCE
        if (asset.tickCounter === 0) {
             this.logger.info(`[DATA CONNECTED] Mapped '${symbol}' -> '${cleanSymbol}'. Engine Starting.`);
        }

        // --- 1. STATE SYNC ---
        // If the bot says we have no position, unlock the strategy
        if (!this.bot.activePositions[cleanSymbol]) {
            asset.currentRegime = 0;
        }

        // --- 2. DATA INGESTION ---
        asset.tickCounter++;
        const midPrice = (bestBid + bestAsk) / 2;
        const totalVol = bestBidSize + bestAskSize;
        
        if (totalVol === 0) return;

        // OBI (Order Book Imbalance): -1.0 (Sell) to 1.0 (Buy)
        const obi = (bestBidSize - bestAskSize) / totalVol;

        // Microprice: Volume-Weighted Mid Price
        const microPrice = (bestAsk * bestBidSize + bestBid * bestAskSize) / totalVol;

        // --- 3. DUAL WELFORD PROCESSOR ---
        
        // Dynamic Alpha: Speeds up "Slow" mean calculation during early ticks
        const dynamicSlowAlpha = Math.max(this.ALPHA_SLOW, 1 / asset.tickCounter);

        const delta = obi - asset.obiMean;
        
        // Update Mean
        asset.obiMean += dynamicSlowAlpha * delta;

        // Update Variances (Skip tick 1)
        if (asset.tickCounter > 1) {
            // Fast Variance (Signal)
            asset.fastObiVar = (1 - this.ALPHA_FAST) * (asset.fastObiVar + this.ALPHA_FAST * delta * delta);
            
            // Slow Variance (Baseline)
            asset.slowObiVar = (1 - dynamicSlowAlpha) * (asset.slowObiVar + dynamicSlowAlpha * delta * delta);
        }

        // --- 4. WARMUP GATE ---
        // Stop here if we don't have enough data for statistically valid Z-Scores
        if (asset.tickCounter < this.WARMUP_TICKS) {
            return; 
        }

        // --- 5. REGIME CALCULATION ---
        const fastVol = Math.sqrt(asset.fastObiVar);
        const slowVol = Math.sqrt(asset.slowObiVar);
        
        // Regime Ratio > 1.0 implies High Volatility (Chaos)
        asset.regimeRatio = (slowVol > 1e-9) ? (fastVol / slowVol) : 1.0;
        
        // Dynamic Scaler: Increases required Z-Score during chaos
        const dynamicScaler = Math.min(Math.max(asset.regimeRatio, 0.5), 3.0);

        // --- 6. SIGNAL GENERATION ---
        const zScore = (fastVol > 1e-9) ? (obi - asset.obiMean) / fastVol : 0;
        const requiredZ = this.BASE_ENTRY_Z * dynamicScaler;

        const isMicroUp = microPrice > midPrice;
        const isMicroDown = microPrice < midPrice;

        // --- 7. EXECUTION ---
        if (asset.currentRegime === 0 && !this.bot.activePositions[cleanSymbol]) {
            
            // BUY SIGNAL
            if (zScore > requiredZ && isMicroUp) {
                this.logger.info(`[SIGNAL BUY] ${cleanSymbol} | Z: ${zScore.toFixed(2)} | Ratio: ${dynamicScaler.toFixed(2)} | Price: ${midPrice}`);
                await this.executeTrade(cleanSymbol, 'buy', midPrice);
            } 
            // SELL SIGNAL
            else if (zScore < -requiredZ && isMicroDown) {
                this.logger.info(`[SIGNAL SELL] ${cleanSymbol} | Z: ${zScore.toFixed(2)} | Ratio: ${dynamicScaler.toFixed(2)} | Price: ${midPrice}`);
                await this.executeTrade(cleanSymbol, 'sell', midPrice);
            }
        }
    }

    async executeTrade(symbol, side, entryPrice) {
        const asset = this.assets[symbol];
        
        // Lock Strategy State
        asset.currentRegime = (side === 'buy') ? 1 : -1;

        const size = this.bot.config.orderSize || 100; 

        // Trailing Stop Calculation
        const trailAmount = entryPrice * (this.TRAILING_PERCENT / 100);
        const finalTrail = trailAmount.toFixed(asset.precision);
        const clientOid = `TICK_${Date.now()}`;

        try {
            this.logger.info(`[EXEC] ${symbol} ${side.toUpperCase()} @ ${entryPrice} | Trail: ${finalTrail}`);

            const payload = {
                product_id: asset.deltaId,
                size: size,
                side: side,
                order_type: 'market_order',
                client_order_id: clientOid,
                bracket_trail_amount: finalTrail.toString(), 
                bracket_stop_trigger_method: 'last_traded_price' 
            };

            const result = await this.bot.placeOrder(payload);

            if (result && result.success) {
                this.logger.info(`[FILLED] ${symbol} ${side} | ID: ${result.id}`);
            } else {
                // Handle "Position Exists" specifically to sync state
                const errorStr = JSON.stringify(result || {});
                if (errorStr.includes("bracket_order_position_exists")) {
                    this.logger.warn(`[STRATEGY] ${symbol} Position exists. Syncing state.`);
                    this.bot.activePositions[symbol] = true; 
                } else {
                    this.logger.error(`[ORDER FAIL] ${symbol} | ${errorStr}`);
                    asset.currentRegime = 0; // Unlock on failure
                }
            }

        } catch (error) {
            this.logger.error(`[EXEC EXCEPTION] ${error.message}`);
            asset.currentRegime = 0;
        }
    }
}

module.exports = TickStrategy;
    
