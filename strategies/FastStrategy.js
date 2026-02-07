// FastStrategy.js
// v6.1.0 - [VIP-0ms] Volume-Filtered Pulls | Tick-Based Deltas | Configurable Weights

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CORE STRATEGY CONFIG ---
        this.OBI_WINDOW = parseInt(process.env.OBI_WINDOW || '500'); // Increased for 0ms stability
        this.LOG_FREQ_MS = 5000;
        
        // --- TIERED ENTRY THRESHOLDS ---
        this.MIN_SCORE_LIMIT = parseInt(process.env.MIN_SCORE_LIMIT || '80');
        this.MIN_SCORE_MARKET = parseInt(process.env.MIN_SCORE_MARKET || '85');
        
        this.LOCK_DURATION_MS = 2000; 
        
        // --- 0ms VIP FILTERS ---
        // Minimum quantity change to count as a "Real Pull" (Noise Reduction)
        this.MIN_PULL_QTY = parseFloat(process.env.MIN_PULL_QTY || '1.05'); 

        // --- CONFIGURABLE WEIGHTS (Sum should be 100) ---
        this.WEIGHTS = {
            GATE1_ZSCORE: parseInt(process.env.W_ZSCORE || '40'),
            GATE2_MOMENTUM: parseInt(process.env.W_MOMENTUM || '10'),
            GATE3_SHIFT: parseInt(process.env.W_SHIFT || '20'),
            GATE4_PULL: parseInt(process.env.W_PULL || '30') // Predictive Heavy for VIP
        };
        
        // --- EXIT CONFIGURATION ---
        this.ALPHA_DECAY_THRESHOLD = parseFloat(process.env.ALPHA_DECAY_THRESHOLD || '0'); 
        this.MOMENTUM_FLIP_THRESHOLD = parseFloat(process.env.MOMENTUM_FLIP_THRESHOLD || '75'); 
        this.TRAILING_DIP_TICKS = 100;   
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

    getName() { return "FastStrategy (VIP-v6.1)"; }

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset || !depth.bids.length || !depth.asks.length) return;

        const now = Date.now();

        try {
            // --- 1. DATA PROCESSING (VAMP-Effective) ---
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
            const standardMid = (parseFloat(depth.bids[0][0]) + parseFloat(depth.asks[0][0])) / 2;

            // --- 2. SIGNAL GENERATION ---
            const obi = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
            asset.history.obi.push(obi);
            if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
            
            const rawZ = this.calculateZScore(asset.history.obi);
            const rawDOBI = obi - asset.history.prevOBI;
            
            const wdobp = (sumBidPQ + sumAskPQ) / (totalBidQty + totalAskQty);
            const rawShiftTicks = (wdobp - vampEff) / asset.config.tickSize;
            
            // --- [FIX] TICK-BASED LIQUIDITY PULL WITH NOISE FILTER ---
            // We compare current total qty to the previous tick's total qty.
            const askDelta = asset.history.prevAskQty - totalAskQty;
            const bidDelta = asset.history.prevBidQty - totalBidQty;

            // Apply Micro-Pull Filter: Only count deltas larger than MIN_PULL_QTY
            const filteredAskPull = Math.abs(askDelta) >= this.MIN_PULL_QTY ? askDelta : 0;
            const filteredBidPull = Math.abs(bidDelta) >= this.MIN_PULL_QTY ? bidDelta : 0;
            
            // Net result: Positive if Asks are evaporating faster (Bullish)
            const rawPull = filteredAskPull - filteredBidPull;

            // --- 3. REFINED WEIGHTED SCORING (VIP SETTINGS) ---
            const buyScore = 
                this.getScore(rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE) + 
                this.getScore(rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM) + 
                this.getScore(rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT) + 
                this.getScore(rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);

            const sellScore = 
                this.getScore(-rawZ, 2.5, this.WEIGHTS.GATE1_ZSCORE) + 
                this.getScore(-rawDOBI, 0.4, this.WEIGHTS.GATE2_MOMENTUM) + 
                this.getScore(-rawShiftTicks, 2.0, this.WEIGHTS.GATE3_SHIFT) + 
                this.getScore(-rawPull, asset.config.saturationQty, this.WEIGHTS.GATE4_PULL);

            // --- 4. POSITION MANAGEMENT ---
            if (this.bot.hasOpenPosition && asset.position) {
                this.manageExits(symbol, vampEff, buyScore, sellScore);
                this.updateHistory(asset, obi, totalBidQty, totalAskQty);
                return; 
            }

            // --- 5. LOGGING ---
            if (now - asset.lastLogTime > this.LOG_FREQ_MS) {
                const isBuyStronger = buyScore >= sellScore;
                const score = isBuyStronger ? buyScore : sellScore;
                const sideTag = isBuyStronger ? '[BUY]' : '[SELL]';
                this.logger.info(`[VIP Heartbeat] ${symbol} Strength: ${score.toFixed(1)}% ${sideTag}`);
                asset.lastLogTime = now;
            }

            // --- 6. ENTRY LOGIC ---
            if (!this.bot.hasOpenPosition && !this.isOrderInProgress && !this.bot.isOrderInProgress) {
                let side = null;
                let finalScore = 0;

                if (buyScore >= this.MIN_SCORE_LIMIT && buyScore >= sellScore) { side = 'buy'; finalScore = buyScore; }
                else if (sellScore >= this.MIN_SCORE_LIMIT) { side = 'sell'; finalScore = sellScore; }

                if (side && (now - asset.lastTriggerTime > this.LOCK_DURATION_MS)) {
                    asset.lastTriggerTime = now;
                    const orderType = finalScore >= this.MIN_SCORE_MARKET ? 'market_order' : 'limit_order';
                    const execPrice = side === 'buy' ? Math.min(vampEff, standardMid) : Math.max(vampEff, standardMid);
                    
                    this.logger.info(`[🔥 TRIGGER] ${side.toUpperCase()} ${symbol} | CONF: ${finalScore.toFixed(1)}% | TYPE: ${orderType}`);
                    asset.position = { side: side, entryPrice: vampEff, peakPrice: vampEff };
                    await this.executeMicroTrade(symbol, side, execPrice, asset.config, orderType);
                }
            }

            this.updateHistory(asset, obi, totalBidQty, totalAskQty);

        } catch (e) {
            this.logger.error(`[FastStrategy] Error: ${e.message}`);
        }
    }

    // [Standard Exits Unchanged - Using vampEff as currentPrice]
    manageExits(symbol, currentPrice, buyScore, sellScore) {
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;
        const asset = this.assets[symbol];
        const pos = asset.position;
        if (!pos) return;

        let dip = pos.side === 'buy' ? Math.max(0, pos.peakPrice - currentPrice) : Math.max(0, currentPrice - pos.peakPrice);
        if (pos.side === 'buy' && currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
        if (pos.side === 'sell' && currentPrice < pos.peakPrice) pos.peakPrice = currentPrice;

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

    async executeMarketExit(symbol, reason) {
        if (this.isOrderInProgress) return;
        this.isOrderInProgress = true; this.bot.isOrderInProgress = true;
        const asset = this.assets[symbol];
        try {
            const orderData = {
                product_id: asset.config.deltaId.toString(),
                size: this.bot.config.orderSize,
                side: asset.position.side === 'buy' ? 'sell' : 'buy',
                order_type: 'market_order', reduce_only: true
            };
            this.logger.warn(`[Exiting] ${symbol} | Reason: ${reason}`);
            await this.bot.placeOrder(orderData);
            asset.position = null; 
        } catch (err) { this.logger.error(`[Exit Error] ${err.message}`); }
        finally { this.isOrderInProgress = false; this.bot.isOrderInProgress = false; }
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
        this.isOrderInProgress = true; this.bot.isOrderInProgress = true;
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
            this.logger.warn(`[Execution Error] ${err.message}`);
            const asset = this.assets[symbol];
            if (asset) asset.position = null; // Zombie Fix
        } finally { this.isOrderInProgress = false; this.bot.isOrderInProgress = false; }
    }
}

module.exports = FastStrategy;
            
