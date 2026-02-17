/**
 * TickStrategy.js
 * v12.91 - GLASS BOX EDITION (0.01% SNIPER HARMONY)
 * * * FEATURES:
 * 1. GLASS LOGGING: Exposes raw data, model thinking, and warmup status every 5s.
 * 2. 0.01% SNIPER CONFIG: Z=3.8, Floor=1.0.
 * 3. COOLDOWN: 5000ms safety period.
 * 4. AUTO-LIMITER: Dynamically scales down Z-score targets when market volatility makes them mathematically impossible, down to a hard floor of 2.5.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. HUMAN CONFIGURATION (EDIT THIS) ---
        const EXPECTED_TPS = 400; 
        const FAST_WINDOW_MINS = 1;   
        const SLOW_WINDOW_MINS = 15;  

        // --- 2. AUTOMATIC QUANT TRANSLATION ---
        this.FAST_TICKS = FAST_WINDOW_MINS * 60 * EXPECTED_TPS;
        this.SLOW_TICKS = SLOW_WINDOW_MINS * 60 * EXPECTED_TPS;
        this.ALPHA_FAST = 1 / this.FAST_TICKS;
        this.ALPHA_SLOW = 1 / this.SLOW_TICKS;
        this.WARMUP_TICKS = this.FAST_TICKS; 

        // --- 3. CORE PARAMETERS (0.01% HARMONY) ---
        
        // 1. The 0.01% Statistical Target
        // Demands a 3.8 standard deviation move (1-in-10,000 statistical probability)
        this.BASE_ENTRY_Z = 3.8; 
        
        // 2. Disable the "Quiet Market Discount"
        // 1.0 means we NEVER discount the Z-score just because the market is quiet.
        this.REGIME_FLOOR = 1.0;

        // 3. The Risk Leash (Keep it tight to prevent mean-reversion drag)
        this.TRAILING_PERCENT = 0.02; 
        
        // 4. Cooldown (Wait 30 seconds for the shockwave to settle)
        this.COOLDOWN_MS = 30000;

        // --- 4. SAFETY LIMITS ---
        
        // The Ultimate Garbage Filter.
        // Even if the Auto-Limiter engages, NEVER trade below a 2.5 Z-score. 
        // 2.5 is the top 0.6%. If the market is so chaotic that a 2.5 is impossible, we lock the bot.
        this.MIN_AUTO_LIMIT_Z = 2.5; 

        // Exchange Config
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};
        
        for (const [symbol, details] of Object.entries(MASTER_CONFIG)) {
            this.assets[symbol] = {
                obiMean: 0,
                fastObiVar: 0,
                slowObiVar: 0,
                tickCounter: 0,
                regimeRatio: 1.0,
                currentRegime: 0, 
                cooldownUntil: 0,
                latestSnapshot: null, // For the Glass Log
                ...details
            };
        }
    }

    getName() {
        return 'TickStrategy (v12.91 0.01% Sniper)';
    }

    async start() {
        this.logger.info(`[STRATEGY START] TickStrategy Engine Active.`);
        this.logger.info(`[STRATEGY CONFIG] Base Z: ${this.BASE_ENTRY_Z} | Min Floor Z: ${this.MIN_AUTO_LIMIT_Z}`);
        
        // --- 5s HEARTBEAT ---
        setInterval(() => {
            this.runMathCheck();
        }, 5000);
    }

    runMathCheck() {
        for (const symbol in this.assets) {
            const asset = this.assets[symbol];
            
            // Skip if no data has arrived yet
            if (asset.tickCounter === 0 || !asset.latestSnapshot) continue;

            const snap = asset.latestSnapshot;
            const vol = Math.sqrt(asset.fastObiVar);

            // --- GLASS LOG: WHAT IT SEES ---
            this.logger.info(`[👀 VISUAL] ${symbol} | Bid: ${snap.bestBid} Ask: ${snap.bestAsk} | OBI: ${snap.obi.toFixed(3)} | Micro: ${snap.microPrice.toFixed(4)} | Mid: ${snap.midPrice.toFixed(4)}`);

            // --- WARMUP HEARTBEAT LOGGING ---
            if (asset.tickCounter < this.WARMUP_TICKS) {
                const percent = ((asset.tickCounter / this.WARMUP_TICKS) * 100).toFixed(1);
                this.logger.info(`[🧠 WARMUP ⏳] ${symbol} | Collecting baseline variance... ${asset.tickCounter}/${this.WARMUP_TICKS} ticks (${percent}%)`);
                continue;
            }

            if (vol < 1e-9) continue;

            // --- MODEL THINKING ---
            const maxPossibleZ = 1.0 / vol;
            const currentScaler = Math.min(Math.max(asset.regimeRatio, this.REGIME_FLOOR), 3.0);
            const yourTargetZ = this.BASE_ENTRY_Z * currentScaler;

            const isPossible = maxPossibleZ > yourTargetZ;
            
            if (isPossible) {
                this.logger.info(
                    `[🧠 THINKING ✅] ${symbol} | Vol: ${vol.toFixed(4)} | ` +
                    `MaxLimit: ${maxPossibleZ.toFixed(2)} > Target: ${yourTargetZ.toFixed(2)} | ` +
                    `Status: NORMAL TRADING`
                );
            } else {
                const cappedTarget = Math.max(maxPossibleZ * 0.95, this.MIN_AUTO_LIMIT_Z);
                if (maxPossibleZ < this.MIN_AUTO_LIMIT_Z) {
                     this.logger.warn(
                        `[🧠 THINKING 🛑] ${symbol} | Vol: ${vol.toFixed(4)} | ` +
                        `MaxLimit: ${maxPossibleZ.toFixed(2)} | ` +
                        `Status: CHAOS (Below min Z of ${this.MIN_AUTO_LIMIT_Z}. Trading locked.)`
                    );                   
                } else {
                    this.logger.info(
                        `[🧠 THINKING 🔧] ${symbol} | Vol: ${vol.toFixed(4)} | ` +
                        `MaxLimit: ${maxPossibleZ.toFixed(2)} < Target: ${yourTargetZ.toFixed(2)} | ` +
                        `Status: AUTO-LIMITER ENGAGED (New Target: ${cappedTarget.toFixed(2)})`
                    );
                }
            }
        }
    }

    async onDepthUpdate(depth) {
        const symbol = depth.s; 
        if (!this.assets[symbol]) return;
        
        const asset = this.assets[symbol];

        if (Date.now() < asset.cooldownUntil) return;
        
        const bestBid = parseFloat(depth.bb);
        const bestAsk = parseFloat(depth.ba);
        const bestBidSize = parseFloat(depth.bq); 
        const bestAskSize = parseFloat(depth.aq); 

        if (asset.tickCounter === 0) {
            this.logger.info(`[DATA FLOW] First tick received for ${symbol}. Engine starting.`);
        }

        if (!this.bot.activePositions[symbol]) {
            asset.currentRegime = 0;
        }

        asset.tickCounter++;
        const midPrice = (bestBid + bestAsk) / 2;
        const totalVol = bestBidSize + bestAskSize;
        
        if (totalVol === 0) return;

        const obi = (bestBidSize - bestAskSize) / totalVol;
        const microPrice = (bestAsk * bestBidSize + bestBid * bestAskSize) / totalVol;

        // Save snapshot for the Glass Log heartbeat
        asset.latestSnapshot = {
            bestBid, bestAsk, obi, microPrice, midPrice
        };

        const dynamicSlowAlpha = Math.max(this.ALPHA_SLOW, 1 / asset.tickCounter);
        const delta = obi - asset.obiMean;
        
        asset.obiMean += dynamicSlowAlpha * delta;

        if (asset.tickCounter > 1) {
            asset.fastObiVar = (1 - this.ALPHA_FAST) * (asset.fastObiVar + this.ALPHA_FAST * delta * delta);
            asset.slowObiVar = (1 - dynamicSlowAlpha) * (asset.slowObiVar + dynamicSlowAlpha * delta * delta);
        }

        if (asset.tickCounter < this.WARMUP_TICKS) return; 

        const fastVol = Math.sqrt(asset.fastObiVar);
        const slowVol = Math.sqrt(asset.slowObiVar);
        
        asset.regimeRatio = (slowVol > 1e-9) ? (fastVol / slowVol) : 1.0;
        const dynamicScaler = Math.min(Math.max(asset.regimeRatio, this.REGIME_FLOOR), 3.0);

        const zScore = (fastVol > 1e-9) ? (obi - asset.obiMean) / fastVol : 0;
        
        let requiredZ = this.BASE_ENTRY_Z * dynamicScaler;
        const maxPossibleZ = (fastVol > 1e-9) ? (1.0 / fastVol) : 999;
        let isAutoCorrected = false;

        if (requiredZ >= maxPossibleZ) {
            requiredZ = Math.max(maxPossibleZ * 0.95, this.MIN_AUTO_LIMIT_Z);
            isAutoCorrected = true;
        }

        const isMicroUp = microPrice > midPrice;
        const isMicroDown = microPrice < midPrice;

        if (asset.currentRegime === 0 && !this.bot.activePositions[symbol]) {
            const autoTag = isAutoCorrected ? '[AUTO-CORRECTED] ' : '';

            if (zScore > requiredZ && isMicroUp) {
                this.logger.info(`[SIGNAL BUY] ${autoTag}${symbol} | Z: ${zScore.toFixed(2)} > ${requiredZ.toFixed(2)} | MicroPrice: OK`);
                await this.executeTrade(symbol, 'buy', midPrice);
            } 
            else if (zScore < -requiredZ && isMicroDown) {
                this.logger.info(`[SIGNAL SELL] ${autoTag}${symbol} | Z: ${zScore.toFixed(2)} < -${requiredZ.toFixed(2)} | MicroPrice: OK`);
                await this.executeTrade(symbol, 'sell', midPrice);
            }
        }
    }

    async executeTrade(symbol, side, entryPrice) {
        const asset = this.assets[symbol];
        
        asset.cooldownUntil = Date.now() + this.COOLDOWN_MS;
        asset.currentRegime = (side === 'buy') ? 1 : -1;

        const envSize = process.env.ORDER_SIZE ? parseFloat(process.env.ORDER_SIZE) : null;
        const size = envSize || this.bot.config.orderSize || 1;

        let trailAmount = entryPrice * (this.TRAILING_PERCENT / 100);
        if (side === 'buy') trailAmount = -trailAmount;
        
        const finalTrail = trailAmount.toFixed(asset.precision);
        const clientOid = `TICK_${Date.now()}`;

        try {
            this.logger.info(`[EXEC] ${symbol} ${side.toUpperCase()} @ ${entryPrice} | Size: ${size} | Trail: ${finalTrail} (${this.TRAILING_PERCENT}%) | Cooldown: 5s`);

            const payload = {
                product_id: asset.deltaId.toString(), 
                size: size.toString(), 
                side: side,
                order_type: 'market_order',
                client_order_id: clientOid,
                bracket_trail_amount: finalTrail.toString(), 
                bracket_stop_trigger_method: 'last_traded_price' 
            };

            const result = await this.bot.placeOrder(payload);

            if (result && result.success) {
                this.logger.info(`[FILLED] ${symbol} ${side} | OrderID: ${result.id}`);
            } else {
                const errorStr = JSON.stringify(result || {});
                if (errorStr.includes("bracket_order_position_exists")) {
                    this.logger.warn(`[STRATEGY] ${symbol} Entry Rejected: Position already exists.`);
                    this.bot.activePositions[symbol] = true; 
                } else {
                    this.logger.error(`[ORDER FAIL] ${symbol} ${side} | ${errorStr}`);
                    asset.currentRegime = 0; 
                }
            }
        } catch (error) {
            this.logger.error(`[EXEC EXCEPTION] ${error.message}`);
            asset.currentRegime = 0;
        }
    }
}

module.exports = TickStrategy;
    
