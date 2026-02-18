/**
 * MicroStrategy.js
 * v14.0 - ADAPTIVE VOLATILITY (The Scholar)
 * * LOGIC:
 * 1. Adaptive Threshold: Replaces static 0.03% with (2 * StandardDeviation).
 * 2. Volatility Floor: Never goes below 0.005% to avoid noise.
 * 3. 30ms Window: Kept strict.
 */

class MicroStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- CONFIGURATION ---
        this.TRIGGER_THRESHOLD = parseFloat(process.env.MICRO_THRESHOLD || '0.60');
        this.MIN_NOTIONAL_VALUE = parseFloat(process.env.MIN_NOTIONAL || '2000');
        this.TRAILING_PERCENT = parseFloat(process.env.TRAILING_PERCENT || '0.02'); 
        this.COOLDOWN_MS = 30000;

        // --- ADAPTIVE SETTINGS ---
        this.VOLATILITY_WINDOW_SIZE = 1000; // Look at last ~1.5 seconds (30ms * 50)
        this.SIGMA_MULTIPLIER = 3.1;      // Trigger = 2 * Volatility
        this.MIN_VOLATILITY = 0.000025;    // Floor: 0.005% (Minimum required move)
        
        // Window for the velocity calculation itself
        this.SPIKE_WINDOW_MS = 30; 

        this.assets = {};

        // Delta Exchange Specs
        const envSize = process.env.ORDER_SIZE ? parseFloat(process.env.ORDER_SIZE) : null;
        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: envSize || 0.001, minLot: 0.001 },
            'ETH': { deltaId: 299,   precision: 2, lot: envSize || 0.01,  minLot: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: envSize || 10,    minLot: 1 },
            'SOL': { deltaId: 417,   precision: 3, lot: envSize || 0.1,   minLot: 0.1 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        targets.forEach(symbol => {
            if (this.specs[symbol]) {
                this.assets[symbol] = {
                    lastTriggerTime: 0,
                    lastLogTime: 0,
                    priceHistory: [],      // Stores {price, time}
                    returnsBuffer: [],     // Stores % changes for Volatility Calc
                    prevVelocity: null,
                    prevHalfSpread: null
                };
            }
        });
        
        this.logger.info(`[MicroStrategy] v14.0 ADAPTIVE | Sigma: ${this.SIGMA_MULTIPLIER}x | MinFloor: ${this.MIN_VOLATILITY*100}%`);
    }

    getName() {
        return `MicroStrategy (Adaptive Volatility)`;
    }

    onPositionClose(symbol) {
        if (this.assets[symbol]) {
            this.assets[symbol].lastTriggerTime = 0;
            this.logger.info(`[STRATEGY] ${symbol} Timer reset.`);
        }
    }

    onExchange1Quote(msg) {} 
    onLaggerTrade(trade) {}

    async onDepthUpdate(update) {
        const symbol = update.s;
        const asset = this.assets[symbol];
        if (!asset || this.bot.isOrderInProgress || this.bot.hasOpenPosition(symbol)) return;

        const now = Date.now();
        const Pb = parseFloat(update.bb);
        const Vb = parseFloat(update.bq);
        const Pa = parseFloat(update.ba);
        const Va = parseFloat(update.aq);

        if (isNaN(Pb) || isNaN(Pa) || Pb === 0 || Pa === 0) return;
        const midPrice = (Pa + Pb) / 2;
        
        // 1. Notional Filter
        if ((Vb * Pb) + (Va * Pa) < this.MIN_NOTIONAL_VALUE) return;

        // --- HISTORY MANAGEMENT ---
        asset.priceHistory.push({ price: midPrice, time: now });
        
        // Calculate Return (Current vs Previous Tick)
        // We only calculate if we have at least 2 ticks
        if (asset.priceHistory.length > 1) {
            const prevPrice = asset.priceHistory[asset.priceHistory.length - 2].price;
            const ret = (midPrice - prevPrice) / prevPrice;
            asset.returnsBuffer.push(ret);
        }

        // Keep buffers clean (Max 50 items)
        if (asset.priceHistory.length > this.VOLATILITY_WINDOW_SIZE) asset.priceHistory.shift();
        if (asset.returnsBuffer.length > this.VOLATILITY_WINDOW_SIZE) asset.returnsBuffer.shift();

        // --- CALCULATE VOLATILITY (StdDev) ---
        // 1. Mean of Returns
        let sum = 0;
        for (let r of asset.returnsBuffer) sum += r;
        const mean = asset.returnsBuffer.length > 0 ? sum / asset.returnsBuffer.length : 0;

        // 2. Variance -> StdDev
        let sqDiffSum = 0;
        for (let r of asset.returnsBuffer) sqDiffSum += (r - mean) ** 2;
        const variance = asset.returnsBuffer.length > 0 ? sqDiffSum / asset.returnsBuffer.length : 0;
        const volatility = Math.sqrt(variance);

        // 3. Define Dynamic Threshold
        // It is EITHER (2 * Volatility) OR (The Floor), whichever is HIGHER.
        const dynamicThreshold = Math.max(volatility * this.SIGMA_MULTIPLIER, this.MIN_VOLATILITY);

        // --- VELOCITY CALCULATION (30ms) ---
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

        // --- LOGGING (Every 5s) ---
        if (now - asset.lastLogTime > 5000) {
            const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);
            const spread = Pa - Pb;
            const signalStrength = spread > 1e-8 ? (microPrice - midPrice) / (spread/2) : 0;
            
            this.logger.info(
                `[ADAPT] ${symbol} | Vel:${(signedChange * 100).toFixed(4)}% | Thresh:${(dynamicThreshold * 100).toFixed(4)}% | Vol:${(volatility*100).toFixed(4)}% | Sig:${signalStrength.toFixed(2)}`
            );
            asset.lastLogTime = now;
        }

        // --- THE TRIGGER ---
        // Compare Velocity vs Dynamic Threshold
        if (absChange < dynamicThreshold) return;

        // ... [Rest of logic remains identical] ...
        const isVelocityUp = signedChange > 0;
        const isVelocityDown = signedChange < 0;
        asset.prevVelocity = signedChange;

        const microPrice = ((Vb * Pa) + (Va * Pb)) / (Vb + Va);
        const halfSpread = (Pa - Pb) / 2;
        if (halfSpread <= 1e-8) return;

        if (asset.prevHalfSpread !== null) {
            if (halfSpread > asset.prevHalfSpread * 1.05) return; 
        }
        asset.prevHalfSpread = halfSpread;

        const signalStrength = (microPrice - midPrice) / halfSpread;

        const pressureFailing =
            (isVelocityUp && signalStrength < 0) ||
            (isVelocityDown && signalStrength > 0);

        if (pressureFailing) return;

        let side = null;
        if (signalStrength > this.TRIGGER_THRESHOLD && isVelocityUp) side = 'buy';
        if (signalStrength < -this.TRIGGER_THRESHOLD && isVelocityDown) side = 'sell';

        if (side) {
            if (now - asset.lastTriggerTime < this.COOLDOWN_MS) return;
            asset.lastTriggerTime = now;
            await this.executeTrade(symbol, side, Pa, Pb);
        }
    }

    async executeTrade(symbol, side, bestAsk, bestBid) {
        this.bot.isOrderInProgress = true;
        try {
            const spec = this.specs[symbol];
            const quotePrice = side === 'buy' ? bestAsk : bestBid;
            
            // Hard SL / Trail Logic
            let trailDist = Math.abs(quotePrice * (this.TRAILING_PERCENT / 100));
            const tickSize = 1 / Math.pow(10, spec.precision);
            if (trailDist < tickSize) trailDist = tickSize;
            
            const finalTrailAmount = side === 'buy' ? -trailDist : trailDist;
            const trailAmountStr = finalTrailAmount.toFixed(spec.precision);
            const clientOid = `micro_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

            const payload = {
                product_id: spec.deltaId.toString(),
                size: spec.lot.toString(),
                side: side,
                order_type: 'market_order',
                bracket_trail_amount: trailAmountStr,
                bracket_stop_trigger_method: 'last_traded_price', 
                client_order_id: clientOid
            };

            this.bot.recordOrderPunch(clientOid);
            await this.bot.placeOrder(payload);

            this.logger.info(
                `[EXEC_ADAPT] ⚡ ${symbol} ${side} @ ${quotePrice} | Thresh Used:${(Math.abs(this.assets[symbol].prevVelocity)*100).toFixed(4)}%`
            );
        } catch (e) {
            this.logger.error(`[EXEC_FAIL] ${e.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}

module.exports = MicroStrategy;
                
