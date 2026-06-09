/**
 * ============================================================================
 * MOMENTUM SIMPLE STRATEGY
 * Cross-exchange arbitrage: Binance (reference) → Delta Exchange (execution)
 * ============================================================================
 * 
 * FEE STRUCTURE (Delta Exchange - India):
 *   - Taker fee: 0.05% per side
 *   - Scalper offer: 0% closing fee (opening fee only)
 *   - Round trip cost: 0.05% (opening) + 0% (closing) = 0.05%
 *   - MONUMENT_FEE should be set to 0.0005 (0.05% one-way)
 *
 * FORMULA 0: Baseline Spread (EMA) — Remove structural premium/discount
 * FORMULA 1: Edge Signal & Side — Determine if edge exceeds 0.05% fee
 * 
 * Final: Trade only when dislocation > 0.05% fee.
 */

class MomentumSimpleStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        // FEE: Delta taker fee = 0.05% per side, scalper offer = 0% closing
        // MONUMENT_FEE should be 0.0005 (0.05% one-way opening fee)
        // F1 passes when edge > FEE (i.e., edge > 0.05%)
        this.FEE = parseFloat(process.env.MONUMENT_FEE || '0.0005');
        this.EMA_ALPHA = 0.2;
        this.COOLDOWN_MS = 30000;
        
        // --- TRAILING STOP ---
        // Delta Exchange bracket_trail_amount is ABSOLUTE price, NOT percentage
        // XRPUSD tick_size = 0.0001 (verified via API)
        // 1 tick at $1.1672 = 0.00857% (approximately 3x smaller than 0.025% fee)
        // Sign convention: POSITIVE for buy, NEGATIVE for sell (per Delta docs)
        this.TRAILING_STOP_AMOUNT = '0.0001';  // 1 tick = ~0.00857%

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
                lastDeltaTradeTime: null,
                lastDeltaUpdate: null,

                // Formula 0: EMA baseline
                emaBaseline: null,

                // Trade state
                lastSignalTime: 0,
                signalActive: false
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
        this.lastTradeSignalId = null;
        this.lastTradeEntryPrice = null;
        this.lastTradeSide = null;

        this.logger.info(`[MomentumSimple] Initialized | Fee: ${this.FEE * 100}% | EMA α: ${this.EMA_ALPHA}`);
    }

    getName() { return "MomentumSimpleStrategy"; }

    _logMissing(symbol, data) {
        this._missingCount = (this._missingCount || 0) + 1;
        if (this._missingCount % 1000 === 0) {
            const missing = [];
            if (!data.bidPrice) missing.push('Binance bid');
            if (!data.askPrice) missing.push('Binance ask');
            if (!data.deltaPrice) missing.push('Delta price');
            this.logger.warn(`[MomentumSimple] ${symbol} waiting for: ${missing.join(', ')}`);
        }
    }

    async start() {
        this.logger.info(`[MomentumSimple] 🟢 Ready — Watching ${Object.keys(this.assets).join(', ')}`);
    }

    // =========================================================================
    // DATA INGESTION
    // =========================================================================

    /**
     * Binance BookTicker feed (bidPrice, askPrice, bidSize, askSize)
     * Called via onDepthUpdate from trader.js
     */
    onDepthUpdate(update) {
        const symbol = update.s;
        if (!symbol) return;

        const asset = Object.keys(this.assets).find(k => symbol.toUpperCase().includes(k));
        if (!asset) return;

        const data = this.assets[asset];

        data.bidPrice = update.bb;
        data.askPrice = update.ba;
        data.bidSize = update.bq;
        data.askSize = update.aq;

        this.stats.binanceUpdates++;
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
        data.lastDeltaTradeTime = Date.now();
        data.lastDeltaUpdate = Date.now();
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
     * Long Signal: Edge% > 0.05% → BUY Delta
     * Short Signal: Edge% < -0.05% → SELL Delta
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
                this.logger.info(`[MomentumSimple] 🔺 PEAK EDGE: ${edgePct.toFixed(4)}% (spread=${(spread*100).toFixed(4)}%)`);
            }
        }

        // Periodic status logging (every 10s) - shows why no signal
        this._statusCount = (this._statusCount || 0) + 1;
        if (this._statusCount % 500 === 0) {
            const blocker = !side ? `edge ${edgePct.toFixed(4)}% < ${this.FEE * 100}% fee` : 'checking...';
            const peakAge = this.peakEdgeTime ? `${Math.round((Date.now() - this.peakEdgeTime) / 1000)}s ago` : 'none';
            this.logger.info(`[MomentumSimple] ${symbol} | Binance=${pBinance.toFixed(4)} Delta=${pDelta.toFixed(4)} | Edge=${edgePct.toFixed(4)}% | Peak=${this.peakEdge.toFixed(4)}% (${peakAge}) | Blocker: ${blocker}`);
        }

        // Check cooldown
        const cooldownActive = Date.now() - data.lastSignalTime < this.COOLDOWN_MS;

        // If no edge, return
        if (!side) {
            return;
        }

        // F1 PASSED - log it
        this.logger.info(`[MomentumSimple] ✅ F1 PASSED: ${symbol} ${side.toUpperCase()} edge=${edgePct.toFixed(4)}% (fee=${this.FEE * 100}%)`);

        // Execute trade
        if (!data.signalActive && !cooldownActive) {
            const signalId = Date.now();
            this.logger.info(`[MomentumSimple] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
            this.logger.info(`  Formula 0: Spread=${(spread * 100).toFixed(4)}% | Baseline=${(baseline * 100).toFixed(4)}% | AdjEdge=${(adjustedEdge * 100).toFixed(4)}%`);
            this.logger.info(`  Formula 1: Edge=${edgePct.toFixed(4)}% > ${this.FEE * 100}% fee ✅`);
            this.logger.info(`  [EXEC] Binance=${pBinance.toFixed(4)} | Delta=${pDelta.toFixed(4)}`);

            this.executeTrade(symbol, side, pDelta, signalId);
            data.signalActive = true;
            data.lastSignalTime = Date.now();
            this.stats.signals++;
        }
    }

    // =========================================================================
    // EXECUTION
    // =========================================================================

    async executeTrade(symbol, side, price, signalId) {
        const spec = this.specs[symbol];
        if (!spec) return;

        if (this.bot.hasOpenPosition(symbol)) {
            this.logger.info(`[MomentumSimple] Skip ${symbol} - already in position`);
            return;
        }

        const data = this.assets[symbol];

        this.logger.info(`[MomentumSimple] POSITION LOCK: ${symbol} = true`);
        this.bot.activePositions[symbol] = true;
        this.lastTradeSignalId = signalId;
        this.lastTradeSide = side;

        // Calculate bracket trail amount
        // Delta Exchange sign convention: POSITIVE for buy, NEGATIVE for sell
        // trail_amount is ABSOLUTE price (not percentage)
        // XRPUSD tick_size = 0.0001 (minimum viable trail)
        const trailAmount = side === 'buy' 
            ? this.TRAILING_STOP_AMOUNT
            : `-${this.TRAILING_STOP_AMOUNT}`;
        
        const payload = {
            product_id: spec.deltaId.toString(),
            size: process.env.ORDER_SIZE || "1",
            side: side,
            order_type: 'market_order',
            client_order_id: `mom_${Date.now()}`,
            bracket_trail_amount: trailAmount,
            bracket_stop_trigger_method: 'last_traded_price'
        };

        try {
            this.logger.info(`[MomentumSimple] ENTRY: ${side} ${payload.size} ${symbol} MARKET`);
            this.logger.info(`  [DEBUG] Binance=${data.bidPrice} | Delta=${price} | Trail=${trailAmount}`);
            
            const t0 = process.hrtime.bigint();
            const result = await this.bot.placeOrder(payload);
            const t1 = process.hrtime.bigint();
            const totalMs = Number(t1 - t0) / 1e6;
            this.logger.info(`[TIMING] placeOrder total: ${totalMs.toFixed(2)}ms`);

            if (result && result.success) {
                this.logger.info(`[MomentumSimple] ✅ ORDER PLACED: ${symbol} ${side} (trail=${trailAmount})`);
            } else {
                this.logger.error(`[MomentumSimple] ❌ ORDER FAILED: ${JSON.stringify(result)}`);
                this.logger.info(`[MomentumSimple] POSITION LOCK: ${symbol} = false (order failed)`);
                this.bot.activePositions[symbol] = false;
            }
        } catch (error) {
            this.logger.error(`[MomentumSimple] ❌ ORDER ERROR: ${error.message}`);
            this.logger.info(`[MomentumSimple] POSITION LOCK: ${symbol} = false (order error)`);
            this.bot.activePositions[symbol] = false;
        }
    }

    // =========================================================================
    // ORDER & POSITION HANDLERS
    // =========================================================================

    onOrderUpdate(order) {
        this.logger.info(`[MomentumSimple] ORDER: ${order.action} | state=${order.state} | reason=${order.reason} | side=${order.side}`);

        if (order.state === 'closed' && order.reason === 'fill') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (!symbol) return;

            if (order.side === 'sell' && this.bot.activePositions[symbol]) {
                this.logger.info(`[MomentumSimple] ✅ POSITION CLOSED: ${symbol}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;

                if (this.lastTradeSignalId && this.lastTradeEntryPrice) {
                    const exitPrice = parseFloat(order.price || order.avg_price || 0);
                    const entryPrice = this.lastTradeEntryPrice;
                    const side = this.lastTradeSide;
                    let pnl = 0;
                    if (exitPrice > 0 && entryPrice > 0) {
                        pnl = side === 'buy'
                            ? (exitPrice - entryPrice) / entryPrice
                            : (entryPrice - exitPrice) / entryPrice;
                        pnl -= this.FEE * 2;
                    }
                    this.logger.info(`[MomentumSimple] TRADE OUTCOME: ${symbol} ${side} entry=${entryPrice} exit=${exitPrice} pnl=${(pnl * 100).toFixed(4)}%`);
                }

                this.lastTradeSignalId = null;
                this.lastTradeEntryPrice = null;
                this.lastTradeSide = null;
            }
        }

        if (order.reason === 'stop_trigger') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (symbol) {
                this.logger.info(`[MomentumSimple] 🛑 STOP TRIGGERED: ${symbol}`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;

                if (this.lastTradeSignalId && this.lastTradeEntryPrice) {
                    const exitPrice = parseFloat(order.price || order.stop_price || 0);
                    const entryPrice = this.lastTradeEntryPrice;
                    const side = this.lastTradeSide;
                    let pnl = 0;
                    if (exitPrice > 0 && entryPrice > 0) {
                        pnl = side === 'buy'
                            ? (exitPrice - entryPrice) / entryPrice
                            : (entryPrice - exitPrice) / entryPrice;
                        pnl -= this.FEE * 2;
                    }
                    this.logger.info(`[MomentumSimple] TRADE OUTCOME: ${symbol} ${side} entry=${entryPrice} exit=${exitPrice} pnl=${(pnl * 100).toFixed(4)}%`);
                }

                this.lastTradeSignalId = null;
                this.lastTradeEntryPrice = null;
                this.lastTradeSide = null;
            }
        }
    }

    onUserTrade(trade) {
        if (trade.reason !== 'normal') return;
        if (!trade.client_order_id || !trade.client_order_id.startsWith('mom_')) return;

        const symbol = this.symbolIndex.get(trade.symbol) ||
            Object.keys(this.assets).find(s => trade.symbol?.includes(s));
        if (!symbol) return;

        this.logger.info(`[MomentumSimple] 🎯 FILL: ${symbol} @ ${trade.price}`);
        this.lastTradeEntryPrice = parseFloat(trade.price);
    }

    onPositionClose(asset) {
        this.logger.info(`[MomentumSimple] POSITION CLOSED: ${asset} - resetting lock`);
        this.bot.activePositions[asset] = false;
        this.assets[asset].signalActive = false;
    }

    // =========================================================================
    // POSITION CHECK
    // =========================================================================

    startPositionCheck() {
        // Periodic position sync (optional)
    }
}

module.exports = MomentumSimpleStrategy;
