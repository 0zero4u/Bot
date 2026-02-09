/**
 * market_listener.js
 * v3.0 [FINAL PRODUCTION] - Robust Gate.io Futures Sync
 * * CRITICAL FIXES:
 * 1. Order Book: Handles {p, s} Objects (prevents crash).
 * 2. Trades: Maps 'contract'/'price' correctly (fixes Z=0).
 * 3. Sequence: Auto-Resyncs on gap detection.
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- CONFIGURATION ---
const config = {
    marketSource: process.env.MARKET_SOURCE || '1', 
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    gateUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    assets: (process.env.TARGET_ASSETS || 'XRP').split(','),
    reconnectInterval: 5000
};

// --- LOGGER ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

// --- LOCAL STATE ---
const orderBooks = new Map();
config.assets.forEach(asset => {
    orderBooks.set(asset, {
        bids: new Map(),
        asks: new Map(),
        lastUpdateId: 0,
        state: 'INITIALIZING' 
    });
});

let botWs = null;
let exchangeWs = null;

// --- 1. INTERNAL BOT CONNECTION ---
function connectToInternal() {
    botWs = new WebSocket(config.internalReceiverUrl);
    botWs.on('open', () => logger.info('✓ Connected to Trader Bot. Ready to forward data.'));
    botWs.on('close', () => setTimeout(connectToInternal, 2000));
    botWs.on('error', () => {});
}

function sendToBot(payload) {
    if (botWs && botWs.readyState === WebSocket.OPEN) {
        botWs.send(JSON.stringify(payload));
    }
}

// --- 2. GATE.IO RESYNC LOGIC ---
function triggerResync(symbol) {
    if (!exchangeWs || exchangeWs.readyState !== WebSocket.OPEN) return;
    
    const pair = `${symbol}_USDT`;
    logger.warn(`[Gate] Sequence Gap Detected for ${symbol}. Triggering Resync...`);

    const time = Math.floor(Date.now() / 1000);

    // Unsubscribe
    exchangeWs.send(JSON.stringify({
        time: time,
        channel: "futures.order_book_update",
        event: "unsubscribe",
        payload: [pair, "20ms", "20"]
    }));

    // Re-Subscribe after 500ms
    setTimeout(() => {
        if (exchangeWs.readyState === WebSocket.OPEN) {
            exchangeWs.send(JSON.stringify({
                time: Math.floor(Date.now() / 1000),
                channel: "futures.order_book_update",
                event: "subscribe",
                payload: [pair, "20ms", "20"]
            }));
        }
    }, 500);

    // Reset Local Memory
    const book = orderBooks.get(symbol);
    if (book) {
        book.bids.clear();
        book.asks.clear();
        book.state = 'INITIALIZING';
        book.lastUpdateId = 0;
    }
}

// --- 3. GATE.IO CONNECTION & HANDLER ---
function connectGate() {
    exchangeWs = new WebSocket(config.gateUrl);

    exchangeWs.on('open', () => {
        logger.info('[Gate.io] Connected. Subscribing to Futures Feed...');
        
        const assetPairs = config.assets.map(a => `${a}_USDT`);
        
        // Subscribe to Order Book
        exchangeWs.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: "futures.order_book_update",
            event: "subscribe",
            payload: [...assetPairs, "20ms", "20"]
        }));

        // Subscribe to Trades
        exchangeWs.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: "futures.trades",
            event: "subscribe",
            payload: assetPairs
        }));
    });

    exchangeWs.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            
            // Filter heartbeats and ack messages
            if (!msg.result || msg.event === 'subscribe' || msg.event === 'unsubscribe' || msg.channel === 'futures.pong') return;

            const channel = msg.channel;
            const data = msg.result;

            // ============================================================
            // HANDLER A: ORDER BOOK UPDATES
            // ============================================================
            if (channel === 'futures.order_book_update') {
                // Robust Symbol Extraction
                let rawSymbol = data.s;
                if (!rawSymbol && Array.isArray(data) && data.length > 0) rawSymbol = data[0].s;
                
                if (!rawSymbol) return;
                const symbol = rawSymbol.replace('_USDT', '');
                
                const book = orderBooks.get(symbol);
                if (!book) return;

                // Sequence Integrity Check
                const isGap = (book.state === 'LIVE' && data.U !== book.lastUpdateId + 1);
                
                if (book.state === 'INITIALIZING' || isGap) {
                    if (isGap) {
                        logger.warn(`[Gate] Gap ${symbol}: Expected ${book.lastUpdateId + 1}, Got ${data.U}.`);
                        triggerResync(symbol);
                        return; // Halt processing
                    }
                    // Snapshot Mode
                    book.bids.clear();
                    book.asks.clear();
                    book.state = 'LIVE';
                }

                // Helper: Normalize {p, s} Object vs [p, s] Array
                const processLevel = (item, map) => {
                    let p, s;
                    // Format 1: Object (Seen in your logs)
                    if (typeof item === 'object' && item !== null && 'p' in item) {
                        p = item.p;
                        s = item.s;
                    } 
                    // Format 2: Array (Standard API docs)
                    else if (Array.isArray(item) && item.length >= 2) {
                        [p, s] = item;
                    } else {
                        return;
                    }

                    if (parseFloat(s) === 0) map.delete(p);
                    else map.set(p, s);
                };

                // Apply Updates
                if (data.a && Array.isArray(data.a)) data.a.forEach(item => processLevel(item, book.asks));
                if (data.b && Array.isArray(data.b)) data.b.forEach(item => processLevel(item, book.bids));

                book.lastUpdateId = data.u;

                // Sort & Broadcast
                const sortedBids = Array.from(book.bids.entries())
                    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
                    .slice(0, 20);
                const sortedAsks = Array.from(book.asks.entries())
                    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
                    .slice(0, 20);

                if (sortedBids.length > 0 || sortedAsks.length > 0) {
                    sendToBot({
                        type: 'depthUpdate',
                        s: symbol,
                        bids: sortedBids,
                        asks: sortedAsks,
                        u: data.u,
                        ts: Date.now()
                    });
                }
            }

            // ============================================================
            // HANDLER B: TRADE UPDATES
            // ============================================================
            else if (channel === 'futures.trades') {
                const trades = Array.isArray(data) ? data : [data];
                
                trades.forEach(t => {
                    // MAPPING FIX: Handle 'contract' vs 's' and 'price' vs 'p'
                    const rawSymbol = t.contract || t.s;
                    const rawPrice = t.price || t.p;
                    const rawSize = t.size; // Futures uses 'size'

                    if (!rawSymbol || typeof rawSymbol !== 'string') return;
                    
                    const asset = rawSymbol.replace('_USDT', '');
                    const sizeFloat = parseFloat(rawSize);

                    sendToBot({
                        type: 'trade',
                        s: asset,
                        p: rawPrice,
                        q: Math.abs(sizeFloat),
                        side: sizeFloat > 0 ? 'buy' : 'sell', // Gate.io Futures: +Buy, -Sell
                        ts: t.create_time_ms || Date.now()
                    });
                });
            }
        } catch (e) {
            logger.error(`[Gate.io] Handler Error: ${e.message}`);
        }
    });

    exchangeWs.on('close', () => {
        logger.warn('[Gate.io] Connection Closed. Reconnecting...');
        config.assets.forEach(asset => {
            const book = orderBooks.get(asset);
            if(book) {
                book.state = 'INITIALIZING';
                book.lastUpdateId = 0;
            }
        });
        setTimeout(connectGate, config.reconnectInterval);
    });

    exchangeWs.on('error', (e) => logger.error(`[Gate.io] WS Error: ${e.message}`));
}

// Start
connectToInternal();
connectGate();
                      
