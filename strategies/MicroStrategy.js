/**
 * MicroStrategy.js
 *
 * Strategy: Volume-Weighted Microprice (VWM)
 * with Directional Velocity Gating & Server-Side Trailing Stop.
 *
 * ADDITIONAL SAFETY (NO LATENCY ADDED):
 * - Require velocity to be DECELERATING (pressure exhaustion)
 * - Require spread stability (no panic liquidity pull)
 * - Require L1 liquidity persistence (anti-spoof)
 */

class MicroStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        this.TRIGGER_THRESHOLD = parseFloat(process.env.MICRO_THRESHOLD || '0.75');
        this.MIN_NOTIONAL_VALUE = parseFloat(process.env.MIN_NOTIONAL || '2000');
        this.TRAILING_PERCENT = parseFloat(process.env.TRAILING_PERCENT || '0.02');
        this.COOLDOWN_MS = 2000;

        this.SPIKE_PERCENT = 0.00017;   // 0.017%
        this.SPIKE_WINDOW_MS = 30;

        this.assets = {};

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

    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset || !depth.bids[0] || !depth.asks[0]) return;

        const now = Date.now();

        const Pb = +depth.bids[0][0];
        const Vb = +depth.bids[0][1];
        const Pa = +depth.asks[0][0];
        const Va = +depth.asks[0][1];

        const midPrice = (Pa + Pb) / 2;
        const totalNotional = (Vb * Pb) + (Va * Pa);
        if (totalNotional < this.MIN_NOTIONAL_VALUE) return;

        // --- Velocity buffer ---
        asset.priceHistory.push({ price: midPrice, time: now });
        while (
            asset.priceHistory.length > 2 &&
            now - asset.priceHistory[0].time > this.SPIKE_WINDOW_MS + 200
        ) {
            asset.priceHistory.shift();
        }

        // Time-correct baseline
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

        // --- FIX #1: Velocity must be DECELERATING ---
        if (asset.prevVelocity !== null) {
            if (absChange >= Math.abs(asset.prevVelocity)) return;
        }

        asset.prevVelocity = signedChange;

        // --- Microprice ---
        const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);
        const halfSpread = (Pa - Pb) / 2;
        if (halfSpread <= 1e-8) return;

        // --- FIX #2: Spread stability (no panic pull) ---
        if (asset.prevHalfSpread !== null) {
            if (halfSpread > asset.prevHalfSpread * 1.05) return;
        }
        asset.prevHalfSpread = halfSpread;

        // --- FIX #3: Liquidity persistence (anti-spoof) ---
        if (asset.prevBidVol !== null && asset.prevAskVol !== null) {
            if (Vb < asset.prevBidVol * 0.8 && Va < asset.prevAskVol * 0.8) return;
        }
        asset.prevBidVol = Vb;
        asset.prevAskVol = Va;

        const signalStrength = (microPrice - midPrice) / halfSpread;
        let side = null;

        if (signalStrength > this.TRIGGER_THRESHOLD && isVelocityUp) {
            side = 'buy';
        } else if (signalStrength < -this.TRIGGER_THRESHOLD && isVelocityDown) {
            side = 'sell';
        }

        if (now - asset.lastLogTime > 5000) {
            this.logger.info(
                `[MICRO] ${symbol} | Vel:${(signedChange * 100).toFixed(4)}% | Sig:${signalStrength.toFixed(2)}`
            );
            asset.lastLogTime = now;
        }

        if (side && !this.bot.hasOpenPosition(symbol) && !this.bot.isOrderInProgress) {
            if (now - asset.lastTriggerTime < this.COOLDOWN_MS) return;
            asset.lastTriggerTime = now;
            await this.executeTrade(symbol, side, Pa, Pb);
        }
    }

    async executeTrade(symbol, side, bestAsk, bestBid) {
        this.bot.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];
            const entryPrice = side === 'buy' ? bestAsk : bestBid;

            let trailDistance = entryPrice * (this.TRAILING_PERCENT / 100);
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDistance < tickSize) trailDistance = tickSize;

            let signedTrailAmount = side === 'buy' ? -trailDistance : trailDistance;

            const payload = {
                product_id: spec.deltaId.toString(),
                size: process.env.ORDER_SIZE || "1",
                side,
                order_type: 'market_order',
                limit_price: entryPrice.toFixed(spec.precision),
                bracket_trail_amount: signedTrailAmount.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            };

            await this.bot.placeOrder(payload);
        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = MicroStrategy;
                
