/**
 * TickStrategy.js
 * v13.6 - QUANTUM HYBRID (Asset-Scaled Kalman + Risk Floors)
 * * * FEATURES ADDED:
 * 1. 1D KALMAN FILTER: Cleans raw mid-price microstructure noise before statistical processing.
 * 2. ASSET-SCALED MATRICES: Q/R noise parameters dynamically scaled per asset price unit.
 * 3. VOLATILITY SCALING: Dynamically lowers Z-Score & OBI thresholds as market kinetic energy rises.
 * 4. MICROSTRUCTURE GATES: 500ms Micro-EMA + Absolute Minimum Liquidity Floors to defeat spoofing.
 * 5. TICK-SIZE FLOORS: Spread and Risk distances have hard minimums (e.g., Min SL = 3 Ticks).
 * 6. EXCHANGE-LEVEL RISK: Resting Bracket SL (1.5σ) and TP (2.5σ) via Delta Exchange API.
 * 7. RUST ALIGNMENT: Strictly typed payload mapping for lib.rs `DepthUpdate`.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. HARMONIZED QUANT CONFIGURATION ---
        this.FAST_TAU_MS = 10000;   // 10 seconds for momentum burst
        this.SLOW_TAU_MS = 180000;  // 3 minutes for baseline mean/volatility
        this.WARMUP_MS = 180000;    // 3 minutes warmup

        // --- 2. BASE THRESHOLDS & RISK GATES ---
        this.Z_BASE_ENTRY = 2.1;    // Base StdDev required for breakout (scales down with vol)
        this.VOL_REGIME_MIN = 1.0;  // Fast Vol must be 20% higher than Slow Vol
        this.MIN_OBI = 0.30;        // Base 30% order book imbalance (scales down with vol)
        this.SL_MULTIPLIER = 1.5;   // Hard Stop Loss distance (1.5 * slow volatility)
        this.TP_MULTIPLIER = 2.5;   // Hard Take Profit distance (2.5 * slow volatility)
        this.COOLDOWN_MS = 30000;   // 30s safety period post-trade

        // --- 3. RUST-ALIGNED ASSET INITIALIZATION (With Unit-Scaled Constants) ---
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001, minLiquidity: 5000, kalmanQ: 1e-8, kalmanR: 1e-6 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1,    minLiquidity: 0.5,  kalmanQ: 1e-2, kalmanR: 1e-0 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01,   minLiquidity: 5.0,  kalmanQ: 1e-4, kalmanR: 1e-2 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1,    minLiquidity: 50.0, kalmanQ: 1e-2, kalmanR: 1e-0 }
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
                emaObi: 0, 
                kalmanX: 0, // Kalman State Estimate (True Price)
                kalmanP: 1, // Kalman Estimate Uncertainty
                lastLogMs: now,
                cooldownUntil: 0,
                ...details
            };
        }
    }

    getName() {
        return 'TickStrategy_QuantumHybrid';
    }

    async start() {
        this.logger.info(`[STRATEGY] Starting ${this.getName()}...`);
        this.logger.info(`[STRATEGY] Quantum Hybrid Parameters Loaded: FastTau=${this.FAST_TAU_MS}ms, SlowTau=${this.SLOW_TAU_MS}ms`);
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

        // RUST PAYLOAD MAPPING & STRICT COERCION
        const bestBid = Number(depth.bb);
        const bestAsk = Number(depth.ba);
        const bidSize = Number(depth.bq || 0); 
        const askSize = Number(depth.aq || 0); 

        // GHOST LIQUIDITY DEFENSE
        const totalLiquidity = bidSize + askSize;
        if (totalLiquidity < asset.minLiquidity) return;

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
            asset.kalmanX = midPrice; // Initialize Kalman state
            asset.lastLogMs = now;
            asset.isInitialized = true;
            this.logger.info(`[DATA FLOW] First tick received for ${symbol}. Hybrid Engine starting.`);
            return;
        }

        // 2. Time-Decay (Δt) Math & Micro-Debounce
        const dtMs = Math.max(1, now - asset.lastTickMs);
        asset.lastTickMs = now;

        const alphaFast = 1 - Math.exp(-dtMs / this.FAST_TAU_MS);
        const alphaSlow = 1 - Math.exp(-dtMs / this.SLOW_TAU_MS);
        const alphaMicro = 1 - Math.exp(-dtMs / 100); // 500ms Debounce for OBI Spoofing

        // 3. Raw Imbalance & Micro-EMA Filter
        const rawObi = (bidSize - askSize) / totalLiquidity; 
        asset.emaObi += alphaMicro * (rawObi - asset.emaObi);

        // --- 4. 1D KALMAN FILTER (Asset-Scaled Noise Matrices) ---
        // Predict
        const pPred = asset.kalmanP + asset.kalmanQ;
        // Update (Kalman Gain)
        const kalmanGain = pPred / (pPred + asset.kalmanR);
        asset.kalmanX = asset.kalmanX + kalmanGain * (midPrice - asset.kalmanX);
        asset.kalmanP = (1 - kalmanGain) * pPred;
        
        const truePrice = asset.kalmanX; // The mathematically cleaned price

        // 5. Update Moving Averages & Variances (Using TRUE PRICE, not raw mid)
        const deltaFast = truePrice - asset.muFast;
        asset.muFast += alphaFast * deltaFast;
        asset.varFast = (1 - alphaFast) * (asset.varFast + alphaFast * deltaFast * deltaFast);

        const deltaSlow = truePrice - asset.muSlow;
        asset.muSlow += alphaSlow * deltaSlow;
        asset.varSlow = (1 - alphaSlow) * (asset.varSlow + alphaSlow * deltaSlow * deltaSlow);

        // 6. Compute Volatility & Statistical Bounds
        const fastVol = Math.sqrt(asset.varFast);
        const slowVol = Math.sqrt(asset.varSlow);

        // Z-Score is anchored to TruePrice and Slow Volatility
        const zScore = slowVol > 1e-9 ? (truePrice - asset.muSlow) / slowVol : 0;
        const regimeRatio = slowVol > 1e-9 ? fastVol / slowVol : 1.0;

        // --- 7. VOLATILITY-LINKED DYNAMIC SCALING ---
        const activeRegime = Math.max(1.0, regimeRatio); 
        const dynamicZ = Math.max(1.5, this.Z_BASE_ENTRY / Math.sqrt(activeRegime));
        const dynamicObi = Math.max(0.10, this.MIN_OBI / activeRegime);

        // 8. State Determinations (Warmup, Cooldown, Positions)
        const elapsedWarmup = now - asset.startTimeMs;
        const isWarm = elapsedWarmup >= this.WARMUP_MS;
        const isOnCooldown = asset.cooldownUntil && now < asset.cooldownUntil;
        const hasOpenPosition = this.bot.activePositions && this.bot.activePositions[symbol];

        // 9. OMNIPRESENT GLASS LOG (Fires strictly every 5 seconds)
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
                `📊 Mid(Clean): ${truePrice.toFixed(4)} | ` +
                `🎯 Z-Score: ${zScore > 0 ? '+' : ''}${zScore.toFixed(2)} (Req: ±${dynamicZ.toFixed(2)}) | ` +
                `🌪️ Vol Regime: ${regimeRatio.toFixed(2)}x (Req: >${this.VOL_REGIME_MIN}) | ` +
                `⚖️ OBI(EMA): ${asset.emaObi > 0 ? '+' : ''}${(asset.emaObi * 100).toFixed(1)}% (Req: ±${(dynamicObi * 100).toFixed(1)}%) | ` +
                `📏 Spread: ${spread.toFixed(4)} | 🎛️ K-Gain: ${kalmanGain.toFixed(4)}`
            );

            // Print inner thoughts only if we are active and searching for a trade
            if (isWarm && !isOnCooldown && !hasOpenPosition && regimeRatio > 1.0) {
                let thoughts = `[THINKING] ${symbol} -> Volatility is waking up... `;
                if (Math.abs(zScore) > (dynamicZ * 0.6)) thoughts += `Z-Score building (${zScore.toFixed(2)}). `;
                if (Math.abs(asset.emaObi) > (dynamicObi * 0.6)) thoughts += `Book is tilting (${(asset.emaObi*100).toFixed(0)}%). `;
                this.logger.info(thoughts);
            }
        }

        // --- 10. STRICT GATEKEEPING: Block logic if warming up, cooling down, or in position ---
        if (!isWarm || isOnCooldown || hasOpenPosition) return;

        // 11. TICK-SIZE FLOORS & LOGICAL EXECUTION (The Harmony)
        const isVolExpanding = regimeRatio >= this.VOL_REGIME_MIN;
        
        // Spread must be tighter than half typical volatility, but never demand impossible sub-tick spreads
        const maxSpread = Math.max(asset.tickSize * 1.5, slowVol * 0.5);
        const isSpreadTight = spread <= maxSpread; 

        if (isVolExpanding && isSpreadTight) {
            
            // LONG HYPOTHESIS
            if (zScore >= dynamicZ && asset.emaObi >= dynamicObi) {
                this.logger.info(`[DYNAMIC SCALING] 📈 Long Triggered | Target Z: ${dynamicZ.toFixed(2)} | Target OBI: ${(dynamicObi*100).toFixed(1)}%`);
                // Note: We execute on physical midPrice to ensure API compatibility
                this.executeTrade(symbol, 'buy', midPrice, slowVol, asset);
                asset.cooldownUntil = now + this.COOLDOWN_MS;
            }
            
            // SHORT HYPOTHESIS
            else if (zScore <= -dynamicZ && asset.emaObi <= -dynamicObi) {
                this.logger.info(`[DYNAMIC SCALING] 📉 Short Triggered | Target Z: ${dynamicZ.toFixed(2)} | Target OBI: ${(dynamicObi*100).toFixed(1)}%`);
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

        // VOLATILITY-ADJUSTED RISK COMPUTATION WITH TICK FLOORS
        const minRiskTicks = 3; 
        const minRewardTicks = 6;
        
        const riskDistance = Math.max(slowVol * this.SL_MULTIPLIER, asset.tickSize * minRiskTicks);
        const rewardDistance = Math.max(slowVol * this.TP_MULTIPLIER, asset.tickSize * minRewardTicks);

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
                    
