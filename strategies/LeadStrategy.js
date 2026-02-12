
/**
 * ============================================================================
 * LEAD STRATEGY (GAP + IMBALANCE)
 * Version: Simple v1.1 [WITH EXTENSIVE HEARTBEAT]
 * Logic: 
 * 1. Calculate Gap % between Binance (Leader) and Delta Last Trade (Lagger).
 * 2. If Gap > 0.03% -> BUY | If Gap < -0.03% -> SELL.
 * 3. Filter: Confirm Binance Order Book Imbalance supports the direction.
 * ============================================================================
 */

class LeadStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.GAP_THRESHOLD = 0.0004;      // 0.03% target
        this.IMBALANCE_RATIO = 0.6;       // 60% book dominance required
        this.COOLDOWN_MS = 1000;          // 1s cooldown

        // --- ASSET SPECS ---
        this.assets = {
            'XRP': { deltaId: 14969, precision: 4 }, 
            'BTC': { deltaId: 27, precision: 1 },    
            'ETH': { deltaId: 299, precision: 2 },
            'SOL': { deltaId: 417, precision: 3 }
        };

        // --- STATE ---
        this.lastDeltaPrice = {};         
        this.lastTriggerTime = {};        
        
        // Store latest calculations for the Heartbeat Logger
        this.latestStats = {}; 

        this.logger.info(`[LeadStrategy Simple] Loaded.`);
        this.logger.info(`> Config: Gap Req > ${this.GAP_THRESHOLD * 100}% | Imbalance Req > ${this.IMBALANCE_RATIO * 100}%`);

        // Start the 10s Monitor
        this.startHeartbeat();
    }

    /**
     * 🟢 HEARTBEAT LOGGER
     * Runs every 10 seconds to show you exactly what the bot sees.
     */
    startHeartbeat() {
        setInterval(() => {
            const activeAssets = Object.keys(this.assets);
            this.logger.info(`--- 📊 STRATEGY SNAPSHOT (10s) 📊 ---`);

            activeAssets.forEach(asset => {
                const stats = this.latestStats[asset];
                const deltaP = this.lastDeltaPrice[asset];

                if (!stats || !deltaP) {
                    this.logger.info(`[${asset}] Waiting for data...`);
                    return;
                }

                // 1. Format Values
                const gapPct = (stats.gap * 100).toFixed(4);
                const reqGap = (this.GAP_THRESHOLD * 100).toFixed(3);
                const imb = stats.imbalance.toFixed(2);
                const reqImb = this.IMBALANCE_RATIO.toFixed(2);
                
                // 2. Determine Status
                let status = "💤 IDLE";
                if (Math.abs(stats.gap) > this.GAP_THRESHOLD) {
                    if (stats.imbalance >= this.IMBALANCE_RATIO) {
                        status = "🔥 TRIGGERING";
                    } else {
                        status = "⚠️ GAP OK / LOW IMBALANCE";
                    }
                } else if (Math.abs(stats.gap) > (this.GAP_THRESHOLD * 0.5)) {
                    status = "👀 WARMING UP";
                }

                // 3. Log Line
                this.logger.info(
                    `[${asset}] ${status} | Gap: ${gapPct}% (Req ${reqGap}%) | Imb: ${imb} (Req ${reqImb}) | Bin: ${stats.binancePrice} vs Delta: ${deltaP}`
                );
            });
            this.logger.info(`------------------------------------------`);
        }, 10000); // 10,000 ms = 10 seconds
    }

    /**
     * Called when a public trade happens on Delta (The Lagger)
     */
    onLaggerTrade(trade) {
        const rawSymbol = trade.symbol || trade.product_symbol;
        if (!rawSymbol) return;
        const asset = Object.keys(this.assets).find(k => rawSymbol.startsWith(k));
        if (!asset) return;

        const price = parseFloat(trade.price);
        if (!isNaN(price)) {
            this.lastDeltaPrice[asset] = price;
        }
    }

    /**
     * Called when Binance (Leader) updates (High Frequency)
     */
    async onDepthUpdate(asset, depth) {
        if (!this.assets[asset]) return;
        
        const deltaPrice = this.lastDeltaPrice[asset];
        if (!deltaPrice) return;

        // 1. Extract Leader Metrics
        const binanceBid = parseFloat(depth.bids[0][0]);
        const binanceBidQty = parseFloat(depth.bids[0][1]);
        const binanceAsk = parseFloat(depth.asks[0][0]);
        const binanceAskQty = parseFloat(depth.asks[0][1]);
        const binanceMid = (binanceBid + binanceAsk) / 2;

        // 2. Calculate Gap & Imbalance
        const gap = (binanceMid - deltaPrice) / deltaPrice;
        
        const totalQty = binanceBidQty + binanceAskQty;
        const bidRatio = binanceBidQty / totalQty;
        const askRatio = binanceAskQty / totalQty;

        // 3. Store Stats for Heartbeat (regardless of trigger)
        // We store the relevant imbalance based on direction of gap
        // If Gap is positive (Buy), we care about Bid Ratio. If negative (Sell), Ask Ratio.
        const relevantImbalance = gap > 0 ? bidRatio : askRatio;

        this.latestStats[asset] = {
            gap: gap,
            imbalance: relevantImbalance,
            binancePrice: binanceMid,
            timestamp: Date.now()
        };

        // 4. Logic: Check Thresholds
        if (Math.abs(gap) > this.GAP_THRESHOLD) {
            
            let side = null;

            // BUY: Leader Higher + Heavy Bids
            if (gap > 0 && bidRatio >= this.IMBALANCE_RATIO) {
                side = 'buy';
            }
            // SELL: Leader Lower + Heavy Asks
            else if (gap < 0 && askRatio >= this.IMBALANCE_RATIO) {
                side = 'sell';
            }

            // 5. Execute
            if (side) {
                this.logger.info(`[Signal ${asset}] Gap: ${(gap*100).toFixed(3)}% | Imb: ${relevantImbalance.toFixed(2)} | Delta: ${deltaPrice} -> Bin: ${binanceMid}`);
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
            client_order_id: `simp_${now}`
        };

        this.logger.info(`[Sniper] ⚡ FIRE ${asset} ${side.toUpperCase()} @ ${currentPrice}`);
        await this.bot.placeOrder(payload);
    }

    getName() { return "LeadStrategy (Simple + Heartbeat)"; }
    onPositionClose(asset) {}
}

module.exports = LeadStrategy;
