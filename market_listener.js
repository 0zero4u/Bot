/**
 * market_listener.js
 * Unified Market Data Adapter
 * Sources: 
 * 0: Binance Futures (Low Latency BookTicker)
 * 1: Gate.io Futures (Order Book + Trades)
 * * Logic:
 * - Reads process.env.MARKET_SOURCE to determine which exchange to connect to.
 * - Forwards normalized data to the internal Trader Bot.
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- CONFIGURATION ---
const config = {
    // 0 = Binance, 1 = Gate.io
    marketSource: process.env.MARKET_SOURCE || '0', 
    
    // Connects to the trader.js websocket server
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    
    // Exchange URLs
    binanceUrl: 'wss://fstream.binance.com/stream',
    gateUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',

    reconnectInterval: 5000,
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',')
};

// --- LOGGING ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

// --- STATE MANAGEMENT ---
let internalWs = null;
let exchangeWs = null;

// Gate.io Specific State
const orderBooks = new Map(); 

// --- HELPER CLASS: Gate.io OrderBook ---
class LocalOrderBook {
    constructor(symbol) {
        this.symbol = symbol;
        this.bids = new Map();
        this.asks = new Map();
        this.lastUpdateId = 0;
        this.firstReceived = false;
        this.ready = false;
    }

    reset() {
        this.bids.clear();
        this.asks.clear();
        this.lastUpdateId = 0;
        this.firstReceived = false;
        this.ready = false;
    }

    processUpdate(data) {
        const U = data.U; 
        const u = data.u; 

        if (!this.firstReceived) {
            this.reset();
            this.applyChanges(data.b, this.bids);
            this.applyChanges(data.a, this.asks);
            this.lastUpdateId = u;
            this.firstReceived = true;
            this.ready = true;
            return true;
        }

        // Gap detection
        if (U > this.lastUpdateId + 1) {
            logger.warn(`[${this.symbol}] Gap detected in Gate.io sequence. Resyncing...`);
            return false; 
        }

        // Ignore old packets
        if (u < this.lastUpdateId) return true; 

        this.applyChanges(data.b, this.bids);
        this.applyChanges(data.a, this.asks);
        this.lastUpdateId = u;
        return true;
    }

    applyChanges(changes, bookMap) {
        if (!changes) return;
        for (const point of changes) {
            const p = parseFloat(point.p);
            const s = parseFloat(point.s);
            if (s === 0) bookMap.delete(p);
            else bookMap.set(p, s);
        }
    }

    getSnapshot(depth = 20) {
        if (!this.ready) return null;
        const sortedBids = Array.from(this.bids.entries()).sort((a, b) => b[0] - a[0]).slice(0, depth).map(([p, s]) => [p.toString(), s.toString()]);
        const sortedAsks = Array.from(this.asks.entries()).sort((a, b) => a[0] - b[0]).slice(0, depth).map(([p, s]) => [p.toString(), s.toString()]);
        return { bids: sortedBids, asks: sortedAsks };
    }
}

// Initialize OrderBooks for Gate.io assets
config.assets.forEach(asset => orderBooks.set(asset, new LocalOrderBook(asset)));


// --- 1. INTERNAL CONNECTION (To Trader Bot) ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);

    internalWs.on('open', () => {
        logger.info(`✓ Connected to Trader Bot. Ready to forward data for: ${config.assets.join(', ')}`);
    });

    internalWs.on('close', () => {
        logger.warn('⚠ Internal Bot Disconnected. Retrying...');
        setTimeout(connectToInternal, config.reconnectInterval);
    });

    internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

function sendToBot(payload) {
    if (internalWs && internalWs.readyState === WebSocket.OPEN) {
        internalWs.send(JSON.stringify(payload));
    }
}


// --- 2. SOURCE: BINANCE (Mode 0) ---
function connectBinance() {
    // bookTicker is the fastest L1 update (Best Bid/Ask only)
    const streams = config.assets
        .map(a => `${a.toLowerCase()}usdt@bookTicker`)
        .join('/');

    const url = `${config.binanceUrl}?streams=${streams}`;

    logger.info(`[Mode 0: Binance] Connecting to Low-Latency Stream...`);
    
    exchangeWs = new WebSocket(url);

    exchangeWs.on('open', () => logger.info('[Binance] ✓ Connected & Streaming.'));

    exchangeWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (!msg.data) return;

            // Extract Asset Name (e.g., "BTCUSDT" -> "BTC")
            const asset = msg.data.s.replace('USDT', '');

            // Standardize Payload
            const payload = {
                type: 'B',                     // 'B' for Binance BookTicker
                s: asset,                      // Symbol
                bb: parseFloat(msg.data.b),    // Best Bid Price
                bq: parseFloat(msg.data.B),    // Best Bid Qty
                ba: parseFloat(msg.data.a),    // Best Ask Price
                aq: parseFloat(msg.data.A)     // Best Ask Qty
            };

            sendToBot(payload);

        } catch (e) {
            // Squelch parsing errors
        }
    });

    exchangeWs.on('close', () => {
        logger.warn('[Binance] Disconnected. Reconnecting...');
        setTimeout(connectBinance, config.reconnectInterval);
    });

    exchangeWs.on('error', (e) => logger.error(`[Binance] Error: ${e.message}`));
}


// --- 3. SOURCE: GATE.IO (Mode 1) ---
function connectGate() {
    logger.info(`[Mode 1: Gate.io] Connecting to Futures V4 Stream...`);
    exchangeWs = new WebSocket(config.gateUrl);

    exchangeWs.on('open', () => {
        logger.info('[Gate.io] Connected.');
        
        config.assets.forEach(asset => {
            // 1. Subscribe to Order Book (20ms)
             exchangeWs.send(JSON.stringify({
                time: Math.floor(Date.now() / 1000),
                channel: "futures.order_book_update",
                event: "subscribe",
                payload: [`${asset}_USDT`, "20ms", "20"]
            }));
            
            // 2. Subscribe to TRADES (Real-Time)
            exchangeWs.send(JSON.stringify({
                time: Math.floor(Date.now() / 1000),
                channel: "futures.trades",
                event: "subscribe",
                payload: [`${asset}_USDT`]
            }));
        });
        
        logger.info(`[Gate.io] Subscribed to Books & Trades for: ${config.assets.join(', ')}`);
    });

    exchangeWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const channel = msg.channel;
            const event = msg.event;
            const result = msg.result;

            if (event === 'update' && result) {
                // --- HANDLE ORDER BOOK ---
                if (channel === 'futures.order_book_update') {
                    const gateSymbol = result.s; 
                    const asset = gateSymbol.replace('_USDT', '');
                    const book = orderBooks.get(asset);
                    
                    if (book) {
                        if (!book.processUpdate(result)) {
                            book.reset(); 
                            // Ideally trigger resubscribe here in full prod
                            return; 
                        }
                        
                        // Send 'depth' payload to Bot
                        sendToBot({
                            type: 'depth',
                            s: asset,
                            ts: Date.now(),
                            ...book.getSnapshot()
                        });
                    }
                }

                // --- HANDLE TRADES ---
                if (channel === 'futures.trades') {
                    // Result is an array of trades
                    const trades = Array.isArray(result) ? result : [result];
                    
                    trades.forEach(trade => {
                        const gateSymbol = trade.contract; 
                        const asset = (gateSymbol || config.assets[0] + '_USDT').replace('_USDT', ''); 
                        const size = parseFloat(trade.size);
                        const price = parseFloat(trade.price);
                        const side = size > 0 ? 'buy' : 'sell';

                        // Send 'trade' payload to Bot
                        sendToBot({
                            type: 'trade',
                            s: asset,
                            p: price,
                            q: Math.abs(size),
                            side: side,
                            id: trade.id,
                            ts: Date.now()
                        });
                    });
                }
            }
        } catch (e) {
            logger.error(`[Gate.io] Parse Error: ${e.message}`);
        }
    });

    exchangeWs.on('close', () => {
        logger.warn('[Gate.io] Disconnected. Reconnecting...');
        config.assets.forEach(a => orderBooks.get(a).reset()); 
        setTimeout(connectGate, config.reconnectInterval);
    });

    exchangeWs.on('error', (e) => logger.error(`[Gate.io] Error: ${e.message}`));
}


// --- MAIN EXECUTION ---
function start() {
    // 1. Always connect to the internal bot first
    connectToInternal();

    // 2. Select External Source based on ENV
    if (config.marketSource === '1') {
        connectGate();
    } else {
        // Default to Binance (Source 0)
        connectBinance();
    }
}

start();

