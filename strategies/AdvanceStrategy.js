// AdvanceStrategy.js
// v14.4 - [FIXED] Warmup Check on All Updates

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

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
                    deltaHistory: [],
                    gapHistory: [],
                    sources: {} 
                };
            }
        });

        this.windowSizeMs = 2 * 60 * 1000; // 2 Minutes
        this.lockDurationMs = 10000;
        this.isWarmup = true;
        this.startTime = Date.now();

        // --- TRADING STATE ---
        this.lastOrderTime = 0;
        this.slPercent = 0.15; 
        this.localInPosition = false; 
    }

    getName() { return "AdvanceStrategy (All Trades IOC)"; }

    // [NEW] Helper to check warmup status from ANY source
    checkWarmup() {
        if (this.isWarmup) {
            const now = Date.now();
            if (now - this.startTime > this.windowSizeMs) {
                this.isWarmup = false;
                this.logger.info(`[AdvanceStrategy] *** ACTIVE *** (Warmup Complete)`);
            }
        }
    }

    async onPriceUpdate(asset, price, source = 'UNKNOWN') {
        const now = Date.now();
        const assetData = this.assets[asset];
        
        // 1. Always check warmup timer first
        this.checkWarmup();

        if (!assetData || this.isLockedOut()) return;

        if (!assetData.sources[source]) assetData.sources[source] = [];
        this.updateHistory(assetData.sources[source], price, now);

        // 2. Return if still warming up OR not enough data
        if (this.isWarmup || assetData.sources[source].length < 2 || assetData.deltaHistory.length < 2) return;

        const marketStats = this.calculateSpikeStats(assetData.sources[source], price);
        const currentDeltaPrice = assetData.deltaHistory[assetData.deltaHistory.length - 1].p;
        const deltaStats = this.calculateSpikeStats(assetData.deltaHistory, currentDeltaPrice);

        let gap = marketStats.direction === 'up' 
            ? marketStats.changePct - deltaStats.changePct 
            : Math.abs(marketStats.changePct) - Math.abs(deltaStats.changePct);
        
        if (gap < 0) gap = 0;

        const cutoff = now - this.windowSizeMs;
        while (assetData.gapHistory.length > 0 && assetData.gapHistory[0].t < cutoff) assetData.gapHistory.shift();
        
        let rollingMax = 0.1; 
        for (const item of assetData.gapHistory) { if (item.v > rollingMax) rollingMax = item.v; }

        if (gap > (rollingMax * 1.11)) {
            if (this.localInPosition) return; 

            const triggerContext = {
                externalSource: source,
                externalPrice: price,
                deltaPrice: currentDeltaPrice,
                gapPct: gap,
                gapUsd: Math.abs(price - currentDeltaPrice),
                threshold: rollingMax
            };

            this.logger.info(`[AdvanceStrategy] ⚡ Trigger: Gap ${gap.toFixed(4)}% > Max ${rollingMax.toFixed(4)}%`);
            
            await this.executeTrade(
                asset, 
                marketStats.direction === 'up' ? 'buy' : 'sell', 
                assetData.deltaId, 
                triggerContext
            );
        }

        assetData.gapHistory.push({ t: now, v: gap });
    }

    // [UPDATED] Now checks warmup too
    onTradeUpdate(symbol, price) {
        // 1. Check warmup here too!
        this.checkWarmup();

        const asset = Object.keys(this.assets).find(a => symbol.startsWith(a));
        if (asset) {
            this.updateHistory(this.assets[asset].deltaHistory, price, Date.now());
        }
    }

    async executeTrade(asset, side, productId, context) {
        this.localInPosition = true;
        this.bot.isOrderInProgress = true;
        const punchStartTime = Date.now();

        try {
            const aggressionPercent = this.bot.config.priceAggressionOffset || 0.05;
            let basePrice = context.externalPrice; 
            
            var executionPrice = side === 'buy' 
                ? basePrice * (1 + (aggressionPercent / 100))
                : basePrice * (1 - (aggressionPercent / 100));

            const slOffset = executionPrice * (this.slPercent / 100);
            const stopLossPrice = side === 'buy' ? (executionPrice - slOffset) : (executionPrice + slOffset);

            const orderData = { 
                product_id: productId.toString(), 
                size: this.bot.config.orderSize.toString(), 
                side: side, 
                order_type: 'limit_order',              
                limit_price: executionPrice.toFixed(4), 
                time_in_force: 'ioc',                   
                bracket_stop_loss_price: stopLossPrice.toFixed(4),
                bracket_stop_trigger_method: 'mark_price' 
            };
            
            const apiStart = Date.now();
            const orderResult = await this.bot.placeOrder(orderData);
            const apiEnd = Date.now();
            
            const apiLatency = apiEnd - apiStart;
            this.lastOrderTime = Date.now();

            if (orderResult && orderResult.success) {
                this.logger.info(`[AdvanceStrategy] ✅ IOC Order Success.`);
                const orderId = orderResult.result ? orderResult.result.id : 'UNKNOWN_ID';

                const logPayload = JSON.stringify({
                    event: "TRADE_LIFECYCLE",
                    asset: asset,
                    direction: side.toUpperCase(),
                    trigger: {
                        source: context.externalSource,
                        ext_price: context.externalPrice,
                        delta_price: context.deltaPrice,
                        gap_usd: context.gapUsd.toFixed(4)
                    },
                    execution: {
                        limit_price: executionPrice.toFixed(4),
                        aggression: `${aggressionPercent}%`
                    },
                    timing: {
                        punch_time: new Date(punchStartTime).toISOString(),
                        api_latency_ms: apiLatency,
                        total_ms: (apiEnd - punchStartTime)
                    },
                    delta_order_id: orderId
                }, null, 2);

                this.logger.info(`\n${logPayload}`);
            } else {
                this.logger.error(`[AdvanceStrategy] ❌ Exchange Error:`, { 
                    error: orderResult.error || 'Unknown Error' 
                });
                this.localInPosition = false; 
            }

        } catch (error) {
            this.logger.error(`[AdvanceStrategy] ❌ Execution Failed:`, { message: error.message });
            this.localInPosition = false; 
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    isLockedOut() {
        if (this.localInPosition) return true;
        if (this.bot.isOrderInProgress) return true;
        if (this.lastOrderTime === 0) return false;
        return (Date.now() - this.lastOrderTime) < this.lockDurationMs;
    }

    onPositionUpdate(pos) {
        const rawSize = (pos && pos.size !== undefined) ? pos.size : 0;
        const size = Math.abs(parseFloat(rawSize));
        
        if (size > 0) {
            if (!this.localInPosition) {
                this.logger.info(`[AdvanceStrategy] Exchange reports position ACTIVE. Strategy Locked.`);
            }
            this.localInPosition = true;
        } else {
            if (this.localInPosition) {
                this.logger.info(`[AdvanceStrategy] Exchange reports position CLOSED. Strategy Unlocked.`);
            }
            this.localInPosition = false;
        }
    }

    updateHistory(array, p, t) {
        array.push({ p, t });
        const cutoff = t - this.windowSizeMs;
        while (array.length > 0 && array[0].t < cutoff) array.shift();
    }

    calculateSpikeStats(history, currentPrice) {
        let min = Math.min(...history.map(h => h.p));
        let max = Math.max(...history.map(h => h.p));
        if (Math.abs(currentPrice - min) > Math.abs(currentPrice - max)) {
            return { direction: 'up', changePct: ((currentPrice - min) / min) * 100 };
        } else {
            return { direction: 'down', changePct: -((max - currentPrice) / max) * 100 };
        }
    }
}

module.exports = AdvanceStrategy;
                    
