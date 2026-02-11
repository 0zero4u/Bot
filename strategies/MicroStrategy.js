/**
 * Strategy: Volume-Weighted Microprice (VWM)
 * FIXED VERSION:
 * 1. Window maintained at 30ms (User Requirement)
 * 2. Removed "Acceleration Trap" (Allows sustained high velocity)
 * 3. Fixed "Liquidity Laddering" bug (Uses Imbalance instead of raw volume history)
 * 4. Fixed API Payload (Removed limit_price from market_order)
 */

class MicroStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.TRIGGER_THRESHOLD = parseFloat(process.env.MICRO_THRESHOLD || '0.60');
        this.MIN_NOTIONAL_VALUE = parseFloat(process.env.MIN_NOTIONAL || '2000');
        this.TRAILING_PERCENT = parseFloat(process.env.TRAILING_PERCENT || '0.05');
        this.COOLDOWN_MS = 2000;

        // --- VELOCITY CONFIG ---
        this.SPIKE_PERCENT = 0.0000017;   
        this.SPIKE_WINDOW_MS = 30; // KEPT AT 30ms PER REQUEST

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
                prevHalfSpread: null
            };
        });
    }

    getName() {
        return `MicroStrategy (VWM + 30ms Tick + Corrected Logic)`;
    }

    /**
     * Called by Trader when a position closes to bypass COOLDOWN_MS
     */
    onPositionClose(symbol) {
        if (this.assets[symbol]) {
            this.assets[symbol].lastTriggerTime = 0;
            this.logger.info(`[STRATEGY] ${symbol} Timer reset. Ready for immediate entry.`);
        }
    }

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
        
        // 1. Notional Filter
        if ((Vb * Pb) + (Va * Pa) < this.MIN_NOTIONAL_VALUE) return;

        // --- Velocity Calculation (Strict 30ms Window) ---
        asset.priceHistory.push({ price: midPrice, time: now });
        
        // Cleanup old ticks (> 2x Window to be safe)
        while (asset.priceHistory.length > 0 && now - asset.priceHistory[0].time > this.SPIKE_WINDOW_MS * 2) {
            asset.priceHistory.shift();
        }

        // Find baseline tick (approx 30ms ago)
        let baselineTick = null;
        for (let i = 0; i < asset.priceHistory.length; i++) {
             if (now - asset.priceHistory[i].time <= this.SPIKE_WINDOW_MS) {
                 baselineTick = asset.priceHistory[i];
                 break;
             }
        }
        
        if (!baselineTick) return;

        const signedChange = (midPrice - baselineTick.price) / baselineTick.price;
        const absChange = Math.abs(signedChange);

        // 2. Minimum Velocity Threshold
        if (absChange < this.SPIKE_PERCENT) return;

        const isVelocityUp = signedChange > 0;
        const isVelocityDown = signedChange < 0;

        // [CORRECTION 1] Removed "Acceleration Trap"
        // We track velocity, but we DO NOT require it to be higher than the previous tick.
        // As long as it is above SPIKE_PERCENT, it is valid.
        asset.prevVelocity = signedChange;

        // --- Microprice & Imbalance ---
        const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);
        const halfSpread = (Pa - Pb) / 2;
        
        // Filter crossed books or zero spread errors
        if (halfSpread <= 1e-8) return;

        // 3. Spread Stability
        if (asset.prevHalfSpread !== null) {
            if (halfSpread > asset.prevHalfSpread * 1.05) return; // Allow 5% breath
        }
        asset.prevHalfSpread = halfSpread;

        const signalStrength = (microPrice - midPrice) / halfSpread;

        // 4. Pressure Confirmation
        const pressureFailing =
            (isVelocityUp && signalStrength < 0) ||
            (isVelocityDown && signalStrength > 0);

        if (pressureFailing) return;

        let side = null;

        // [CORRECTION 2] Liquidity Logic (Imbalance vs Raw Volume)
        // Check if the Order Book supports the move (Ratio) rather than raw volume history
        const totalL1Vol = Vb + Va;
        const bidRatio = Vb / totalL1Vol;

        if (signalStrength > this.TRIGGER_THRESHOLD && isVelocityUp) {
            // If buying, we want decent bid support (not < 30%)
            if (bidRatio < 0.3) return; 
            side = 'buy';
        }

        if (signalStrength < -this.TRIGGER_THRESHOLD && isVelocityDown) {
            // If selling, we want decent ask support (bid ratio shouldn't be huge > 70%)
            if (bidRatio > 0.7) return; 
            side = 'sell';
        }

        // Logging (Throttled)
        if (now - asset.lastLogTime > 5000) {
            this.logger.info(
                `[CONT] ${symbol} | Vel:${(signedChange * 100).toFixed(4)}% | Sig:${signalStrength.toFixed(2)} | Ratio:${bidRatio.toFixed(2)}`
            );
            asset.lastLogTime = now;
        }

        // Execution Trigger
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

            // Delta expects positive integer for trail amount usually, but string for API
            const trailAmount = trailDistance.toFixed(spec.precision);

            const clientOid = `c_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            this.bot.recordOrderPunch(clientOid);

            // [CORRECTION 3] Cleaned Market Order Payload
            // Removed 'limit_price' (invalid for market_order)
            const payload = {
                product_id: spec.deltaId.toString(),
                size: process.env.ORDER_SIZE || "1",
                side: side,
                order_type: 'market_order',
                bracket_trail_amount: trailAmount,
                bracket_stop_trigger_method: 'mark_price',
                client_order_id: clientOid
            };

            await this.bot.placeOrder(payload);

            this.logger.info(
                `[EXEC_CONT] ${symbol} ${side} @ ${entryPrice} | Trail:${trailAmount} | OID:${clientOid}`
            );
        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = MicroStrategy;
    
