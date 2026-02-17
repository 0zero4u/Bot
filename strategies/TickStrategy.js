/**
 * TickStrategy.js
 * v12.2 - GLASS BOX MONITORING & WARMUP VISIBILITY
 * * CHANGES:
 * 1. ADDED: getName() to fix startup crash.
 * 2. ADDED: start() to trigger the 5s Heartbeat loop.
 * 3. UPDATED: Heartbeat now logs status during WARMUP (does not wait for completion).
 * 4. LOGIC: Core trading math remains untouched.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- 1. CONFIGURATION ---
        const EXPECTED_TPS = 400; 
        const FAST_WINDOW_MINS = 1;   
        const SLOW_WINDOW_MINS = 15;  

        // --- 2. QUANT SETUP ---
        this.FAST_TICKS = FAST_WINDOW_MINS * 60 * EXPECTED_TPS;
        this.SLOW_TICKS = SLOW_WINDOW_MINS * 60 * EXPECTED_TPS;

        this.ALPHA_FAST = 1 / this.FAST_TICKS;
        this.ALPHA_SLOW = 1 / this.SLOW_TICKS;
        
        // Warmup = Fast Window (we need valid variance before trading)
        this.WARMUP_TICKS = this.FAST_TICKS; 

        // --- 3. TRADING PARAMETERS ---
        this.BASE_ENTRY_Z = 3.0; 
        this.TRAILING_PERCENT = 0.02; 

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
                obiMean: 0,
                fastObiVar: 0,
                slowObiVar: 0,
                tickCounter: 0,
                regimeRatio: 1.0,
                currentRegime: 0, 
                ...details
            };
        }
    }

    // --- CRITICAL FIX: REQUIRED BY TRADER.JS ---
    getName() {
        return 'TickStrategy (v12.2)';
    }

    // --- CRITICAL FIX: STARTS THE HEARTBEAT ---
    async start() {
        this.logger.info(`[STRATEGY START] TickStrategy Engine Active.`);
        this.logger.info(`[STRATEGY CONFIG] Warmup Target: ${this.WARMUP_TICKS} ticks per asset.`);
        
        // Start 5-second Heartbeat Loop
        setInterval(() => {
            this.logHeartbeat();
        }, 5000);
    }

    // --- GLASS BOX LOGGING (Run every 5s) ---
    logHeartbeat() {
        let activeAssets = 0;

        for (const symbol in this.assets) {
            const asset = this.assets[symbol];
            
            // Skip totally dead assets (0 ticks received)
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
                `Mean: ${mean} | Vol: ${fastVol} | Ratio: ${ratio}x`
            );
        }

        if (activeAssets === 0) {
            this.logger.info(`[💓 HB] Waiting for market data... (No ticks received yet)`);
        }
    }

    /**
     * Main Tick Processor
     */
    async onDepthUpdate(depth) {
        const { symbol, bestBid, bestAsk, bestBidSize, bestAskSize } = depth;
        
        if (!this.assets[symbol]) return;
        const asset = this.assets[symbol];

        // 0. FIRST TICK CHECK
        if (asset.tickCounter === 0) {
             this.logger.info(`[DATA FLOW] First tick received for ${symbol}. Engine starting.`);
        }

        // 1. STATE MANAGEMENT
        if (!this.bot.activePositions[symbol]) {
            asset.currentRegime = 0;
        }

        // 2. MATH CALCULATIONS
        asset.tickCounter++;
        const midPrice = (bestBid + bestAsk) / 2;
        const totalVol = bestBidSize + bestAskSize;
        
        if (totalVol === 0) return;

        const obi = (bestBidSize - bestAskSize) / totalVol;
        const microPrice = (bestAsk * bestBidSize + bestBid * bestAskSize) / totalVol;

        // Dynamic Alpha for Fast Start
        const dynamicSlowAlpha = Math.max(this.ALPHA_SLOW, 1 / asset.tickCounter);
        const delta = obi - asset.obiMean;
        
        asset.obiMean += dynamicSlowAlpha * delta;

        if (asset.tickCounter > 1) {
            asset.fastObiVar = (1 - this.ALPHA_FAST) * (asset.fastObiVar + this.ALPHA_FAST * delta * delta);
            asset.slowObiVar = (1 - dynamicSlowAlpha) * (asset.slowObiVar + dynamicSlowAlpha * delta * delta);
        }

        // 3. WARMUP GUARD
        // We calculate stats above, but we STOP here if warming up.
        // The Heartbeat logger will still see the updated stats above.
        if (asset.tickCounter < this.WARMUP_TICKS) {
            return; 
        }

        // 4. REGIME & SIGNAL (Only runs after Warmup)
        const fastVol = Math.sqrt(asset.fastObiVar);
        const slowVol = Math.sqrt(asset.slowObiVar);
        
        asset.regimeRatio = (slowVol > 1e-9) ? (fastVol / slowVol) : 1.0;
        const dynamicScaler = Math.min(Math.max(asset.regimeRatio, 0.5), 3.0);

        const zScore = (fastVol > 1e-9) ? (obi - asset.obiMean) / fastVol : 0;
        const requiredZ = this.BASE_ENTRY_Z * dynamicScaler;

        const isMicroUp = microPrice > midPrice;
        const isMicroDown = microPrice < midPrice;

        // 5. EXECUTION
        if (asset.currentRegime === 0 && !this.bot.activePositions[symbol]) {
            if (zScore > requiredZ && isMicroUp) {
                this.logger.info(`[SIGNAL BUY] ${symbol} | Z: ${zScore.toFixed(2)} | Ratio: ${dynamicScaler.toFixed(2)}`);
                await this.executeTrade(symbol, 'buy', midPrice);
            } 
            else if (zScore < -requiredZ && isMicroDown) {
                this.logger.info(`[SIGNAL SELL] ${symbol} | Z: ${zScore.toFixed(2)} | Ratio: ${dynamicScaler.toFixed(2)}`);
                await this.executeTrade(symbol, 'sell', midPrice);
            }
        }
    }

    async executeTrade(symbol, side, entryPrice) {
        const asset = this.assets[symbol];
        asset.currentRegime = (side === 'buy') ? 1 : -1;
        const size = this.bot.config.orderSize || 100; 
        const trailAmount = entryPrice * (this.TRAILING_PERCENT / 100);
        const finalTrail = trailAmount.toFixed(asset.precision);
        const clientOid = `TICK_${Date.now()}`;

        try {
            this.logger.info(`[EXEC] ${symbol} ${side.toUpperCase()} @ ${entryPrice}`);

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
                const errorStr = JSON.stringify(result || {});
                if (errorStr.includes("bracket_order_position_exists")) {
                    this.logger.warn(`[STRATEGY] Position exists. Syncing.`);
                    this.bot.activePositions[symbol] = true; 
                } else {
                    this.logger.error(`[ORDER FAIL] ${symbol} | ${errorStr}`);
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
                
