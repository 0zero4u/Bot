/**
 * market_listener.js
 * v2.0 - Gate.io Incremental Sync Implementation
 * Rules: First update = Snapshot | Sequence (U/u) is Law | Gap = Resync
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
        state: 'INITIALIZING' // INITIALIZING -> LIVE
    });
});

let botWs = null;

function connectToInternal() {
    botWs = new WebSocket(config.internalReceiverUrl);
    botWs.on('open', () => logger.info('✓ Connected to Trader Bot.'));
    botWs.on('close', () => setTimeout(connectToInternal, 2000));
    botWs.on('error', () => {});
}

function sendToBot(payload) {
    if (botWs && botWs.readyState === WebSocket.OPEN) {
        botWs.send(JSON.stringify(payload));
    }
}

function connectGate() {
    const exchangeWs = new WebSocket(config.gateUrl);

    exchangeWs.on('open', () => {
        logger.info('[Gate.io] Connected. Subscribing to Book and Trades...');
        
        // Subscribe to Order Book Updates (Rule 1)
        const assetPairs = config.assets.map(a => `${a}_USDT`);
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
            if (!msg.result || msg.event === 'subscribe') return;

            const channel = msg.channel;
            const data = msg.result;
            const symbol = (data.s || "").replace('_USDT', '');

            // --- 1. HANDLE ORDER BOOK (INCREMENTAL) ---
            if (channel === 'futures.order_book_update') {
                const book = orderBooks.get(symbol);
                if (!book) return;

                // RULE 2 & 4: First update = Snapshot OR Resync on Gap
                if (book.state === 'INITIALIZING' || data.U !== book.lastUpdateId + 1) {
                    if (book.state === 'LIVE') {
                        logger.warn(`[Gate] Sequence Gap on ${symbol}! Expected ${book.lastUpdateId + 1}, got ${data.U}. Resyncing...`);
                    }
                    book.bids.clear();
                    book.asks.clear();
                    book.state = 'LIVE';
                }

                // RULE 3: Apply Updates (a = asks, b = bids)
                if (data.a) {
                    data.a.forEach(([p, s]) => {
                        const price = p; // String price as key
                        const size = parseFloat(s);
                        if (size === 0) book.asks.delete(price);
                        else book.asks.set(price, size);
                    });
                }
                if (data.b) {
                    data.b.forEach(([p, s]) => {
                        const price = p;
                        const size = parseFloat(s);
                        if (size === 0) book.bids.delete(price);
                        else book.bids.set(price, size);
                    });
                }

                book.lastUpdateId = data.u;

                // Sort and Prepare Top 20 for Strategy
                const sortedBids = Array.from(book.bids.entries())
                    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
                    .slice(0, 20);
                const sortedAsks = Array.from(book.asks.entries())
                    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
                    .slice(0, 20);

                sendToBot({
                    type: 'depthUpdate',
                    s: symbol,
                    bids: sortedBids,
                    asks: sortedAsks,
                    u: data.u,
                    ts: Date.now()
                });
            }

            // --- 2. HANDLE TRADES ---
            else if (channel === 'futures.trades') {
                const trades = Array.isArray(data) ? data : [data];
                trades.forEach(t => {
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
            logger.error(`[Gate.io] Error: ${e.message}`);
        }
    });

    exchangeWs.on('close', () => {
        logger.warn('[Gate.io] Disconnected. Resetting books and reconnecting...');
        config.assets.forEach(asset => {
            const book = orderBooks.get(asset);
            book.state = 'INITIALIZING';
            book.lastUpdateId = 0;
        });
        setTimeout(connectGate, config.reconnectInterval);
    });
}

// Start
connectToInternal();
connectGate();
        
