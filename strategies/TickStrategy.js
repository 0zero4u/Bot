/**
 * TickStrategy.js
 * v12.92 - MID-PRICE PIVOT (TRUE VALUE HARMONY)
 * * * FEATURES:
 * 1. GLASS LOGGING: Exposes raw data, model thinking, and warmup status every 5s.
 * 2. 0.01% SNIPER CONFIG: Z=3.8, Floor=1.0.
 * 3. COOLDOWN: 5000ms safety period.
 * 4. SOURCE: Mid-Price (BestBid + BestAsk / 2) - Immune to Order Book Noise.
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
        this.BASE_ENTRY_Z = 2.1; 
        
        // 2. Disable the "Quiet Market Discount"
        this.REGIME_FLOOR = 0.7;

        // 3. The Risk Leash
        this.TRAILING_PERCENT = 0.015; 
        
        // 4. Cooldown
        this.COOLDOWN_MS = 30000;

        // --- 4. SAFETY LIMITS ---
        this.MIN_AUTO_LIMIT_Z = 1.5; 

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
                priceMean: 0,      // UPDATED: Now tracking Price Mean
                fastPriceVar: 0,   // UPDATED: Now tracking Price Variance
                slowPriceVar: 0,   // UPDATED: Now tracking Price Variance
                tickCounter: 0,
                regimeRatio: 1.0,
                currentRegime: 0, 
                cooldownUntil: 0,
                latestSnapshot: null, 
                ...details
            };
        }
    }

    getName() {
        return 'TickStrategy (v12.92 Mid-Price Pivot)';
    }

    async start() {
        this.logger.info(`[STRATEGY START] TickStrategy Engine Active (Mid-Price Mode).`);
        this.logger.info(`[STRATEGY CONFIG] Base Z: ${this.BASE_ENTRY_Z}`);
        
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
            const vol = Math.sqrt(asset.fastPriceVar); // Price Volatility

            // --- GLASS LOG: WHAT IT SEES ---
            this.logger.info(`[👀 VISUAL] ${symbol} | Bid: ${snap.bestBid} Ask: ${snap.bestAsk} | Mid: ${snap.midPrice.toFixed(4)} | Vol(Price): ${vol.toFixed(4)}`);

            // --- WARMUP HEARTBEAT LOGGING ---
            if (asset.tickCounter < this.WARMUP_TICKS) {
                const percent = ((asset.tickCounter / this.WARMUP_TICKS) * 100).toFixed(1);
                this.logger.info(`[🧠 WARMUP ⏳] ${symbol} | Collecting baseline variance... ${asset.tickCounter}/${this.WARMUP_TICKS} ticks (${percent}%)`);
                continue;
            }

            if (vol < 1e-9) continue;

            // --- MODEL THINKING ---
            // NOTE: In Price-Space, there is no "Max Limit" (1.0) like in OBI. Price is unbounded.
            // We disable the Auto-Limiter logic by setting maxPossibleZ to Infinity.
            const maxPossibleZ = 999.0; 
            const currentScaler = Math.min(Math.max(asset.regimeRatio, this.REGIME_FLOOR), 3.0);
            const yourTargetZ = this.BASE_ENTRY_Z * currentScaler;

            this.logger.info(
                `[🧠 THINKING ✅] ${symbol} | Vol: ${vol.toFixed(4)} | ` +
                `Target Z: ${yourTargetZ.toFixed(2)} | ` +
                `Status: NORMAL TRADING`
            );
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

        // OBI Calculated purely for MicroPrice Logic (Directional Confirmation)
        // We no longer use OBI for the Z-Score itself.
        const obi = (bestBidSize - bestAskSize) / totalVol;
        const microPrice = (bestAsk * bestBidSize + bestBid * bestAskSize) / totalVol;

        // Save snapshot for the Glass Log heartbeat
        asset.latestSnapshot = {
            bestBid, bestAsk, obi, microPrice, midPrice
        };

        // --- PIVOT: WELFORD ON MID-PRICE ---
        
        // Initialization: On first tick, set mean to current price to avoid explosion
        if (asset.tickCounter === 1) {
            asset.priceMean = midPrice;
        }

        const dynamicSlowAlpha = Math.max(this.ALPHA_SLOW, 1 / asset.tickCounter);
        const delta = midPrice - asset.priceMean; // PRICE DELTA
        
        asset.priceMean += dynamicSlowAlpha * delta;

        if (asset.tickCounter > 1) {
            // Updating Price Variance
            asset.fastPriceVar = (1 - this.ALPHA_FAST) * (asset.fastPriceVar + this.ALPHA_FAST * delta * delta);
            asset.slowPriceVar = (1 - dynamicSlowAlpha) * (asset.slowPriceVar + dynamicSlowAlpha * delta * delta);
        }

        if (asset.tickCounter < this.WARMUP_TICKS) return; 

        const fastVol = Math.sqrt(asset.fastPriceVar);
        const slowVol = Math.sqrt(asset.slowPriceVar);
        
        asset.regimeRatio = (slowVol > 1e-9) ? (fastVol / slowVol) : 1.0;
        const dynamicScaler = Math.min(Math.max(asset.regimeRatio, this.REGIME_FLOOR), 3.0);

        // --- Z-SCORE CALCULATION (PRICE BASED) ---
        const zScore = (fastVol > 1e-9) ? (midPrice - asset.priceMean) / fastVol : 0;
        
        let requiredZ = this.BASE_ENTRY_Z * dynamicScaler;
        
        // Auto-Limiter removed (Price is unbounded)
        const isAutoCorrected = false;

        const isMicroUp = microPrice > midPrice;
        const isMicroDown = microPrice < midPrice;

        if (asset.currentRegime === 0 && !this.bot.activePositions[symbol]) {
            const autoTag = isAutoCorrected ? '[AUTO-CORRECTED] ' : '';

            if (zScore > requiredZ && isMicroUp) {
                // Short on High Z (Mean Reversion)
                // Note: If Price is High (Pos Z), we Expect Reversion Down -> SELL
                this.logger.info(`[SIGNAL SELL] ${autoTag}${symbol} | Price Z: ${zScore.toFixed(2)} > ${requiredZ.toFixed(2)} | MicroPrice: OK`);
                await this.executeTrade(symbol, 'sell', midPrice);
            } 
            else if (zScore < -requiredZ && isMicroDown) {
                // Long on Low Z (Mean Reversion)
                // Note: If Price is Low (Neg Z), we Expect Reversion Up -> BUY
                this.logger.info(`[SIGNAL BUY] ${autoTag}${symbol} | Price Z: ${zScore.toFixed(2)} < -${requiredZ.toFixed(2)} | MicroPrice: OK`);
                await this.executeTrade(symbol, 'buy', midPrice);
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
            this.logger.info(`[EXEC] ${symbol} ${side.toUpperCase()} @ ${entryPrice} | Size: ${size} | Trail: ${finalTrail} (${this.TRAILING_PERCENT}%) | Cooldown: 30s`);

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
            
