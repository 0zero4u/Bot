// FastStrategy.js
// v3.1.0 - [FINAL] Weighted Confidence, VAMP Integration, & Dual-Mode Logging

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- STRATEGY CONFIG ---
        this.OBI_WINDOW = 100;
        this.LOG_FREQ_MS = 5000;      // Heartbeat every 5s
        this.MIN_SCORE_FIRE = 75;     // Threshold for trade (Out of 100)
        this.LOCK_DURATION_MS = 1500; // Post-trade cooldown
        
        // Safety & SL
        this.lastErrorTime = 0;
        this.ERROR_COOLDOWN_MS = 5000;
        this.slPercent = 0.15;        // 0.15% safety net

        // MASTER ASSET CONFIG (Saturation values for 100% confidence)
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

    getName() { return "FastStrategy (Micro-Weighted v3.1)"; }

    async onDepthUpdate(symbol, depth) {
        // Prevent concurrent orders or firing during error cooldown
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;
        if (Date.now() - this.lastErrorTime < this.ERROR_COOLDOWN_MS) return;

        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // ============================================
            // 1. DATA PROCESSING (Depth 5)
            // ============================================
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         // Weighted Price
            let sumBidP_AskQ = 0, sumAskP_BidQ = 0; // VAMP Cross-Mult

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

            // ============================================
            // 2. RAW CALCULATIONS (Microstructure)
            // ============================================
            
            // Gate 1: OBI Z-Score
            const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            const rawZ = this.calculateZScore(asset.history.obi);

            // Gate 2: Momentum (dOBI)
            const rawDOBI = obi - asset.history.prevOBI;

            // Gate 3: WD Shift (Ticks relative to VAMP)
            const wdobp = (sumBidPQ + sumAskPQ) / (totalBidQty + totalAskQty);
            const vamp = (sumBidP_AskQ + sumAskP_BidQ) / (totalBidQty + totalAskQty);
            const rawShiftTicks = (wdobp - vamp) / asset.config.tickSize;

            // Gate 4: Gravity Pull (Change in Quantities)
            const rawPull = (asset.history.prevAskQty - totalAskQty) - (asset.history.prevBidQty - totalBidQty);

            // ============================================
            // 3. WEIGHTED CONFIDENCE SCORING
            // ============================================
            
            // --- Scoring Parameters ---
            // OBI: 30%, Momentum: 20%, Shift: 30%, Gravity Pull: 20%
            
            const buyScore = 
                this.getScore(rawZ, 2.5, 30) + 
                this.getScore(rawDOBI, 0.4, 20) + 
                this.getScore(rawShiftTicks, 2.0, 30) + 
                this.getScore(rawPull, asset.config.saturationQty, 20);

            const sellScore = 
                this.getScore(-rawZ, 2.5, 30) + 
                this.getScore(-rawDOBI, 0.4, 20) + 
                this.getScore(-rawShiftTicks, 2.0, 30) + 
                this.getScore(-rawPull, asset.config.saturationQty, 20);

            // ============================================
            // 4. DUAL-MODE LOGGING
            // ============================================
            
            // MODE A: Heartbeat (Background Log every 5s)
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                const direction = buyScore > sellScore ? 'BUY' : 'SELL';
                const score = Math.max(buyScore, sellScore).toFixed(1);
                this.logger.info(`[H-Beat] ${symbol} Strength: ${score}% (${direction}) -> [ Z:${rawZ.toFixed(2)} | dOBI:${rawDOBI.toFixed(3)} | Shift:${rawShiftTicks.toFixed(2)} | Pull:${rawPull.toFixed(2)} ]`);
                asset.lastLogTime = now;
            }

            // ============================================
            // 5. EXECUTION GATES
            // ============================================
            
            if (!this.bot.hasOpenPosition && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS)) {
                let side = null;
                let finalScore = 0;

                if (buyScore >= this.MIN_SCORE_FIRE) { side = 'buy'; finalScore = buyScore; }
                else if (sellScore >= this.MIN_SCORE_FIRE) { side = 'sell'; finalScore = sellScore; }

                if (side) {
                    asset.lastTriggerTime = now;
                    
                    // MODE B: Trigger Log (Immediate on Order Punch)
                    this.logger.info(`[🔥 TRIGGER] ${side.toUpperCase()} ${symbol} | CONFIDENCE: ${finalScore.toFixed(1)}%`);
                    this.logger.info(`[Signal Breakdown] Z:${rawZ.toFixed(2)} | dOBI:${rawDOBI.toFixed(3)} | Shift:${rawShiftTicks.toFixed(2)} | Pull:${rawPull.toFixed(2)}`);

                    // Use VAMP for smarter entry price anchor
                    const execPrice = side === 'buy' ? Math.min(vamp, standardMid) : Math.max(vamp, standardMid);
                    await this.executeMicroTrade(symbol, side, execPrice, asset.config);
                }
            }

            this.updateHistory(asset, obi, totalBidQty, totalAskQty);

        } catch (e) {
            this.logger.error(`[FastStrategy] Critical Error: ${e.message}`);
        }
    }

    getScore(val, saturation, maxPoints) {
        if (val <= 0) return 0;
        return Math.min(val / saturation, 1.0) * maxPoints;
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
            const sizeStr = (Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize).toFixed(assetConfig.sizeDecimals);
            
            const aggression = this.bot.config.priceAggressionOffset || 0.02;
            const limitPriceNum = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100));
            const slPriceNum = (side === 'buy' ? limitPriceNum * (1 - this.slPercent/100) : limitPriceNum * (1 + this.slPercent/100));

            const orderData = {
                product_id: assetConfig.deltaId.toString(),
                size: sizeStr,
                side: side,
                order_type: 'limit_order',
                limit_price: limitPriceNum.toFixed(assetConfig.precision),
                time_in_force: 'ioc',
                bracket_stop_loss_price: slPriceNum.toFixed(assetConfig.precision),
                bracket_stop_trigger_method: 'mark_price'
            };

            this.logger.info(`[Order Payload] Sending Aggressive IOC + Safety SL...`);
            await this.bot.placeOrder(orderData);
            
        } catch (err) {
            this.lastErrorTime = Date.now();
            this.logger.warn(`[Execution Error] ${err.message}`);
        } finally {
            this.isOrderInProgress = false; 
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
        
