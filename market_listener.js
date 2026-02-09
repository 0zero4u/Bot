/**
 * market_listener.js
 * v2.3 - [FIXED] Gate.io Object Format Support
 * Fixes: correctly parses {p: price, s: size} objects from Gate.io
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    marketSource: process.env.MARKET_SOURCE || '1', 
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    gateUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    assets: (process.env.TARGET_ASSETS || 'XRP').split(','),
    reconnectInterval: 5000
};

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

// --- LOCAL BOOK STORAGE ---
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

// --- RESYNC LOGIC ---
function triggerResync(symbol) {
    if (!exchangeWs || exchangeWs.readyState !== WebSocket.OPEN) return;
    
    const pair = `${symbol}_USDT`;
    logger.warn(`[Gate] Triggering Resync for ${symbol} (Unsub/Sub)...`);

    const time = Math.floor(Date.now() / 1000);

    // 1. Unsubscribe
    exchangeWs.send(JSON.stringify({
        time: time,
        channel: "futures.order_book_update",
        event: "unsubscribe",
        payload: [pair, "20ms", "20"]
    }));

    // 2. Subscribe (Delay slightly to ensure clean state)
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

    // Reset Local State
    const book = orderBooks.get(symbol);
    if (book) {
        book.bids.clear();
        book.asks.clear();
        book.state = 'INITIALIZING';
        book.lastUpdateId = 0;
    }
}

function connectGate() {
    exchangeWs = new WebSocket(config.gateUrl);

    exchangeWs.on('open', () => {
        logger.info('[Gate.io] Connected. Subscribing...');
        
        const assetPairs = config.assets.map(a => `${a}_USDT`);
        
        // 1. Subscribe to Incremental Order Book
        exchangeWs.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: "futures.order_book_update",
            event: "subscribe",
            payload: [...assetPairs, "20ms", "20"]
        }));

        // 2. Subscribe to Trades
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
            
            // Filter non-data messages
            if (!msg.result || msg.event === 'subscribe' || msg.event === 'unsubscribe' || msg.channel === 'futures.pong') return;

            const channel = msg.channel;
            const data = msg.result;

            // --- SAFETY: Robust Symbol Extraction ---
            let rawSymbol = data.s;
            if (!rawSymbol && Array.isArray(data) && data.length > 0) {
                rawSymbol = data[0].s;
            }

            if (!rawSymbol || typeof rawSymbol !== 'string') return;
            const symbol = rawSymbol.replace('_USDT', '');

            // --- 1. HANDLE ORDER BOOK ---
            if (channel === 'futures.order_book_update') {
                const book = orderBooks.get(symbol);
                if (!book) return;

                // Sequence Gap Check
                const isGap = (book.state === 'LIVE' && data.U !== book.lastUpdateId + 1);

                if (book.state === 'INITIALIZING' || isGap) {
                    if (isGap) {
                        logger.warn(`[Gate] Gap ${symbol}: Prev=${book.lastUpdateId}, Next=${data.U}.`);
                        triggerResync(symbol);
                        return; 
                    }
                    book.bids.clear();
                    book.asks.clear();
                    book.state = 'LIVE';
                }

                // --- CRITICAL FIX: Handle {p, s} Objects ---
                const processLevel = (item, map) => {
                    let p, s;
                    
                    // Handle Object format: { "p": "100", "s": 10 } (Seen in logs)
                    if (typeof item === 'object' && item !== null && 'p' in item) {
                        p = item.p;
                        s = item.s;
                    } 
                    // Handle Array format: ["100", 10] (Alternative format)
                    else if (Array.isArray(item) && item.length >= 2) {
                        [p, s] = item;
                    } 
                    else {
                        return; // Invalid format
                    }

                    if (parseFloat(s) === 0) map.delete(p);
                    else map.set(p, s);
                };

                if (data.a && Array.isArray(data.a)) {
                    data.a.forEach(item => processLevel(item, book.asks));
                }

                if (data.b && Array.isArray(data.b)) {
                    data.b.forEach(item => processLevel(item, book.bids));
                }

                book.lastUpdateId = data.u;

                // Sort and Send Top 20
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

            // --- 2. HANDLE TRADES ---
            else if (channel === 'futures.trades') {
                const trades = Array.isArray(data) ? data : [data];
                trades.forEach(t => {
                    if (!t || !t.s || typeof t.s !== 'string') return;
                    
                    const asset = t.s.replace('_USDT', '');
                    sendToBot({
                        type: 'trade',
                        s: asset,
                        p: t.p,
                        q: Math.abs(parseFloat(t.size)),
                        side: parseFloat(t.size) > 0 ? 'buy' : 'sell',
                        ts: Date.now()
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

// Entry Point
connectToInternal();
connectGate();
