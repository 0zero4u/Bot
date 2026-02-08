/**
 * TickStrategy.js - High-Frequency Trading (HFT) Bot
 * Final Complete Version v1.0.3
 * * [span_0](start_span)CORE THESIS[span_0](end_span):
 * 1. [span_1](start_span)[span_2](start_span)FILTRATION: MTF/PLFF removes "flickering" noise from Level 2 streams[span_1](end_span)[span_2](end_span).
 * 2. [span_3](start_span)[span_4](start_span)REGIMES: Discretizes OBI into 5 dynamic states to stabilize signal clarity[span_3](end_span)[span_4](end_span).
 * 3. HAWKES CAUSALITY: Uses an exponential decay kernel to measure Causal Coherence 
 * between realized trades and price movement.
 */

class TickStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- RESEARCH-DRIVEN PARAMETERS ---
        this.PLFF_THRESHOLD_MS = 100;     [span_5](start_span)[span_6](start_span)// Price-Level Frequency Filter[span_5](end_span)[span_6](end_span)
        this.OBI_HISTORY_SIZE = 1000;    [span_7](start_span)[span_8](start_span)// Buffer for Dynamic Quantiles[span_7](end_span)[span_8](end_span)
        this.HEARTBEAT_INTERVAL = 3000;  // Strict 3s logging
        
        // --- HAWKES CAUSAL PARAMETERS ---
        this.HAWKES_DECAY = 5.0;         [span_9](start_span)[span_10](start_span)// λ: Focuses on immediate micro-bursts[span_9](end_span)[span_10](end_span)
        this.MIN_CAUSAL_SCORE = 0.5;     // Threshold for Causal Coherence Score
        this.MIN_TRADE_OBI = 0.35;       [span_11](start_span)[span_12](start_span)// Directional conviction from OBI(T)[span_11](end_span)[span_12](end_span)

        this.assets = {};
        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        targets.forEach(asset => {
            this.assets[asset] = {
                levelTimestamps: new Map(), // Track last update per price level (PLFF)
                obiHistory: [],             // Historical buffer for regimes
                recentTrades: [],           // Event stream for Hawkes Process
                lastHeartbeat: 0,
                lastTriggerTime: 0,
                currentRegime: 0,
                currentPercentile: 0,
                filteredObi: 0
            };
        });

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: 0.001 },
            'ETH': { deltaId: 299,   precision: 2, lot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 1 }
        };
    }

    getName() { return "TickStrategy (Hawkes Causal + PLFF)"; }

    /**
     * 1. ASSOCIATIVE SIGNAL (LOB DEPTH)
     * Filters noise via PLFF and segmenting into 5 Regimes.
     */
    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        const now = Date.now();

        // A. Price-Level Frequency Filter (PLFF)
        [span_13](start_span)[span_14](start_span)// Adaptation of MTF for Level 2 data[span_13](end_span)[span_14](end_span)
        const validBids = this.applyPLFF(asset, depth.bids, now);
        const validAsks = this.applyPLFF(asset, depth.asks, now);

        [span_15](start_span)[span_16](start_span)// B. Calculate Filtered OBI[span_15](end_span)[span_16](end_span)
        const bVol = validBids.reduce((s, l) => s + parseFloat(l[1]), 0);
        const aVol = validAsks.reduce((s, l) => s + parseFloat(l[1]), 0);
        if (bVol + aVol === 0) return;
        asset.filteredObi = (bVol - aVol) / (bVol + aVol);

        [span_17](start_span)[span_18](start_span)// C. Update Dynamic Quantile Regimes[span_17](end_span)[span_18](end_span)
        this.updateRegimeState(asset);

        // D. Heartbeat Logging (Strict 3s)
        if (now - asset.lastHeartbeat > this.HEARTBEAT_INTERVAL) {
            const metrics = this.calculateHawkesCausality(asset, now);
            this.logPayload(symbol, asset, "HEARTBEAT", now, null, metrics);
            asset.lastHeartbeat = now;
        }

        // E. Trigger Evaluation (Strong Regimes ±2 Only)
        if (Math.abs(asset.currentRegime) >= 2) {
            await this.evaluateCausalSnipe(symbol, asset, now);
        }
    }

    /**
     * 2. CAUSAL SIGNAL (TRADE FLOW)
     * [span_19](start_span)[span_20](start_span)Realized conviction fuels the Hawkes Point Process[span_19](end_span)[span_20](end_span).
     */
    onPriceUpdate(symbol, price, source) {
        const asset = this.assets[symbol];
        if (asset) {
            asset.recentTrades.push({ t: Date.now(), p: parseFloat(price) });
            // Prune events > 1s for localized causal coherence
            if (asset.recentTrades.length > 100) asset.recentTrades.shift();
        }
    }

    /**
     * 3. FILTRATION & ANALYTICS
     */

    applyPLFF(asset, levels, now) {
        return levels.filter(level => {
            const price = level[0];
            const lastUpdate = asset.levelTimestamps.get(price) || 0;
            const diff = now - lastUpdate;
            asset.levelTimestamps.set(price, now);
            [span_21](start_span)[span_22](start_span)return diff > this.PLFF_THRESHOLD_MS; // Rejects flickering noise[span_21](end_span)[span_22](end_span)
        });
    }

    updateRegimeState(asset) {
        const history = asset.obiHistory;
        history.push(asset.filteredObi);
        if (history.length > this.OBI_HISTORY_SIZE) history.shift();
        if (history.length < 50) return;

        const sorted = [...history].sort((a, b) => a - b);
        const rank = sorted.filter(v => v < asset.filteredObi).length;
        asset.currentPercentile = (rank / sorted.length) * 100;

        [span_23](start_span)[span_24](start_span)// --- 5-REGIME DISCRETIZATION[span_23](end_span)[span_24](end_span) ---
        if (asset.currentPercentile >= 90) asset.currentRegime = 2;       // Strong Buy
        else if (asset.currentPercentile >= 75) asset.currentRegime = 1;  // Weak Buy
        else if (asset.currentPercentile <= 10) asset.currentRegime = -2; // Strong Sell
        else if (asset.currentPercentile <= 25) asset.currentRegime = -1; // Weak Sell
        else asset.currentRegime = 0;                                    // Neutral
    }

    /**
     * HAWKES CAUSAL COHERENCE SCORE
     * [span_25](start_span)[span_26](start_span)Models directional excitation norms under exponential kernels[span_25](end_span)[span_26](end_span).
     */
    calculateHawkesCausality(asset, now) {
        let intensity = 0;
        let up = 0, down = 0;
        const window = asset.recentTrades.filter(t => now - t.t < 1000);

        for (let i = 1; i < window.length; i++) {
            const deltaT = (now - window[i].t) / 1000;
            [span_27](start_span)[span_28](start_span)// Hawkes Kernel: Σ exp(-λ * Δt)[span_27](end_span)[span_28](end_span)
            intensity += Math.exp(-this.HAWKES_DECAY * deltaT);
            
            [span_29](start_span)[span_30](start_span)// Tick-Direction OBI(T)[span_29](end_span)[span_30](end_span)
            if (window[i].p > window[i-1].p) up++;
            else if (window[i].p < window[i-1].p) down++;
        }
        return { 
            causalScore: intensity, 
            tradeObi: (up + down) > 0 ? (up - down) / (up + down) : 0 
        };
    }

    /**
     * 4. SNIPE EXECUTION
     */
    async evaluateCausalSnipe(symbol, asset, now) {
        if (this.bot.hasOpenPosition || this.bot.isOrderInProgress) return;
        if (now - asset.lastTriggerTime < 2000) return;

        const metrics = this.calculateHawkesCausality(asset, now);

        let side = null;
        [span_31](start_span)[span_32](start_span)// The Multi-Signal Execution Trigger[span_31](end_span)[span_32](end_span)
        if (asset.currentRegime === 2 && metrics.causalScore > this.MIN_CAUSAL_SCORE && metrics.tradeObi > this.MIN_TRADE_OBI) {
            side = 'buy';
        } else if (asset.currentRegime === -2 && metrics.causalScore > this.MIN_CAUSAL_SCORE && metrics.tradeObi < -this.MIN_TRADE_OBI) {
            side = 'sell';
        }

        if (side) {
            asset.lastTriggerTime = now;
            this.logPayload(symbol, asset, "TICK_TRIGGER", now, side, metrics);
            await this.executeSnipe(symbol, asset, side);
        }
    }

    async executeSnipe(symbol, asset, side) {
        this.bot.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];
            const lastPrice = asset.recentTrades[asset.recentTrades.length - 1]?.p;
            if (!lastPrice) return;

            [span_33](start_span)[span_34](start_span)// Aggressive Limit IOC Sniping[span_33](end_span)[span_34](end_span)
            const limit = side === 'buy' ? lastPrice * 1.0005 : lastPrice * 0.9995;
            const stop = side === 'buy' ? lastPrice * 0.998 : lastPrice * 1.002;

            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                size: this.bot.config.orderSize,
                side,
                order_type: 'limit_order',
                time_in_force: 'ioc',
                limit_price: limit.toFixed(spec.precision),
                bracket_stop_loss_limit_price: stop.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            });
        } catch (e) { this.logger.error(`[EXEC_FAIL] ${e.message}`); }
        finally { this.bot.isOrderInProgress = false; }
    }

    /**
     * 5. LOGGING (JSON PAYLOADS)
     */
    logPayload(symbol, asset, type, now, side, metrics) {
        const payload = {
            timestamp: new Date(now).toISOString(),
            event: type,
            asset: symbol,
            regime: `${asset.currentRegime} (p: ${asset.currentPercentile.toFixed(1)}%)`,
            filtered_obi: asset.filteredObi.toFixed(4),
            [span_35](start_span)[span_36](start_span)// Causal Coherence Audit[span_35](end_span)[span_36](end_span)
            causal_coherence_score: metrics.causalScore.toFixed(2),
            trade_obi: metrics.tradeObi.toFixed(4)
        };
        if (side) payload.side = side.toUpperCase();
        this.logger.info(`[TICK-STRAT] ${JSON.stringify(payload)}`);
    }
}

module.exports = TickStrategy;
          
