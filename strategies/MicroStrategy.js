/**
 * *
 * Strategy: Volume-Weighted Microprice (VWM)
 * with Directional Velocity Confirmation & Server-Side Trailing Stop.
 *
 * CORE LOGIC:
 * 1. Normalized Liquidity (filters dust)
 * 2. Velocity MUST be increasing
 * 3. Microprice confirms dominance
 * 4. Spread stable or tightening
 * 5. Abort immediately if pressure shows failure
 * 6. Market IOC with Server-Side Trailing Stop
 */

class MicroStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.TRIGGER_THRESHOLD = parseFloat(process.env.MICRO_THRESHOLD || '0.60');
        this.MIN_NOTIONAL_VALUE = parseFloat(process.env.MIN_NOTIONAL || '2000');
        this.TRAILING_PERCENT = parseFloat(process.env.TRAILING_PERCENT || '0.05'); // wider for continuation
        this.COOLDOWN_MS = 2000;

        // --- VELOCITY CONFIG ---
        this.SPIKE_PERCENT = 0.0000015;   // 0.017%
        this.SPIKE_WINDOW_MS = 30;

        this.assets = {};

        // Delta Exchange Specs
        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: 0.001 },
            'ETH': { deltaId: 299,   precision: 2, lot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 1 },
            'SOL': { deltaId: 417,   precision: 3, lot: 0.1 }
        };

        const targets = (process.env.TARGET_ASSETS || 'XRP').split(',');
        targets.forEach(symbol => {
            this.assets[symbol] = {
                lastTriggerTime: 0,
                lastLogTime: 0,
                priceHistory: [],
                prevVelocity: null,
                prevHalfSpread: null,
                prevBidVol: null,
                prevAskVol: null
            };
        });
    }

    // REQUIRED BY LOADER
    getName() {
        return `MicroStrategy (VWM + Continuation + ${this.TRAILING_PERCENT}% Server-Trail)`;
    }

    /**
     * [NEW] Immediate Reset Hook
     * Called by Trader when a position closes to bypass COOLDOWN_MS
     */
    onPositionClose(symbol) {
        if (this.assets[symbol]) {
            this.assets[symbol].lastTriggerTime = 0;
            // Optional: this.logger.info(`[STRATEGY] ${symbol} Timer reset. Ready for immediate entry.`);
        }
    }

    /**
     * Runs on every order book update
     */
    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;
        if (!depth.bids[0] || !depth.asks[0]) return;

        const now = Date.now();

        // --- L1 Data ---
        const Pb = parseFloat(depth.bids[0][0]);
        const Vb = parseFloat(depth.bids[0][1]);
        const Pa = parseFloat(depth.asks[0][0]);
        const Va = parseFloat(depth.asks[0][1]);

        const midPrice = (Pa + Pb) / 2;
        const totalNotional = (Vb * Pb) + (Va * Pa);
        if (totalNotional < this.MIN_NOTIONAL_VALUE) return;

        // --- Velocity Buffer ---
        asset.priceHistory.push({ price: midPrice, time: now });
        while (
            asset.priceHistory.length > 2 &&
            now - asset.priceHistory[0].time > this.SPIKE_WINDOW_MS + 1
        ) {
            asset.priceHistory.shift();
        }

        // Baseline aligned to window
        let baselineTick = null;
        for (let i = asset.priceHistory.length - 1; i >= 0; i--) {
            if (now - asset.priceHistory[i].time >= this.SPIKE_WINDOW_MS) {
                baselineTick = asset.priceHistory[i];
                break;
            }
        }
        if (!baselineTick) return;

        const signedChange = (midPrice - baselineTick.price) / baselineTick.price;
        const absChange = Math.abs(signedChange);
        if (absChange < this.SPIKE_PERCENT) return;

        const isVelocityUp = signedChange > 0;
        const isVelocityDown = signedChange < 0;

        // --- Velocity MUST be increasing ---
        if (asset.prevVelocity !== null) {
            if (absChange <= Math.abs(asset.prevVelocity)) return;
        }
        asset.prevVelocity = signedChange;

        // --- Microprice ---
        const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);
        const halfSpread = (Pa - Pb) / 2;
        if (halfSpread <= 1e-8) return;

        // --- Spread must be stable or tightening ---
        if (asset.prevHalfSpread !== null) {
            if (halfSpread > asset.prevHalfSpread * 1.02) return;
        }
        asset.prevHalfSpread = halfSpread;

        // --- Signal Strength ---
        const signalStrength = (microPrice - midPrice) / halfSpread;

        // --- Pressure failure kill-switch ---
        const pressureFailing =
            (isVelocityUp && signalStrength < 0) ||
            (isVelocityDown && signalStrength > 0);

        if (pressureFailing) return;

        let side = null;

        // --- Directional Liquidity Persistence ---
        if (signalStrength > this.TRIGGER_THRESHOLD && isVelocityUp) {
            if (asset.prevBidVol !== null && Vb < asset.prevBidVol * 0.9) return;
            side = 'buy';
        }

        if (signalStrength < -this.TRIGGER_THRESHOLD && isVelocityDown) {
            if (asset.prevAskVol !== null && Va < asset.prevAskVol * 0.9) return;
            side = 'sell';
        }

        asset.prevBidVol = Vb;
        asset.prevAskVol = Va;

        if (now - asset.lastLogTime > 5000) {
            this.logger.info(
                `[CONT] ${symbol} | Vel:${(signedChange * 100).toFixed(4)}% | Sig:${signalStrength.toFixed(2)}`
            );
            asset.lastLogTime = now;
        }

        if (
            side &&
            !this.bot.hasOpenPosition(symbol) &&
            !this.bot.isOrderInProgress
        ) {
            if (now - asset.lastTriggerTime < this.COOLDOWN_MS) return;
            asset.lastTriggerTime = now;
            await this.executeTrade(symbol, side, Pa, Pb);
        }
    }

    /**
     * Execution Logic
     */
    async executeTrade(symbol, side, bestAsk, bestBid) {
        this.bot.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];
            const entryPrice = side === 'buy' ? bestAsk : bestBid;

            let trailDistance = entryPrice * (this.TRAILING_PERCENT / 100);
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDistance < tickSize) trailDistance = tickSize;

            const signedTrailAmount =
                side === 'buy' ? -trailDistance : trailDistance;

            const clientOid = `c_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            this.bot.recordOrderPunch(clientOid);

            const payload = {
                product_id: spec.deltaId.toString(),
                size: process.env.ORDER_SIZE || "1",
                side: side,
                order_type: 'market_order',
                limit_price: entryPrice.toFixed(spec.precision),
                bracket_trail_amount: signedTrailAmount.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price',
                client_order_id: clientOid
            };

            await this.bot.placeOrder(payload);

            this.logger.info(
                `[EXEC_CONT] ${symbol} ${side} @ ${entryPrice} | Trail:${signedTrailAmount.toFixed(spec.precision)} | OID:${clientOid}`
            );
        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = MicroStrategy;
                
