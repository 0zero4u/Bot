/**
 * ============================================================================
 * MONUMENT STRATEGY
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
 * FORMULA 2: Chase Safety Filter — Confirm Binance order flow supports direction
 * FORMULA 3: Remaining Opportunity — Delta hasn't already absorbed the move
 * 
 * Final: Trade only when dislocation > 0.05% fee, Binance still pushing,
 *        and Delta has absorbed < 50% of the move.
 */

class MonumentStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        // FEE: Delta taker fee = 0.05% per side, scalper offer = 0% closing
        // MONUMENT_FEE should be 0.0005 (0.05% one-way opening fee)
        // F1 passes when edge > FEE (i.e., edge > 0.05%)
        this.FEE = parseFloat(process.env.MONUMENT_FEE || '0.0005');
        this.EMA_ALPHA = 0.02;
        this.COOLDOWN_MS = 30000;
        this.TRAILING_STOP_PCT = 0.0002;
        this.REQUIRE_FLOW_CONFIRMATION = false;

        // --- F3 v2: ABSORPTION RATIO ---
        // NOTE: MIN_LEADER_MOVE_PCT validates Binance actually moved (real signal)
        // NOTE: MIN_DELTA_MOVE_PCT set to 0 because Delta XRP trades every 7-20s
        //       With sparse trades, deltaMove is always 0, making the check impossible
        //       to pass. F3 still validates leader move; absorption is skipped.
        //       TODO: Re-enable when subscribing to Delta ob_l1 (100ms updates)
        this.MAX_AGE_MS = parseInt(process.env.MONUMENT_MAX_AGE_MS || '500');
        this.MIN_REMAINING_RATIO = 0.50;
        this.MIN_LEADER_MOVE_PCT = 0.00005;  // 0.005% - validates Binance moved
        this.MIN_DELTA_MOVE_PCT = 0;          // DISABLED: Delta trades too sparse (7-20s)
        this.MAX_DATA_AGE_MS = parseInt(process.env.MONUMENT_MAX_DATA_AGE_MS || '10000');

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

                // Binance trade data (for F3 - more frequent updates)
                binanceTradePrice: null,
                lastBinanceTradeTime: null,

                // Delta trade data
                deltaPrice: null,
                lastDeltaTradeTime: null,
                lastLeaderUpdate: null,
                lastDeltaUpdate: null,

                // Formula 0: EMA baseline
                emaBaseline: null,
                spreadHistory: [],

                // Formula 3: Absorption ratio (F3 v2)
                leaderStart: null,
                deltaStart: null,
                signalSide: null,
                signalId: null,
                triggerTime: null,

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
        this.lastTradeSignalId = null;
        this.lastTradeAgeMs = null;
        this.lastTradeEntryPrice = null;
        this.lastTradeSide = null;

        this.signalLog = [];
        this.tradeOutcomes = [];
        this.ageWindows = [100, 250, 500, 1000, 2000];

        this.logger.info(`[Monument] Initialized | Fee: ${this.FEE * 100}% | EMA α: ${this.EMA_ALPHA} | MaxAge: ${this.MAX_AGE_MS}ms | MinRemaining: ${this.MIN_REMAINING_RATIO * 100}% | MinLeader: ${this.MIN_LEADER_MOVE_PCT * 100}% | MinDelta: ${this.MIN_DELTA_MOVE_PCT * 100}%`);
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

        const asset = Object.keys(this.assets).find(k => symbol.toUpperCase().includes(k));
        if (!asset) return;

        const data = this.assets[asset];

        data.bidPrice = update.bb;
        data.askPrice = update.ba;
        data.bidSize = update.bq;
        data.askSize = update.aq;

        this.stats.binanceUpdates++;
    }

    /**
     * Binance Trade feed (fallback if depth not available)
     */
    onBinanceTrade(update) {
        const symbol = update.s;
        const asset = Object.keys(this.assets).find(k => symbol.toUpperCase().includes(k));
        if (!asset) return;

        const data = this.assets[asset];
        
        data.binanceTradePrice = parseFloat(update.p);
        data.lastBinanceTradeTime = Date.now();
        data.lastLeaderUpdate = Date.now();

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
    // FORMULA 3: ABSORPTION RATIO (F3 v2)
    // =========================================================================

    /**
     * Measures how much Delta has absorbed of Binance's move.
     * Directional version: rejects reversals.
     * 
     * leaderMove = pLeader - leaderStart (BUY) or leaderStart - pLeader (SELL)
     * deltaMove = pDelta - deltaStart (BUY) or deltaStart - pDelta (SELL)
     * absorption = deltaMove / leaderMove
     * remaining = 1 - absorption
     * 
     * Trade if remaining > MIN_REMAINING_RATIO AND age < MAX_AGE_MS
     */
    calculateFormula3(symbol, pLeader, pDelta, side) {
        const data = this.assets[symbol];

        if (data.leaderStart === null) {
            data.leaderStart = pLeader;
            data.deltaStart = pDelta;
            data.signalSide = side;
            data.signalId = Date.now();
            data.triggerTime = Date.now();
            this.logger.info(`[F3] ${symbol} | 🎯 TRIGGER CAPTURED: leader=${pLeader.toFixed(6)} delta=${pDelta.toFixed(6)} side=${side}`);
            return null;
        }

        if (data.signalSide !== side) {
            this.logger.info(`[F3] ${symbol} | ❌ DIRECTION FLIP: ${data.signalSide} → ${side} — resetting`);
            this.resetF3State(symbol);
            return null;
        }

        const ageMs = Date.now() - data.triggerTime;
        if (ageMs > this.MAX_AGE_MS) {
            this.logger.info(`[F3] ${symbol} | ⏰ STATE STALE: ${ageMs}ms > ${this.MAX_AGE_MS}ms — resetting`);
            this.resetF3State(symbol);
            return null;
        }

        if (ageMs < 10) {
            return null;
        }

        const now = Date.now();
        const leaderDataAge = data.lastLeaderUpdate ? now - data.lastLeaderUpdate : Infinity;
        const deltaDataAge = data.lastDeltaUpdate ? now - data.lastDeltaUpdate : Infinity;

        if (leaderDataAge > this.MAX_DATA_AGE_MS) {
            this.logger.info(`[F3] ${symbol} | ⏰ LEADER DATA STALE: ${leaderDataAge}ms > ${this.MAX_DATA_AGE_MS}ms`);
            return null;
        }

        if (deltaDataAge > this.MAX_DATA_AGE_MS) {
            this.logger.info(`[F3] ${symbol} | ⏰ DELTA DATA STALE: ${deltaDataAge}ms > ${this.MAX_DATA_AGE_MS}ms`);
            return null;
        }

        let leaderMove, deltaMove;
        if (side === 'buy') {
            leaderMove = pLeader - data.leaderStart;
            deltaMove = pDelta - data.deltaStart;
        } else {
            leaderMove = data.leaderStart - pLeader;
            deltaMove = data.deltaStart - pDelta;
        }

        if (leaderMove !== 0 || deltaMove !== 0) {
            this.logger.info(`[F3] ${symbol} | 📊 MOVEMENT: leaderNow=${pLeader.toFixed(6)} leaderStart=${data.leaderStart.toFixed(6)} leaderMove=${leaderMove.toFixed(6)} | deltaNow=${pDelta.toFixed(6)} deltaStart=${data.deltaStart.toFixed(6)} deltaMove=${deltaMove.toFixed(6)} | age=${ageMs}ms`);
        }

        if (leaderMove < 0 || deltaMove < 0) {
            this.logger.info(`[F3] ${symbol} | ❌ REVERSAL: leaderMove=${leaderMove.toFixed(6)} deltaMove=${deltaMove.toFixed(6)}`);
            return null;
        }

        const minLeaderMove = data.leaderStart * this.MIN_LEADER_MOVE_PCT;
        if (leaderMove < minLeaderMove) {
            if (!data._leaderSmallLogged) {
                this.logger.info(`[F3] ${symbol} | ❌ LEADER TOO SMALL: ${leaderMove.toFixed(6)} < ${minLeaderMove.toFixed(6)} (${this.MIN_LEADER_MOVE_PCT * 100}% of ${data.leaderStart.toFixed(6)})`);
                data._leaderSmallLogged = true;
            }
            return null;
        }

        const minDeltaMove = data.deltaStart * this.MIN_DELTA_MOVE_PCT;
        if (this.MIN_DELTA_MOVE_PCT > 0 && deltaMove < minDeltaMove) {
            this.logger.info(`[F3] ${symbol} | ❌ DELTA TOO SMALL: ${deltaMove.toFixed(6)} < ${minDeltaMove.toFixed(6)} (${this.MIN_DELTA_MOVE_PCT * 100}% of ${data.deltaStart.toFixed(6)})`);
            return null;
        }

        const absorption = deltaMove / leaderMove;
        const remaining = 1 - absorption;

        if (!isFinite(absorption)) {
            this.logger.warn(`[F3] ${symbol} | ❌ NON-FINITE: absorption=${absorption}`);
            return null;
        }

        if (absorption > 1.0) {
            this.logger.info(`[F3] ${symbol} | ❌ OVER-ABSORPTION: ${(absorption * 100).toFixed(2)}% > 100%`);
            return null;
        }

        this.logger.info(`[F3] ${symbol} | ✅ PASSED: absorption=${(absorption * 100).toFixed(2)}% remaining=${(remaining * 100).toFixed(2)}% (need > ${(this.MIN_REMAINING_RATIO * 100).toFixed(0)}%)`);

        this.logSignalState(symbol, data.signalId, ageMs, leaderMove, deltaMove, absorption, remaining);

        return { absorption, remaining, leaderMove, deltaMove, ageMs, signalId: data.signalId };
    }

    resetF3State(symbol) {
        const data = this.assets[symbol];
        data.leaderStart = null;
        data.deltaStart = null;
        data.signalSide = null;
        data.signalId = null;
        data.triggerTime = null;
        data._leaderSmallLogged = false;
    }

    logSignalState(symbol, signalId, ageMs, leaderMove, deltaMove, absorption, remaining) {
        const entry = {
            signal_id: signalId,
            symbol,
            age_ms: ageMs,
            leader_move: parseFloat(leaderMove.toFixed(6)),
            delta_move: parseFloat(deltaMove.toFixed(6)),
            absorption: parseFloat(absorption.toFixed(4)),
            remaining: parseFloat(remaining.toFixed(4))
        };
        this.signalLog.push(entry);
        this.logger.info(`[SIGNAL-EVOL] ${JSON.stringify(entry)}`);
    }

    logTradeOutcome(symbol, signalId, ageAtEntry, entryPrice, exitPrice, pnl, reason) {
        const outcome = {
            signal_id: signalId,
            symbol,
            age_at_entry: ageAtEntry,
            entry_price: entryPrice,
            exit_price: exitPrice,
            pnl: parseFloat((pnl * 100).toFixed(4)),
            reason
        };
        this.tradeOutcomes.push(outcome);
        this.logger.info(`[TRADE-OUTCOME] ${JSON.stringify(outcome)}`);
        this.printStats();

        this.lastTradeSignalId = null;
        this.lastTradeAgeMs = null;
        this.lastTradeEntryPrice = null;
        this.lastTradeSide = null;
    }

    printStats() {
        if (this.tradeOutcomes.length === 0) return;

        const outcomes = this.tradeOutcomes;
        const wins = outcomes.filter(t => t.pnl > 0);
        const losses = outcomes.filter(t => t.pnl <= 0);
        const winRate = (wins.length / outcomes.length * 100).toFixed(1);
        const avgPnl = (outcomes.reduce((s, t) => s + t.pnl, 0) / outcomes.length).toFixed(4);
        const totalPnl = outcomes.reduce((s, t) => s + t.pnl, 0).toFixed(4);

        const pnls = outcomes.map(t => t.pnl).sort((a, b) => a - b);
        const mid = Math.floor(pnls.length / 2);
        const medianPnl = pnls.length % 2 ? pnls[mid].toFixed(4) : ((pnls[mid - 1] + pnls[mid]) / 2).toFixed(4);

        const expectedValue = (outcomes.reduce((s, t) => s + t.pnl, 0) / outcomes.length).toFixed(4);

        this.logger.info(`[STATS] trades=${outcomes.length} wins=${wins.length} losses=${losses.length} winRate=${winRate}% avgPnl=${avgPnl}% medianPnl=${medianPnl}% totalPnl=${totalPnl}% EV=${expectedValue}%`);

        this.ageWindows.forEach(window => {
            const windowTrades = outcomes.filter(t => t.age_at_entry <= window);
            if (windowTrades.length > 0) {
                const windowWins = windowTrades.filter(t => t.pnl > 0).length;
                const windowWinRate = (windowWins / windowTrades.length * 100).toFixed(1);
                const windowAvgPnl = (windowTrades.reduce((s, t) => s + t.pnl, 0) / windowTrades.length).toFixed(4);
                this.logger.info(`[STATS-${window}ms] trades=${windowTrades.length} winRate=${windowWinRate}% avgPnl=${windowAvgPnl}%`);
            }
        });
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

        // If no edge, reset F3 state (thesis died)
        if (!side) {
            // Edge distribution diagnostic: log what fee threshold would let this through
            const absEdge = Math.abs(edgePct);
            if (absEdge >= 0.001) {
                const hypoBucket = Math.floor(absEdge * 1000) / 1000;
                const prev = this._lastHypoLog?.[symbol] || 0;
                if (hypoBucket > prev) {
                    if (!this._lastHypoLog) this._lastHypoLog = {};
                    this._lastHypoLog[symbol] = hypoBucket;
                    this.logger.info(`[F1-HYPO] ${symbol} edge=${edgePct.toFixed(4)}% would pass FEE at ≤${hypoBucket.toFixed(3)}% (current=${(this.FEE*100).toFixed(3)}%)`);
                }
            }
            this.resetF3State(symbol);
            return;
        }

        // F1 PASSED - log it
        this.logger.info(`[Monument] ✅ F1 PASSED: ${symbol} ${side.toUpperCase()} edge=${edgePct.toFixed(4)}% (fee=${this.FEE * 100}%)`);

        // Formula 2: Chase safety filter (disabled)
        const f2 = this.calculateFormula2(symbol);
        if (!f2) return;

        // Formula 3: Absorption ratio (F3 v2) - use real-time mid price
        const leaderAge = data.lastBinanceTradeTime ? Date.now() - data.lastBinanceTradeTime : Infinity;
        const pLeaderForF3 = leaderAge < 1000 ? data.binanceTradePrice : pBinance;
        const f3 = this.calculateFormula3(symbol, pLeaderForF3, pDelta, side);
        if (!f3) {
            this.logger.info(`[Monument] ${symbol} | F1 OK but F3 null (guard blocked)`);
            return;
        }

        const { absorption, remaining, leaderMove, deltaMove, ageMs, signalId } = f3;

        if (remaining <= this.MIN_REMAINING_RATIO) {
            this.logger.info(`[Monument] ${symbol} | Edge OK but F3 blocked: remaining=${(remaining * 100).toFixed(2)}% <= ${(this.MIN_REMAINING_RATIO * 100).toFixed(0)}%`);
            return;
        }

        // ALL FORMULAS PASSED — Execute trade
        if (!data.signalActive && !cooldownActive) {
            this.logger.info(`[Monument] 🎯 SIGNAL: ${symbol} ${side.toUpperCase()}`);
            this.logger.info(`  Formula 0: Spread=${(spread * 100).toFixed(4)}% | Baseline=${(baseline * 100).toFixed(4)}% | AdjEdge=${(adjustedEdge * 100).toFixed(4)}%`);
            this.logger.info(`  Formula 1: Edge=${edgePct.toFixed(4)}% > ${this.FEE * 100}% fee ✅`);
            this.logger.info(`  Formula 3: Absorption=${(absorption * 100).toFixed(2)}% | Remaining=${(remaining * 100).toFixed(2)}% > ${(this.MIN_REMAINING_RATIO * 100).toFixed(0)}% ✅`);
            this.logger.info(`  [EXEC] Binance=${pBinance.toFixed(4)} | Delta=${pDelta.toFixed(4)} | leaderMove=${leaderMove.toFixed(6)} | deltaMove=${deltaMove.toFixed(6)} | age=${ageMs}ms`);

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
            this.logger.info(`[Monument] Skip ${symbol} - already in position`);
            return;
        }

        const data = this.assets[symbol];
        const ageMs = Date.now() - data.triggerTime;

        this.logger.info(`[Monument] POSITION LOCK: ${symbol} = true`);
        this.bot.activePositions[symbol] = true;
        this.lastTradeSignalId = signalId;
        this.lastTradeAgeMs = ageMs;
        this.lastTradeSide = side;

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
                    this.logTradeOutcome(symbol, this.lastTradeSignalId, this.lastTradeAgeMs, entryPrice, exitPrice, pnl, 'close');
                }
            }
        }

        if (order.reason === 'stop_trigger') {
            const symbol = this.symbolIndex.get(order.symbol) ||
                Object.keys(this.assets).find(s => order.symbol?.includes(s));
            if (symbol) {
                this.logger.info(`[Monument] 🛑 STOP TRIGGERED: ${symbol}`);
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
                    this.logTradeOutcome(symbol, this.lastTradeSignalId, this.lastTradeAgeMs, entryPrice, exitPrice, pnl, 'stop');
                }

                this.resetF3State(symbol);
            }
        }
    }

    onUserTrade(trade) {
        if (trade.reason !== 'normal') return;
        if (!trade.client_order_id || !trade.client_order_id.startsWith('mon_')) return;

        const symbol = this.symbolIndex.get(trade.symbol) ||
            Object.keys(this.assets).find(s => trade.symbol?.includes(s));
        if (!symbol) return;

        this.logger.info(`[Monument] 🎯 FILL: ${symbol} @ ${trade.price}`);
        this.lastTradeEntryPrice = parseFloat(trade.price);
    }

    onPositionClose(asset) {
        this.logger.info(`[Monument] POSITION CLOSED: ${asset} - resetting lock`);
        this.bot.activePositions[asset] = false;
        this.assets[asset].signalActive = false;

        if (this.lastTradeSignalId && this.lastTradeEntryPrice) {
            const data = this.assets[asset];
            const exitPrice = data.deltaPrice || 0;
            const entryPrice = this.lastTradeEntryPrice;
            const side = this.lastTradeSide;
            let pnl = 0;
            if (exitPrice > 0 && entryPrice > 0) {
                pnl = side === 'buy'
                    ? (exitPrice - entryPrice) / entryPrice
                    : (entryPrice - exitPrice) / entryPrice;
                pnl -= this.FEE * 2;
            }
            this.logTradeOutcome(asset, this.lastTradeSignalId, this.lastTradeAgeMs, entryPrice, exitPrice, pnl, 'position_close');
        }

        this.resetF3State(asset);
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
                            this.resetF3State(symbol);
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
