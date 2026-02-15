/**
 * AdvanceStrategy.js
 * v82.0 - FLOW-BASED MICROSTRUCTURE ARBITRAGE
 * * CORE LOGIC CHANGES:
 * 1. DEPLETION SIGNAL: Tracks 'Volume Since Update'. If (Vol > Limit), assumes liquidity is ghosted.
 * 2. HIERARCHY: Trade-Through > Aggressive Trades > Fair Value.
 * 3. ZONING: 
 * - GOLD (20-40ms): 1.2x Size
 * - SILVER (40-60ms): 1.0x Size
 * - BRONZE (60-75ms): 0.5x Size
 * 4. 3ms REVERSAL CHECK: Hard abort if Ex2 ticks against us in final moments.
 */

class PriceHistory {
    constructor(retentionMs = 200) {
        this.buffer = []; 
        this.retentionMs = retentionMs;
    }

    add(price) {
        const now = Date.now();
        this.buffer.push({ price, ts: now });
        if (this.buffer.length > 50) this.buffer.shift(); // Keep buffer small/fast
    }

    // Returns price change in last N ms
    getTrend(msAgo) {
        const now = Date.now();
        const target = now - msAgo;
        // Find closest snapshot strictly BEFORE or AT target
        let pastPrice = null;
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            if (this.buffer[i].ts <= target) {
                pastPrice = this.buffer[i].price;
                break;
            }
        }
        if (pastPrice === null && this.buffer.length > 0) pastPrice = this.buffer[0].price;
        if (pastPrice === null) return 0;
        
