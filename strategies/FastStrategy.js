// FastStrategy.js
// v6.3.0 - [PROD] VAMP-Effective | Granular Force Logging | Predictive Weights

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CORE STRATEGY CONFIG ---
        this.OBI_WINDOW = parseInt(process.env.OBI_WINDOW || '500'); 
        this.LOG_FREQ_MS = 5000;
        
        // --- TIERED ENTRY THRESHOLDS ---
        this.MIN_SCORE_LIMIT = parseInt(process.env.MIN_SCORE_LIMIT || '75');
        this.MIN_SCORE_MARKET = parseInt(process.env.MIN_SCORE_MARKET || '80');
        this.LOCK_DURATION_MS = 2000; 
        
        // --- VIP 0ms FILTERS (Noise Reduction) ---
        this.MIN_PULL_QTY = parseFloat(process.env.MIN_PULL_QTY || '1.0'); 

        // --- PREDICTIVE SCORING WEIGHTS ---
        this.WEIGHTS = {
            GATE1_ZSCORE: parseInt(process.env.W_ZSCORE || '40'),   // Baseline Pressure
            GATE2_MOMENTUM: parseInt(process.env.W_MOMENTUM || '10'), // Lagging Velocity
            GATE3_SHIFT: parseInt(process.env.W_SHIFT || '20'),      // Reactive Gravity
            GATE4_PULL: parseInt(process.env.W_PULL || '30')        // PREDICTIVE INTENT
        };
        
        // --- EXIT CONFIGURATION ---
        this.ALPHA_DECAY_THRESHOLD = parseFloat(process.env.ALPHA_DECAY_THRESHOLD || '0'); 
        this.MOMENTUM_FLIP_THRESHOLD = parseFloat(process.env.MOMENTUM_FLIP_THRESHOLD || '75'); 
        this.TRAILING_DIP_TICKS = 10;   
        this.slPercent = 0.15;         

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

    getName() { return "FastStrategy (VIP-v6.3 Granular)"; }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // --- 1. VAMP-EFFECTIVE MATH ---
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         

            for (let i = 0; i < 5; i++) {
                const bP = parseFloat(depth.bids[i][0]); const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]); const aQ = parseFloat(depth.asks[i][1]);
                totalBidQty += bQ; totalAskQty += aQ;
                sumBidPQ += (bP * bQ); sumAskPQ += (aP * aQ);
            }

            const pEffBid = sumBidPQ / totalBidQty;
            const pEffAsk = sumAskPQ / totalAskQty;
            const vampEff = (pEffBid * totalAskQty + pEffAsk * totalBidQty) / (totalBidQty + totalAskQty);
            const currentPrice = vampEff;

            // --- 2. SIGNAL GATES (TICK-BASED) ---
            const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            const rawZ = this.calculateZScore(asset.history.obi);
            const rawDOBI = obi - asset.history.prevOBI;
            
            const wdobp = (sumBidPQ + sumAskPQ) / (totalBidQty + totalAskQty);
            const rawShiftTicks = (wdobp - currentPrice) / asset.config.tickSize;
            
            const askDelta = asset.history.prevAskQty - totalAskQty;
            const bidDelta = asset.history.prevBidQty - totalBidQty;
            const filteredAskPull = Math.abs(askDelta) >= this.MIN_PULL_QTY ? askDelta : 0;
            const filteredBidPull = Math.abs(bidDelta) >= this.MIN_PULL_QTY ? bidDelta : 0;
            const rawPull = filteredAskPull - filteredBidPull;

            // --- 3. GRANULAR WEIGHTED SCORING ---
            // Calculate components individually for visibility
            
            // BUY Components
            const b_Z = this.getScore(rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE);
            const b_M = this.getScore(rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM);
            const b_S = this.getScore(rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT);
            const b_P = this.getScore(rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);
            const buyScore = b_Z + b_M + b_S + b_P;

            // SELL Components
            const s_Z = this.getScore(-rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE);
            const s_M = this.getScore(-rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM);
            const s_S = this.getScore(-rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT);
            const s_P = this.getScore(-rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);
            const sellScore = s_Z + s_M + s_S + s_P;

            // --- 4. POSITION MANAGEMENT ---
            if (this.bot.hasOpenPosition && asset.position) {
                this.manageExits(symbol, currentPrice, buyScore, sellScore);
                this.updateHistory(asset, obi, totalBidQty, totalAskQty);
                return; 
            }

            // --- 5. LOGGING (With Granularity) ---
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                const isBuyStronger = buyScore >= sellScore;
                const score = isBuyStronger ? buyScore : sellScore;
                const sideTag = isBuyStronger ? '[BUY]' : '[SELL]';
                
                // Construct Force String: (Z:10 M:5 S:20 P:30)
                const f = isBuyStronger 
                    ? `Z:${b_Z.toFixed(0)} M:${b_M.toFixed(0)} S:${b_S.toFixed(0)} P:${b_P.toFixed(0)}`
                    : `Z:${s_Z.toFixed(0)} M:${s_M.toFixed(0)} S:${s_S.toFixed(0)} P:${s_P.toFixed(0)}`;

                this.logger.info(`[VIP Heartbeat] ${symbol} Strength: ${score.toFixed(1)}% ${sideTag} (${f}) | VAMP: ${currentPrice.toFixed(asset.config.precision)}`);
                asset.lastLogTime = now;
            }

            // --- 6. ENTRY LOGIC ---
            if (!this.bot.hasOpenPosition && !this.isOrderInProgress && !this.bot.isOrderInProgress) {
                let side = null;
                let finalScore = 0;
                let forceString = "";

                if (buyScore >= this.MIN_SCORE_LIMIT && buyScore >= sellScore) { 
                    side = 'buy'; 
                    finalScore = buyScore;
                    forceString = `Z:${b_Z.toFixed(1)} M:${b_M.toFixed(1)} S:${b_S.toFixed(1)} P:${b_P.toFixed(1)}`;
                }
                else if (sellScore >= this.MIN_SCORE_LIMIT) { 
                    side = 'sell'; 
                    finalScore = sellScore;
                    forceString = `Z:${s_Z.toFixed(1)} M:${s_M.toFixed(1)} S:${s_S.toFixed(1)} P:${s_P.toFixed(1)}`;
                }

                if (side && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS)) {
                    asset.lastTriggerTime = now;
                    const orderType = finalScore >= this.MIN_SCORE_MARKET ? 'market_order' : 'limit_order';
                    
                    this.logger.info(`[🔥 TRIGGER] ${side.toUpperCase()} ${symbol} | CONF: ${finalScore.toFixed(1)}% [${forceString}] | TYPE: ${orderType}`);
                    asset.position = { side: side, entryPrice: currentPrice, peakPrice: currentPrice };
                    
                    await this.executeMicroTrade(symbol, side, currentPrice, asset.config, orderType);
                }
            }

            this.updateHistory(asset, obi, totalBidQty, totalAskQty);

        } catch (e) {
            this.logger.error(`[FastStrategy] Loop Error: ${e.message}`);
        }
    }

    manageExits(symbol, currentPrice, buyScore, sellScore) {
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;
        const asset = this.assets[symbol];
        const pos = asset.position;
        if (!pos) return;

        // Peak Tracking for Trailing Dip
        if (pos.side === 'buy' && currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
        if (pos.side === 'sell' && currentPrice < pos.peakPrice) pos.peakPrice = currentPrice;

        const dip = pos.side === 'buy' ? pos.peakPrice - currentPrice : currentPrice - pos.peakPrice;

        if (dip >= (this.TRAILING_DIP_TICKS * asset.config.tickSize)) {
            return this.executeMarketExit(symbol, `Trailing Dip Triggered ($${dip.toFixed(4)})`);
        }
        if ((pos.side === 'buy' ? buyScore : sellScore) < this.ALPHA_DECAY_THRESHOLD) {
            return this.executeMarketExit(symbol, `Alpha Decay`);
        }
        if ((pos.side === 'buy' ? sellScore : buyScore) >= this.MOMENTUM_FLIP_THRESHOLD) {
            return this.executeMarketExit(symbol, `Momentum Flip`);
        }
    }

    /**
     * EXIT EXECUTION with STATE RECOVERY
     */
    async executeMarketExit(symbol, reason) {
        if (this.isOrderInProgress) return;
        this.isOrderInProgress = true; 
        this.bot.isOrderInProgress = true;
        
        const asset = this.assets[symbol];
        try {
            const side = asset.position.side === 'buy' ? 'sell' : 'buy';
            this.logger.warn(`[Exiting] ${symbol} | Reason: ${reason}`);

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
            // STATE RECOVERY FIX
            if (err.message.includes('no_position_for_reduce_only') || err.message.includes('400')) {
                this.logger.info(`[State Recovery] Forced position reset for ${symbol}.`);
                asset.position = null;
                this.bot.hasOpenPosition = false;
            }
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

    async executeMicroTrade(symbol, side, price, assetConfig, orderType) {
        this.isOrderInProgress = true; 
        this.bot.isOrderInProgress = true;
        try {
            const rawSize = parseFloat(this.bot.config.orderSize);
            const sizeStr = (Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize).toFixed(assetConfig.sizeDecimals);
            const orderData = { product_id: assetConfig.deltaId.toString(), size: sizeStr, side: side, order_type: orderType };

            if (orderType === 'limit_order') {
                const aggression = this.bot.config.priceAggressionOffset || 0.02;
                const limitPriceNum = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100));
                const slPriceNum = (side === 'buy' ? limitPriceNum * (1 - this.slPercent/100) : limitPriceNum * (1 + this.slPercent/100));
                orderData.limit_price = limitPriceNum.toFixed(assetConfig.precision);
                orderData.time_in_force = 'ioc';
                orderData.bracket_stop_loss_price = slPriceNum.toFixed(assetConfig.precision);
                orderData.bracket_stop_trigger_method = 'mark_price';
            }
            
            await this.bot.placeOrder(orderData);
            
        } catch (err) {
            this.logger.warn(`[Entry Error] ${err.message}`);
            const asset = this.assets[symbol];
            if (asset) asset.position = null; 
        } finally { 
            this.isOrderInProgress = false; 
            this.bot.isOrderInProgress = false; 
        }
    }
}

module.exports = FastStrategy;
        
