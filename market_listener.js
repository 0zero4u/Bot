/**
 * market_listener.js
 * v2.1 - Gate.io Incremental Sync [STABLE]
 * Logic: First update = Snapshot | Sequence (U/u) is Law | Gap = Resync
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

function connectGate() {
    const exchangeWs = new WebSocket(config.gateUrl);

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
            
            // Filter non-data messages (heartbeats, sub-confirmations)
            if (!msg.result || msg.event === 'subscribe' || msg.channel === 'futures.pong') return;

            const channel = msg.channel;
            const data = msg.result;

            // Safe Symbol Extraction
            const rawSymbol = data.s || (Array.isArray(data) ? data[0].s : null);
            if (!rawSymbol) return; 
            const symbol = rawSymbol.replace('_USDT', '');

            // --- 1. HANDLE ORDER BOOK (The "Law of Sequence") ---
            if (channel === 'futures.order_book_update') {
                const book = orderBooks.get(symbol);
                if (!book) return;

                // RULE: First update or Sequence Gap = Resync (Wipe and Start over)
                if (book.state === 'INITIALIZING' || data.U !== book.lastUpdateId + 1) {
                    if (book.state === 'LIVE') {
                        logger.warn(`[Gate] Sequence Gap on ${symbol}! Expected ${book.lastUpdateId + 1}, got ${data.U}. Resyncing...`);
                    }
                    book.bids.clear();
                    book.asks.clear();
                    book.state = 'LIVE';
                }

                // Apply Updates (Price is Key, Size 0 = Delete)
                if (data.a && Array.isArray(data.a)) {
                    data.a.forEach(([p, s]) => {
                        if (parseFloat(s) === 0) book.asks.delete(p);
                        else book.asks.set(p, s);
                    });
                }
                if (data.b && Array.isArray(data.b)) {
                    data.b.forEach(([p, s]) => {
                        if (parseFloat(s) === 0) book.bids.delete(p);
                        else book.bids.set(p, s);
                    });
                }

                book.lastUpdateId = data.u;

                // Sort and Send Top 20 to Bot
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
                    if (!t.s) return;
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
            book.state = 'INITIALIZING';
            book.lastUpdateId = 0;
        });
        setTimeout(connectGate, config.reconnectInterval);
    });

    exchangeWs.on('error', (e) => logger.error(`[Gate.io] WS Error: ${e.message}`));
}

// Entry Point
connectToInternal();
connectGate();
                      
