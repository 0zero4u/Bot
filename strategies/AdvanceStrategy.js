/**
 * AdvanceStrategy.js
 * v83.1 - BINARY SNIPER (ENV ORDER SIZE)
 * * LOGIC:
 * 1. BINARY ENTRY: Either we are in the safe window (15-60ms) or we don't trade.
 * 2. NO GAMBLING: No "half size" trades in the danger zone.
 * 3. LIQUIDITY SYNC: Size is capped by BBO quantity to prevent slippage.
 * 4. DYNAMIC SIZING: Base lot size can be overridden via process.env.ORDER_SIZE
 */

class PriceHistory {
    constructor(retentionMs = 200) {
        this.buffer = []; 
        this.retentionMs = retentionMs;
    }

    add(price) {
        const now = Date.now();
        this.buffer.push({ price, ts: now });
        if (this.buffer.length > 50) this.buffer.shift(); 
    }

    // Returns price change in last N ms
    getTrend(msAgo) {
        const now = Date.now();
        const target = now - msAgo;
        let pastPrice = null;
        for (let i = this.buffer.length - 1; i >= 0; i--) {
            if (this.buffer[i].ts <= target) {
                pastPrice = this.buffer[i].price;
                break;
            }
        }
        if (pastPrice === null && this.buffer.length > 0) pastPrice = this.buffer[0].price;
        if (pastPrice === null) return 0;
        return this.buffer[this.buffer.length - 1].price - pastPrice;
    }
}

class AdvanceStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;

        // --- BINARY TIMING (STRICT) ---
        this.TIME_NOISE = 15;      // Wait for WS jitter to settle
        this.TIME_KILL = 65;       // HARD CUTOFF. 66ms+ = NO TRADE.
        
        this.FRESHNESS_LIMIT_MS = 20; 
        this.DEPLETION_RATIO = 2.0; 

        // --- RISK SETTINGS ---
        this.ENTRY_BUFFER_TICKS = 6;   
        this.TRAILING_PERCENT = 0.035; 
        this.TP_PERCENT = 0.00075; 
        this.LOCK_DURATION_MS = 5000;    

        // --- DYNAMIC ENV SIZE ---
        // Reads ORDER_SIZE from .env, defaults to null if not set
        const envSize = process.env.ORDER_SIZE ? parseFloat(process.env.ORDER_SIZE) : null;

        this.specs = {
            'BTC': { deltaId: 27,    precision: 1, lot: envSize || 0.002, minLot: envSize ? envSize * 0.5 : 0.001, tickSize: 0.1 },
            'ETH': { deltaId: 299,   precision: 2, lot: envSize || 0.02,  minLot: envSize ? envSize * 0.5 : 0.01,  tickSize: 0.01 },
            'XRP': { deltaId: 14969, precision: 4, lot: envSize || 20,    minLot: envSize ? envSize * 0.5 : 10,    tickSize: 0.0001 },
            'SOL': { deltaId: 417,   precision: 3, lot: envSize || 0.2,   minLot: envSize ? envSize * 0.5 : 0.1,   tickSize: 0.001 }
        };

        const targets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        this.assets = {};
        
        targets.forEach(symbol => {
            if (this.specs[symbol]) {
                this.assets[symbol] = {
                    ex1Bid: 0, ex1Ask: 0,
                    ex1BidSize: 0, ex1AskSize: 0, // Track liquidity
                    ex1UpdateTs: 0,
                    volSinceUpdateBuy: 0, 
                    volSinceUpdateSell: 0,
                    lastTradePrice: 0,
                    lastTradeTs: 0,
                    ex2Mid: 0,
                    history: new PriceHistory(100),
                    basis: 0,
                    lockedUntil: 0,
                    initialized: false
                };
            }
        });

        this.stats = { signals: 0, fills: 0, misses: 0 };
        this.logger.info(`[Strategy] Loaded V83.1 (BINARY SNIPER) | ENV Size: ${envSize ? envSize : 'Default'}`);
    }

    getName() { return "AdvanceStrategy (V83.1 Binary)"; }

    async start() {
        this.logger.info(`[Strategy] 🟢 V83.1 Engine Started.`);
    }

    onExchange1Quote(msg) {
        if (!msg.symbol) return;
        const asset = Object.keys(this.assets).find(k => msg.symbol.includes(k));
        if (!asset) return;

        const data = this.assets[asset];
        
        data.ex1Bid = parseFloat(msg.bid || msg.best_bid || 0);
        data.ex1Ask = parseFloat(msg.ask || msg.best_ask || 0);
        
        // Capture Liquidity Size for capping
        data.ex1BidSize = parseFloat(msg.bid_size || msg.bid_qty || 0);
        data.ex1AskSize = parseFloat(msg.ask_size || msg.ask_qty || 0);
        
        data.volSinceUpdateBuy = 0;
        data.volSinceUpdateSell = 0;
        data.ex1UpdateTs = Date.now(); 
        if (!data.initialized && data.ex1Bid > 0) data.initialized = true;
    }

    onLaggerTrade(trade) {
        const price = parseFloat(trade.price);
        const size = parseFloat(trade.size || trade.qty || 0);
        const side = trade.side; 
        const asset = Object.keys(this.assets).find(k => trade.symbol && trade.symbol.includes(k));
        if (!asset) return;

        const data = this.assets[asset];
        data.lastTradePrice = price;
        data.lastTradeTs = Date.now();

        if (data.ex2Mid > 0) data.basis = price - data.ex2Mid;

        if (side === 'buy') data.volSinceUpdateBuy += size;
        else data.volSinceUpdateSell += size;
    }

    onDepthUpdate(update) {
        const asset = update.s;
        const data = this.assets[asset];
        const spec = this.specs[asset];
        
        if (!data || !data.initialized || this.bot.isOrderInProgress) return;
        if (this.bot.hasOpenPosition(asset)) return;
        
        const now = Date.now();
        if (now < data.lockedUntil) return;

        const bb = parseFloat(update.bb);
        const ba = parseFloat(update.ba);
        data.ex2Mid = (bb + ba) / 2;
        data.history.add(data.ex2Mid);

        const dt = now - data.ex1UpdateTs;

        // --- BINARY FILTER ---
        // 1. Too Early? (Noise)
        if (dt < this.TIME_NOISE) return;
        // 2. Too Late? (Danger Zone)
        if (dt > this.TIME_KILL) return;

        // Depletion Logic
        const maxVol = spec.lot * this.DEPLETION_RATIO;
        const isAskDepleted = data.volSinceUpdateBuy > maxVol;
        const isBidDepleted = data.volSinceUpdateSell > maxVol;

        let signal = null;
        let signalType = '';
        const bufferVal = spec.tickSize * this.ENTRY_BUFFER_TICKS;
        const fairEx1 = data.ex2Mid + data.basis;
        const isFreshTrade = (now - data.lastTradeTs) < this.FRESHNESS_LIMIT_MS;

        // SIGNAL 1: FRESH TRADE-THROUGH
        if (isFreshTrade) {
            if (data.lastTradePrice >= data.ex1Ask && !isAskDepleted) {
                signal = 'buy'; signalType = 'TRADE_THROUGH';
            } else if (data.lastTradePrice <= data.ex1Bid && data.lastTradePrice > 0 && !isBidDepleted) {
                signal = 'sell'; signalType = 'TRADE_THROUGH';
            }
        }

        // SIGNAL 2: FAIR VALUE
        if (!signal) {
            if (fairEx1 > (data.ex1Ask + bufferVal) && !isAskDepleted) {
                signal = 'buy'; signalType = 'FV_DEVIATION';
            } else if (fairEx1 < (data.ex1Bid - bufferVal) && !isBidDepleted) {
                signal = 'sell'; signalType = 'FV_DEVIATION';
            }
        }

        if (!signal) return;

        // 3ms Reversal Filter
        const trend3ms = data.history.getTrend(3);
        if (signal === 'buy' && trend3ms < 0) return; 
        if (signal === 'sell' && trend3ms > 0) return;

        this.executeSniper(asset, signal, fairEx1, dt, signalType);
    }

    async executeSniper(asset, side, fairPrice, dt, type) {
        this.bot.isOrderInProgress = true;
        this.stats.signals++;

        const spec = this.specs[asset];
        const data = this.assets[asset];

        try {
            data.lockedUntil = Date.now() + this.LOCK_DURATION_MS;
            
            // --- LIQUIDITY-AWARE SIZING ---
            let available = (side === 'buy') ? data.ex1AskSize : data.ex1BidSize;
            if (!available || available <= 0) available = spec.lot;
            
            let finalSize = Math.min(spec.lot, available); 
            if (finalSize < spec.minLot) finalSize = spec.minLot;

            const quotePrice = side === 'buy' ? data.ex1Ask : data.ex1Bid;
            
            this.logger.info(`[Sniper] ⚡ ${asset} ${side.toUpperCase()} | Type: ${type} | T+${dt}ms | Size: ${finalSize.toFixed(4)}`);

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
                
