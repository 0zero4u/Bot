/**
 * MicroStrategy.js
 *
 * Strategy: Volume-Weighted Microprice (VWM)
 * with Directional Velocity Gating & Server-Side Trailing Stop.
 * * CORE LOGIC:
 * 1. Normalized Liquidity: Filters out "dust" (requires ~$2000 USDT on L1).
 * 2. Velocity Gate: Requires price to move > 0.02% in ~30ms to wake up.
 * 3. Microprice Imbalance: Calculates weighted pressure of the order book.
 * 4. Directional Confluence: Trades ONLY if Microprice & Velocity agree.
 * 5. Execution: Limit IOC with a Server-Side Percentage Trailing Stop.
 */

class MicroStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---

        // Signal Strength Threshold
        // 0.65 means Microprice has moved 65% across the spread toward the other side.
        this.TRIGGER_THRESHOLD = parseFloat(process.env.MICRO_THRESHOLD || '0.90');

        // Liquidity Filter: Minimum TOTAL value on L1 (Bid + Ask) in USDT.
        // We sum them to allow for heavy imbalances (e.g., huge Buy wall, empty Sell side).
        this.MIN_NOTIONAL_VALUE = parseFloat(process.env.MIN_NOTIONAL || '2000');

        // Trailing Stop Configuration (Percentage Based)
        // 0.005% = The price only needs to dip 0.005% from its peak to trigger the exit.
        // This is calculated dynamically based on Entry Price at the moment of the trade.
        this.TRAILING_PERCENT = parseFloat(process.env.TRAILING_PERCENT || '0.02');

        this.COOLDOWN_MS = 2000;

        // --- VELOCITY GATE CONFIG ---
        // Prevents trading in chopping/stagnant markets.
        this.SPIKE_PERCENT = 0.0003;   // 0.03% Price Move required
        this.SPIKE_WINDOW_MS = 30;     // 30ms Time Window

        this.assets = {};

        // Asset Specs (Delta Exchange Standard)
        // precision: Decimals for price
        // deltaId: Product ID for API
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
                priceHistory: [] // Buffer for velocity calculation
            };
        });
    }

    getName() {
        return `MicroStrategy (VWM + Vel + ${this.TRAILING_PERCENT}% Server-Trail)`;
    }

    /**
     * Main Signal Loop
     * Runs on every Order Book update (approx 5-20ms).
     */
    async onDepthUpdate(symbol, depth) {
        const asset = this.assets[symbol];
        if (!asset) return;
        
        // Safety: Ensure book has data
        if (!depth.bids[0] || !depth.asks[0]) return;

        const now = Date.now();
        
        // Parse L1 Data
        const Pb = parseFloat(depth.bids[0][0]); // Best Bid Price
        const Vb = parseFloat(depth.bids[0][1]); // Best Bid Volume
        const Pa = parseFloat(depth.asks[0][0]); // Best Ask Price
        const Va = parseFloat(depth.asks[0][1]); // Best Ask Volume

        const midPrice = (Pa + Pb) / 2;
        const totalNotional = (Vb * Pb) + (Va * Pa);

        // 1. Liquidity Filter
        if (totalNotional < this.MIN_NOTIONAL_VALUE) return;

        // 2. Velocity Buffer Management
        asset.priceHistory.push({ price: midPrice, time: now });
        // Keep only recent ticks within window + buffer
        while (asset.priceHistory.length > 2 &&
               (now - asset.priceHistory[0].time > this.SPIKE_WINDOW_MS + 200)) {
            asset.priceHistory.shift();
        }

        const baselineTick = asset.priceHistory[0];
        const signedChange = (midPrice - baselineTick.price) / baselineTick.price;
        const absChange = Math.abs(signedChange);

        // 3. Velocity Gate Check
        if (absChange < this.SPIKE_PERCENT) return;

        const isVelocityUp = signedChange > 0;
        const isVelocityDown = signedChange < 0;

        // 4. Microprice Calculation
        // VWM = (BidVol * AskPx + AskVol * BidPx) / (BidVol + AskVol)
        const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);
        const halfSpread = (Pa - Pb) / 2;
        
        // Avoid division by zero in tight spreads
        if (halfSpread <= 1e-8) return; 

        // Signal Strength = (Microprice - Midprice) / HalfSpread
        // Range: -1.0 to 1.0 (approximated)
        const signalStrength = (microPrice - midPrice) / halfSpread;

        let side = null;

        // 5. Confluence Check (Signal + Velocity Direction)
        if (signalStrength > this.TRIGGER_THRESHOLD && isVelocityUp) {
            side = 'buy';
        } else if (signalStrength < -this.TRIGGER_THRESHOLD && isVelocityDown) {
            side = 'sell';
        }

        // Heartbeat Logging (every 5s)
        if (now - asset.lastLogTime > 5000) {
            this.logger.info(`[MICRO] ${symbol} | Vel:${(signedChange*100).toFixed(4)}% | Sig:${signalStrength.toFixed(2)}`);
            asset.lastLogTime = now;
        }

        // 6. Trigger Logic
        if (side && !this.bot.hasOpenPosition(symbol) && !this.bot.isOrderInProgress) {
            // Cooldown Check
            if (now - asset.lastTriggerTime < this.COOLDOWN_MS) return;
            
            this.logger.info(`[TRIGGER] ${symbol} ${side.toUpperCase()} | Vel:${(signedChange*100).toFixed(4)}% | Sig:${signalStrength.toFixed(3)}`);
            asset.lastTriggerTime = now;

            await this.executeTrade(symbol, side, Pa, Pb);
        }
    }

    /**
     * Execution Logic
     * Places an IOC Limit Order with a Server-Side Trailing Stop.
     */
    async executeTrade(symbol, side, bestAsk, bestBid) {
        this.bot.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];

            // A. Determine Entry Price
            // Aggressive IOC: Buy at Ask, Sell at Bid to ensure fill on velocity spike
            const entryPrice = side === 'buy' ? bestAsk : bestBid;

            // B. Calculate Trailing Amount (Absolute Distance)
            // Formula: EntryPrice * (Percent / 100)
            let trailDistance = entryPrice * (this.TRAILING_PERCENT / 100);

            // C. Minimum Tick Safety
            // Ensure the trail distance is at least 1 tick, otherwise API rejects it.
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDistance < tickSize) {
                trailDistance = tickSize;
            }

            // --- FIX START: Apply Negative Sign for Buy Orders ---
            // Delta Exchange API requires negative trail amount for Buy orders 
            // (Stop Price = Mark Price + Amount). Since we want Stop < Mark for Buys, Amount must be negative.
            let signedTrailAmount = trailDistance;
            if (side === 'buy') {
                signedTrailAmount = -trailDistance;
            }
            // --- FIX END ---

            const size = process.env.ORDER_SIZE || "1";

            // D. Construct Payload
            // Using 'bracket_trail_amount' delegates management to the exchange.
            // We DO NOT send 'bracket_stop_loss_price'.
            const payload = {
                product_id: spec.deltaId.toString(),
                size: size,
                side: side,
                order_type: 'limit_order',
                time_in_force: 'ioc', // Immediate or Cancel
                limit_price: entryPrice.toFixed(spec.precision),
                
                // --- SERVER-SIDE TRAILING STOP ---
                // "bracket_trail_amount": The signed distance (e.g., -0.05 for buy, 0.05 for sell).
                // The exchange engine automatically adjusts the stop price.
                bracket_trail_amount: signedTrailAmount.toFixed(spec.precision),
                bracket_stop_trigger_method: 'mark_price'
            };

            // E. Send Order
            await this.bot.placeOrder(payload);

            this.logger.info(`[EXEC] ${symbol} ${side} @ ${entryPrice} | ServerTrail: ${signedTrailAmount.toFixed(spec.precision)} (${this.TRAILING_PERCENT}%)`);

        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = MicroStrategy;
