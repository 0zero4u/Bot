/**
 * MicroStrategy.js
 *
 * Strategy: Volume-Weighted Microprice (VWM)
 * with Directional Velocity Gating & Dynamic Trailing Stop.
 *
 * CORE LOGIC:
 * 1. Normalized Liquidity: Filters out "dust" (requires ~$2000 USDT on L1).
 * 2. Velocity Gate: Requires price to move > 0.02% in ~30ms to wake up.
 * 3. Microprice Imbalance: Calculates weighted pressure of the order book.
 * 4. Directional Confluence: Trades ONLY if Microprice & Velocity agree.
 * 5. Execution: Limit IOC with a Dynamic 10-Tick Trailing Stop.
 */

class MicroStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---

        // Signal Strength Threshold
        // 0.6 means Microprice has moved 60% across the spread toward the other side.
        this.TRIGGER_THRESHOLD = parseFloat(process.env.MICRO_THRESHOLD || '0.65');

        // Liquidity Filter: Minimum TOTAL value on L1 (Bid + Ask) in USDT.
        // We sum them to allow for heavy imbalances (e.g., huge Buy wall, empty Sell side).
        // Default: $2000 USDT visible on L1 required to trade.
        this.MIN_NOTIONAL_VALUE = parseFloat(process.env.MIN_NOTIONAL || '2000');

        this.COOLDOWN_MS = 2000;

        // --- VELOCITY GATE CONFIG ---
        this.SPIKE_PERCENT = 0.0003;   // 0.02% Price Move required
        this.SPIKE_WINDOW_MS = 30;     // 30ms Time Window

        this.assets = {};

        // Asset Specs (Delta Exchange Standard)
        // Precision: Decimal places for price.
        // DeltaId: Product ID for order placement.
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
                /**
                 * Rolling tick buffer for Velocity calculation.
                 * Stores: { price: Number, time: Number }
                 */
                priceHistory: []
            };
        });
    }

    getName() {
        return "MicroStrategy (VWM + Velocity + 10-Tick Trail)";
    }

    /**
     * Main Tick Handler
     * Expects depth payload: { bids: [[price, vol]], asks: [[price, vol]] }
     */
    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;

        // 1. Data Integrity Check
        if (!depth.bids[0] || !depth.asks[0]) return;

        const now = Date.now();
        const Pb = parseFloat(depth.bids[0][0]); // Bid Price
        const Vb = parseFloat(depth.bids[0][1]); // Bid Vol
        const Pa = parseFloat(depth.asks[0][0]); // Ask Price
        const Va = parseFloat(depth.asks[0][1]); // Ask Vol

        const midPrice = (Pa + Pb) / 2;

        // ============================================================
        // STEP 1: NORMALIZED LIQUIDITY CHECK (USDT)
        // ============================================================

        // Calculate Total Value on L1 (Price * Volume)
        const totalNotional = (Vb * Pb) + (Va * Pa);

        // If total liquidity is too low (dust/spoofing), ignore.
        if (totalNotional < this.MIN_NOTIONAL_VALUE) {
            return;
        }

        // ============================================================
        // STEP 2: SMART VELOCITY BUFFER
        // ============================================================

        asset.priceHistory.push({ price: midPrice, time: now });

        // Prune history:
        // Remove ticks older than Window (30ms) + Buffer (200ms).
        // CRITICAL: We ensure we keep at least 2 ticks (length > 2).
        // This prevents the buffer from emptying on slow data feeds/stale markets.
        while (asset.priceHistory.length > 2 &&
               (now - asset.priceHistory[0].time > this.SPIKE_WINDOW_MS + 200)) {
            asset.priceHistory.shift();
        }

        // Baseline Selection:
        // We use the oldest available tick in our buffer to compare against.
        // Even if the feed is slow (e.g. last tick was 100ms ago), we use it as the baseline.
        const baselineTick = asset.priceHistory[0];

        // Calculate Velocity (Percentage Change)
        // Formula: (Current - Old) / Old
        const signedChange = (midPrice - baselineTick.price) / baselineTick.price;
        const absChange = Math.abs(signedChange);

        // ============================================================
        // STEP 3: VELOCITY GATE (The Filter)
        // ============================================================

        // If price hasn't moved 0.02%, stop immediately.
        // This saves CPU and filters out "creeping" trends.
        if (absChange < this.SPIKE_PERCENT) {
            return;
        }

        // Determine Direction of Movement
        const isVelocityUp = signedChange > 0;
        const isVelocityDown = signedChange < 0;

        // ============================================================
        // STEP 4: MICROPRICE CALCULATION
        // ============================================================

        // Formula: Volume-Weighted Microprice
        const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);

        const halfSpread = (Pa - Pb) / 2;
        if (halfSpread <= 1e-8) return; // Prevent div/0

        // Signal Strength: Normalized deviation from Midprice
        // Range: -1.0 (Bid Pressure) to +1.0 (Ask Pressure)
        const signalStrength = (microPrice - midPrice) / halfSpread;

        // ============================================================
        // STEP 5: CONFLUENCE CHECK & TRIGGER
        // ============================================================

        let side = null;

        // BUY SIGNAL:
        // 1. Microprice Imbalance > 0.6 (Strong Bid Support pushing up)
        // 2. Velocity is UP (Price actually moving Up)
        if (signalStrength > this.TRIGGER_THRESHOLD && isVelocityUp) {
            side = 'buy';
        }
        // SELL SIGNAL:
        // 1. Microprice Imbalance < -0.6 (Strong Ask Resistance pushing down)
        // 2. Velocity is DOWN (Price actually moving Down)
        else if (signalStrength < -this.TRIGGER_THRESHOLD && isVelocityDown) {
            side = 'sell';
        }

        // Logging (Heartbeat) - Only logs if we pass the velocity gate
        if (now - asset.lastLogTime > 5000) {
            this.logger.info(`[MICRO] ${symbol} | Vel:${(signedChange*100).toFixed(4)}% | Sig:${signalStrength.toFixed(2)} | Val:$${totalNotional.toFixed(0)}`);
            asset.lastLogTime = now;
        }

        // Execute Logic
        // We check:
        // 1. Valid Side
        // 2. No open position FOR THIS SPECIFIC ASSET
        // 3. No order currently being placed
        if (side && !this.bot.hasOpenPosition(symbol) && !this.bot.isOrderInProgress) {
            
            if (now - asset.lastTriggerTime < this.COOLDOWN_MS) return;

            this.logger.info(`[TRIGGER] ${symbol} ${side.toUpperCase()} | Vel:${(signedChange*100).toFixed(4)}% | Sig:${signalStrength.toFixed(3)}`);
            asset.lastTriggerTime = now;

            await this.executeTrade(symbol, side, Pa, Pb);
        }
    }

    async executeTrade(symbol, side, bestAsk, bestBid) {
        this.bot.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];

            // 1. Determine Entry Price (Aggressive IOC)
            // Buy = Ask Price | Sell = Bid Price
            const entryPrice = side === 'buy' ? bestAsk : bestBid;

            // 2. Calculate Dynamic 10-Tick Trail
            // BTC (Prec:1) -> Tick 0.1 -> Trail 1.0
            // XRP (Prec:4) -> Tick 0.0001 -> Trail 0.0010
            const tickSize = 1 / Math.pow(10, spec.precision);
            let trailAmount = 10 * tickSize;

            // 3. Apply Directional Sign
            // Buy: Stop is BELOW price (Negative)
            // Sell: Stop is ABOVE price (Positive)
            if (side === 'buy') {
                trailAmount = -trailAmount;
            }

            await this.bot.placeOrder({
                product_id: spec.deltaId.toString(),
                size: process.env.ORDER_SIZE || "1",
                side: side,
                order_type: 'limit_order',
                time_in_force: 'ioc',
                limit_price: entryPrice.toFixed(spec.precision),

                // --- 10-TICK TRAILING STOP ---
                // This activates immediately. If price moves in favor, it trails.
                // If price moves against by 10 ticks, it exits.
                bracket_trail_amount: trailAmount.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            });

        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = MicroStrategy;
        
