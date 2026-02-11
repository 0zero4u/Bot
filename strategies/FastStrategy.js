/**
 * FastStrategy.js
 * v9.0.0 [DUST BUSTER EDITION]
 * - Strategy: VAMP (Volume-Weighted Average Micro-Pressure)
 * - FIX: Ignores "Dust" orders (e.g., 1 XRP) that skew Price/Shift calculations.
 * - FIX: Requires Z-Score Alignment (won't trade purely on Shift).
 */

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CORE STRATEGY CONFIG ---
        this.OBI_WINDOW = parseInt(process.env.OBI_WINDOW || '250'); 
        this.LOG_FREQ_MS = 10000; // 10s Heartbeat
        
        // --- TIERED ENTRY THRESHOLDS ---
        this.MIN_SCORE_LIMIT = parseInt(process.env.MIN_SCORE_LIMIT || '70');
        this.MIN_SCORE_MARKET = parseInt(process.env.MIN_SCORE_MARKET || '95');
        this.LOCK_DURATION_MS = 2000; 
        
        // --- DUST FILTER (CRITICAL FIX) ---
        // Any order below this size is treated as non-existent for math.
        // Prevents 1 XRP orders from faking the spread.
        this.MIN_MATH_QTY = 30.0; 

        this.MIN_PULL_QTY = parseFloat(process.env.MIN_PULL_QTY || '1.0'); 

        // --- PREDICTIVE SCORING WEIGHTS ---
        this.WEIGHTS = {
            GATE1_ZSCORE: parseInt(process.env.W_ZSCORE || '30'),      
            GATE2_MOMENTUM: parseInt(process.env.W_MOMENTUM || '20'),  
            GATE3_SHIFT: parseInt(process.env.W_SHIFT || '35'),        
            GATE4_PULL: parseInt(process.env.W_PULL || '15')           
        };
        
        this.MOMENTUM_FLIP_THRESHOLD = parseFloat(process.env.MOMENTUM_FLIP_THRESHOLD || '75'); 
        this.slPercent = 0.15; 

        // --- ASSET CONFIGURATION ---
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, tickSize: 0.0001, lotSize: 1,     precision: 4, sizeDecimals: 0, saturationQty: 50000 },
            'BTC': { deltaId: 27,    tickSize: 0.1,    lotSize: 0.001, precision: 1, sizeDecimals: 3, saturationQty: 5.0 },
            'ETH': { deltaId: 299,   tickSize: 0.01,   lotSize: 0.01,  precision: 2, sizeDecimals: 2, saturationQty: 100.0 },
            'SOL': { deltaId: 417,   tickSize: 0.1,    lotSize: 0.1,   precision: 3, sizeDecimals: 1, saturationQty: 500.0 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(asset => {
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

        this.bot.isOrderInProgress = false; 
    }

    getName() { return "FastStrategy (DustBuster v9.0)"; }

    async execute(data) {
        if (!data || !data.type) return;
        if (data.type === 'depthUpdate' && data.s) {
            await this.onDepthUpdate(data.s, data);
        }
    }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset || !depth.bids || !depth.bids.length || !depth.asks || !depth.asks.length) return;

        const now = Date.now();

        try {
            // --- 1. FILTERED MATH (The Fix) ---
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         

            const loopLimit = Math.min(depth.bids.length, depth.asks.length, 5);

            for (let i = 0; i < loopLimit; i++) {
                const bP = parseFloat(depth.bids[i][0]); const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]); const aQ = parseFloat(depth.asks[i][1]);
                
                if (isNaN(bP) || isNaN(bQ) || isNaN(aP) || isNaN(aQ)) continue;

                // [CRITICAL FIX] IGNORE DUST
                if (bQ > this.MIN_MATH_QTY) {
                    totalBidQty += bQ; 
                    sumBidPQ += (bP * bQ);
                }
                
                if (aQ > this.MIN_MATH_QTY) {
                    totalAskQty += aQ;
                    sumAskPQ += (aP * aQ);
                }
            }

            // If everything was dust, abort
            if (totalBidQty === 0 || totalAskQty === 0) return;

            const pEffBid = sumBidPQ / totalBidQty;
            const pEffAsk = sumAskPQ / totalAskQty;
            const vampEff = (pEffBid * totalAskQty + pEffAsk * totalBidQty) / (totalBidQty + totalAskQty);
            const currentPrice = vampEff;

            // --- 2. SIGNALS ---
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

            // --- 3. SCORING ---
            const b_Z = this.getScore(rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE);
            const b_M = this.getScore(rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM);
            const b_S = this.getScore(rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT);
            const b_P = this.getScore(rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);
            const buyScore = b_Z + b_M + b_S + b_P;

            const s_Z = this.getScore(-rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE);
            const s_M = this.getScore(-rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM);
            const s_S = this.getScore(-rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT);
            const s_P = this.getScore(-rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);
            const sellScore = s_Z + s_M + s_S + s_P;

            // --- 4. LOGGING ---
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                const isBuyStronger = buyScore >= sellScore;
                const score = isBuyStronger ? buyScore : sellScore;
                const sideTag = isBuyStronger ? '[BUY]' : '[SELL]';
                
                const f = isBuyStronger ? 
                    `Z:${b_Z.toFixed(0)} M:${b_M.toFixed(0)} S:${b_S.toFixed(0)} P:${b_P.toFixed(0)}` :
                    `Z:${s_Z.toFixed(0)} M:${s_M.toFixed(0)} S:${s_S.toFixed(0)} P:${s_P.toFixed(0)}`;

                this.logger.info(`-----------------------------------------------------------`);
                this.logger.info(`[${symbol}] ${sideTag} TOTAL:${score.toFixed(0)} | Breakdown: (${f})`);
                this.logger.info(` > RAW MATH | Z-Score: ${rawZ.toFixed(3)} | Mom(dOBI): ${rawDOBI.toFixed(4)} | Shift: ${rawShiftTicks.toFixed(2)}`);
                
                // Log the unfiltered snapshot for debugging, but math used filtered
                const topB = depth.bids.slice(0, 2).map(b => `${b[0]}x${b[1]}`).join(' | ');
                const topA = depth.asks.slice(0, 2).map(a => `${a[0]}x${a[1]}`).join(' | ');
                this.logger.info(` > SNAPSHOT | Bids: [${topB}] vs Asks: [${topA}]`);
                this.logger.info(`-----------------------------------------------------------`);

                asset.lastLogTime = now;
            }

            // --- 5. EXECUTION WITH ALIGNMENT ---
            const hasPosition = (this.bot.activePositions && this.bot.activePositions[symbol]) || asset.position;
            if (hasPosition) { 
                this.manageExits(symbol, asset, buyScore, sellScore);
                this.updateHistory(asset, obi, totalBidQty, totalAskQty);
                return; 
            }

            if (now - asset.lastTriggerTime < this.LOCK_DURATION_MS) return;
            if (this.bot.isOrderInProgress) return;

            // [NEW] Trend Alignment Check
            // We do NOT buy if Z-Score (Trend) is heavily negative
            const trendAlignedBuy = (buyScore >= this.MIN_SCORE_LIMIT) && (rawZ > -0.2);
            const trendAlignedSell = (sellScore >= this.MIN_SCORE_LIMIT) && (rawZ < 0.2);

            if (trendAlignedBuy) {
                if (buyScore >= this.MIN_SCORE_MARKET) await this.placeEntry(symbol, 'buy', 'market_order', currentPrice);
                else await this.placeEntry(symbol, 'buy', 'limit_order', currentPrice);
            } else if (trendAlignedSell) {
                if (sellScore >= this.MIN_SCORE_MARKET) await this.placeEntry(symbol, 'sell', 'market_order', currentPrice);
                else await this.placeEntry(symbol, 'sell', 'limit_order', currentPrice);
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
        
        this.bot.isOrderInProgress = true;
        
        try {
            const rawSize = parseFloat(this.bot.config.orderSize);
            const sizeStr = (Math.floor(rawSize / assetConfig.lotSize) * assetConfig.lotSize).toFixed(assetConfig.sizeDecimals);
            
            const orderData = { 
                product_id: assetConfig.deltaId.toString(), 
                size: sizeStr, 
                side: side, 
                order_type: orderType 
            };

            if (orderType === 'limit_order') {
                const aggression = this.bot.config.priceAggressionOffset || 0.02;
                const limitPriceNum = (side === 'buy') ? price * (1 + aggression/100) : price * (1 - aggression/100);
                const slPriceNum = (side === 'buy') ? limitPriceNum * (1 - this.slPercent/100) : limitPriceNum * (1 + this.slPercent/100);
                
                orderData.limit_price = limitPriceNum.toFixed(assetConfig.precision);
                orderData.time_in_force = 'ioc'; 
                orderData.bracket_stop_loss_price = slPriceNum.toFixed(assetConfig.precision);
                orderData.bracket_stop_trigger_method = 'mark_price';
            }
            
            asset.lastTriggerTime = Date.now();
            this.logger.info(`[EXECUTE] ${side.toUpperCase()} ${orderType} on ${symbol} | Size: ${sizeStr}`);
            await this.bot.placeOrder(orderData);
            asset.position = { side: side, entryPrice: price, size: rawSize };

        } catch (err) {
            this.logger.warn(`[Entry Error] ${err.message}`);
            asset.position = null; 
        } finally { 
            this.bot.isOrderInProgress = false; 
        }
    }

    manageExits(symbol, asset, buyScore, sellScore) {
        if (!asset.position) return;
        if (asset.position.side === 'buy' && sellScore > this.MOMENTUM_FLIP_THRESHOLD) {
            this.logger.info(`[EXIT] Momentum Flip on ${symbol}. Sell Pressure: ${sellScore}`);
            this.closePosition(asset, 'sell');
        }
        else if (asset.position.side === 'sell' && buyScore > this.MOMENTUM_FLIP_THRESHOLD) {
            this.logger.info(`[EXIT] Momentum Flip on ${symbol}. Buy Pressure: ${buyScore}`);
            this.closePosition(asset, 'buy');
        }
    }

    closePosition(asset, side) {
        this.bot.placeOrder({
            product_id: asset.config.deltaId.toString(),
            size: asset.position.size.toString(),
            side: side,
            order_type: 'market_order'
        });
        asset.position = null;
    }
}

module.exports = FastStrategy;
                              
