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
        this.FEE = 0.0005;                    // Delta round-trip fee: 0.05% threshold
        this.EMA_ALPHA = 0.02;                // EMA smoothing factor
        this.LAG_RATIO_THRESHOLD = 0.50;      // Formula 3: Min remaining opportunity
        this.COOLDOWN_MS = 30000;             // 30s cooldown between trades
        this.TRAILING_STOP_PCT = 0.0002;      // 0.02% trailing stop
        this.REQUIRE_FLOW_CONFIRMATION = false; // F2: disabled for testing
        this.REQUIRE_MOVE_TRACKING = true;     // F3: keep enabled to debug

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
        this.peakEdge = 0;
        this.peakEdgeTime = null;
        this.lastPeakLogThreshold = 0;

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
                moveStartSpread: null,
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

    _logMissing(symbol, data) {
        this._missingCount = (this._missingCount || 0) + 1;
        if (this._missingCount % 1000 === 0) {
            const missing = [];
            if (!data.bidPrice) missing.push('Binance bid');
            if (!data.askPrice) missing.push('Binance ask');
            if (!data.deltaPrice) missing.push('Delta price');
            this.logger.warn(`[Monument] ${symbol} waiting for: ${missing.join(', ')}`);
        }
    }

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

        // Track SPREAD movement, not Binance price
        // spread = pBinance - pDelta (but we use adjustedEdge which is already normalized)
        if (data.moveStartSpread === null) {
            data.moveStartSpread = adjustedEdge;
            data.edgeTriggeredAt = Date.now();
            this.logger.debug(`[F3] ${symbol} | Set moveStartSpread=${(adjustedEdge * 100).toFixed(4)}%`);
        }

        // How much has the spread changed since we first detected edge?
        const spreadMove = Math.abs(adjustedEdge - data.moveStartSpread);

        // Debug: show spread movement
        this.logger.debug(`[F3] ${symbol} | adjEdge=${(adjustedEdge * 100).toFixed(4)}% moveStart=${(data.moveStartSpread * 100).toFixed(4)}% spreadMove=${(spreadMove * 100).toFixed(6)}% (need > 0.0001)`);

        // If spread hasn't moved enough, skip
        if (spreadMove < 0.000001) return null;

        const lagRatio = Math.abs(adjustedEdge) / spreadMove;

        return { moveSize: spreadMove, lagRatio, moveStartPrice: data.moveStartSpread };
    }

    // =========================================================================
    // MAIN SIGNAL CHECK
    // =========================================================================

    checkSignal(symbol) {
        const data = this.assets[symbol];

        // Need both Binance and Delta prices
        if (!data.bidPrice || !data.askPrice || !data.deltaPrice) {
            this._logMissing(symbol, data);
            return;
        }

        // Formula 0: Calculate baseline spread
        const f0 = this.calculateFormula0(symbol);
        if (!f0) return;

        const { pBinance, pDelta, spread, baseline, adjustedEdge } = f0;

        // Formula 1: Determine edge and side
        const f1 = this.calculateFormula1(adjustedEdge, pBinance);
        const { edgePct, side } = f1;

        // Track peak edge - only log at 0.02%, 0.04%, 0.06%, 0.08%
        if (Math.abs(edgePct) > Math.abs(this.peakEdge)) {
            this.peakEdge = edgePct;
            this.peakEdgeTime = Date.now();
            
            const absEdge = Math.abs(edgePct);
            const threshold = absEdge >= 0.08 ? 0.08 : absEdge >= 0.06 ? 0.06 : absEdge >= 0.04 ? 0.04 : 0.02;
            if (threshold > this.lastPeakLogThreshold) {
                this.lastPeakLogThreshold = threshold;
                this.logger.info(`[Monument] 🔺 PEAK EDGE: ${edgePct.toFixed(4)}% (spread=${(spread*100).toFixed(4)}%)`);
            }
        }

        // Periodic status logging (every 10s) - shows why no signal
        this._statusCount = (this._statusCount || 0) + 1;
        if (this._statusCount % 500 === 0) {
            const blocker = !side ? `edge ${edgePct.toFixed(4)}% < ${this.FEE * 100}% fee` : 'checking...';
            const peakAge = this.peakEdgeTime ? `${Math.round((Date.now() - this.peakEdgeTime) / 1000)}s ago` : 'none';
            this.logger.info(`[Monument] ${symbol} | Binance=${pBinance.toFixed(4)} Delta=${pDelta.toFixed(4)} | Edge=${edgePct.toFixed(4)}% | Peak=${this.peakEdge.toFixed(4)}% (${peakAge}) | Blocker: ${blocker}`);
        }

        // Check cooldown
        const cooldownActive = Date.now() - data.lastSignalTime < this.COOLDOWN_MS;

        // If no edge, reset move tracking
        if (!side) {
            data.moveStartSpread = null;
            data.edgeTriggeredAt = null;
            return;
        }

        // F1 PASSED - log it
        this.logger.info(`[Monument] ✅ F1 PASSED: ${symbol} ${side.toUpperCase()} edge=${edgePct.toFixed(4)}% (fee=${this.FEE * 100}%)`);

        // Formula 2: Chase safety filter
        const f2 = this.calculateFormula2(symbol);
        if (!f2) return;

        const { midprice, microprice } = f2;

        // Check microprice confirms direction
        let flowConfirmed = true;
        if (this.REQUIRE_FLOW_CONFIRMATION) {
            if (side === 'buy') {
                flowConfirmed = microprice > midprice;
            } else {
                flowConfirmed = microprice < midprice;
            }
        }

        if (!flowConfirmed) {
            this.logger.info(`[Monument] ${symbol} | Edge=${edgePct.toFixed(4)}% OK but F2 blocked: micro=${microprice.toFixed(4)} vs mid=${midprice.toFixed(4)}`);
            data.moveStartSpread = null;
            data.edgeTriggeredAt = null;
            return;
        }

        // F2 passed - log
        this.logger.debug(`[Monument] F2 passed: micro=${microprice.toFixed(4)} mid=${midprice.toFixed(4)}`);

        // Formula 3: Remaining opportunity
        const f3 = this.calculateFormula3(symbol, pBinance, adjustedEdge);
        if (!f3) {
            this.logger.info(`[Monument] ${symbol} | F1+F2 OK but F3 null (moveSize too small)`);
            return;
        }

        const { moveSize, lagRatio } = f3;

        if (lagRatio <= this.LAG_RATIO_THRESHOLD) {
            this.logger.info(`[Monument] ${symbol} | Edge OK, F2 OK, but F3 blocked: LagRatio=${lagRatio.toFixed(2)} <= ${this.LAG_RATIO_THRESHOLD}`);
            data.moveStartSpread = null;
            data.edgeTriggeredAt = null;
            return;
        }

        // ALL FORMULAS PASSED — Execute trade
        if (!data.signalActive && !cooldownActive) {
            this.logger.info(`[Monument] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
            this.logger.info(`  Formula 0: Spread=${(spread * 100).toFixed(4)}% | Baseline=${(baseline * 100).toFixed(4)}% | AdjEdge=${(adjustedEdge * 100).toFixed(4)}%`);
            this.logger.info(`  Formula 1: Edge=${edgePct.toFixed(4)}% > ${this.FEE * 100}% fee ✅`);
            this.logger.info(`  Formula 2: Microprice=${microprice.toFixed(4)} vs Midprice=${midprice.toFixed(4)} ${side === 'buy' ? '>' : '<'} ✅`);
            this.logger.info(`  Formula 3: LagRatio=${lagRatio.toFixed(2)} > ${this.LAG_RATIO_THRESHOLD} ✅`);
            this.logger.info(`  [EXEC] Binance=${pBinance.toFixed(4)} | Delta=${pDelta.toFixed(4)} | MoveSize=${moveSize.toFixed(4)}`);

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

        this.logger.info(`[Monument] POSITION LOCK: ${symbol} = true`);
        this.bot.activePositions[symbol] = true;

        // Calculate bracket trail amount (negative for buy, positive for sell)
        const trailAbs = price * this.TRAILING_STOP_PCT;
        const trailAmount = side === 'buy' 
            ? (-trailAbs).toFixed(spec.precision)
            : trailAbs.toFixed(spec.precision);
        
        const payload = {
            product_id: spec.deltaId.toString(),
            size: process.env.ORDER_SIZE || "1",
            side: side,
            order_type: 'market_order',
            client_order_id: `mon_${Date.now()}`,
            bracket_trail_amount: trailAmount,
            bracket_stop_trigger_method: 'last_traded_price'
        };

        try {
            this.logger.info(`[Monument] ENTRY: ${side} ${payload.size} ${symbol} MARKET`);
            this.logger.info(`  [DEBUG] Binance=${data.bidPrice} | Delta=${price} | Trail=${trailAmount}`);
            
            const t0 = process.hrtime.bigint();
            const result = await this.bot.placeOrder(payload);
            const t1 = process.hrtime.bigint();
            const totalMs = Number(t1 - t0) / 1e6;
            this.logger.info(`[TIMING] placeOrder total: ${totalMs.toFixed(2)}ms`);

            if (result && result.success) {
                this.logger.info(`[Monument] ✅ ORDER PLACED: ${symbol} ${side} (trail=${trailAmount})`);
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
        // Bracket orders handle SL atomically - no separate stop placement needed
        if (trade.reason !== 'normal') return;
        if (!trade.client_order_id || !trade.client_order_id.startsWith('mon_')) return;

        const symbol = this.symbolIndex.get(trade.symbol) ||
            Object.keys(this.assets).find(s => trade.symbol?.includes(s));
        if (!symbol) return;

        this.logger.info(`[Monument] 🎯 FILL: ${symbol} @ ${trade.price}`);
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
