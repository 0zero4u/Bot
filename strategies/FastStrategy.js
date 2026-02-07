// FastStrategy.js
// v4.1.0 - [FINAL] Weighted Confidence, Trailing Stop, Alpha Decay & Momentum Flip

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CORE STRATEGY CONFIG ---
        this.OBI_WINDOW = 100;
        this.LOG_FREQ_MS = 5000;      // Heartbeat frequency (5s)
        this.MIN_SCORE_FIRE = 75;     // Threshold to enter (0-100)
        this.LOCK_DURATION_MS = 2000; // Cooldown after trade attempt
        
        // --- EXIT CONFIGURATION (Configurable Thresholds) ---
        this.ALPHA_DECAY_THRESHOLD = parseFloat(process.env.ALPHA_DECAY_THRESHOLD || '30'); // Exit if confidence < 30%
        this.MOMENTUM_FLIP_THRESHOLD = parseFloat(process.env.MOMENTUM_FLIP_THRESHOLD || '65'); // Exit if opposite signal > 65%
        this.TRAILING_DIP_TICKS = 2;   // Exit if price dips 2 ticks from peak
        this.slPercent = 0.15;         // Initial Safety SL (%)

        // MASTER ASSET CONFIG (Saturation for 100% confidence per gate)
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
                    position: null, // Tracks {side, entryPrice, peakPrice}
                    lastTriggerTime: 0,
                    lastLogTime: 0 
                };
            }
        });

        this.isOrderInProgress = false;
    }

    getName() { return "FastStrategy (Weighted-Pro v4.1)"; }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // 1. DATA PROCESSING (Depth 5)
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         
            let sumBidP_AskQ = 0, sumAskP_BidQ = 0; 

            for (let i = 0; i < 5; i++) {
                const bP = parseFloat(depth.bids[i][0]); const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]); const aQ = parseFloat(depth.asks[i][1]);

                totalBidQty += bQ; totalAskQty += aQ;
                sumBidPQ += (bP * bQ); sumAskPQ += (aP * aQ);
                sumBidP_AskQ += (bP * aQ); sumAskP_BidQ += (aP * bQ);
            }

            const standardMid = (parseFloat(depth.bids[0][0]) + parseFloat(depth.asks[0][0])) / 2;
            const vamp = (sumBidP_AskQ + sumAskP_BidQ) / (totalBidQty + totalAskQty);
            const currentPrice = vamp; 

            // 2. MICROSTRUCTURE CALCULATIONS
            const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            const rawZ = this.calculateZScore(asset.history.obi);
            const rawDOBI = obi - asset.history.prevOBI;
            const wdobp = (sumBidPQ + sumAskPQ) / (totalBidQty + totalAskQty);
            const rawShiftTicks = (wdobp - vamp) / asset.config.tickSize;
            const rawPull = (asset.history.prevAskQty - totalAskQty) - (asset.history.prevBidQty - totalBidQty);

            // 3. WEIGHTED SCORING
            const buyScore = this.getScore(rawZ, 2.5, 30) + this.getScore(rawDOBI, 0.4, 20) + 
                             this.getScore(rawShiftTicks, 2.0, 30) + this.getScore(rawPull, asset.config.saturationQty, 20);

            const sellScore = this.getScore(-rawZ, 2.5, 30) + this.getScore(-rawDOBI, 0.4, 20) + 
                              this.getScore(-rawShiftTicks, 2.0, 30) + this.getScore(-rawPull, asset.config.saturationQty, 20);

            // 4. OPEN POSITION MANAGEMENT (EXITS)
            if (this.bot.hasOpenPosition && asset.position) {
                this.manageExits(symbol, currentPrice, buyScore, sellScore);
                this.updateHistory(asset, obi, totalBidQty, totalAskQty);
                return; // One Punch Rule: Lock Entry Logic
            }

            // 5. HEARTBEAT LOGGING (5s)
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                const dominant = buyScore > sellScore ? 'BUY' : 'SELL';
                const score = Math.max(buyScore, sellScore).toFixed(1);
                this.logger.info(`[H-Beat] ${symbol} Strength: ${score}% (${dominant}) | Pos: ${this.bot.hasOpenPosition}`);
                asset.lastLogTime = now;
            }

            // 6. ENTRY GATES
            if (!this.bot.hasOpenPosition && !this.isOrderInProgress && !this.bot.isOrderInProgress) {
                let side = null;
                let finalScore = 0;

                if (buyScore >= this.MIN_SCORE_FIRE) { side = 'buy'; finalScore = buyScore; }
                else if (sellScore >= this.MIN_SCORE_FIRE) { side = 'sell'; finalScore = sellScore; }

                if (side && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS)) {
                    asset.lastTriggerTime = now;
                    this.logger.info(`[🔥 TRIGGER] ${side.toUpperCase()} ${symbol} | CONF: ${finalScore.toFixed(1)}%`);
                    
                    asset.position = { side: side, entryPrice: currentPrice, peakPrice: currentPrice };
                    
                    const execPrice = side === 'buy' ? Math.min(vamp, standardMid) : Math.max(vamp, standardMid);
                    await this.executeMicroTrade(symbol, side, execPrice, asset.config);
                }
            }

            this.updateHistory(asset, obi, totalBidQty, totalAskQty);

        } catch (e) {
            this.logger.error(`[FastStrategy] Loop Error: ${e.message}`);
        }
    }

    manageExits(symbol, currentPrice, buyScore, sellScore) {
        const asset = this.assets[symbol];
        const pos = asset.position;
        if (!pos) return;

        // --- A. TRAILING STOP (2 Ticks) ---
        let dip = 0;
        const dipThreshold = this.TRAILING_DIP_TICKS * asset.config.tickSize;

        if (pos.side === 'buy') {
            if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
            dip = pos.peakPrice - currentPrice;
        } else {
            if (currentPrice < pos.peakPrice) pos.peakPrice = currentPrice;
            dip = currentPrice - pos.peakPrice;
        }

        if (dip >= dipThreshold) {
            this.logger.warn(`[EXIT] Trailing Stop hit for ${symbol} (Dipped ${this.TRAILING_DIP_TICKS} ticks)`);
            return this.executeMarketExit(symbol);
        }

        // --- B. ALPHA DECAY (Confidence Drop) ---
        const currentConf = pos.side === 'buy' ? buyScore : sellScore;
        if (currentConf < this.ALPHA_DECAY_THRESHOLD) {
            this.logger.warn(`[EXIT] Alpha Decay for ${symbol} (Strength ${currentConf.toFixed(1)}% < ${this.ALPHA_DECAY_THRESHOLD}%)`);
            return this.executeMarketExit(symbol);
        }

        // --- C. MOMENTUM FLIP (Opposing Signal) ---
        const opposingConf = pos.side === 'buy' ? sellScore : buyScore;
        if (opposingConf >= this.MOMENTUM_FLIP_THRESHOLD) {
            this.logger.warn(`[EXIT] Momentum Flip for ${symbol} (Opposing Strength ${opposingConf.toFixed(1)}% > ${this.MOMENTUM_FLIP_THRESHOLD}%)`);
            return this.executeMarketExit(symbol);
        }
    }

    async executeMarketExit(symbol) {
        if (this.isOrderInProgress) return;
        this.isOrderInProgress = true;
        this.bot.isOrderInProgress = true;
        const asset = this.assets[symbol];
        try {
            const side = asset.position.side === 'buy' ? 'sell' : 'buy';
            const orderData = {
                product_id: asset.config.deltaId.toString(),
                size: this.bot.config.orderSize,
                side: side,
                order_type: 'market_order',
                reduce_only: true
            };
            this.logger.info(`[EXIT] Sending Market Order to close ${symbol} position.`);
            await this.bot.placeOrder(orderData);
            asset.position = null; 
        } catch (err) {
            this.logger.error(`[Exit Error] ${err.message}`);
        } finally {
            this.isOrderInProgress = false;
            this.bot.isOrderInProgress = false;
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
                