        const currentPrice = this.buffer[this.buffer.length - 1].price;
        return currentPrice - pastPrice;
    }
}

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- MICROSTRUCTURE SETTINGS ---
        this.TIME_NOISE = 15;      // Skip < 15ms (Noise)
        this.TIME_GOLD_END = 40;   // 15-40ms (Best edge)
        this.TIME_SILVER_END = 60; // 40-60ms (Good edge)
        this.TIME_BRONZE_END = 75; // 60-75ms (Risk/Late)
        
        this.FRESHNESS_LIMIT_MS = 20; // Trade-through valid only if < 20ms old
        
        // --- DEPLETION SETTINGS ---
        // If accumulated volume > (OurLot * Ratio), assume level is dead
        this.DEPLETION_RATIO = 2.0; 

        // --- RISK SETTINGS ---
        this.ENTRY_BUFFER_TICKS = 2;   
        this.TRAILING_PERCENT = 0.035; 
        this.TP_PERCENT = 0.0090; 
        this.LOCK_DURATION_MS = 5000;    

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: 0.002, minLot: 0.001, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, lot: 0.02,  minLot: 0.01,  tickSize: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: 20,    minLot: 10,    tickSize: 0.0001 },
            'SOL': { deltaId: 417,   precision: 3, lot: 0.2,   minLot: 0.1,   tickSize: 0.001 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        this.assets = {};
        
        targets.forEach(symbol => {
            if (this.specs[symbol]) {
                this.assets[symbol] = {
                    // Exchange 1 (Delta)
                    ex1Bid: 0, ex1Ask: 0,
                    ex1UpdateTs: 0,
                    
                    // FLOW TRACKING (Reset on Quote Update)
                    volSinceUpdateBuy: 0, // Volume of trades hitting ASK
                    volSinceUpdateSell: 0,// Volume of trades hitting BID
                    
                    // Trade-Through State
                    lastTradePrice: 0,
                    lastTradeTs: 0,
                    
                    // Exchange 2 (Binance)
                    ex2Mid: 0,
                    history: new PriceHistory(100),
                    
                    basis: 0,
                    lockedUntil: 0,
                    initialized: false
                };
            }
        });

        this.stats = { signals: 0, fills: 0, misses: 0 };
        this.logger.info(`[Strategy] Loaded V82.0 (FLOW + ZONING)`);
    }

    getName() { return "AdvanceStrategy (V82.0 Flow)"; }

    async start() {
        this.logger.info(`[Strategy] 🟢 V82 Engine Started.`);
    }

    /**
     * HANDLER 1: Delta Quote Update (The Reset)
     * When this happens, we know the matching engine has "flushed" previous trades.
     */
    onExchange1Quote(msg) {
        if (!msg.symbol) return;
        const asset = Object.keys(this.assets).find(k => msg.symbol.includes(k));
        if (!asset) return;

        const data = this.assets[asset];
        
        data.ex1Bid = parseFloat(msg.bid || msg.best_bid || 0);
        data.ex1Ask = parseFloat(msg.ask || msg.best_ask || 0);
        
        // CRITICAL: Reset Volume Counters
        // New BBO means previous trade volume is now "priced in"
        data.volSinceUpdateBuy = 0;
        data.volSinceUpdateSell = 0;
        
        data.ex1UpdateTs = Date.now(); 
        if (!data.initialized && data.ex1Bid > 0) data.initialized = true;
    }

    /**
     * HANDLER 2: Delta Trade Execution (The Depletion Tracker)
     */
    onLaggerTrade(trade) {
        const price = parseFloat(trade.price);
        const size = parseFloat(trade.size || trade.qty || 0);
        const side = trade.side; // 'buy' or 'sell'
        
        const asset = Object.keys(this.assets).find(k => trade.symbol && trade.symbol.includes(k));
        if (!asset) return;

        const data = this.assets[asset];
        
        // Update Trade-Through State
        data.lastTradePrice = price;
        data.lastTradeTs = Date.now();

        // Update Basis
        if (data.ex2Mid > 0) data.basis = price - data.ex2Mid;

        // ACCUMULATE AGGRESSIVE VOLUME
        // Note: A 'buy' side trade on Delta means someone lifted the ASK.
        if (side === 'buy') {
            data.volSinceUpdateBuy += size;
        } else {
            data.volSinceUpdateSell += size;
        }
    }

    /**
     * HANDLER 3: Binance Depth Update (The Driver)
     */
    onDepthUpdate(update) {
        const asset = update.s;
        const data = this.assets[asset];
        const spec = this.specs[asset];
        
        if (!data || !data.initialized || this.bot.isOrderInProgress) return;
        if (this.bot.hasOpenPosition(asset)) return;
        
        const now = Date.now();
        if (now < data.lockedUntil) return;

        // 1. Update Binance State
        const bb = parseFloat(update.bb);
        const ba = parseFloat(update.ba);
        data.ex2Mid = (bb + ba) / 2;
        data.history.add(data.ex2Mid);

        // 2. CHECK TIME ZONE
        const dt = now - data.ex1UpdateTs;

        // Filter Noise & Late
        if (dt < this.TIME_NOISE || dt > this.TIME_BRONZE_END) return;

        // 3. DEPLETION CHECK (Ghost Liquidity)
        // If we want to BUY, we check if others have already bought too much
        const maxVol = spec.lot * this.DEPLETION_RATIO;
        const isAskDepleted = data.volSinceUpdateBuy > maxVol;
        const isBidDepleted = data.volSinceUpdateSell > maxVol;

        // 4. SIGNAL GENERATION
        let signal = null;
        let signalType = '';

        const bufferVal = spec.tickSize * this.ENTRY_BUFFER_TICKS;
        const fairEx1 = data.ex2Mid + data.basis;
        const isFreshTrade = (now - data.lastTradeTs) < this.FRESHNESS_LIMIT_MS;

        // --- HIERARCHY 1: TRADE-THROUGH (The "Gold" Signal) ---
        if (isFreshTrade) {
            if (data.lastTradePrice >= data.ex1Ask) {
                // Price moved UP. Check if ask is still alive.
                if (!isAskDepleted) {
                    signal = 'buy';
                    signalType = 'TRADE_THROUGH';
                }
            } else if (data.lastTradePrice <= data.ex1Bid && data.lastTradePrice > 0) {
                // Price moved DOWN. Check if bid is still alive.
                if (!isBidDepleted) {
                    signal = 'sell';
                    signalType = 'TRADE_THROUGH';
                }
            }
        }

        // --- HIERARCHY 2: FAIR VALUE DEVIATION ---
        if (!signal) {
            if (fairEx1 > (data.ex1Ask + bufferVal)) {
                 if (!isAskDepleted) {
                     signal = 'buy';
                     signalType = 'FV_DEVIATION';
                 }
            } else if (fairEx1 < (data.ex1Bid - bufferVal)) {
                 if (!isBidDepleted) {
                     signal = 'sell';
                     signalType = 'FV_DEVIATION';
                 }
            }
        }

        if (!signal) return;

        // 5. MICRO-REVERSAL FILTER (3ms)
        // "If last 3ms tick opposite -> cancel"
        const trend3ms = data.history.getTrend(3); // Change in last 3ms
        
        if (signal === 'buy') {
            if (trend3ms < 0) { // Price ticking down in last 3ms
                // this.logger.debug(`[Filter] 3ms Reversal prevented BUY on ${asset}`);
                return; 
            }
        } else {
            if (trend3ms > 0) { // Price ticking up in last 3ms
                // this.logger.debug(`[Filter] 3ms Reversal prevented SELL on ${asset}`);
                return;
            }
        }

        // 6. ZONE SIZING (Time-Weighted Aggression)
        let sizeMult = 1.0;
        let zoneName = 'SILVER';

        if (dt <= this.TIME_GOLD_END) {
            sizeMult = 1.2; // Aggressive Early
            zoneName = 'GOLD';
        } else if (dt > this.TIME_SILVER_END) {
            sizeMult = 0.5; // Conservative Late
            zoneName = 'BRONZE';
        }

        // 7. EXECUTE
        this.executeSniper(asset, signal, fairEx1, dt, sizeMult, signalType, zoneName);
    }

    async executeSniper(asset, side, fairPrice, dt, sizeMult, type, zone) {
        this.bot.isOrderInProgress = true;
        this.stats.signals++;

        const spec = this.specs[asset];
        const data = this.assets[asset];

        try {
            data.lockedUntil = Date.now() + this.LOCK_DURATION_MS;
            
            // Calculate Sizing
            let finalSize = spec.lot * sizeMult;
            if (finalSize < spec.minLot) finalSize = spec.minLot;

            // Quote Price for TP/SL ref
            const quotePrice = side === 'buy' ? data.ex1Ask : data.ex1Bid;
            
            this.logger.info(`[Sniper] ⚡ ${asset} ${side.toUpperCase()} | Type: ${type} | Zone: ${zone} (${dt}ms) | Size: ${finalSize.toFixed(3)}`);

            // TP & SL Calculation
            let trailValue = quotePrice * (this.TRAILING_PERCENT / 100);
            trailValue = side === 'buy' ? -Math.abs(trailValue) : Math.abs(trailValue);
            
            let tpPrice = (side === 'buy') 
                ? quotePrice * (1 + this.TP_PERCENT) 
                : quotePrice * (1 - this.TP_PERCENT);

            const payload = { 
                product_id: spec.deltaId.toString(), 
                size: finalSize.toFixed(6), 
                side: side, 
                order_type: 'market_order',              
                bracket_trail_amount: trailValue.toFixed(spec.precision), 
                bracket_take_profit_price: tpPrice.toFixed(spec.precision), 
                bracket_stop_trigger_method: 'mark_price', 
                client_order_id: `snipe_${Date.now()}`
            };
            
            const startT = Date.now();
            const orderResult = await this.bot.placeOrder(payload);
            const execTime = Date.now() - startT;

            if (orderResult && orderResult.success) {
                 this.stats.fills++;
                 this.logger.info(`[Sniper] 🎯 FILLED ${asset} | Exec: ${execTime}ms`);
            } else {
                this.stats.misses++;
            }

        } catch (error) {
            this.stats.misses++;
            this.logger.error(`[Sniper] ❌ EXEC FAIL: ${error.message}`);
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }
}
module.exports = AdvanceStrategy;
            
