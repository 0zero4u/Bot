/**
 * TickStrategy.js
 * v7.1 [DOCUMENTED SNIPER]
 * * --- STRATEGY ARCHITECTURE (THE 3 ARMS) ---
 * * 1. THE EYE (Spatial Filter): "Cliff-Edge Decay"
 * - Logic: We care INTENSELY about Level 1-3. We ignore Level 10+.
 * - Math: Weight = e^(-alpha * ticks_away).
 * - Setting: Alpha = 0.5.
 * - Result: 
 * - Level 1 (0 ticks): 100% Weight.
 * - Level 5 (4 ticks): 13% Weight (Noise Floor).
 * - Level 10 (9 ticks): 1% Weight (Dead Zone).
 * * 2. THE BRAIN (Temporal Filter): "Forgetful Welford"
 * - Logic: We need to know if the CURRENT pressure is abnormal compared to RECENT history.
 * - Math: Exponential Moving Average & Variance.
 * - Setting: Alpha = 0.02.
 * - Result: Memory is approx ~100 snapshots. 
 * - High Volatility: Adapts in ~2 seconds.
 * - Low Volatility: Adapts in ~30 seconds.
 * * 3. THE HAND (Execution): "Microprice Sniping"
 * - Logic: We don't buy at Market. We buy at the "Center of Gravity".
 * - Math: Limit = MidPrice + (HalfSpread * OBI_Signal).
 * - Result: If OBI is 0.5 (strong buy), we place limit 25% into the spread.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- [CRITICAL] STRATEGY PARAMETERS ---
        
        // 1. DECAY_ALPHA = 0.5 (The "Golden Number")
        // DO NOT CHANGE without simulation.
        // 0.2 = Too gentle (sees deep spoofing). 
        // 0.8 = Too sharp (sees only Best Bid).
        // 0.5 = Perfect Cliff (L1=100%, L10=1%).
        this.DECAY_ALPHA = 0.5;      

        // 2. WELFORD_ALPHA = 0.02 (The "100-Tick Memory")
        // Formula: Alpha ~= 2 / (N + 1). 
        // 0.02 means we remember roughly the last 100 valid updates.
        // Since market_listener.js filters duplicates, these are 100 *real* moves.
        this.WELFORD_ALPHA = 0.02;   
        
        this.ENTRY_Z = 2.5;          // 2.5 Sigma = 99% Confidence Interval
        this.EXIT_Z = 0.5;           // Hysteresis: Stay in until signal dies
        this.MIN_NOISE_FLOOR = 0.05; // Prevents division by zero in dead markets
        this.WARMUP_TICKS = 50;      // Need 50 valid updates before trusting Z-Score

        // --- MASTER CONFIGURATION ---
        // 'tickSize' is vital for the Normalized Decay to work across BTC & XRP.
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};
        
        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            const cleanSymbol = symbol.replace('_USDT', '');
            if (MASTER_CONFIG[cleanSymbol]) {
                this.assets[cleanSymbol] = {
                    config: MASTER_CONFIG[cleanSymbol],
                    
                    // Welford Memory State
                    obiMean: 0,
                    obiVariance: 0,
                    obiCount: 0,
                    
                    // Market State
                    currentRegime: 0, 
                    midPrice: 0,      
                    avgSpread: 0,     
                    lastZ: 0,   
                    lastLogTime: 0 
                };
            }
        });
    }

    async execute(data) {
        if (!data || !data.type) return;
        try {
            if (data.type === 'depthUpdate') {
                const cleanSymbol = data.s.replace('_USDT', '');
                await this.onDepthUpdate(cleanSymbol, data);
            } 
        } catch (e) {
            this.logger.error(`[STRATEGY] Execution Error: ${e.message}`);
        }
    }

    /**
     * [THE EYE] Tick-Normalized Exponential Decay
     * * GOAL: Ignore deep liquidity (Level 10+) regardless of asset price.
     * METHOD: Normalize distance by 'tickSize'.
     */
    calcNormalizedVol(levels, midPrice, tickSize) {
        let weightedTotal = 0;
        
        // [GUARD RAIL] 
        // We strictly limit to Top 10 levels. 
        // With Alpha=0.5, Level 11 weight is < 0.005 (0.5%).
        // Processing deeper levels wastes CPU for 0% signal gain.
        const limit = Math.min(levels.length, 10); 

        for (let i = 0; i < limit; i++) {
            const price = parseFloat(levels[i][0]);
            const size = parseFloat(levels[i][1]);
            
            if (isNaN(size) || isNaN(price)) continue;

            // 1. Calculate Absolute Distance
            const dist = Math.abs(price - midPrice);
            
            // 2. Normalize to "Ticks Away"
            // BTC: $10 dist / $0.1 tick = 100 ticks (Huge distance)
            // XRP: $0.001 dist / $0.0001 tick = 10 ticks (Medium distance)
            const ticksAway = dist / tickSize;

            // 3. Apply Decay
            const weight = Math.exp(-this.DECAY_ALPHA * ticksAway);
            
            weightedTotal += size * weight;
        }
        return weightedTotal;
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;
        if (!depth.bids.length || !depth.asks.length) return;
        
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        
        // Sanity Check: Crossed Book (Exchange Error)
        if (bestBid >= bestAsk) return; 

        const midPrice = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;
        asset.midPrice = midPrice;

        // Spread Volatility Tracker (SMA)
        if (asset.avgSpread === 0) asset.avgSpread = spread;
        else asset.avgSpread = (asset.avgSpread * 0.99) + (spread * 0.01);

        // --- 1. THE EYE: Calculate Weighted Volumes ---
        const wBidVol = this.calcNormalizedVol(depth.bids, midPrice, asset.config.tickSize);
        const wAskVol = this.calcNormalizedVol(depth.asks, midPrice, asset.config.tickSize);

        if (wBidVol + wAskVol === 0) return;

        // --- 2. THE SIGNAL: Weighted OBI ---
        // Range: -1.0 (Full Sell) to +1.0 (Full Buy)
        const currentOBI = (wBidVol - wAskVol) / (wBidVol + wAskVol);

        // --- 3. THE BRAIN: Forgetful Welford ---
        // [GUARD RAIL]
        // We use "Forgetful" logic (Alpha Decay) instead of "Infinite" logic.
        // This ensures the Z-Score adapts to TODAY'S volatility, not yesterday's.
        
        if (asset.obiCount === 0) {
            asset.obiMean = currentOBI;
            asset.obiVariance = 0;
            asset.obiCount = 1;
        } else {
            // Update Mean (Exponential Moving Average)
            const delta = currentOBI - asset.obiMean;
            asset.obiMean = asset.obiMean + (this.WELFORD_ALPHA * delta);

            // Update Variance (Exponential Moving Variance)
            // This is the "Vibe Check". If market goes crazy, Variance spikes, Z-Score drops.
            asset.obiVariance = (1 - this.WELFORD_ALPHA) * (asset.obiVariance + this.WELFORD_ALPHA * delta * delta);
            asset.obiCount++;
        }

        if (asset.obiCount < this.WARMUP_TICKS) return;

        // --- 4. Z-Score Calculation ---
        const stdDev = Math.sqrt(asset.obiVariance);
        const effectiveStdDev = Math.max(stdDev, this.MIN_NOISE_FLOOR);
        const zScore = (currentOBI - asset.obiMean) / effectiveStdDev;

        // Heartbeat Logging (4s)
        const now = Date.now();
        if (now - asset.lastLogTime > 4000) {
            this.logger.info(`[HEARTBEAT] ${symbol} | Z: ${zScore.toFixed(2)} | OBI: ${currentOBI.toFixed(3)} | Vol: ${effectiveStdDev.toFixed(4)}`);
            asset.lastLogTime = now;
        }

        this.handleRegime(symbol, zScore, spread, asset.avgSpread, currentOBI);
        asset.lastZ = zScore; 
    }

    handleRegime(symbol, zScore, spread, avgSpread, currentOBI) {
        const asset = this.assets[symbol];
        const absZ = Math.abs(zScore);

        // [GUARD RAIL] THE SHIELD: Volatility Gating
        // If Spread > 2x Average, the order book is thin/broken.
        // We increase entry requirement by 1.5x to avoid getting wrecked.
        let dynamicEntry = this.ENTRY_Z;
        if (spread > avgSpread * 2) {
             dynamicEntry = this.ENTRY_Z * 1.5;
        }

        if (asset.currentRegime === 0) {
            // IDLE -> ACTIVE (Entry)
            if (absZ > dynamicEntry) {
                asset.currentRegime = 1;
                const side = zScore > 0 ? 'buy' : 'sell';
                
                this.logger.info(`[SNIPER] ${symbol} ${side.toUpperCase()} | Z: ${zScore.toFixed(2)} (Req: ${dynamicEntry.toFixed(1)})`);
                this.executeTrade(symbol, side, spread, currentOBI);
            }
        } else {
            // ACTIVE -> IDLE (Exit/Cooldown)
            if (absZ < this.EXIT_Z) {
                asset.currentRegime = 0;
                this.logger.info(`[COOLDOWN] ${symbol} | Z-Score normalized.`);
            }
        }
    }

    async executeTrade(symbol, side, spread, obiSignal) {
        if (this.bot.isOrderInProgress) return;
        const pos = this.bot.getPosition(symbol);
        if (pos && pos !== 0) return;

        try {
            const asset = this.assets[symbol];
            const price = asset.midPrice;
            
            // --- [THE HAND] Smart Microprice Targeting ---
            // Goal: Place Limit order at the "Fair Value".
            // Calculation: MidPrice + (HalfSpread * SignalStrength).
            
            const halfSpread = spread / 2;
            const fairValueOffset = halfSpread * obiSignal; 
            
            // Base Price: The calculated Microprice
            let limitPrice = price + fairValueOffset;

            // Aggression: Add 1 tick to ensure we cross the gap if momentum is real.
            if (side === 'buy') limitPrice += asset.config.tickSize;
            else limitPrice -= asset.config.tickSize;

            // Rounding
            limitPrice = parseFloat(limitPrice.toFixed(asset.config.precision));

            // Trailing Stop Calculation
            // Logic: Give the trade room to breathe (2.5x spread), but cut losers fast.
            let trail = spread * 2.5; 
            const minTrail = asset.config.tickSize * 5;
            if (trail < minTrail) trail = minTrail;
            
            if (side === 'buy') trail = -trail;

            await this.bot.placeOrder({
                product_id: asset.config.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "1",
                order_type: 'limit_order',
                time_in_force: 'ioc', 
                limit_price: limitPrice.toString(),
                bracket_trail_amount: trail.toFixed(asset.config.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

            this.logger.info(`[EXECUTE] ${side} @ ${limitPrice} | OBI: ${obiSignal.toFixed(2)}`);

        } catch (e) {
            this.logger.error(`[EXEC_ERROR] ${symbol}: ${e.message}`);
        }
    }
}

module.exports = TickStrategy;
                
