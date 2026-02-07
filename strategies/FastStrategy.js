// FastStrategy.js
// v3.0.0 - [FINAL] Weighted Signal Confidence & 5s Log Frequency

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY CONFIG ---
        this.OBI_WINDOW = 100;
        
        // LOGGING CONFIG
        this.LOG_FREQ_MS = 5000;      // Log every 5 seconds (Heartbeat)
        
        // EXECUTION CONFIG
        this.MIN_SCORE_FIRE = 75;     // Fire if Total Confidence > 75%
        this.LOCK_DURATION_MS = 1500;
        
        // Safety
        this.lastErrorTime = 0;
        this.ERROR_COOLDOWN_MS = 5000;
        this.slPercent = 0.15; 

        // MASTER ASSET CONFIG
        // 'saturationQty' is the amount of 'Pull' needed for 100% confidence on Gate 4
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, tickSize: 0.0001, lotSize: 1,     precision: 4, sizeDecimals: 0, saturationQty: 50000 },
            'BTC': { deltaId: 27,    tickSize: 0.1,    lotSize: 0.001, precision: 1, sizeDecimals: 3, saturationQty: 5.0 },
            'ETH': { deltaId: 299,   tickSize: 0.01,   lotSize: 0.01,  precision: 2, sizeDecimals: 2, saturationQty: 100.0 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(asset => {
            if (MASTER_CONFIG[asset]) {
                this.assets[asset] = {
                    config: MASTER_CONFIG[asset],
                    history: { obi: [], prevOBI: 0, prevBidQty: 0, prevAskQty: 0 },
                    lastTriggerTime: 0,
                    lastLogTime: 0 
                };
            }
        });

        this.isOrderInProgress = false;
    }

    getName() { return "FastStrategy (Weighted Confidence v3.0)"; }

    async onDepthUpdate(symbol, depth) {
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;
        if (Date.now() - this.lastErrorTime < this.ERROR_COOLDOWN_MS) return;

        const asset = this.assets[symbol];
        if (!asset) return;

        const now = Date.now();

        try {
            // 1. DATA PROCESSING (Depth 5)
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         // For WDOBP
            let sumBidP_AskQ = 0, sumAskP_BidQ = 0; // For VAMP

            for (let i = 0; i < 5; i++) {
                const bP = parseFloat(depth.bids[i][0]); const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]); const aQ = parseFloat(depth.asks[i][1]);

                totalBidQty += bQ; totalAskQty += aQ;
                sumBidPQ += (bP * bQ); sumAskPQ += (aP * aQ);
                sumBidP_AskQ += (bP * aQ); sumAskP_BidQ += (aP * bQ);
            }

            const standardMid = (parseFloat(depth.bids[0][0]) + parseFloat(depth.asks[0][0])) / 2;

            if (asset.history.prevBidQty === 0) {
                this.updateHistory(asset, 0, totalBidQty, totalAskQty);
                return;
            }

            // 2. CALCULATE RAW METRICS
            // ------------------------
            
            // Gate 1: OBI Z-Score
            const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            const rawZ = this.calculateZScore(asset.history.obi);

            // Gate 2: Momentum (dOBI)
            const rawDOBI = obi - asset.history.prevOBI;

            // Gate 3: WD Shift (Ticks)
            const wdobp = (sumBidPQ + sumAskPQ) / (totalBidQty + totalAskQty);
            const vamp = (sumBidP_AskQ + sumAskP_BidQ) / (totalBidQty + totalAskQty);
            const rawShiftTicks = (wdobp - vamp) / asset.config.tickSize;

            // Gate 4: Gravity Pull (Qty)
            const rawPull = (asset.history.prevAskQty - totalAskQty) - (asset.history.prevBidQty - totalBidQty);

            // 3. CALCULATE WEIGHTED CONFIDENCE
            // --------------------------------
            // We calculate scores for BUY (positive values) and SELL (negative values converted to positive for scoring)
            
            // --- BUY SCORE ---
            const scoreZ_Buy = this.getScore(rawZ, 2.5, 30);        // Target Z=2.5 for full 30%
            const scoreMom_Buy = this.getScore(rawDOBI, 0.4, 20);   // Target dOBI=0.4 for full 20%
            const scoreShift_Buy = this.getScore(rawShiftTicks, 2.0, 30); // Target Shift=2 ticks for full 30%
            const scorePull_Buy = this.getScore(rawPull, asset.config.saturationQty, 20); // Target 5 BTC pull for 20%
            const totalBuyScore = scoreZ_Buy + scoreMom_Buy + scoreShift_Buy + scorePull_Buy;

            // --- SELL SCORE ---
            // For Sell, we expect negative numbers, so we flip sign (-rawZ)
            const scoreZ_Sell = this.getScore(-rawZ, 2.5, 30);
            const scoreMom_Sell = this.getScore(-rawDOBI, 0.4, 20);
            const scoreShift_Sell = this.getScore(-rawShiftTicks, 2.0, 30);
            const scorePull_Sell = this.getScore(-rawPull, asset.config.saturationQty, 20);
            const totalSellScore = scoreZ_Sell + scoreMom_Sell + scoreShift_Sell + scorePull_Sell;

            // 4. LOGGING (5s Frequency)
            // -------------------------
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                const direction = totalBuyScore > totalSellScore ? 'BUY' : 'SELL';
                const score = Math.max(totalBuyScore, totalSellScore).toFixed(1);
                
                // Detailed breakdown for debugging
                const details = direction === 'BUY' 
                    ? `Z:${scoreZ_Buy.toFixed(0)}% | Mom:${scoreMom_Buy.toFixed(0)}% | WD:${scoreShift_Buy.toFixed(0)}% | Pull:${scorePull_Buy.toFixed(0)}%`
                    : `Z:${scoreZ_Sell.toFixed(0)}% | Mom:${scoreMom_Sell.toFixed(0)}% | WD:${scoreShift_Sell.toFixed(0)}% | Pull:${scorePull_Sell.toFixed(0)}%`;

                this.logger.info(`[H-Beat] ${symbol} Strength: ${score}% (${direction}) -> [ ${details} ]`);
                asset.lastLogTime = now;
            }

            // 5. EXECUTION LOGIC
            // ------------------
            const isCoolingDown = (now - asset.lastTriggerTime < this.LOCK_DURATION_MS);
            
            if (!isCoolingDown) {
                let side = null;
                let finalScore = 0;

                if (totalBuyScore > this.MIN_SCORE_FIRE) {
                    side = 'buy';
                    finalScore = totalBuyScore;
                } else if (totalSellScore > this.MIN_SCORE_FIRE) {
                    side = 'sell';
                    finalScore = totalSellScore;
                }

                if (side) {
                    asset.lastTriggerTime = now;
                    
                    // --- IMMEDIATE LOG (When Order Happens) ---
                    this.logger.info(`[🔥 TRIGGER] ${side.toUpperCase()} ${symbol} | CONFIDENCE: ${finalScore.toFixed(1)}%`);
                    this.logger.info(`[Signal Breakdown] Z:${rawZ.toFixed(2)} | dOBI:${rawDOBI.toFixed(3)} | Shift:${rawShiftTicks.toFixed(2)} | Pull:${rawPull.toFixed(2)}`);

                    // Use VAMP for smarter execution price
                    const execPrice = side === 'buy' ? Math.min(vamp, standardMid) : Math.max(vamp, standardMid);
                    
                    await this.executeMicroTrade(symbol, side, execPrice, asset.config);
                }
            }

            this.updateHistory(asset, obi, totalBidQty, totalAskQty);

        } catch (e) {
            this.logger.error(`[FastStrategy] Error: ${e.message}`);
        }
    }

    // Helper: Normalize value to a weighted score
    // val: current value (e.g., Z-Score 1.5)
    // saturation: value needed for max points (e.g., 2.5)
    // maxPoints: max percentage for this gate (e.g., 30)
    getScore(val, saturation, maxPoints) {
        if (val <= 0) return 0; // If value opposes signal, 0 points
        const ratio = Math.min(val / saturation, 1.0); // Cap at 1.0 (100%)
        return ratio * maxPoints;
    }

    updateHistory(asset, obi, bQty, aQty) {
        asset.history.prevOBI = obi;
        asset.history.prevBidQty = bQty;
        asset.history.prevAskQty = aQty;
    }

    calculateZScore(values) {
        if (values.length < 20) return 0;
        const mean = values.reduce((a, b) => a + b) / values.length;
        const std = Math.sqrt(values.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / values.length);
        return std === 0 ? 0 : (values[values.length - 1] - mean) / std;
    }

    async executeMicroTrade(symbol, side, price, assetConfig) {
        this.isOrderInProgress = true; 
        this.bot.isOrderInProgress = true;
        try {
            const rawSize = parseFloat(this.bot.config.orderSize);
            let calculatedSize = Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize;
            
            // Aggression
            const aggression = this.bot.config.priceAggressionOffset || 0.02;
            const limitPriceNum = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100));
            
            const orderData = {
                product_id: assetConfig.deltaId.toString(),
                size: calculatedSize.toFixed(assetConfig.sizeDecimals),
                side: side,
                order_type: 'limit_order',
                limit_price: limitPriceNum.toFixed(assetConfig.precision),
                time_in_force: 'ioc'
            };

            this.logger.info(`[Order Payload] Sending...`);
            await this.bot.placeOrder(orderData);
            
        } catch (err) {
            this.lastErrorTime = Date.now();
            this.logger.warn(`[Strategy Error] ${err.message}`);
        } finally {
            this.isOrderInProgress = false; 
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
                    
