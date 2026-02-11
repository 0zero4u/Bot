/**
 * FastStrategy.js
 * v6.5.0 [ALIGNED] - Synced with Trader v67.2 & Listener v4.0
 * Changes:
 * 1. Added execute(data) router to match TickStrategy interface.
 * 2. Fixed Position State check (uses bot.activePositions[symbol]).
 * 3. Aligned onDepthUpdate signature with Listener payload.
 * 4. Depth Processing: Uses Top 5 levels (Listener sends 10).
 */

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CORE STRATEGY CONFIG ---
        this.OBI_WINDOW = parseInt(process.env.OBI_WINDOW || '250'); 
        this.LOG_FREQ_MS = 5000;
        
        // --- TIERED ENTRY THRESHOLDS ---
        this.MIN_SCORE_LIMIT = parseInt(process.env.MIN_SCORE_LIMIT || '80');
        this.MIN_SCORE_MARKET = parseInt(process.env.MIN_SCORE_MARKET || '95');
        this.LOCK_DURATION_MS = 2000; 
        
        // --- VIP 0ms FILTERS (Noise Reduction) ---
        this.MIN_PULL_QTY = parseFloat(process.env.MIN_PULL_QTY || '1.0'); 

        // --- PREDICTIVE SCORING WEIGHTS ---
        this.WEIGHTS = {
            GATE1_ZSCORE: parseInt(process.env.W_ZSCORE || '30'),   // Baseline Pressure
            GATE2_MOMENTUM: parseInt(process.env.W_MOMENTUM || '20'), // Lagging Velocity
            GATE3_SHIFT: parseInt(process.env.W_SHIFT || '35'),      // Reactive Gravity
            GATE4_PULL: parseInt(process.env.W_PULL || '15')        // PREDICTIVE INTENT
        };
        
        // --- EXIT CONFIGURATION ---
        this.ALPHA_DECAY_THRESHOLD = parseFloat(process.env.ALPHA_DECAY_THRESHOLD || '0'); 
        this.MOMENTUM_FLIP_THRESHOLD = parseFloat(process.env.MOMENTUM_FLIP_THRESHOLD || '75'); 
        this.TRAILING_DIP_TICKS = 6;   
        this.slPercent = 0.15;         

        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, tickSize: 0.0001, lotSize: 1,     precision: 4, sizeDecimals: 0, saturationQty: 50000 },
            'BTC': { deltaId: 27,    tickSize: 0.1,    lotSize: 0.001, precision: 1, sizeDecimals: 3, saturationQty: 5.0 },
            'ETH': { deltaId: 299,   tickSize: 0.01,   lotSize: 0.01,  precision: 2, sizeDecimals: 2, saturationQty: 100.0 },
            'SOL': { deltaId: 417,   tickSize: 0.1,    lotSize: 0.1,   precision: 3, sizeDecimals: 1, saturationQty: 500.0 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(asset => {
            // Handle both clean "XRP" and dirty "XRP_USDT" formats just in case
            const cleanKey = asset.replace('_USDT', '');
            if (MASTER_CONFIG[cleanKey]) {
                this.assets[cleanKey] = {
                    config: MASTER_CONFIG[cleanKey],
                    history: { obi: [], prevOBI: 0, prevBidQty: 0, prevAskQty: 0 },
                    position: null, 
                    lastTriggerTime: 0,
                    lastLogTime: 0 
                };
            }
        });
    }

    getName() { return "FastStrategy (VIP-v6.5 Aligned)"; }

    /**
     * MAIN SIGNAL ROUTER
     * Aligns with TickStrategy.js execution flow
     */
    async execute(data) {
        if (!data || !data.type) return;

        try {
            // Market Listener sends cleaned symbol in 's' (e.g., 'XRP')
            if (data.type === 'depthUpdate') {
                await this.onDepthUpdate(data.s, data);
            }
        } catch (e) {
            this.logger.error(`[FastStrategy] Exec Error: ${e.message}`);
        }
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        // Validate asset exists and data is valid
        if (!asset || !depth.bids || !depth.bids.length || !depth.asks || !depth.asks.length) return;

        const now = Date.now();

        try {
            // --- 1. VAMP-EFFECTIVE MATH ---
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         

            // CONFIG: DEPTH LEVEL PROCESSING
            // Market Listener sends 10. We use 5 for speed, but more than TickStrategy (3).
            const loopLimit = Math.min(depth.bids.length, depth.asks.length, 5);

            for (let i = 0; i < loopLimit; i++) {
                const bP = parseFloat(depth.bids[i][0]); const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]); const aQ = parseFloat(depth.asks[i][1]);
                
                if (isNaN(bP) || isNaN(bQ) || isNaN(aP) || isNaN(aQ)) continue;

                totalBidQty += bQ; totalAskQty += aQ;
                sumBidPQ += (bP * bQ); sumAskPQ += (aP * aQ);
            }

            if (totalBidQty === 0 || totalAskQty === 0) return;

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

            // --- 4. POSITION MANAGEMENT [FIXED] ---
            // Check specific asset position state in Bot, not global 'hasOpenPosition'
            const hasPosition = this.bot.activePositions && this.bot.activePositions[symbol];

            if (hasPosition && asset.position) { 
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
                const f = isBuyStronger ? 
                    `Z:${b_Z.toFixed(0)} M:${b_M.toFixed(0)} S:${b_S.toFixed(0)} P:${b_P.toFixed(0)}` :
                    `Z:${s_Z.toFixed(0)} M:${s_M.toFixed(0)} S:${s_S.toFixed(0)} P:${s_P.toFixed(0)}`;

                this.logger.info(`[${symbol}] ${sideTag} Sc:${score.toFixed(0)} (${f}) | Z:${rawZ.toFixed(2)} P:${currentPrice.toFixed(asset.config.precision)}`);
                asset.lastLogTime = now;
            }

            // --- 6. ENTRY EXECUTION ---
            if (now - asset.lastTriggerTime < this.LOCK_DURATION_MS) return;
            // Note: We removed 'this.bot.isOrderInProgress' check here to allow
            // multiple assets to trade simultaneously if your bot supports it.
            // If you want strictly one order at a time across ALL assets, uncomment:
            // if (this.bot.isOrderInProgress) return; 

            if (buyScore >= this.MIN_SCORE_MARKET) {
                await this.placeEntry(symbol, 'buy', 'market_order', currentPrice);
            } else if (sellScore >= this.MIN_SCORE_MARKET) {
                await this.placeEntry(symbol, 'sell', 'market_order', currentPrice);
            } else if (buyScore >= this.MIN_SCORE_LIMIT) {
                await this.placeEntry(symbol, 'buy', 'limit_order', currentPrice);
            } else if (sellScore >= this.MIN_SCORE_LIMIT) {
                await this.placeEntry(symbol, 'sell', 'limit_order', currentPrice);
            }

            this.updateHistory(asset, obi, totalBidQty, totalAskQty);

        } catch (err) {
            this.logger.error(`[FastStrategy] Update Error: ${err.message}`);
        }
    }

    calculateZScore(data) {
        if (data.length < 10) return 0;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        const stdDev = Math.sqrt(data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / data.length);
        return stdDev === 0 ? 0 : (data[data.length - 1] - mean) / stdDev;
    }

    getScore(val, saturation, maxPoints) {
        if (val <= 0) return 0;
        const ratio = Math.min(val / saturation, 1.0);
        return ratio * maxPoints;
    }

    updateHistory(asset, obi, bQty, aQty) {
        asset.history.prevOBI = obi;
        asset.history.prevBidQty = bQty;
        asset.history.prevAskQty = aQty;
    }

    async placeEntry(symbol, side, orderType, price) {
        const asset = this.assets[symbol];
        const assetConfig = asset.config;
        
        // We set a flag, but we should handle it per-asset ideally or globally depending on preference
        this.bot.isOrderInProgress = true;
        
        try {
            const rawSize = parseFloat(this.bot.config.orderSize);
            // Calculate size ensuring it adheres to lot size
            const sizeStr = (Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize).toFixed(assetConfig.sizeDecimals);
            
            const orderData = { 
                product_id: assetConfig.deltaId.toString(), 
                size: sizeStr, 
                side: side, 
                order_type: orderType 
            };

            if (orderType === 'limit_order') {
                const aggression = this.bot.config.priceAggressionOffset || 0.02;
                const limitPriceNum = (side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100));
                
                // Bracket Stop Loss calculation
                const slPriceNum = (side === 'buy' ? limitPriceNum * (1 - this.slPercent/100) : limitPriceNum * (1 + this.slPercent/100));
                
                orderData.limit_price = limitPriceNum.toFixed(assetConfig.precision);
                orderData.time_in_force = 'post_only'; // Better for limit strategies
                orderData.bracket_stop_loss_price = slPriceNum.toFixed(assetConfig.precision);
                orderData.bracket_stop_trigger_method = 'mark_price';
            } else {
                // Market Order
                orderData.time_in_force = 'ioc';
            }
            
            // Record local state before sending to ensure we don't double fire
            asset.lastTriggerTime = Date.now();
            
            this.logger.info(`[EXECUTE] ${side.toUpperCase()} ${orderType} on ${symbol} | Size: ${sizeStr}`);
            await this.bot.placeOrder(orderData);
            
            // Assume fill for local state tracking (Trader will update actuals)
            asset.position = { side: side, entryPrice: price, size: rawSize };

        } catch (err) {
            this.logger.warn(`[Entry Error] ${err.message}`);
            asset.position = null; 
        } finally { 
            this.bot.isOrderInProgress = false; 
        }
    }

    manageExits(symbol, currentPrice, buyScore, sellScore) {
        // Basic Exit Logic
        const asset = this.assets[symbol];
        if (!asset.position) return;

        // If momentum flips hard against us
        if (asset.position.side === 'buy' && sellScore > this.MOMENTUM_FLIP_THRESHOLD) {
            this.logger.info(`[EXIT] Momentum Flip Sell detected for ${symbol}.`);
            this.closePosition(symbol, 'sell');
        } else if (asset.position.side === 'sell' && buyScore > this.MOMENTUM_FLIP_THRESHOLD) {
            this.logger.info(`[EXIT] Momentum Flip Buy detected for ${symbol}.`);
            this.closePosition(symbol, 'buy');
        }
    }

    async closePosition(symbol, side) {
        // Implement close logic connecting to bot.placeOrder
        // Usually requires fetching current position size if partials are involved
        // For simple reversal/close:
        // await this.bot.placeOrder({ ... size: asset.position.size, side: side ... });
        // This is a placeholder for the actual close logic integration
    }
}

module.exports = FastStrategy;
                
