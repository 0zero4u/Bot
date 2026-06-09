/**
 * ============================================================================
 * MOMENTUM SIMPLE STRATEGY
 * Cross-exchange arbitrage: Binance (reference) → Delta Exchange (execution)
 * ============================================================================
 * 
 * FEE STRUCTURE (Delta Exchange - India) — VERIFIED 2026-06-09:
 *   - Standard taker fee: 0.05% per side
 *   - Scalper offer: 0% closing fee (opening fee only)
 *   - Round trip cost: 0.05% (opening) + 0% (closing) = 0.05%
 *   - TRADING_FEE = 0.0005 (0.05%) — use for PNL calculation
 *
 * MONUMENT_FEE (signal threshold):
 *   - Set HIGHER than actual fees to filter for larger edges
 *   - Current: 0.0008 (0.08%) — only trade when edge > 0.08%
 *   - This is a SIGNAL FILTER, not the actual fee
 *
 * ROE CALCULATION (with leverage):
 *   - Price move % = (exit - entry) / entry × 100
 *   - Net PNL = Price move % - TRADING_FEE (0.05%)
 *   - ROE = Net PNL × leverage (e.g., 100x)
 *   - Example: Entry 1.1641, Exit 1.1650 = +0.0773% price move
 *   - Net PNL = 0.0773% - 0.05% = +0.0273%
 *   - ROE (100x) = 0.0273% × 100 = +2.73%
 *
 * DELTA EXCHANGE BRACKET ORDERS (VERIFIED via live API 2026-06-09):
 *   - bracket_trail_amount is ABSOLUTE price, NOT percentage
 *   - XRPUSD tick_size = 0.0001 (verified via API: api.india.delta.exchange)
 *   - Sign convention: NEGATIVE for buy, POSITIVE for sell
 *   - Trail calculated dynamically: 0.02% of entry price, rounded to tick
 *
 * FORMULA 0: Baseline Spread (EMA) — Remove structural premium/discount
 * FORMULA 1: Edge Signal & Side — Determine if edge exceeds MONUMENT_FEE
 * 
 * Final: Trade only when dislocation > MONUMENT_FEE (signal threshold).
 */

class MomentumSimpleStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.FEE = parseFloat(process.env.MONUMENT_FEE || '0.0005');  // Signal threshold (edge must exceed this)
        this.TRADING_FEE = 0.0005;  // Actual round-trip fee: 0.05% (scalper offer: 0% closing fee)
        this.EMA_ALPHA = 0.02;
        this.COOLDOWN_MS = 30000;
        
        // Delta Exchange bracket_trail_amount is ABSOLUTE price, NOT percentage
        // Sign convention: NEGATIVE for buy, POSITIVE for sell (verified via live API)
        // Trail = 0.02% of entry price (dynamic, calculated per trade)
        this.TRAILING_STOP_PCT = 0.0002;  // 0.02% trailing stop
        // TICK_SIZE is now per-asset in specs

        // --- ASSET SPECS ---
        this.specs = {
            'BTC': { deltaId: 27, precision: 1, tickSize: 0.1 },
            'ETH': { deltaId: 299, precision: 2, tickSize: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, tickSize: 0.0001 },
            'SOL': { deltaId: 417, precision: 3, tickSize: 0.001 },
            'DOGE': { deltaId: 14745, precision: 6, tickSize: 0.000001 }
        };

        // --- STATE ---
        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        this.peakEdge = 0;
        this.peakEdgeTime = null;
        this.lastPeakLogThreshold = 0;

        targets.forEach(symbol => {
            this.assets[symbol] = {
                bidPrice: null,
                askPrice: null,
                bidSize: null,
                askSize: null,
                deltaPrice: null,
                lastDeltaTradeTime: null,
                emaBaseline: null,
                lastSignalTime: 0,
                signalActive: false
            };
        });

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
    }

    onBinanceTrade(update) {
        const symbol = update.s;
        const asset = Object.keys(this.assets).find(k => symbol.toUpperCase().includes(k));
        if (!asset) return;

        const data = this.assets[asset];
        if (!data.bidPrice || !data.askPrice) {
            data.bidPrice = parseFloat(update.p);
            data.askPrice = parseFloat(update.p);
            data.bidSize = 1;
            data.askSize = 1;
        }
        this.checkSignal(asset);
    }

    onLaggerTrade(trade) {
        if (!trade.symbol) return;

        const symbol = this.symbolIndex.get(trade.symbol) ||
            Object.keys(this.assets).find(k => trade.symbol.includes(k));
        if (!symbol) return;

        const data = this.assets[symbol];
        data.deltaPrice = parseFloat(trade.price);
        data.lastDeltaTradeTime = Date.now();
        this.stats.deltaTrades++;
        this.checkSignal(symbol);
    }

    // =========================================================================
    // FORMULA 0: BASELINE SPREAD (EMA)
    // =========================================================================

    calculateFormula0(symbol) {
        const data = this.assets[symbol];
        if (!data.bidPrice || !data.askPrice || !data.deltaPrice) return null;

        const pBinance = (data.bidPrice + data.askPrice) / 2;
        const pDelta = data.deltaPrice;
        const spread = pBinance - pDelta;

        if (data.emaBaseline === null) {
            data.emaBaseline = spread;
        } else {
            data.emaBaseline = this.EMA_ALPHA * spread + (1 - this.EMA_ALPHA) * data.emaBaseline;
        }

        const adjustedEdge = spread - data.emaBaseline;
        return { pBinance, pDelta, spread, baseline: data.emaBaseline, adjustedEdge };
    }

    // =========================================================================
    // FORMULA 1: EDGE SIGNAL & SIDE
    // =========================================================================

    calculateFormula1(adjustedEdge, pBinance) {
        const edgePct = (adjustedEdge / pBinance) * 100;

        let side = null;
        if (edgePct > this.FEE * 100) {
            side = 'buy';
        } else if (edgePct < -(this.FEE * 100)) {
            side = 'sell';
        }

        return { edgePct, side };
    }

    // =========================================================================
    // MAIN SIGNAL CHECK
    // =========================================================================

    checkSignal(symbol) {
        const data = this.assets[symbol];

        if (!data.bidPrice || !data.askPrice || !data.deltaPrice) {
            this._logMissing(symbol, data);
            return;
        }

        const f0 = this.calculateFormula0(symbol);
        if (!f0) return;

        const { pBinance, pDelta, spread, baseline, adjustedEdge } = f0;

        const f1 = this.calculateFormula1(adjustedEdge, pBinance);
        const { edgePct, side } = f1;

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

        this._statusCount = (this._statusCount || 0) + 1;
        if (this._statusCount % 500 === 0) {
            const blocker = !side ? `edge ${edgePct.toFixed(4)}% < ${this.FEE * 100}% fee` : 'checking...';
            const peakAge = this.peakEdgeTime ? `${Math.round((Date.now() - this.peakEdgeTime) / 1000)}s ago` : 'none';
            this.logger.info(`[MomentumSimple] ${symbol} | Binance=${pBinance.toFixed(4)} Delta=${pDelta.toFixed(4)} | Edge=${edgePct.toFixed(4)}% | Peak=${this.peakEdge.toFixed(4)}% (${peakAge}) | Blocker: ${blocker}`);
        }

        const cooldownActive = Date.now() - data.lastSignalTime < this.COOLDOWN_MS;

        if (!side) return;

        this.logger.info(`[MomentumSimple] ✅ F1 PASSED: ${symbol} ${side.toUpperCase()} edge=${edgePct.toFixed(4)}% (fee=${this.FEE * 100}%)`);

        if (!data.signalActive && !cooldownActive) {
            this.logger.info(`[MomentumSimple] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
            this.logger.info(`  Formula 0: Spread=${(spread * 100).toFixed(4)}% | Baseline=${(baseline * 100).toFixed(4)}% | AdjEdge=${(adjustedEdge * 100).toFixed(4)}%`);
            this.logger.info(`  Formula 1: Edge=${edgePct.toFixed(4)}% > ${this.FEE * 100}% fee ✅`);
            this.logger.info(`  [EXEC] Binance=${pBinance.toFixed(4)} | Delta=${pDelta.toFixed(4)}`);

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
            this.logger.info(`[MomentumSimple] Skip ${symbol} - already in position`);
            return;
        }

        const data = this.assets[symbol];

        this.logger.info(`[MomentumSimple] POSITION LOCK: ${symbol} = true`);
        this.bot.activePositions[symbol] = true;
        this.lastTradeSide = side;
        this.lastTradeEntryPrice = price;
        this.lastTradeSignalId = `mom_${Date.now()}`;

        // Calculate trail amount dynamically: 0.02% of entry price, rounded to tick
        const trailAbs = price * this.TRAILING_STOP_PCT;
        const tickSize = spec.tickSize || 0.0001;
        const trailTicks = Math.round(trailAbs / tickSize);
        const trailAmount = (trailTicks * tickSize).toFixed(spec.precision || 4);
        
        // Sign convention: NEGATIVE for buy, POSITIVE for sell
        const signedTrail = side === 'buy' ? `-${trailAmount}` : trailAmount;
        
        const payload = {
            product_id: spec.deltaId.toString(),
            size: process.env.ORDER_SIZE || "1",
            side: side,
            order_type: 'market_order',
            client_order_id: this.lastTradeSignalId,
            bracket_trail_amount: signedTrail,
            bracket_stop_trigger_method: 'last_traded_price'
        };

        try {
            this.logger.info(`[MomentumSimple] ENTRY: ${side} ${payload.size} ${symbol} MARKET`);
            this.logger.info(`  [DEBUG] Binance=${data.bidPrice} | Delta=${price} | Trail=${signedTrail} (${(this.TRAILING_STOP_PCT * 100).toFixed(2)}%)`);
            
            const t0 = process.hrtime.bigint();
            const result = await this.bot.placeOrder(payload);
            const t1 = process.hrtime.bigint();
            const totalMs = Number(t1 - t0) / 1e6;
            this.logger.info(`[TIMING] placeOrder total: ${totalMs.toFixed(2)}ms`);

            if (result && result.success) {
                this.logger.info(`[MomentumSimple] ✅ ORDER PLACED: ${symbol} ${side} (trail=${signedTrail})`);
            } else {
                this.logger.error(`[MomentumSimple] ❌ ORDER FAILED: ${JSON.stringify(result)}`);
                this.logger.info(`[MomentumSimple] POSITION LOCK: ${symbol} = false (order failed)`);
                this.bot.activePositions[symbol] = false;
                this.lastTradeSignalId = null;
                this.lastTradeEntryPrice = null;
                this.lastTradeSide = null;
            }
        } catch (error) {
            this.logger.error(`[MomentumSimple] ❌ ORDER ERROR: ${error.message}`);
            this.logger.info(`[MomentumSimple] POSITION LOCK: ${symbol} = false (order error)`);
            this.bot.activePositions[symbol] = false;
            this.lastTradeSignalId = null;
            this.lastTradeEntryPrice = null;
            this.lastTradeSide = null;
        }
    }

    // =========================================================================
    // ORDER & POSITION HANDLERS
    // =========================================================================

    onOrderUpdate(order) {
        this.logger.info(`[MomentumSimple] ORDER: ${order.action} | state=${order.state} | reason=${order.reason} | side=${order.side}`);

        if (order.reason === 'stop_create') {
            this.logger.info(`[MomentumSimple] 🛑 STOP CREATED: ${order.side} bracket order`);
        }

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
                    let priceMove = 0;
                    if (exitPrice > 0 && entryPrice > 0) {
                        priceMove = side === 'buy'
                            ? (exitPrice - entryPrice) / entryPrice
                            : (entryPrice - exitPrice) / entryPrice;
                        pnl = priceMove - this.TRADING_FEE;
                    }
                    const leverage = parseFloat(process.env.LEVERAGE || '100');
                    const roe = priceMove * leverage;
                    this.logger.info(`[MomentumSimple] TRADE OUTCOME: ${symbol} ${side} entry=${entryPrice} exit=${exitPrice} priceMove=${(priceMove * 100).toFixed(4)}% pnl=${(pnl * 100).toFixed(4)}% roe=${roe.toFixed(2)}%`);
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
                    let priceMove = 0;
                    if (exitPrice > 0 && entryPrice > 0) {
                        priceMove = side === 'buy'
                            ? (exitPrice - entryPrice) / entryPrice
                            : (entryPrice - exitPrice) / entryPrice;
                        pnl = priceMove - this.TRADING_FEE;
                    }
                    const leverage = parseFloat(process.env.LEVERAGE || '100');
                    const roe = priceMove * leverage;
                    this.logger.info(`[MomentumSimple] TRADE OUTCOME: ${symbol} ${side} entry=${entryPrice} exit=${exitPrice} priceMove=${(priceMove * 100).toFixed(4)}% pnl=${(pnl * 100).toFixed(4)}% roe=${roe.toFixed(2)}%`);
                }

                this.lastTradeSignalId = null;
                this.lastTradeEntryPrice = null;
                this.lastTradeSide = null;
            }
        }

        if (order.reason === 'cancelled_by_user') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (symbol) {
                this.logger.info(`[MomentumSimple] ⚠️ BRACKET CANCELLED: ${symbol} - resetting position lock`);
                this.bot.activePositions[symbol] = false;
                this.assets[symbol].signalActive = false;
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
    // SAFETY: Position Check (every 3s)
    // =========================================================================

    startPositionCheck() {
        this.logger.info(`[MomentumSimple] Starting position check (every 3s)`);
        setInterval(async () => {
            try {
                const positions = await this.bot.client.getPositions();
                const openPositions = positions.result?.filter(p => parseFloat(p.size) !== 0) || [];

                if (openPositions.length === 0 && Object.values(this.bot.activePositions).some(v => v)) {
                    this.logger.info(`[MomentumSimple] 🔄 POSITION CLOSED detected via API - resetting locks`);
                    Object.keys(this.bot.activePositions).forEach(symbol => {
                        if (this.bot.activePositions[symbol]) {
                            this.logger.info(`[MomentumSimple] Unlocking ${symbol}`);
                            this.bot.activePositions[symbol] = false;
                            this.assets[symbol].signalActive = false;
                        }
                    });
                }
            } catch (e) {
                this.logger.error(`[MomentumSimple] Position check error: ${e.message}`);
            }
        }, 3000);
    }
}

module.exports = MomentumSimpleStrategy;
