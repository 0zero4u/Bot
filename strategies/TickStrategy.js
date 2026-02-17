/**
 * TickStrategy.js
 * v9.3 [NATIVE ALIGNMENT + HARD SL TRAIL]
 * Updated to accept Rust Native Client (Level 1) Data
 * Aligned SL/TP with AdvanceStrategy v83
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY PARAMETERS ---
        this.DECAY_ALPHA = 0.2;
        this.WELFORD_ALPHA = 0.00011 ;
        this.ENTRY_Z = 1.85;
        this.EXIT_Z = 0.2;
        this.MIN_NOISE_FLOOR = 0.05;
        this.WARMUP_TICKS = 10000; 
        
        // --- RISK SETTINGS (Aligned with AdvanceStrategy) ---
        // 0.02% (Stored as percentage like AdvanceStrategy)
        this.TRAILING_PERCENT = 0.02; 

        // Config aligned with what the Bot expects
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, tickSize: 0.01 },
            'SOL': { deltaId: 417,   precision: 3, tickSize: 0.1 }
        };

        this.assets = {};

        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            const cleanSymbol = symbol.trim().toUpperCase().replace('_USDT', '');
            if (MASTER_CONFIG[cleanSymbol]) {
                this.assets[cleanSymbol] = {
                    config: MASTER_CONFIG[cleanSymbol],
                    obiMean: 0,
                    obiVariance: 0,
                    obiCount: 0,
                    currentRegime: 0,
                    regimeSide: null,
                    midPrice: 0,
                    avgSpread: 0,
                    lastZ: 0,
                    lastLogTime: 0
                };
            }
        });
        
        this.logger.info(`[TickStrategy] Loaded v9.3 | SL/Trail: ${this.TRAILING_PERCENT}% | Targets: ${Object.keys(this.assets).join(',')}`);
    }

    getName() {
        return "TickStrategy v9.3 (Native+Trail)";
    }

    async start() {
        this.logger.info(`[TickStrategy] 🟢 Engine Started (Waiting for Rust Data...)`);
    }

    onPositionClose(symbol) {
        if (this.assets[symbol]) {
            this.assets[symbol].currentRegime = 0;
            this.assets[symbol].regimeSide = null;
            this.logger.info(`[STRATEGY] ${symbol} Position Closed -> Regime Reset.`);
        }
    }

    /**
     * Entry point called by trader.js when Rust sends data
     * Data format: { s: symbol, bb: best_bid, bq: bid_qty, ba: best_ask, aq: ask_qty }
     */
    async onDepthUpdate(data) {
        if (!data || !data.s) return;
        
        const cleanSymbol = data.s.replace('_USDT', '');
        const asset = this.assets[cleanSymbol];
        if (!asset) return;

        // Parse Rust Data (Level 1 Only)
        const bestBid = parseFloat(data.bb);
        const bestAsk = parseFloat(data.ba);
        const bestBidSize = parseFloat(data.bq);
        const bestAskSize = parseFloat(data.aq);

        // Basic validation
        if (bestBid >= bestAsk || bestBid === 0 || bestAsk === 0) return;

        // --- 1. METRICS CALCULATION (Adapted for Level 1) ---
        const pureMid = (bestBid + bestAsk) / 2;
        
        // Microprice (Level 1 weighted mid)
        // Formula: (Ask * BidVol + Bid * AskVol) / (BidVol + AskVol)
        const microprice = (bestAsk * bestBidSize + bestBid * bestAskSize) / (bestBidSize + bestAskSize);
        
        const spread = bestAsk - bestBid;
        asset.midPrice = microprice;

        // Update Average Spread
        if (asset.avgSpread === 0) asset.avgSpread = spread;
        else asset.avgSpread = (asset.avgSpread * 0.99) + (spread * 0.01);

        // OBI (Order Book Imbalance) - Level 1 Adaptation
        // (BidVol - AskVol) / (BidVol + AskVol)
        const totalVol = bestBidSize + bestAskSize;
        if (totalVol === 0) return;
        
        const currentOBI = (bestBidSize - bestAskSize) / totalVol;

        // --- 2. WELFORD'S ALGORITHM (Volatility/Z-Score) ---
        if (asset.obiCount === 0) {
            asset.obiMean = currentOBI;
            asset.obiVariance = 0;
        } else {
            const delta = currentOBI - asset.obiMean;
            asset.obiMean += this.WELFORD_ALPHA * delta;
            asset.obiVariance = (1 - this.WELFORD_ALPHA) * (asset.obiVariance + this.WELFORD_ALPHA * delta * delta);
        }
        asset.obiCount++;

        // Warmup check
        if (asset.obiCount < this.WARMUP_TICKS) {
            if (asset.obiCount % 100 === 0) {
                this.logger.info(`[WARMUP] ${cleanSymbol} Ticks: ${asset.obiCount}/${this.WARMUP_TICKS}`);
            }
            return;
        }

        const stdDev = Math.sqrt(asset.obiVariance);
        const effectiveStd = Math.max(stdDev, this.MIN_NOISE_FLOOR); // Noise floor
        const zScore = (currentOBI - asset.obiMean) / effectiveStd;

        asset.lastZ = zScore;

        // --- 3. SIGNAL LOGIC ---
        
        // EXIT LOGIC
        if (asset.currentRegime !== 0) {
            // If we are LONG (1) and Z drops below EXIT_Z
            if (asset.currentRegime === 1 && zScore < this.EXIT_Z) {
                this.logger.info(`[SIGNAL] ${cleanSymbol} EXIT LONG (Z: ${zScore.toFixed(2)})`);
                // Note: Actual exit is handled by the Trail Stop, but we could force exit here if desired.
                // For now, we just reset regime to allow re-entry.
                asset.currentRegime = 0; 
                asset.regimeSide = null;
            }
            // If we are SHORT (-1) and Z rises above -EXIT_Z
            else if (asset.currentRegime === -1 && zScore > -this.EXIT_Z) {
                this.logger.info(`[SIGNAL] ${cleanSymbol} EXIT SHORT (Z: ${zScore.toFixed(2)})`);
                asset.currentRegime = 0;
                asset.regimeSide = null;
            }
        }

        // ENTRY LOGIC (Only if no position known in bot)
        if (asset.currentRegime === 0 && !this.bot.hasOpenPosition(cleanSymbol)) {
            if (zScore > this.ENTRY_Z) {
                await this.executeEntry(cleanSymbol, 'buy', bestAsk, asset);
            } else if (zScore < -this.ENTRY_Z) {
                await this.executeEntry(cleanSymbol, 'sell', bestBid, asset);
            }
        }

        // Extensive Logging (Throttled slightly to prevent disk flood, but detailed)
        const now = Date.now();
        if (now - asset.lastLogTime > 2000) { // Log every 2s
            this.logger.info(`[TICK] ${cleanSymbol} | P: ${pureMid.toFixed(asset.config.precision)} | OBI: ${currentOBI.toFixed(3)} | Z: ${zScore.toFixed(2)} | Vol: ${totalVol.toFixed(2)}`);
            asset.lastLogTime = now;
        }
    }

    async executeEntry(symbol, side, price, asset) {
        // Prevent double entry
        asset.currentRegime = (side === 'buy') ? 1 : -1;
        asset.regimeSide = side;

        this.logger.info(`[EXECUTE] ${symbol} ${side.toUpperCase()} triggered | Z: ${asset.lastZ.toFixed(2)}`);

        try {
            const clientOid = `tick_${Date.now()}`;
            
            // --- TRAIL LOGIC ALIGNED WITH ADVANCE STRATEGY ---
            // AdvanceStrategy Logic: trailValue = quotePrice * (this.TRAILING_PERCENT / 100);
            const trailValue = price * (this.TRAILING_PERCENT / 100);
            
            // Ensure trail is positive absolute number
            const trailAmountAbs = Math.abs(trailValue).toFixed(asset.config.precision);
            
            // Safety: Ensure trail isn't smaller than 2 ticks
            const minSafeTrail = asset.config.tickSize * 2;
            if (parseFloat(trailAmountAbs) < minSafeTrail) {
                this.logger.warn(`[SAFETY] Calculated trail ${trailAmountAbs} too small. Using min ${minSafeTrail}`);
            }

            // Punch latency record
            this.bot.recordOrderPunch(clientOid);

            const payload = {
                product_id: asset.config.deltaId.toString(),
                side: side,
                size: process.env.ORDER_SIZE || "10", // Defaulting if env missing
                order_type: 'market_order', 
                client_order_id: clientOid,
                
                // --- SAFETY + PROFIT MECHANISM (Aligned) ---
                bracket_trail_amount: trailAmountAbs,
                bracket_stop_trigger_method: 'last_traded_price' // Aligned with AdvanceStrategy
            };

            const result = await this.bot.placeOrder(payload);

            if (result && result.success) {
                this.logger.info(`[FILLED] ${symbol} ${side} | Trail: ${trailAmountAbs} (${this.TRAILING_PERCENT}%)`);
            } else {
                this.logger.error(`[ORDER FAIL] ${symbol} ${side} | ${JSON.stringify(result)}`);
                asset.currentRegime = 0; // Reset on failure
            }

        } catch (error) {
            this.logger.error(`[EXEC EXCEPTION] ${error.message}`);
            asset.currentRegime = 0;
        }
    }
}

module.exports = TickStrategy;
