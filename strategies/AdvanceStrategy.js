// AdvanceStrategy.js
// v16.0 - [HFT] Micro-Burst Sniping (Sub-50ms)

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // Configuration
        this.BURST_WINDOW_MS = 50;       // Max time window to measure the move
        this.BURST_THRESHOLD = 0.0008;   // 0.04% Move Trigger
        this.GAP_THRESHOLD = 0.0004;     // 0.03% Price Gap (External vs Delta)
        this.DELTA_STALE_MS = 100;       // Max allowed age of Delta price
        this.LOCK_DURATION_MS = 2000;    // Prevent double-firing on same spike

        // Mapping
        const MASTER_CONFIG = {
            'XRP': { deltaId: 14969 },
            'BTC': { deltaId: 27 },
            'ETH': { deltaId: 299 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.assets = {};

        targets.forEach(asset => {
            if (MASTER_CONFIG[asset]) {
                this.assets[asset] = {
                    deltaId: MASTER_CONFIG[asset].deltaId,
                    deltaPrice: 0,
                    deltaLastUpdate: 0,
                    // "Micro-Buffers" for external sources
                    // Structure: { 'BINANCE': [{p: 100, t: 123456789}], 'GATE': [...] }
                    buffers: {} 
                };
            }
        });

        this.lastTriggerTime = 0;
        this.localInPosition = false;
        
        // Trading Params
        this.slPercent = 0.15;
    }

    getName() { return "SniperStrategy (30ms Micro-Burst)"; }

    // 1. UPDATE INTERNAL PRICE (Delta)
    // We just store the latest price. No history needed.
    onTradeUpdate(symbol, price) {
        const asset = Object.keys(this.assets).find(a => symbol.startsWith(a));
        if (asset) {
            this.assets[asset].deltaPrice = price;
            this.assets[asset].deltaLastUpdate = Date.now();
        }
    }

    // 2. PROCESS EXTERNAL PRICE (The Snipe Logic)
    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        // Fail-fast checks
        if (this.localInPosition || this.bot.isOrderInProgress) return;
        
        const now = Date.now();
        if (now - this.lastTriggerTime < this.LOCK_DURATION_MS) return;

        const assetData = this.assets[asset];
        if (!assetData) return;

        // Initialize buffer if new source
        if (!assetData.buffers[source]) assetData.buffers[source] = [];
        const buffer = assetData.buffers[source];

        // A. Add new tick
        buffer.push({ p: price, t: now });

        // B. Prune buffer (Remove ticks older than 30ms)
        // Since array is sorted by time, we just shift from front. 
        // Fast operation for small arrays.
        while (buffer.length > 0 && (now - buffer[0].t > this.BURST_WINDOW_MS)) {
            buffer.shift();
        }

        // Need at least 2 ticks to measure a move
        if (buffer.length < 2) return;

        // C. Calculate Move (High/Low within 30ms window)
        // We compare Current Price (newest) vs Extremes in the window
        let minP = buffer[0].p;
        let maxP = buffer[0].p;

        // Tiny loop (likely < 5 iterations) -> Extremely fast
        for (let i = 1; i < buffer.length; i++) {
            if (buffer[i].p < minP) minP = buffer[i].p;
            if (buffer[i].p > maxP) maxP = buffer[i].p;
        }

        // D. Check Burst Criteria
        let direction = null;
        
        // Did we pump > 0.04% from the LOW of the last 30ms?
        if ((price - minP) / minP >= this.BURST_THRESHOLD) {
            direction = 'buy';
        }
        // Did we dump > 0.04% from the HIGH of the last 30ms?
        else if ((maxP - price) / maxP >= this.BURST_THRESHOLD) {
            direction = 'sell';
        }

        if (!direction) return; // No burst detected

        // E. Check Gap vs Delta (Arbitrage Opportunity)
        // Ensure Delta price is fresh
        if (now - assetData.deltaLastUpdate > this.DELTA_STALE_MS) {
            // Optional: Log warning if debugging, otherwise skip to save CPU
            return; 
        }

        const deltaP = assetData.deltaPrice;
        if (deltaP === 0) return;

        let gap = 0;
        if (direction === 'buy') {
            // External Pumping, Delta lagging low
            gap = (price - deltaP) / deltaP;
        } else {
            // External Dumping, Delta lagging high
            gap = (deltaP - price) / deltaP;
        }

        // F. FIRE TRIGGER
        if (gap >= this.GAP_THRESHOLD) {
            this.lastTriggerTime = now;
            
            this.logger.info(`[Sniper] 🔫 FIRE: ${asset} ${direction.toUpperCase()} | Burst: 30ms | Gap: ${(gap*100).toFixed(4)}%`);
            
            await this.executeSnipe(asset, direction, assetData.deltaId, price, deltaP);
        }
    }

    async executeSnipe(asset, side, productId, externalPrice, deltaPrice) {
        this.localInPosition = true;
        this.bot.isOrderInProgress = true;

        try {
            // Use config aggression, default to 0.05%
            const aggressionPercent = this.bot.config.priceAggressionOffset || 0.05;
            
            // Calculate Limit Price
            let limitPrice;
            if (side === 'buy') {
                // We want to buy, so we bid slightly higher than market to ensure fill
                limitPrice = externalPrice * (1 + (aggressionPercent / 100));
            } else {
                // We want to sell, so we ask slightly lower
                limitPrice = externalPrice * (1 - (aggressionPercent / 100));
            }

            // Calculate Stop Loss
            const slOffset = limitPrice * (this.slPercent / 100);
            const stopLossPrice = side === 'buy' 
                ? (limitPrice - slOffset) 
                : (limitPrice + slOffset);

            const orderData = { 
                product_id: productId.toString(), 
                size: this.bot.config.orderSize.toString(), 
                side: side, 
                order_type: 'limit_order',              
                limit_price: limitPrice.toFixed(4), 
                time_in_force: 'ioc', // Immediate or Cancel (Sniping Mode)                  
                bracket_stop_loss_price: stopLossPrice.toFixed(4),
                bracket_stop_trigger_method: 'mark_price' 
            };
            
            const startT = Date.now();
            const orderResult = await this.bot.placeOrder(orderData);
            const latency = Date.now() - startT;

            if (orderResult && orderResult.success) {
                 // [X-RAY LOGGING]
                 const metrics = orderResult._metrics || { server: 0 };
                 this.logger.info(`[Sniper] 🎯 HIT ${asset} | Roundtrip: ${latency}ms | Net: ${metrics.server.toFixed(2)}ms`);
            } else {
                this.logger.error(`[Sniper] 💨 MISS: ${orderResult.error || 'Unknown'}`);
                this.localInPosition = false; 
            }

        } catch (error) {
            this.logger.error(`[Sniper] ❌ CRITICAL: ${error.message}`);
            this.localInPosition = false; 
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    // Standard position state management
    onPositionUpdate(pos) {
        const size = (pos && pos.size) ? parseFloat(pos.size) : 0;
        this.localInPosition = size !== 0;
    }
}

module.exports = AdvanceStrategy;
                    
