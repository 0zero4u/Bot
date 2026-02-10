/**
 * MicroStrategy.js
 *
 * Strategy: Volume-Weighted Microprice (VWM)
 * with Directional Velocity Gating & Server-Side Trailing Stop.
 *
 * CORE LOGIC:
 * 1. Normalized Liquidity: Filters out "dust" (requires ~$2000 USDT on L1).
 * 2. Velocity Gate: Requires price impulse in ~30ms.
 * 3. Microprice Imbalance: Detects liquidity pressure.
 * 4. Directional Confluence: Trades ONLY if pressure is failing.
 * 5. Execution: Market IOC with Server-Side Trailing Stop.
 */

class MicroStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.TRIGGER_THRESHOLD = parseFloat(process.env.MICRO_THRESHOLD || '0.75');
        this.MIN_NOTIONAL_VALUE = parseFloat(process.env.MIN_NOTIONAL || '2000');
        this.TRAILING_PERCENT = parseFloat(process.env.TRAILING_PERCENT || '0.02');
        this.COOLDOWN_MS = 2000;

        // --- VELOCITY CONFIG ---
        this.SPIKE_PERCENT = 0.00007;   // 0.017%
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

    // ✅ REQUIRED BY LOADER (DO NOT REMOVE)
    getName() {
        return `MicroStrategy (VWM + Vel + ${this.TRAILING_PERCENT}% Server-Trail)`;
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
            now - asset.priceHistory[0].time > this.SPIKE_WINDOW_MS + 200
        ) {
            asset.priceHistory.shift();
        }

        // Time-aligned baseline
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

        // --- Anti-Trap #1: Velocity MUST be decelerating ---
        if (asset.prevVelocity !== null) {
            if (absChange >= Math.abs(asset.prevVelocity)) return;
        }
        asset.prevVelocity = signedChange;

        // --- Microprice ---
        const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);
        const halfSpread = (Pa - Pb) / 2;
        if (halfSpread <= 1e-8) return;

        // --- Anti-Trap #2: Spread must be stable ---
        if (asset.prevHalfSpread !== null) {
            if (halfSpread > asset.prevHalfSpread * 1.05) return;
        }
        asset.prevHalfSpread = halfSpread;

        // --- Anti-Trap #3: Liquidity persistence ---
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

            let signedTrailAmount = side === 'buy' ? -trailDistance : trailDistance;

            const payload = {
                product_id: spec.deltaId.toString(),
                size: process.env.ORDER_SIZE || "1",
                side: side,
                order_type: 'market_order',
                limit_price: entryPrice.toFixed(spec.precision),
                bracket_trail_amount: signedTrailAmount.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            };

            await this.bot.placeOrder(payload);

            this.logger.info(
                `[EXEC] ${symbol} ${side} @ ${entryPrice} | Trail:${signedTrailAmount.toFixed(spec.precision)}`
            );
        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = MicroStrategy;
            
