/**
 * ============================================================================
 * LEAD STRATEGY (ANONYMOUS + EXTENSIVE LOGS)
 * Logic: Gap > 0.03% AND Imbalance > 60%
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.GAP_THRESHOLD = 0.0005;      // 0.03%
        this.IMBALANCE_RATIO = 0.6;       // 60% dominance
        this.COOLDOWN_MS = 1000;          

        // --- ASSET SPECS ---
        this.assets = {
            'XRP': { deltaId: 14969 }, 
            'BTC': { deltaId: 27 },    
            'ETH': { deltaId: 299 },
            'SOL': { deltaId: 417 }
        };

        // --- STATE ---
        this.lastDeltaPrice = {};         
        this.lastTriggerTime = {};        
        this.latestStats = {}; 

        this.logger.info(`[LeadStrategy] Loaded. Gap Target: 0.03% | Imbalance: 60%`);
        this.startHeartbeat();
    }

    /**
     * 🟢 EXTENSIVE HEARTBEAT (Every 10s)
     * Shows RAW math. No Asset Names.
     */
    startHeartbeat() {
        setInterval(() => {
            const activeAssets = Object.keys(this.assets);
            this.logger.info(`--- 📊 MARKET X-RAY 📊 ---`);

            activeAssets.forEach(asset => {
                const stats = this.latestStats[asset];
                const deltaP = this.lastDeltaPrice[asset];

                if (!stats || !deltaP) return; // Skip if no data yet

                // 1. Calculate values
                const gapPct = (stats.gap * 100).toFixed(4);
                const imb = stats.imbalance.toFixed(2);
                const binPrice = stats.binancePrice;
                
                // 2. Status Flag
                let status = "💤"; // Idle
                if (Math.abs(stats.gap) > this.GAP_THRESHOLD) {
                    if (stats.imbalance >= this.IMBALANCE_RATIO) status = "🔥 FIRE";
                    else status = "⚠️ IMB_FAIL";
                } else if (Math.abs(stats.gap) > (this.GAP_THRESHOLD * 0.5)) {
                    status = "👀 WARM";
                }

                // 3. LOG (No Name, Just Data)
                // Format: [Status] Gap: X% | Imb: Y | Bin: Z vs Delta: A
                this.logger.info(
                    `${status} | Gap: ${gapPct}% | Imb: ${imb} | Lead: ${binPrice} vs Lag: ${deltaP}`
                );
            });
            this.logger.info(`----------------------------`);
        }, 10000); 
    }

    onLaggerTrade(trade) {
        const rawSymbol = trade.symbol || trade.product_symbol;
        if (!rawSymbol) return;
        const asset = Object.keys(this.assets).find(k => rawSymbol.startsWith(k));
        if (!asset) return;

        const price = parseFloat(trade.price);
        if (!isNaN(price)) this.lastDeltaPrice[asset] = price;
    }

    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;
        
        const deltaPrice = this.lastDeltaPrice[asset];
        if (!deltaPrice) return;

        // 1. Parse Leader
        const binBid = parseFloat(depth.bids[0][0]);
        const binBidQty = parseFloat(depth.bids[0][1]);
        const binAsk = parseFloat(depth.asks[0][0]);
        const binAskQty = parseFloat(depth.asks[0][1]);
        const binMid = (binBid + binAsk) / 2;

        // 2. Math
        const gap = (binMid - deltaPrice) / deltaPrice;
        
        const totalQty = binBidQty + binAskQty;
        const bidRatio = binBidQty / totalQty; // 0.0 to 1.0
        const askRatio = binAskQty / totalQty; // 0.0 to 1.0

        // 3. Store for Heartbeat
        // (If Gap is +, we watch Bids. If -, we watch Asks)
        const relevantImbalance = gap > 0 ? bidRatio : askRatio;

        this.latestStats[asset] = {
            gap: gap,
            imbalance: relevantImbalance,
            binancePrice: binMid
        };

        // 4. Trigger Logic
        if (Math.abs(gap) > this.GAP_THRESHOLD) {
            let side = null;

            // Buy: Leader High + Heavy Bids
            if (gap > 0 && bidRatio >= this.IMBALANCE_RATIO) side = 'buy';
            // Sell: Leader Low + Heavy Asks
            else if (gap < 0 && askRatio >= this.IMBALANCE_RATIO) side = 'sell';

            if (side) {
                // LOG THE TRIGGER
                this.logger.info(`🚀 SIGNAL | Gap: ${(gap*100).toFixed(3)}% | Imb: ${relevantImbalance.toFixed(2)} | P: ${deltaPrice}`);
                await this.tryExecute(asset, side, deltaPrice);
            }
        }
    }

    async tryExecute(asset, side, currentPrice) {
        const now = Date.now();
        if (this.lastTriggerTime[asset] && (now - this.lastTriggerTime[asset] < this.COOLDOWN_MS)) return;
        if (this.bot.hasOpenPosition(asset)) return;

        this.lastTriggerTime[asset] = now;
        const spec = this.assets[asset];

        const payload = {
            product_id: spec.deltaId.toString(),
            side: side,
            size: process.env.ORDER_SIZE || "1",
            order_type: 'market_order',
            client_order_id: `s_${now}`
        };

        this.logger.info(`⚡ EXECUTING ${side.toUpperCase()} @ ${currentPrice}`);
        await this.bot.placeOrder(payload);
    }

    getName() { return "LeadStrategy (Clean)"; }
    onPositionClose(asset) {}
}

module.exports = LeadStrategy;
