/**
 * AdvanceStrategy.js
 * v18.0 - [FIXED] Added onDepthUpdate Adapter
 */

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.BURST_WINDOW_MS = 25;       
        this.BURST_THRESHOLD = 0.0003;   
        this.GAP_THRESHOLD = 0.0002;     
        this.DELTA_STALE_MS = 1000;      
        this.LOCK_DURATION_MS = 2000;    
        this.TRAILING_PERCENT = 0.02;    

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: 0.001 },
            'ETH': { deltaId: 299,   precision: 2, lot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 1 },
            'SOL': { deltaId: 417,   precision: 3, lot: 0.1 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(symbol => {
            if (this.specs[symbol]) {
                this.assets[symbol] = {
                    deltaId: this.specs[symbol].deltaId,
                    deltaPrice: 0,       
                    deltaLastUpdate: 0,
                    buffers: {},         
                    lastLogTime: 0       
                };
            }
        });

        this.lastTriggerTime = 0;
        this.localInPosition = false;
    }

    getName() { return "AdvanceStrategy (Market + Trail 0.02% + Adapter)"; }

    /**
     * [NEW] ADAPTER METHOD
     * This bridges the gap between market_listener (Type B) and this strategy.
     */
    onDepthUpdate(asset, depth) {
        if (!depth.bids[0] || !depth.asks[0]) return;

        // Extract Best Bid/Ask
        const bestBid = parseFloat(depth.bids[0][0]);
        const bestAsk = parseFloat(depth.asks[0][0]);

        // Calculate Mid-Price (Fair Price)
        const midPrice = (bestBid + bestAsk) / 2;

        // Pass to the sniping logic
        this.onPriceUpdate(asset, midPrice, 'BINANCE');
    }

    onLaggerTrade(trade) {
        const symbol = trade.symbol ? trade.symbol.replace('USD', '') : null;
        const price = parseFloat(trade.price);
        if (symbol && this.assets[symbol] && !isNaN(price)) {
            this.assets[symbol].deltaPrice = price;
            this.assets[symbol].deltaLastUpdate = Date.now();
        }
    }

    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        if (this.localInPosition || this.bot.isOrderInProgress) return;
        
        const now = Date.now();
        const assetData = this.assets[asset];
        if (!assetData) return;

        // Heartbeat Log (10s)
        if (now - assetData.lastLogTime > 10000) {
            const gap = assetData.deltaPrice > 0 
                ? ((price - assetData.deltaPrice) / assetData.deltaPrice) * 100 
                : 0;
            this.logger.info(`[HEARTBEAT] ${asset} | Ext: ${price} | Delta: ${assetData.deltaPrice} | Gap: ${gap.toFixed(4)}%`);
            assetData.lastLogTime = now;
        }

        if (now - this.lastTriggerTime < this.LOCK_DURATION_MS) return;

        if (!assetData.buffers[source]) assetData.buffers[source] = [];
        const buffer = assetData.buffers[source];

        buffer.push({ p: price, t: now });

        while (buffer.length > 0 && (now - buffer[0].t > this.BURST_WINDOW_MS)) {
            buffer.shift();
        }

        if (buffer.length < 2) return;

        let minP = buffer[0].p;
        let maxP = buffer[0].p;

        for (let i = 1; i < buffer.length; i++) {
            if (buffer[i].p < minP) minP = buffer[i].p;
            if (buffer[i].p > maxP) maxP = buffer[i].p;
        }

        let direction = null;
        if ((price - minP) / minP >= this.BURST_THRESHOLD) direction = 'buy';
        else if ((maxP - price) / maxP >= this.BURST_THRESHOLD) direction = 'sell';

        if (!direction) return; 

        if (now - assetData.deltaLastUpdate > this.DELTA_STALE_MS) return;
        const deltaP = assetData.deltaPrice;
        if (deltaP === 0) return;

        let gap = (direction === 'buy') ? (price - deltaP) / deltaP : (deltaP - price) / deltaP;

        if (gap >= this.GAP_THRESHOLD) {
            this.lastTriggerTime = now;
            this.logger.info(`[Sniper] ⚡ FIRE: ${asset} ${direction.toUpperCase()} | Gap: ${(gap*100).toFixed(4)}%`);
            await this.executeSnipe(asset, direction, deltaP);
        }
    }

    async executeSnipe(asset, side, currentPrice) {
        this.localInPosition = true;
        this.bot.isOrderInProgress = true;

        try {
            const spec = this.specs[asset];
            
            // Precision-safe trail calculation
            let trailDistance = currentPrice * (this.TRAILING_PERCENT / 100);
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDistance < tickSize) trailDistance = tickSize;
            const trailAmount = trailDistance.toFixed(spec.precision);
            
            const clientOid = `adv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            this.bot.recordOrderPunch(clientOid);

            const payload = { 
                product_id: spec.deltaId.toString(), 
                size: (process.env.ORDER_SIZE || "1"), 
                side: side, 
                order_type: 'market_order',              
                bracket_trail_amount: trailAmount,
                bracket_stop_trigger_method: 'last_traded_price',
                client_order_id: clientOid
            };
            
            const startT = Date.now();
            const orderResult = await this.bot.placeOrder(payload);
            const latency = Date.now() - startT;

            if (orderResult && orderResult.success) {
                 this.logger.info(`[Sniper] 🎯 HIT ${asset} | Trail: ${trailAmount} | Latency: ${latency}ms`);
            } else {
                this.logger.error(`[Sniper] 💨 MISS: ${orderResult ? orderResult.error : 'Unknown'}`);
                this.localInPosition = false; 
            }

        } catch (error) {
            this.logger.error(`[Sniper] ❌ EXEC FAIL: ${error.message}`);
            this.localInPosition = false; 
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    onPositionClose(symbol) {
        this.localInPosition = false;
        this.lastTriggerTime = 0; 
    }

    onPositionUpdate(pos) {
        const size = (pos && pos.size) ? parseFloat(pos.size) : 0;
        this.localInPosition = (size !== 0);
    }
}

module.exports = AdvanceStrategy;
            
