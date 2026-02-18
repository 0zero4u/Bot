/**
 * TickStrategy.js
 * v13.4 - QUANTUM HARMONY (Zero-Lag OBI + Hard Brackets)
 * * * FEATURES ADDED:
 * 1. OMNIPRESENT GLASS LOG: Heartbeat runs every 5s regardless of bot state.
 * 2. TIME-SPACE STATIONARITY: EMAs use exact Δt (Delta time), immune to tick-rate fluctuations.
 * 3. CORRECTED Z-SCORE: Threshold mathematically anchored to slow volatility (No double-scaling).
 * 4. MICROSTRUCTURE GATES: Order Book Imbalance now uses 500ms Micro-EMA to defeat spoofing.
 * 5. EXCHANGE-LEVEL RISK: Replaced trailing stop with resting Bracket SL (1.5σ) and TP (2.5σ).
 * 6. RUST ALIGNMENT: Perfectly maps to lib.rs `DepthUpdate` struct (bb, ba, bq, aq).
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. HARMONIZED QUANT CONFIGURATION ---
        this.FAST_TAU_MS = 10000;   // 10 seconds for momentum burst
        this.SLOW_TAU_MS = 180000;  // 3 minutes for baseline mean/volatility
        this.WARMUP_MS = 180000;    // 3 minutes warmup

        // --- 2. THRESHOLDS & RISK GATES ---
        this.Z_BASE_ENTRY = 2.5;    // Standard Deviations required for breakout
        this.VOL_REGIME_MIN = 1.2;  // Fast Vol must be 20% higher than Slow Vol
        this.MIN_OBI = 0.30;        // 30% minimum order book imbalance
        this.SL_MULTIPLIER = 1.5;   // Hard Stop Loss distance (1.5 * slow volatility)
        this.TP_MULTIPLIER = 2.5;   // Hard Take Profit distance (2.5 * slow volatility)
        this.COOLDOWN_MS = 30000;   // 30s safety period post-trade

        // --- 3. RUST-ALIGNED ASSET INITIALIZATION ---
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};
        const now = Date.now();
        
        for (const [symbol, details] of Object.entries(MASTER_CONFIG)) {
            this.assets[symbol] = {
                isInitialized: false,
                lastTickMs: now,
                startTimeMs: now,
                muFast: 0,
                muSlow: 0,
                varFast: 0,
                varSlow: 0,
                emaObi: 0, // Micro-EMA to filter toxic HFT flow
                lastLogMs: now,
                cooldownUntil: 0,
                ...details
            };
        }
    }

    getName() {
        return 'TickStrategy_Quantum';
    }

    async start() {
        this.logger.info(`[STRATEGY] Starting ${this.getName()}...`);
        this.logger.info(`[STRATEGY] Quantum Parameters Loaded: FastTau=${this.FAST_TAU_MS}ms, SlowTau=${this.SLOW_TAU_MS}ms`);
        return true;
    }

    /**
     * ALIGNED ENTRY POINT: Matches the lib.rs N-API callback execution
     */
    async onDepthUpdate(depth) {
        const symbol = depth.s;
        if (!this.assets[symbol]) return;
        
        const asset = this.assets[symbol];
        const now = Date.now();

        // RUST PAYLOAD MAPPING (Matches lib.rs struct DepthUpdate)
        const bestBid = depth.bb;
        const bestAsk = depth.ba;
        const bidSize = depth.bq || 1; 
        const askSize = depth.aq || 1; 

        const midPrice = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;

        // 1. Initialize State on first tick
        if (!asset.isInitialized) {
            asset.lastTickMs = now;
            asset.startTimeMs = now;
            asset.muFast = midPrice;
            asset.muSlow = midPrice;
            asset.varFast = 0;
            asset.varSlow = 0;
            asset.emaObi = 0; 
            asset.lastLogMs = now;
            asset.isInitialized = true;
            this.logger.info(`[DATA FLOW] First tick received for ${symbol}. Engine starting.`);
            return;
        }

        // 2. Time-Decay (Δt) Alpha Calculation [O(1) continuous time math]
        const dtMs = Math.max(1, now - asset.lastTickMs);
        asset.lastTickMs = now;

        const alphaFast = 1 - Math.exp(-dtMs / this.FAST_TAU_MS);
        const alphaSlow = 1 - Math.exp(-dtMs / this.SLOW_TAU_MS);
        const alphaMicro = 1 - Math.exp(-dtMs / 250); // 500ms Debounce for OBI Spoofing

        // 3. Raw Imbalance & Micro-EMA Filter
        const rawObi = (bidSize - askSize) / (bidSize + askSize); 
        asset.emaObi += alphaMicro * (rawObi - asset.emaObi);

        // 4. Update Moving Averages & Variances (Incremental EMA Variance)
        const deltaFast = midPrice - asset.muFast;
        asset.muFast += alphaFast * deltaFast;
        asset.varFast = (1 - alphaFast) * (asset.varFast + alphaFast * deltaFast * deltaFast);

        const deltaSlow = midPrice - asset.muSlow;
        asset.muSlow += alphaSlow * deltaSlow;
        asset.varSlow = (1 - alphaSlow) * (asset.varSlow + alphaSlow * deltaSlow * deltaSlow);

        // 5. Compute Volatility & Statistical Bounds
        const fastVol = Math.sqrt(asset.varFast);
        const slowVol = Math.sqrt(asset.varSlow);

        // Z-Score mathematically anchored ONLY to Slow Volatility
        const zScore = slowVol > 1e-9 ? (midPrice - asset.muSlow) / slowVol : 0;
        const regimeRatio = slowVol > 1e-9 ? fastVol / slowVol : 1.0;

        // 6. State Determinations (Warmup, Cooldown, Positions)
        const elapsedWarmup = now - asset.startTimeMs;
        const isWarm = elapsedWarmup >= this.WARMUP_MS;
        const isOnCooldown = asset.cooldownUntil && now < asset.cooldownUntil;
        const hasOpenPosition = this.bot.activePositions && this.bot.activePositions[symbol];

        // 7. OMNIPRESENT GLASS LOG (Fires strictly every 5 seconds)
        if (now - asset.lastLogMs > 5000) {
            asset.lastLogMs = now;
            
            // Determine the exact string state for the UI
            let stateString = '[🟢 ACTIVE]';
            if (!isWarm) {
                const warmupPct = Math.min(100, (elapsedWarmup / this.WARMUP_MS) * 100).toFixed(0);
                stateString = `[🟡 WARMING UP: ${warmupPct}%]`;
            } else if (hasOpenPosition) {
                stateString = '[🔴 IN POSITION]';
            } else if (isOnCooldown) {
                const cdRemaining = Math.max(0, (asset.cooldownUntil - now) / 1000).toFixed(0);
                stateString = `[🔵 COOLDOWN: ${cdRemaining}s]`;
            }

            this.logger.info(
                `[GLASS LOG] 🔍 ${symbol} ${stateString} | ` +
                `📊 Mid: ${midPrice.toFixed(4)} | ` +
                `🎯 Z-Score: ${zScore > 0 ? '+' : ''}${zScore.toFixed(2)} (Req: ±${this.Z_BASE_ENTRY}) | ` +
                `🌪️ Vol Regime: ${regimeRatio.toFixed(2)}x (Req: >${this.VOL_REGIME_MIN}) | ` +
                `⚖️ OBI(EMA): ${asset.emaObi > 0 ? '+' : ''}${(asset.emaObi * 100).toFixed(1)}% (Req: ±${this.MIN_OBI * 100}%) | ` +
                `📏 Spread: ${spread.toFixed(4)} (Max allowed: ${(slowVol * 0.5).toFixed(4)})`
            );

            // Print inner thoughts only if we are active and searching for a trade
            if (isWarm && !isOnCooldown && !hasOpenPosition && regimeRatio > 1.0) {
                let thoughts = `[THINKING] ${symbol} -> Volatility is waking up... `;
                if (Math.abs(zScore) > 1.5) thoughts += `Z-Score building (${zScore.toFixed(2)}). `;
                if (Math.abs(asset.emaObi) > 0.2) thoughts += `Book is tilting (${(asset.emaObi*100).toFixed(0)}%). `;
                if (spread > (slowVol * 0.5)) thoughts += `WAITING: Spread too wide.`;
                this.logger.info(thoughts);
            }
        }

        // --- 8. STRICT GATEKEEPING: Block logic if warming up, cooling down, or in position ---
        if (!isWarm || isOnCooldown || hasOpenPosition) return;

        // 9. LOGICAL HYPOTHESIS EXECUTION (The Harmony)
        const isVolExpanding = regimeRatio >= this.VOL_REGIME_MIN;
        const isSpreadTight = spread <= (slowVol * 0.5); // Spread must be less than 50% of typical vol

        if (isVolExpanding && isSpreadTight) {
            
            // LONG HYPOTHESIS
            if (zScore >= this.Z_BASE_ENTRY && asset.emaObi >= this.MIN_OBI) {
                this.executeTrade(symbol, 'buy', midPrice, slowVol, asset);
                asset.cooldownUntil = now + this.COOLDOWN_MS;
            }
            
            // SHORT HYPOTHESIS
            else if (zScore <= -this.Z_BASE_ENTRY && asset.emaObi <= -this.MIN_OBI) {
                this.executeTrade(symbol, 'sell', midPrice, slowVol, asset);
                asset.cooldownUntil = now + this.COOLDOWN_MS;
            }
        }
    }

    /**
     * Executes the trade with Exchange-Level Bracket Hard SL & TP
     */
    async executeTrade(symbol, side, entryPrice, slowVol, asset) {
        const envSize = process.env.ORDER_SIZE ? parseFloat(process.env.ORDER_SIZE) : null;
        const size = envSize || (this.bot.config ? this.bot.config.orderSize : 1);

        // VOLATILITY-ADJUSTED RISK COMPUTATION
        const riskDistance = slowVol * this.SL_MULTIPLIER;
        const rewardDistance = slowVol * this.TP_MULTIPLIER;

        let slPrice, tpPrice;

        if (side === 'buy') {
            slPrice = entryPrice - riskDistance;
            tpPrice = entryPrice + rewardDistance;
        } else { // sell
            slPrice = entryPrice + riskDistance;
            tpPrice = entryPrice - rewardDistance;
        }

        // Failsafe to prevent negative price inputs to exchange
        if (slPrice <= 0) slPrice = asset.tickSize; 
        if (tpPrice <= 0) tpPrice = asset.tickSize;

        const clientOid = `TICK_${Date.now()}`;

        try {
            this.logger.info(
                `[EXEC THINKING] 💥 BREAKOUT DETECTED! ${symbol} ${side.toUpperCase()} @ ${entryPrice.toFixed(asset.precision)}\n` +
                ` -> Volatility Risk (σ): ${slowVol.toFixed(asset.precision)}\n` +
                ` -> Hard SL: ${slPrice.toFixed(asset.precision)} | Hard TP: ${tpPrice.toFixed(asset.precision)}`
            );

            const payload = {
                product_id: asset.deltaId.toString(), 
                size: size.toString(), 
                side: side,
                order_type: 'market_order',
                client_order_id: clientOid,
                bracket_stop_loss_price: slPrice.toFixed(asset.precision).toString(), 
                bracket_take_profit_price: tpPrice.toFixed(asset.precision).toString(),
                bracket_stop_trigger_method: 'last_traded_price' 
            };

            const result = await this.bot.placeOrder(payload);

            if (result && result.success) {
                this.logger.info(`[FILLED] 🎯 ${symbol} ${side} | OrderID: ${result.id}`);
                if (this.bot.activePositions) this.bot.activePositions[symbol] = true; 
            } else {
                const errorStr = JSON.stringify(result || {});
                if (errorStr.includes("bracket_order_position_exists")) {
                    this.logger.warn(`[STRATEGY] ${symbol} Entry Rejected: Position already exists.`);
                    if (this.bot.activePositions) this.bot.activePositions[symbol] = true; 
                } else {
                    this.logger.error(`[ORDER FAIL] ❌ ${symbol} ${side} | ${errorStr}`);
                    asset.cooldownUntil = 0; // Reset cooldown on fail
                }
            }
        } catch (error) {
            this.logger.error(`[EXEC EXCEPTION] ❌ ${error.message}`);
            asset.cooldownUntil = 0;
        }
    }
}

module.exports = TickStrategy;
            
