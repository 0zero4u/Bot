// FastStrategy.js
// v1.0 - [Microstructure] Order Book Imbalance (OBI) & Liquidity Flow

class FastStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // Configuration Constants
        this.OBI_WINDOW = 100;           // Rolling window for Z-Score calculation
        this.Z_THRESHOLD = 1.0;          // OBI Z-Score trigger
        this.SHIFT_THRESHOLD = 0.5;      // WD_Shift (ticks) trigger
        this.LOCK_DURATION_MS = 1500;    // Cooldown to prevent over-trading
        
        // Asset Master Config
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969, tickSize: 0.0001 },
            'BTC': { deltaId: 27,    tickSize: 0.1 },
            'ETH': { deltaId: 299,   tickSize: 0.01 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(asset => {
            if (MASTER_CONFIG[asset]) {
                this.assets[asset] = {
                    config: MASTER_CONFIG[asset],
                    history: {
                        obi: [],
                        prevAskQty: 0,
                        prevBidQty: 0,
                        prevOBI: 0
                    },
                    lastTriggerTime: 0
                };
            }
        });

        this.isOrderInProgress = false;
        this.slPercent = 0.12; // Tight SL for micro-moves
    }

    getName() { return "FastStrategy (Microstructure Alpha)"; }

    /**
     * Entry point for Order Book updates (Depth-5)
     * @param {string} symbol - e.g., 'BTC-USDT'
     * @param {object} depth - { bids: [[p, q],...], asks: [[p, q],...] }
     */
    async onDepthUpdate(symbol, depth) {
        if (this.isOrderInProgress || this.bot.isOrderInProgress) return;

        const assetName = Object.keys(this.assets).find(a => symbol.startsWith(a));
        if (!assetName || !depth.bids.length || !depth.asks.length) return;

        const asset = this.assets[assetName];
        const now = Date.now();

        if (now - asset.lastTriggerTime < this.LOCK_DURATION_MS) return;

        // 1. Raw Inputs (Σ 1..5)
        const bidQty = depth.bids.slice(0, 5).reduce((sum, b) => sum + parseFloat(b[1]), 0);
        const askQty = depth.asks.slice(0, 5).reduce((sum, a) => sum + parseFloat(a[1]), 0);
        
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);
        const midPrice = (bestBid + bestAsk) / 2;

        // 2. Feature Computation
        // A) OBI & OBI_z
        const obi = (bidQty - askQty) / (bidQty + askQty);
        asset.history.obi.push(obi);
        if (asset.history.obi.length > this.OBI_WINDOW) asset.history.obi.shift();
        
        const obiZ = this.calculateZScore(asset.history.obi);

        // B) dOBI
        const dOBI = obi - asset.history.prevOBI;

        // C) Weighted-Depth Price Bias (P_WD)
        const sumBidPQ = depth.bids.slice(0, 5).reduce((sum, b) => sum + (b[0] * b[1]), 0);
        const sumAskPQ = depth.asks.slice(0, 5).reduce((sum, a) => sum + (a[0] * a[1]), 0);
        const pWD = (sumBidPQ + sumAskPQ) / (bidQty + askQty);
        const wdShift = (pWD - midPrice) / asset.config.tickSize;

        // D) Liquidity Pull Imbalance
        const askPull = asset.history.prevAskQty - askQty;
        const bidPull = asset.history.prevBidQty - bidQty;
        const pullImbalance = askPull - bidPull;

        // 3. Signal Generation
        let signal = null;

        // LONG Signal
        if (obiZ > this.Z_THRESHOLD && dOBI > 0 && wdShift > this.SHIFT_THRESHOLD && pullImbalance > 0) {
            signal = 'buy';
        } 
        // SHORT Signal
        else if (obiZ < -this.Z_THRESHOLD && dOBI < 0 && wdShift < -this.SHIFT_THRESHOLD && pullImbalance < 0) {
            signal = 'sell';
        }

        // 4. Execution
        if (signal) {
            asset.lastTriggerTime = now;
            await this.executeMicroTrade(assetName, signal, midPrice, asset.config.deltaId);
        }

        // Update history for next tick
        asset.history.prevOBI = obi;
        asset.history.prevAskQty = askQty;
        asset.history.prevBidQty = bidQty;
    }

    calculateZScore(values) {
        if (values.length < 2) return 0;
        const n = values.length;
        const mean = values.reduce((a, b) => a + b) / n;
        const std = Math.sqrt(values.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n);
        return std === 0 ? 0 : (values[n - 1] - mean) / std;
    }

    async executeMicroTrade(asset, side, price, productId) {
        this.isOrderInProgress = true;
        this.bot.isOrderInProgress = true;

        try {
            const aggression = this.bot.config.priceAggressionOffset || 0.02;
            const limitPrice = side === 'buy' ? price * (1 + aggression/100) : price * (1 - aggression/100);
            
            const slOffset = limitPrice * (this.slPercent / 100);
            const stopPrice = side === 'buy' ? (limitPrice - slOffset) : (limitPrice + slOffset);

            const orderData = {
                product_id: productId.toString(),
                size: this.bot.config.orderSize.toString(),
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice.toFixed(4),
                time_in_force: 'ioc', 
                bracket_stop_loss_price: stopPrice.toFixed(4),
                bracket_stop_trigger_method: 'mark_price'
            };

            this.logger.info(`[Micro-Alpha] ⚡ ${side.toUpperCase()} ${asset} @ ${price} | Z-Score Triggered`);
            await this.bot.placeOrder(orderData);

        } catch (e) {
            this.logger.error(`[Micro-Alpha] Execution Error: ${e.message}`);
        } finally {
            this.isOrderInProgress = false;
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = FastStrategy;
          
