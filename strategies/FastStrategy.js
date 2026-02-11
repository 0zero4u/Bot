/**
 * FastStrategy.js
 * v9.1.0 [DUST FIX + DEEP LOGS]
 * - Strategy: VAMP (Volume-Weighted Average Micro-Pressure)
 * - FIX: Ignores "Dust" orders (< 10 qty) to protect math integrity.
 * - LOGS: 10s Heartbeat with Top 5 Snapshot & Raw Logic Core values.
 * - EXECUTION: Pure Taker (Market=Standard, Limit=IOC).
 */

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CORE STRATEGY CONFIG ---
        this.OBI_WINDOW = parseInt(process.env.OBI_WINDOW || '250'); 
        
        // HEARTBEAT: Set to 10 seconds as requested
        this.LOG_FREQ_MS = 10000;
        
        // --- TIERED ENTRY THRESHOLDS ---
        this.MIN_SCORE_LIMIT = parseInt(process.env.MIN_SCORE_LIMIT || '75');
        this.MIN_SCORE_MARKET = parseInt(process.env.MIN_SCORE_MARKET || '70');
        this.LOCK_DURATION_MS = 2000; 
        
        // --- DUST FILTER (THE FIX) ---
        // Orders below this quantity are ignored by the math engine.
        // This prevents "1 XRP" orders from skewing the "Effective Price".
        this.MIN_MATH_QTY = 10.0; 

        this.MIN_PULL_QTY = parseFloat(process.env.MIN_PULL_QTY || '500.0'); 

        // --- PREDICTIVE SCORING WEIGHTS ---
        this.WEIGHTS = {
            GATE1_ZSCORE: parseInt(process.env.W_ZSCORE || '25'),      // Baseline Pressure
            GATE2_MOMENTUM: parseInt(process.env.W_MOMENTUM || '45'),  // Lagging Velocity
            GATE3_SHIFT: parseInt(process.env.W_SHIFT || '10'),        // Reactive Gravity
            GATE4_PULL: parseInt(process.env.W_PULL || '20')           // Predictive Intent
        };
        
        // --- EXIT CONFIGURATION ---
        this.MOMENTUM_FLIP_THRESHOLD = parseFloat(process.env.MOMENTUM_FLIP_THRESHOLD || '75'); 
        this.slPercent = 0.15; // 0.15% Stop Loss

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

    getName() { return "FastStrategy (DustFix v9.1)"; }

    /**
     * MAIN ROUTER
     */
    async execute(data) {
        if (!data || !data.type) return;
        if (data.type === 'depthUpdate' && data.s) {
            await this.onDepthUpdate(data.s, data);
        }
    }

    /**
     * CORE LOGIC (VAMP + DUST FIX)
     */
    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset || !depth.bids || !depth.bids.length || !depth.asks || !depth.asks.length) return;

        const now = Date.now();

        try {
            // --- 1. VAMP MATH (WITH DUST FILTER) ---
            let totalBidQty = 0, totalAskQty = 0;
            let sumBidPQ = 0, sumAskPQ = 0;         

            const loopLimit = Math.min(depth.bids.length, depth.asks.length, 5);

            for (let i = 0; i < loopLimit; i++) {
                const bP = parseFloat(depth.bids[i][0]); const bQ = parseFloat(depth.bids[i][1]);
                const aP = parseFloat(depth.asks[i][0]); const aQ = parseFloat(depth.asks[i][1]);
                
                if (isNaN(bP) || isNaN(bQ) || isNaN(aP) || isNaN(aQ)) continue;

                // [FIX] ONLY COUNT VALID LIQUIDITY (> 10)
                if (bQ > this.MIN_MATH_QTY) {
                    totalBidQty += bQ; 
                    sumBidPQ += (bP * bQ);
                }
                
                if (aQ > this.MIN_MATH_QTY) {
                    totalAskQty += aQ;
                    sumAskPQ += (aP * aQ);
                }
            }

            // If everything was dust, abort early to protect math
            if (totalBidQty === 0 || totalAskQty === 0) return;

            const pEffBid = sumBidPQ / totalBidQty;
            const pEffAsk = sumAskPQ / totalAskQty;
            const vampEff = (pEffBid * totalAskQty + pEffAsk * totalBidQty) / (totalBidQty + totalAskQty);
            const currentPrice = vampEff;

            // --- 2. SIGNAL CALCULATIONS ---
            const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
            
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            // RAW REASON METRICS
            const rawZ = this.calculateZScore(asset.history.obi);
            const rawDOBI = obi - asset.history.prevOBI;
            
            // Shift Ticks
            const wdobp = (sumBidPQ + sumAskPQ) / (totalBidQty + totalAskQty);
            const rawShiftTicks = (wdobp - currentPrice) / asset.config.tickSize;
            
            // Pull Logic
            const askDelta = asset.history.prevAskQty - totalAskQty;
            const bidDelta = asset.history.prevBidQty - totalBidQty;
            const filteredAskPull = Math.abs(askDelta) >= this.MIN_PULL_QTY ? askDelta : 0;
            const filteredBidPull = Math.abs(bidDelta) >= this.MIN_PULL_QTY ? bidDelta : 0;
            const rawPull = filteredAskPull - filteredBidPull;

            // --- 3. SCORING ---
            // BUY SCORE
            const b_Z = this.getScore(rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE);
            const b_M = this.getScore(rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM);
            const b_S = this.getScore(rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT);
            const b_P = this.getScore(rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);
            const buyScore = b_Z + b_M + b_S + b_P;

            // SELL SCORE
            const s_Z = this.getScore(-rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE);
            const s_M = this.getScore(-rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM);
            const s_S = this.getScore(-rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT);
            const s_P = this.getScore(-rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);
            const sellScore = s_Z + s_M + s_S + s_P;

            // --- 4. HEARTBEAT LOGGING (10s) ---
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                const isBuyStronger = buyScore >= sellScore;
                const score = isBuyStronger ? buyScore : sellScore;
                const sideTag = isBuyStronger ? '[BUY]' : '[SELL]';
                
                // Scoring Breakdown
                const f = isBuyStronger ? 
                    `Z:${b_Z.toFixed(0)} M:${b_M.toFixed(0)} S:${b_S.toFixed(0)} P:${b_P.toFixed(0)}` :
                    `Z:${s_Z.toFixed(0)} M:${s_M.toFixed(0)} S:${s_S.toFixed(0)} P:${s_P.toFixed(0)}`;

                this.logger.info(`-----------------------------------------------------------`);
                this.logger.info(`[${symbol}] ${sideTag} TOTAL:${score.toFixed(0)} | Breakdown: (${f})`);
                
                // RAW REASON (Logic Core)
                this.logger.info(` > LOGIC CORE | Z-Score: ${rawZ.toFixed(3)} | Mom(dOBI): ${rawDOBI.toFixed(4)} | Shift: ${rawShiftTicks.toFixed(2)} | Pull: ${rawPull.toFixed(1)}`);
                
                // SNAPSHOT (What the bot sees)
                // We show Top 5 so you can verify if "Dust" is being filtered correctly in your mind
                const topB = depth.bids.slice(0, 5).map(b => `${b[0]}x${b[1]}`).join(' | ');
                const topA = depth.asks.slice(0, 5).map(a => `${a[0]}x${a[1]}`).join(' | ');
                this.logger.info(` > SNAPSHOT   | Bids: [${topB}]`);
                this.logger.info(` > SNAPSHOT   | Asks: [${topA}]`);
                this.logger.info(` > PRICE      | VampEff: ${currentPrice.toFixed(asset.config.precision)}`);
                this.logger.info(`-----------------------------------------------------------`);

                asset.lastLogTime = now;
            }

            // --- 5. POSITION CHECK ---
            const hasPosition = (this.bot.activePositions && this.bot.activePositions[symbol]) || asset.position;

            if (hasPosition) { 
                this.manageExits(symbol, asset, buyScore, sellScore);
                this.updateHistory(asset, obi, totalBidQty, totalAskQty);
                return; 
            }

            // --- 6. EXECUTION ---
            if (now - asset.lastTriggerTime < this.LOCK_DURATION_MS) return;
            if (this.bot.isOrderInProgress) return;

            // Priority: Market (Fastest) -> Aggressive Limit (Fast w/ Protection)
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

    /**
     * HELPERS
     */
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

    /**
     * ORDER EXECUTION - CLEAN TAKER
     */
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

            // AGGRESSIVE TAKER LOGIC
            if (orderType === 'limit_order') {
                const aggression = this.bot.config.priceAggressionOffset || 0.02;
                
                // Aggressive Limit: Buy HIGHER, Sell LOWER
                const limitPriceNum = (side === 'buy') 
                    ? price * (1 + aggression/100) 
                    : price * (1 - aggression/100);
                
                const slPriceNum = (side === 'buy') 
                    ? limitPriceNum * (1 - this.slPercent/100) 
                    : limitPriceNum * (1 + this.slPercent/100);
                
                orderData.limit_price = limitPriceNum.toFixed(assetConfig.precision);
                
                // LIMIT MUST BE IOC TO BE TAKER
                orderData.time_in_force = 'ioc'; 
                
                orderData.bracket_stop_loss_price = slPriceNum.toFixed(assetConfig.precision);
                orderData.bracket_stop_trigger_method = 'mark_price';
                
            } else {
                // Market Order: STANDARD (No IOC param needed)
                // This will get filled immediately by the exchange engine.
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

        // Momentum Flip Logic
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
            // No IOC here either (Standard Market)
        });
        asset.position = null;
    }
}

module.exports = FastStrategy;
        
