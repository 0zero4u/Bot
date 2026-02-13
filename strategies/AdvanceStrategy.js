/**
 * AdvanceStrategy.js
 * v17.0 - [HFT] Micro-Burst Sniping (Sub-50ms)
 * UPDATES:
 * - Uses Market Order + Trailing Stop (0.02%)
 * - Uses 'all_trades' for internal price (Low Latency)
 * - Fixed Precision/Spec handling for Trail Amount
 * - Added 10s Heartbeat & Gap Logging
 */

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.BURST_WINDOW_MS = 50;       // Max time window to measure the move
        this.BURST_THRESHOLD = 0.0003;   // 0.03% Move Trigger
        this.GAP_THRESHOLD = 0.0002;     // 0.02% Price Gap (External vs Delta)
        this.DELTA_STALE_MS = 1000;      // Tolerated age of Delta price (all_trades is fast)
        this.LOCK_DURATION_MS = 2000;    
        this.TRAILING_PERCENT = 0.02;    // Fixed 0.02% Trailing Stop

        // --- ASSET SPECS (Copied from MicroStrategy for Precision) ---
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
                    deltaPrice: 0,       // Sourced from all_trades
                    deltaLastUpdate: 0,
                    buffers: {},         // External price history
                    lastLogTime: 0       // For Heartbeat
                };
            }
        });

        this.lastTriggerTime = 0;
        this.localInPosition = false;
    }

    getName() { return "AdvanceStrategy (Market + Trail 0.02% + AllTrades)"; }

    /**
     * 1. UPDATE INTERNAL PRICE (Low Latency 'all_trades')
     * Called by trader.js when 'all_trades' message arrives
     */
    onLaggerTrade(trade) {
        // Handle both single object or array, normalized by trader usually
        // But we ensure we get the price and symbol
        const symbol = trade.symbol ? trade.symbol.replace('USD', '') : null;
        const price = parseFloat(trade.price);

        if (symbol && this.assets[symbol] && !isNaN(price)) {
            this.assets[symbol].deltaPrice = price;
            this.assets[symbol].deltaLastUpdate = Date.now();
        }
    }

    /**
     * 2. PROCESS EXTERNAL PRICE (The Snipe Logic)
     * Called by trader.js via WebSocket Server
     */
    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        if (this.localInPosition || this.bot.isOrderInProgress) return;
        
        const now = Date.now();
        const assetData = this.assets[asset];
        if (!assetData) return;

        // --- HEARTBEAT LOG (10s) ---
        if (now - assetData.lastLogTime > 10000) {
            const gap = assetData.deltaPrice > 0 
                ? ((price - assetData.deltaPrice) / assetData.deltaPrice) * 100 
                : 0;
            
            this.logger.info(
                `[HEARTBEAT] ${asset} | Ext: ${price} | Delta: ${assetData.deltaPrice} | Gap: ${gap.toFixed(4)}% | Src: ${source}`
            );
            assetData.lastLogTime = now;
        }

        if (now - this.lastTriggerTime < this.LOCK_DURATION_MS) return;

        // Initialize buffer if new source
        if (!assetData.buffers[source]) assetData.buffers[source] = [];
        const buffer = assetData.buffers[source];

        // A. Add new tick
        buffer.push({ p: price, t: now });

        // B. Prune buffer (Remove ticks older than BURST_WINDOW)
        while (buffer.length > 0 && (now - buffer[0].t > this.BURST_WINDOW_MS)) {
            buffer.shift();
        }

        if (buffer.length < 2) return;

        // C. Calculate Move (High/Low within window)
        let minP = buffer[0].p;
        let maxP = buffer[0].p;

        for (let i = 1; i < buffer.length; i++) {
            if (buffer[i].p < minP) minP = buffer[i].p;
            if (buffer[i].p > maxP) maxP = buffer[i].p;
        }

        // D. Check Burst Criteria
        let direction = null;
        
        // Pump detected?
        if ((price - minP) / minP >= this.BURST_THRESHOLD) {
            direction = 'buy';
        }
        // Dump detected?
        else if ((maxP - price) / maxP >= this.BURST_THRESHOLD) {
            direction = 'sell';
        }

        if (!direction) return; 

        // E. Check Gap vs Delta (Arbitrage Opportunity)
        // Ensure Delta price is fresh
        if (now - assetData.deltaLastUpdate > this.DELTA_STALE_MS) return;

        const deltaP = assetData.deltaPrice;
        if (deltaP === 0) return;

        let gap = 0;
        if (direction === 'buy') {
            gap = (price - deltaP) / deltaP; // External higher
        } else {
            gap = (deltaP - price) / deltaP; // External lower
        }

        // F. FIRE TRIGGER
        if (gap >= this.GAP_THRESHOLD) {
            this.lastTriggerTime = now;
            
            // IMMEDIATE LOG (Fast Speed)
            this.logger.info(`[Sniper] ⚡ FIRE: ${asset} ${direction.toUpperCase()} | Ext: ${price} | Delta: ${deltaP} | Gap: ${(gap*100).toFixed(4)}%`);
            
            await this.executeSnipe(asset, direction, deltaP);
        }
    }

    async executeSnipe(asset, side, currentPrice) {
        this.localInPosition = true;
        this.bot.isOrderInProgress = true;

        try {
            const spec = this.specs[asset];
            if (!spec) throw new Error(`Specs not found for ${asset}`);

            // --- TRAILING STOP CALCULATION (Precision Aware) ---
            // Calculate distance based on current price
            let trailDistance = currentPrice * (this.TRAILING_PERCENT / 100);
            
            // Ensure distance is at least 1 tick
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDistance < tickSize) trailDistance = tickSize;

            // Format strictly as string for API
            const trailAmount = trailDistance.toFixed(spec.precision);
            
            const clientOid = `adv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            this.bot.recordOrderPunch(clientOid);

            // Payload: Market Order + Trailing Stop
            const payload = { 
                product_id: spec.deltaId.toString(), 
                size: (process.env.ORDER_SIZE || "1"), 
                side: side, 
                order_type: 'market_order',              
                bracket_trail_amount: trailAmount,
                bracket_stop_trigger_method: 'last_traded_price', // Trigger off Last Price (not Mark)
                client_order_id: clientOid
            };
            
            const startT = Date.now();
            const orderResult = await this.bot.placeOrder(payload);
            const latency = Date.now() - startT;

            if (orderResult && orderResult.success) {
                 this.logger.info(`[Sniper] 🎯 HIT ${asset} | Trail: ${trailAmount} | Latency: ${latency}ms`);
            } else {
                this.logger.error(`[Sniper] 💨 MISS: ${orderResult ? orderResult.error : 'Unknown Error'}`);
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
        this.logger.info(`[Sniper] Position Closed for ${symbol}. Resetting lock.`);
        this.localInPosition = false;
        this.lastTriggerTime = 0; // Optional: Allow immediate re-entry
    }

    onPositionUpdate(pos) {
        const size = (pos && pos.size) ? parseFloat(pos.size) : 0;
        // Only update local flag if it matches our tracking
        if (size !== 0) this.localInPosition = true;
        else this.localInPosition = false;
    }
}

module.exports = AdvanceStrategy;
