/**
 * ============================================================================
 * MONUMENT STRATEGY
 * Cross-exchange arbitrage: Binance (reference) → Delta Exchange (execution)
 * ============================================================================
 * 
 * FORMULA 0: Baseline Spread (EMA) — Remove structural premium/discount
 * FORMULA 1: Edge Signal & Side — Determine if edge exceeds 0.06% fee
 * FORMULA 2: Chase Safety Filter — Confirm Binance order flow supports direction
 * FORMULA 3: Remaining Opportunity — Delta hasn't already absorbed the move
 * 
 * Final: Trade only when dislocation > 0.06% fee, Binance still pushing,
 *        and Delta has absorbed < 50% of the move.
 */

class MonumentStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.FEE = 0.0006;                    // Delta round-trip fee: 0.06%
        this.EMA_ALPHA = 0.02;                // EMA smoothing factor
        this.LAG_RATIO_THRESHOLD = 0.50;      // Formula 3: Min remaining opportunity
        this.COOLDOWN_MS = 30000;             // 30s cooldown between trades
        this.TRAILING_STOP_PCT = 0.0003;      // 0.03% trailing stop

        // --- ASSET SPECS ---
        this.specs = {
            'BTC': { deltaId: 27, precision: 1 },
            'ETH': { deltaId: 299, precision: 2 },
            'XRP': { deltaId: 14969, precision: 4 },
            'SOL': { deltaId: 417, precision: 3 }
        };

        // --- STATE ---
        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');

        targets.forEach(symbol => {
            this.assets[symbol] = {
                // Binance BookTicker data
                bidPrice: null,
                askPrice: null,
                bidSize: null,
                askSize: null,

                // Delta trade data
                deltaPrice: null,

                // Formula 0: EMA baseline
                emaBaseline: null,
                spreadHistory: [],

                // Formula 3: Move tracking
                moveStartPrice: null,
                edgeTriggeredAt: null,

                // Trade state
                lastSignalTime: 0,
                signalActive: false,
                pendingStopLoss: null
            };
        });

        // Symbol lookup for Delta WS messages
        this.symbolIndex = new Map();
        Object.keys(this.assets).forEach(k => {
            this.symbolIndex.set(k, k);
            this.symbolIndex.set(`${k}USD`, k);
            this.symbolIndex.set(`${k}USDT`, k);
            this.symbolIndex.set(`${k}-USD`, k);
        });

        this.stats = { signals: 0, binanceUpdates: 0, deltaTrades: 0 };
        this.pendingStopLoss = null;

        this.logger.info(`[Monument] Initialized | Fee: ${this.FEE * 100}% | EMA α: ${this.EMA_ALPHA} | Lag Threshold: ${this.LAG_RATIO_THRESHOLD}`);
    }

    getName() { return "MonumentStrategy"; }

    async start() {
        this.logger.info(`[Monument] 🟢 Ready — Watching ${Object.keys(this.assets).join(', ')}`);
        this.startPositionCheck();
    }

    // =========================================================================
    // DATA INGESTION
    // =========================================================================

    /**
     * Binance BookTicker feed (bidPrice, askPrice, bidSize, askSize)
     * Called via onDepthUpdate from trader.js
     * 
     * Rust BinanceListener passes: { s, bb, bq, ba, aq }
     *   s  = symbol (e.g., "BTC")
     *   bb = best bid price
     *   bq = best bid quantity
     *   ba = best ask price
     *   aq = best ask quantity
     */
    onDepthUpdate(update) {
        const symbol = update.s;
        if (!symbol) return;

        // Map Binance symbol to our asset key
        const asset = Object.keys(this.assets).find(k => symbol.toUpperCase().includes(k));
        if (!asset) return;

        const data = this.assets[asset];

        // Parse BookTicker fields (from Rust DepthUpdate struct)
        data.bidPrice = update.bb;
        data.askPrice = update.ba;
        data.bidSize = update.bq;
        data.askSize = update.aq;

        this.stats.binanceUpdates++;
        this.checkSignal(asset);
    }

    /**
     * Binance Trade feed (fallback if depth not available)
     */
    onBinanceTrade(update) {
        const symbol = update.s;
        const asset = Object.keys(this.assets).find(k => symbol.toUpperCase().includes(k));
        if (!asset) return;

        // If we don't have BookTicker, use trade price as both bid/ask
        const data = this.assets[asset];
        if (!data.bidPrice || !data.askPrice) {
            data.bidPrice = parseFloat(update.p);
            data.askPrice = parseFloat(update.p);
            data.bidSize = 1;
            data.askSize = 1;
        }

        this.checkSignal(asset);
    }

    /**
     * Delta Exchange trade feed
     */
    onLaggerTrade(trade) {
        if (!trade.symbol) return;

        const symbol = this.symbolIndex.get(trade.symbol) ||
            Object.keys(this.assets).find(k => trade.symbol.includes(k));
        if (!symbol) return;

        const data = this.assets[symbol];
        data.deltaPrice = parseFloat(trade.price);
        this.stats.deltaTrades++;

        this.checkSignal(symbol);
    }

    // =========================================================================
    // FORMULA 0: BASELINE SPREAD (EMA)
    // =========================================================================

    /**
     * P_Binance = (BidPrice + AskPrice) / 2
     * P_Delta = LastTradePrice
     * Spread_t = P_Binance - P_Delta
     * Baseline_t = α * Spread_t + (1-α) * Baseline_{t-1}
     * AdjustedEdge = Spread_t - Baseline_t
     */
    calculateFormula0(symbol) {
        const data = this.assets[symbol];
        if (!data.bidPrice || !data.askPrice || !data.deltaPrice) return null;

        // Binance mid price
        const pBinance = (data.bidPrice + data.askPrice) / 2;

        // Delta price (last trade)
        const pDelta = data.deltaPrice;

        // Raw spread
        const spread = pBinance - pDelta;

        // Update EMA baseline
        if (data.emaBaseline === null) {
            data.emaBaseline = spread;
        } else {
            data.emaBaseline = this.EMA_ALPHA * spread + (1 - this.EMA_ALPHA) * data.emaBaseline;
        }

        // Adjusted edge (spread minus structural baseline)
        const adjustedEdge = spread - data.emaBaseline;

        return { pBinance, pDelta, spread, baseline: data.emaBaseline, adjustedEdge };
    }

    // =========================================================================
    // FORMULA 1: EDGE SIGNAL & SIDE
    // =========================================================================

    /**
     * Edge% = (AdjustedEdge / P_Binance) × 100
     * 
     * Long Signal: Edge% > 0.06% → BUY Delta
     * Short Signal: Edge% < -0.06% → SELL Delta
     */
    calculateFormula1(adjustedEdge, pBinance) {
        const edgePct = (adjustedEdge / pBinance) * 100;

        let side = null;
        if (edgePct > this.FEE * 100) {
            side = 'buy';  // Delta is cheap, BUY on Delta
        } else if (edgePct < -(this.FEE * 100)) {
            side = 'sell'; // Delta is expensive, SELL on Delta
        }

        return { edgePct, side };
    }

    // =========================================================================
    // FORMULA 2: CHASE SAFETY FILTER
    // =========================================================================

    /**
     * Microprice = (AskSize × BidPrice + BidSize × AskPrice) / (BidSize + AskSize)
     * Midprice = (BidPrice + AskPrice) / 2
     * 
     * BUY requires: Microprice > Midprice (buy pressure exists)
     * SELL requires: Microprice < Midprice (sell pressure exists)
     */
    calculateFormula2(symbol) {
        const data = this.assets[symbol];
        if (!data.bidPrice || !data.askPrice || !data.bidSize || !data.askSize) return null;

        const midprice = (data.bidPrice + data.askPrice) / 2;
        const totalSize = data.bidSize + data.askSize;

        if (totalSize <= 0) return null;

        const microprice = (data.askSize * data.bidPrice + data.bidSize * data.askPrice) / totalSize;

        return { midprice, microprice };
    }

    // =========================================================================
    // FORMULA 3: REMAINING OPPORTUNITY
    // =========================================================================

    /**
     * When Formula 1 first triggers, store P_MoveStart = P_Binance
     * MoveSize = |P_Binance - P_MoveStart|
     * LagRatio = |AdjustedEdge| / MoveSize
     * 
     * Trade if LagRatio > 0.50 (Delta hasn't absorbed > 50% of move)
     */
    calculateFormula3(symbol, pBinance, adjustedEdge) {
        const data = this.assets[symbol];

        // Store move start price on first trigger
        if (data.moveStartPrice === null) {
            data.moveStartPrice = pBinance;
            data.edgeTriggeredAt = Date.now();
        }

        const moveSize = Math.abs(pBinance - data.moveStartPrice);

        // Avoid division by zero
        if (moveSize < 0.0001) return null;

        const lagRatio = Math.abs(adjustedEdge) / moveSize;

        return { moveSize, lagRatio, moveStartPrice: data.moveStartPrice };
    }

    // =========================================================================
    // MAIN SIGNAL CHECK
    // =========================================================================

    checkSignal(symbol) {
        const data = this.assets[symbol];

        // Formula 0: Calculate baseline spread
        const f0 = this.calculateFormula0(symbol);
        if (!f0) return;

        const { pBinance, pDelta, spread, baseline, adjustedEdge } = f0;

        // Formula 1: Determine edge and side
        const f1 = this.calculateFormula1(adjustedEdge, pBinance);
        const { edgePct, side } = f1;

        // Check cooldown
        const cooldownActive = Date.now() - data.lastSignalTime < this.COOLDOWN_MS;

        // If no edge, reset move tracking
        if (!side) {
            data.moveStartPrice = null;
            data.edgeTriggeredAt = null;
            return;
        }

        // Formula 2: Chase safety filter
        const f2 = this.calculateFormula2(symbol);
        if (!f2) return;

        const { midprice, microprice } = f2;

        // Check microprice confirms direction
        let flowConfirmed = false;
        if (side === 'buy') {
            flowConfirmed = microprice > midprice; // Buy pressure
        } else {
            flowConfirmed = microprice < midprice; // Sell pressure
        }

        if (!flowConfirmed) {
            // Reset move tracking if flow doesn't confirm
            data.moveStartPrice = null;
            data.edgeTriggeredAt = null;
            return;
        }

        // Formula 3: Remaining opportunity
        const f3 = this.calculateFormula3(symbol, pBinance, adjustedEdge);
        if (!f3) return;

        const { moveSize, lagRatio } = f3;

        if (lagRatio <= this.LAG_RATIO_THRESHOLD) {
            // Delta has absorbed too much of the move, skip
            data.moveStartPrice = null;
            data.edgeTriggeredAt = null;
            return;
        }

        // ALL FORMULAS PASSED — Execute trade
        if (!data.signalActive && !cooldownActive) {
            this.logger.info(`[Monument] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
            this.logger.info(`  Formula 0: Spread=${(spread * 100).toFixed(4)}% | Baseline=${(baseline * 100).toFixed(4)}% | AdjEdge=${(adjustedEdge * 100).toFixed(4)}%`);
            this.logger.info(`  Formula 1: Edge%=${(edgePct * 100).toFixed(4)}% > ${(this.FEE * 100).toFixed(2)}% ✅`);
            this.logger.info(`  Formula 2: Microprice=${microprice.toFixed(2)} vs Midprice=${midprice.toFixed(2)} ${side === 'buy' ? '>' : '<'} ✅`);
            this.logger.info(`  Formula 3: LagRatio=${lagRatio.toFixed(2)} > ${this.LAG_RATIO_THRESHOLD} ✅`);
            this.logger.info(`  [EXEC] Binance=${pBinance.toFixed(2)} | Delta=${pDelta.toFixed(2)} | MoveSize=${moveSize.toFixed(2)}`);

            this.executeTrade(symbol, side, pDelta);
            data.signalActive = true;
            data.lastSignalTime = Date.now();
            this.stats.signals++;
        }
    }

    // =========================================================================
    // EXECUTION
    // =========================================================================

    async executeTrade(symbol, side, price) {
        const spec = this.specs[symbol];
        if (!spec) return;

        if (this.bot.hasOpenPosition(symbol)) {
            this.logger.info(`[Monument] Skip ${symbol} - already in position`);
            return;
        }

        const data = this.assets[symbol];

        // Set position lock
        this.logger.info(`[Monument] POSITION LOCK: ${symbol} = true`);
        this.bot.activePositions[symbol] = true;

        const payload = {
            product_id: spec.deltaId.toString(),
            size: process.env.ORDER_SIZE || "1",
            side: side,
            order_type: 'market_order',
            client_order_id: `mon_${Date.now()}`
        };

        try {
            this.logger.info(`[Monument] ENTRY: ${side} ${payload.size} ${symbol} MARKET`);
            this.logger.info(`  [DEBUG] Binance=${this.assets[symbol].bidPrice} | Delta=${price}`);

            const t0 = process.hrtime.bigint();
            const result = await this.bot.placeOrder(payload);
            const t1 = process.hrtime.bigint();
            const totalMs = Number(t1 - t0) / 1e6;
            this.logger.info(`[TIMING] placeOrder total: ${totalMs.toFixed(2)}ms`);

            if (result && result.success) {
                this.logger.info(`[Monument] ✅ ORDER PLACED: ${symbol} ${side}`);
                if (result.result?.id) {
                    this.pendingStopLoss = { symbol, side, entryPrice: price, orderId: result.result.id };
                }
            } else {
                this.logger.error(`[Monument] ❌ ORDER FAILED: ${JSON.stringify(result)}`);
                this.logger.info(`[Monument] POSITION LOCK: ${symbol} = false (order failed)`);
                this.bot.activePositions[symbol] = false;
            }
        } catch (error) {
            this.logger.error(`[Monument] ❌ ORDER ERROR: ${error.message}`);
            this.logger.info(`[Monument] POSITION LOCK: ${symbol} = false (order error)`);
            this.bot.activePositions[symbol] = false;
        }
    }

    // =========================================================================
    // ORDER & POSITION HANDLERS
    // =========================================================================

    onOrderUpdate(order) {
        this.logger.info(`[Monument] ORDER: ${order.action} | state=${order.state} | reason=${order.reason} | side=${order.side}`);

        if (order.state === 'closed' && order.reason === 'fill') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (!symbol) return;

            if (order.side === 'sell' && this.bot.activePositions[symbol]) {
                this.logger.info(`[Monument] ✅ POSITION CLOSED: ${symbol}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;
            }
        }

        if (order.reason === 'stop_trigger') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (symbol) {
                this.logger.info(`[Monument] 🛑 STOP TRIGGERED: ${symbol}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;
            }
        }
    }

    onUserTrade(trade) {
        if (trade.reason !== 'normal') return;
        if (!trade.client_order_id || !trade.client_order_id.startsWith('mon_')) return;

        const symbol = this.symbolIndex.get(trade.symbol) ||
            Object.keys(this.assets).find(s => trade.symbol?.includes(s));
        if (!symbol) return;

        const spec = this.specs[symbol];
        if (!spec) return;

        if (this.pendingStopLoss && this.pendingStopLoss.symbol === symbol) {
            const fillPrice = parseFloat(trade.price);
            const side = this.pendingStopLoss.side;
            const trailAbs = (fillPrice * this.TRAILING_STOP_PCT).toFixed(spec.precision);
            const trailAmount = side === 'buy' ? `-${trailAbs}` : trailAbs;
            const stopSide = side === 'buy' ? 'sell' : 'buy';

            this.logger.info(`[Monument] 🎯 FILL: ${symbol} @ ${fillPrice}`);
            this.logger.info(`[Monument] Placing stop: side=${stopSide} trail=${trailAmount}`);

            this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                size: process.env.ORDER_SIZE || "1",
                side: stopSide,
                order_type: "market_order",
                stop_order_type: "stop_loss_order",
                trail_amount: trailAmount,
                stop_trigger_method: "last_traded_price",
                client_order_id: `mon_stop_${Date.now()}`
            }).then(result => {
                if (result && result.success) {
                    this.logger.info(`[Monument] ✅ STOP PLACED: ${symbol}`);
                } else {
                    this.logger.error(`[Monument] ❌ STOP FAILED: ${JSON.stringify(result)}`);
                }
            }).catch(err => {
                this.logger.error(`[Monument] ❌ STOP ERROR: ${err.message}`);
            });

            this.pendingStopLoss = null;
        }
    }

    onPositionClose(asset) {
        this.logger.info(`[Monument] POSITION CLOSED: ${asset} - resetting lock`);
        this.bot.activePositions[asset] = false;
        this.assets[asset].signalActive = false;
    }

    // =========================================================================
    // SAFETY: Position Check (every 3s)
    // =========================================================================

    startPositionCheck() {
        this.logger.info(`[Monument] Starting position check (every 3s)`);
        setInterval(async () => {
            try {
                const positions = await this.bot.client.getPositions();
                const openPositions = positions.result?.filter(p => parseFloat(p.size) !== 0) || [];

                if (openPositions.length === 0 && Object.values(this.bot.activePositions).some(v => v)) {
                    this.logger.info(`[Monument] 🔄 POSITION CLOSED detected via API - resetting locks`);
                    Object.keys(this.bot.activePositions).forEach(symbol => {
                        if (this.bot.activePositions[symbol]) {
                            this.logger.info(`[Monument] Unlocking ${symbol}`);
                            this.bot.activePositions[symbol] = false;
                            this.assets[symbol].signalActive = false;
                        }
                    });
                }
            } catch (e) {
                this.logger.error(`[Monument] Position check error: ${e.message}`);
            }
        }, 3000);
    }

    // No-op for unused callbacks
    onExchange1Quote(msg) {}
}

module.exports = MonumentStrategy;
