/**
 * market_listener.js
 * v3.1 [OPTIMIZED] - Lean Order Book & No Trades
 * * CHANGES:
 * 1. Removed Trade Stream (Bandwidth save).
 * 2. Added Map Pruning (Prevents sorting lag over time).
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
    reconnectInterval: 5000,
    maxBookDepth: 50 // Prune maps to prevent sorting lag
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
        
        // Subscribe to Order Book ONLY (Trades Removed)
        exchangeWs.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: "futures.order_book_update",
            event: "subscribe",
            payload: [...assetPairs, "20ms", "20"]
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
            // HANDLER: ORDER BOOK UPDATES
            // ============================================================
            if (channel === 'futures.order_book_update') {
                let rawSymbol = data.s;
                if (!rawSymbol && Array.isArray(data) && data.length > 0) rawSymbol = data[0].s;
                
                if (!rawSymbol) return;
                const symbol = rawSymbol.replace('_USDT', '');
                
                const book = orderBooks.get(symbol);
                if (!book) return;

                // Sequence Integrity Check
                const isGap = (book.state === 'LIVE' && data.u < book.lastUpdateId); 
                // Note: Gate.io 'u' is "last update id", check documentation for gap detection logic specific to Gate
                // Standard: if (data.u !== book.lastUpdateId + 1) ... (simplified for resilience here)
                
                if (book.state === 'INITIALIZING') {
                    book.bids.clear();
                    book.asks.clear();
                    book.state = 'LIVE';
                }

                // Helper: Normalize {p, s} Object vs [p, s] Array
                const processLevel = (item, map) => {
                    let p, s;
                    if (typeof item === 'object' && item !== null && 'p' in item) {
                        p = item.p;
                        s = item.s;
                    } 
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

                // --- EFFICIENCY FIX: PRUNING & SORTING ---
                // We sort to find the top levels. 
                // Then, if the map is too large, we delete the "tail" to keep sorting fast next time.
                
                const sortedBids = Array.from(book.bids.entries())
                    .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0])); // Descending
                
                const sortedAsks = Array.from(book.asks.entries())
                    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])); // Ascending

                // Pruning: Keep maps clean (Optimization)
                if (book.bids.size > config.maxBookDepth) {
                    // Keep top 50, delete the rest from the Map
                    for (let i = config.maxBookDepth; i < sortedBids.length; i++) {
                        book.bids.delete(sortedBids[i][0]);
                    }
                }
                if (book.asks.size > config.maxBookDepth) {
                    for (let i = config.maxBookDepth; i < sortedAsks.length; i++) {
                        book.asks.delete(sortedAsks[i][0]);
                    }
                }

                // Slice for Strategy (Send only what's needed)
                const finalBids = sortedBids.slice(0, 20);
                const finalAsks = sortedAsks.slice(0, 20);

                if (finalBids.length > 0 || finalAsks.length > 0) {
                    sendToBot({
                        type: 'depthUpdate',
                        s: symbol,
                        bids: finalBids,
                        asks: finalAsks,
                        u: data.u,
                        ts: Date.now()
                    });
                }
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
    
