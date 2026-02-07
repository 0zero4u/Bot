// FastStrategy.js
// v6.0.0 - [FINAL] VAMP-Effective Math | Dual-Tier Entry | Zombie State Fix

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CORE STRATEGY CONFIG ---
        this.OBI_WINDOW = 100;        // Window size for Order Book Imbalance history
        this.LOG_FREQ_MS = 5000;      // Heartbeat log frequency
        
        // --- TIERED ENTRY THRESHOLDS ---
        this.MIN_SCORE_LIMIT = 44;    // Tier 1: Place Limit Order (Standard)
        this.MIN_SCORE_MARKET = 55;   // Tier 2: Place Market Order (High Confidence)
        
        this.LOCK_DURATION_MS = 2000; // Cooldown between signals to prevent spam
        
        // --- EXIT CONFIGURATION ---
        this.ALPHA_DECAY_THRESHOLD = parseFloat(process.env.ALPHA_DECAY_THRESHOLD || '96'); 
        this.MOMENTUM_FLIP_THRESHOLD = parseFloat(process.env.MOMENTUM_FLIP_THRESHOLD || '50'); 
        this.TRAILING_DIP_TICKS = 100;   
        this.slPercent = 0.15;         

        // Asset Specific Configurations (Delta Exchange Specs)
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
                    position: null, 
                    lastTriggerTime: 0,
                    lastLogTime: 0 
                };
            }
        });

        this.isOrderInProgress = false;
    }

    getName() { return "FastStrategy (VAMP-Eff v6.0)"; }

    /**
     * Core Loop: Processes Depth5 updates from Binance/Internal Feed
     * Calculates VAMP, OBI, and triggers trades based on weighted scores.
     */
    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // --- 1. VAMP & DATA PROCESSING (IMPROVED FORMULA) ---
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         

            // Iterate top 5 levels
            for (let i = 0; i < 5; i++) {
                const bP = parseFloat(depth.bids[i][0]); const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]); const aQ = parseFloat(depth.asks[i][1]);
                
                totalBidQty += bQ; 
                totalAskQty += aQ;
                
                // Accumulate Weighted Price for "Effective Price" Calc
                sumBidPQ += (bP * bQ); 
                sumAskPQ += (aP * aQ);
            }

            // [MATH FIX] VAMP-Effective Calculation
            // Step A: Calculate Effective Price (Weighted Average Price) for each side
            const pEffectiveBid = sumBidPQ / totalBidQty;
            const pEffectiveAsk = sumAskPQ / totalAskQty;

            // Step B: Calculate VAMP_Effective by cross-weighting (P_bid * Q_ask + P_ask * Q_bid) / Total_Q
            // This is more stable than raw cross-multiplication for HFT.
            const vampEffective = (pEffectiveBid * totalAskQty + pEffectiveAsk * totalBidQty) / (totalBidQty + totalAskQty);
            const currentPrice = vampEffective; 
            
            // Standard Mid Price for sanity check / limit orders
            const standardMid = (parseFloat(depth.bids[0][0]) + parseFloat(depth.asks[0][0])) / 2;

            // --- 2. SIGNAL GENERATION ---
            // Standard OBI Calculation
            const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            // Z-Score of OBI (Statistical deviation)
            const rawZ = this.calculateZScore(asset.history.obi);
            // Delta OBI (Momentum of imbalance)
            const rawDOBI = obi - asset.history.prevOBI;
            
            // Weighted Depth Order Book Price (WDOBP) Shift
            // WDOBP uses same-side weighting: (SumBidPQ + SumAskPQ) / TotalQ
            const wdobp = (sumBidPQ + sumAskPQ) / (totalBidQty + totalAskQty);
            const rawShiftTicks = (wdobp - vampEffective) / asset.config.tickSize;
            
            // Order Book Pull (Liquidity disappearing)
            const rawPull = (asset.history.prevAskQty - totalAskQty) - (asset.history.prevBidQty - totalBidQty);

            // --- 3. WEIGHTED SCORING ---
            const buyScore = this.getScore(rawZ, 2.5, 30) + this.getScore(rawDOBI, 0.4, 20) + 
                             this.getScore(rawShiftTicks, 2.0, 30) + this.getScore(rawPull, asset.config.saturationQty, 20);

            const sellScore = this.getScore(-rawZ, 2.5, 30) + this.getScore(-rawDOBI, 0.4, 20) + 
                              this.getScore(-rawShiftTicks, 2.0, 30) + this.getScore(-rawPull, asset.config.saturationQty, 20);

            // --- 4. POSITION MANAGEMENT ---
            if (this.bot.hasOpenPosition && asset.position) {
                this.manageExits(symbol, currentPrice, buyScore, sellScore);
                this.updateHistory(asset, obi, totalBidQty, totalAskQty);
                return; 
            }

            // --- 5. INTELLIGENT LOGGING ---
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                // Determine which side is stronger for the log
                const isBuyStronger = buyScore >= sellScore;
                const score = isBuyStronger ? buyScore : sellScore;
                const sideTag = isBuyStronger ? '[BUY]' : '[SELL]';
                
                this.logger.info(`[H-Beat] ${symbol} Strength: ${score.toFixed(1)}% ${sideTag} | VAMP: ${currentPrice.toFixed(asset.config.precision)}`);
                asset.lastLogTime = now;
            }

            // --- 6. DUAL-TIER ENTRY LOGIC ---
            if (!this.bot.hasOpenPosition && !this.isOrderInProgress && !this.bot.isOrderInProgress) {
                let side = null;
                let finalScore = 0;

                // [LOGIC FIX] Pick the stronger side if both are active
                if (buyScore >= this.MIN_SCORE_LIMIT && buyScore >= sellScore) { 
                    side = 'buy'; finalScore = buyScore; 
                }
                else if (sellScore >= this.MIN_SCORE_LIMIT) { 
                    side = 'sell'; finalScore = sellScore; 
                }

                if (side && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS)) {
                    asset.lastTriggerTime = now;

                    // [TIERED ENTRY]
                    // Score 85+ -> MARKET Order (Get in NOW)
                    // Score 74-84 -> LIMIT Order (Try to catch price)
                    const orderType = finalScore >= this.MIN_SCORE_MARKET ? 'market_order' : 'limit_order';
                    const typeTag = orderType === 'market_order' ? '🚀 MARKET' : 'LIMIT';

                    this.logger.info(`[🔥 TRIGGER] ${side.toUpperCase()} ${symbol} | CONF: ${finalScore.toFixed(1)}% | TYPE: ${typeTag}`);
                    
                    // Optimistic state set (Cleared if order fails)
                    asset.position = { side: side, entryPrice: currentPrice, peakPrice: currentPrice };
                    
                    // Limit price logic: Buy below VAMP, Sell above VAMP (or at VAMP based on aggression)
                    const execPrice = side === 'buy' ? Math.min(vampEffective, standardMid) : Math.max(vampEffective, standardMid);
                    
                    await this.executeMicroTrade(symbol, side, execPrice, asset.config, orderType);
                }
            }

            this.updateHistory(asset, obi, totalBidQty, totalAskQty);

        } catch (e) {
            this.logger.error(`[FastStrategy] Error: ${e.message}`);
        }
    }

    manageExits(symbol, currentPrice, buyScore, sellScore) {
        // [SAFETY] Prevent double-firing exit orders
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;

        const asset = this.assets[symbol];
        const pos = asset.position;
        if (!pos) return;

        // A. TRAILING STOP
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
            return this.executeMarketExit(symbol, `2-tick dip from peak ($${dip.toFixed(4)})`);
        }

        // B. ALPHA DECAY (Exit if signal strength drops too low)
        const currentConf = pos.side === 'buy' ? buyScore : sellScore;
        if (currentConf < this.ALPHA_DECAY_THRESHOLD) {
            return this.executeMarketExit(symbol, `Alpha Decay (Strength ${currentConf.toFixed(1)}% < ${this.ALPHA_DECAY_THRESHOLD}%)`);
        }

        // C. MOMENTUM FLIP (Exit if opposing signal becomes strong)
        const opposingConf = pos.side === 'buy' ? sellScore : buyScore;
        if (opposingConf >= this.MOMENTUM_FLIP_THRESHOLD) {
            return this.executeMarketExit(symbol, `Momentum Flip (Opposing Strength ${opposingConf.toFixed(1)}% > ${this.MOMENTUM_FLIP_THRESHOLD}%)`);
        }
    }

    async executeMarketExit(symbol, reason) {
        if (this.isOrderInProgress) return;
        this.isOrderInProgress = true;
        this.bot.isOrderInProgress = true;
        const asset = this.assets[symbol];
        
        try {
            const side = asset.position.side === 'buy' ? 'sell' : 'buy';
            this.logger.warn(`[Position Closed] Trigger: ${reason}`);

            const orderData = {
                product_id: asset.config.deltaId.toString(),
                size: this.bot.config.orderSize,
                side: side,
                order_type: 'market_order',
                reduce_only: true
            };
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

    /**
     * Executes the entry order using either LIMIT (IOC) or MARKET.
     * Includes "Zombie State" fix to clear position if order fails.
     */
    async executeMicroTrade(symbol, side, price, assetConfig, orderType) {
        this.isOrderInProgress = true; 
        this.bot.isOrderInProgress = true;
        
        try {
            const rawSize = parseFloat(this.bot.config.orderSize);
            const sizeStr = (Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize).toFixed(assetConfig.sizeDecimals);
            
            // Base Payload
            const orderData = {
                product_id: assetConfig.deltaId.toString(),
                size: sizeStr,
                side: side,
                order_type: orderType, // 'limit_order' or 'market_order'
            };

            // Limit Order Specifics (Aggressive Price + Bracket SL)
            if (orderType === 'limit_order') {
                const aggression = this.bot.config.priceAggressionOffset || 0.02; // Treated as % offset
                const limitPriceNum = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100));
                
                // Bracket SL attached to Limit Order
                const slPriceNum = (side === 'buy' ? limitPriceNum * (1 - this.slPercent/100) : limitPriceNum * (1 + this.slPercent/100));

                orderData.limit_price = limitPriceNum.toFixed(assetConfig.precision);
                orderData.time_in_force = 'ioc'; // Immediate-or-Cancel
                orderData.bracket_stop_loss_price = slPriceNum.toFixed(assetConfig.precision);
                orderData.bracket_stop_trigger_method = 'mark_price';
            }

            await this.bot.placeOrder(orderData);
            
        } catch (err) {
            this.lastErrorTime = Date.now();
            this.logger.warn(`[Execution Error] ${err.message}`);
            
            // [CRITICAL FIX] "Zombie Position" Prevention
            // If the API call failed, we MUST clear the internal position state.
            const asset = this.assets[symbol];
            if (asset) {
                asset.position = null;
                this.logger.info(`[State Recovery] Position reset for ${symbol} due to failed order.`);
            }

        } finally {
            this.isOrderInProgress = false; 
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
