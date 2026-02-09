/**
 * market_listener.js
 * v7.0 [SYNCHRONIZED CLEANUP]
 * * FEATURES:
 * 1. Zero Latency: Sends snapshot immediately upon receipt.
 * 2. Smart Cleanup: Uses the idle time AFTER sending to prune memory.
 * 3. 20ms Sync: Aligns perfectly with Gate.io's push cycle.
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- CONFIGURATION ---
const config = {
    marketSource: process.env.MARKET_SOURCE || '1', 
    internalPort: process.env.INTERNAL_WS_PORT || 8082,
    gateUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    assets: (process.env.TARGET_ASSETS || 'XRP_USDT').split(','),
    reconnectInterval: 5000,
    pruneIntervalMs: 5000 // Run cleanup every 5s (but only during idle gaps)
};

// --- LOGGER ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => 
            `${timestamp} [${level.toUpperCase()}] ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

// --- STATE MANAGEMENT ---
const orderBooks = new Map();

config.assets.forEach(asset => {
    orderBooks.set(asset, {
        bids: new Map(),
        asks: new Map(),
        state: 'INITIALIZING',
        lastPrune: Date.now()
    });
});

// --- INTERNAL WEBSOCKET SERVER (To Bot) ---
const wss = new WebSocket.Server({ port: config.internalPort });
logger.info(`[Internal] Server started on port ${config.internalPort}`);

let botSocket = null;

wss.on('connection', (ws) => {
    logger.info('[Internal] Bot connected.');
    botSocket = ws;
    ws.on('close', () => { 
        logger.warn('[Internal] Bot disconnected.');
        botSocket = null; 
    });
    ws.on('error', (e) => logger.error(`[Internal] Error: ${e.message}`));
});

function sendToBot(data) {
    if (botSocket && botSocket.readyState === WebSocket.OPEN) {
        botSocket.send(JSON.stringify(data));
    }
}

// --- GATE.IO CONNECTION ---
let exchangeWs = null;
let pingInterval = null;

function connectGate() {
    exchangeWs = new WebSocket(config.gateUrl);

    exchangeWs.on('open', () => {
        logger.info('[Gate.io] Connected to Futures Stream (Instant).');
        
        // Subscribe Depth (20ms)
        const depthPayload = {
            time: Math.floor(Date.now() / 1000),
            channel: 'futures.order_book_update',
            event: 'subscribe',
            payload: config.assets.map(asset => [asset, '20ms', '20']) 
        };
        exchangeWs.send(JSON.stringify(depthPayload));

        // Subscribe Trades
        const tradePayload = {
            time: Math.floor(Date.now() / 1000),
            channel: 'futures.trades',
            event: 'subscribe',
            payload: config.assets
        };
        exchangeWs.send(JSON.stringify(tradePayload));

        // Keep-Alive
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (exchangeWs.readyState === WebSocket.OPEN) {
                exchangeWs.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' }));
            }
        }, 10000);
    });

    exchangeWs.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const channel = data.channel;
            const event = data.event;
            const result = data.result;

            if (!result) return;

            // --- 1. ORDER BOOK UPDATE ---
            if (channel === 'futures.order_book_update' && event === 'update') {
                const symbol = result.s; 
                const book = orderBooks.get(symbol);

                if (book) {
                    book.state = 'READY';

                    // A. Update Memory
                    if (result.a) result.a.forEach(item => processLevel(item, book.asks));
                    if (result.b) result.b.forEach(item => processLevel(item, book.bids));

                    // B. CRITICAL PATH: Send Snapshot IMMEDIATELY
                    // We do not wait for anything. Speed is key.
                    const { bestBid, bestAsk } = sendSnapshot(symbol, book);

                    // C. IDLE PATH: Memory Management
                    // We use the ~19ms gap before the next message to check if we need to clean up.
                    // This ensures cleanup never blocks the send.
                    if (bestBid && bestAsk) {
                        manageMemory(book, bestBid, bestAsk);
                    }
                }
            }

            // --- 2. TRADE UPDATE ---
            else if (channel === 'futures.trades' && event === 'update') {
                const trades = Array.isArray(result) ? result : [result];
                trades.forEach(t => {
                    const symbol = t.contract;
                    if (!config.assets.includes(symbol)) return;

                    sendToBot({
                        type: 'trade',
                        s: symbol,
                        p: parseFloat(t.price),
                        q: parseFloat(t.size),
                        side: parseFloat(t.size) > 0 ? 'buy' : 'sell',
                        ts: t.create_time_ms || Date.now()
                    });
                });
            }

        } catch (e) {
            logger.error(`[Gate.io] Parse Error: ${e.message}`);
        }
    });

    exchangeWs.on('close', () => {
        logger.warn('[Gate.io] Connection Closed. Reconnecting in 5s...');
        cleanUpAndReconnect();
    });

    exchangeWs.on('error', (e) => {
        logger.error(`[Gate.io] Error: ${e.message}`);
        exchangeWs.terminate();
    });
}

function processLevel(item, map) {
    let price, size;
    if (Array.isArray(item)) {
        price = item[0];
        size = parseFloat(item[1]);
    } else {
        price = item.p;
        size = parseFloat(item.s);
    }
    if (size === 0) map.delete(price); 
    else map.set(price, size); 
}

// --- FAST SNAPSHOT SENDER ---
function sendSnapshot(symbol, book) {
    // 1. Sort Bids (High to Low)
    const sortedBids = Array.from(book.bids.entries())
        .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));

    // 2. Sort Asks (Low to High)
    const sortedAsks = Array.from(book.asks.entries())
        .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

    // 3. Send
    if (sortedBids.length > 0 && sortedAsks.length > 0) {
        sendToBot({
            type: 'depthUpdate',
            s: symbol,
            bids: sortedBids.slice(0, 20),
            asks: sortedAsks.slice(0, 20),
            ts: Date.now()
        });
        
        // Return prices for the cleanup function to use
        return { 
            bestBid: parseFloat(sortedBids[0][0]), 
            bestAsk: parseFloat(sortedAsks[0][0]) 
        };
    }
    return { bestBid: null, bestAsk: null };
}

// --- IDLE TIME CLEANUP ---
// Only runs if 5 seconds have passed since last clean
function manageMemory(book, bestBid, bestAsk) {
    if (Date.now() - book.lastPrune < config.pruneIntervalMs) return;

    // Prune logic runs here (inside the idle gap)
    const MAX_DEVIATION = 0.50; // 50% range

    const bidFloor = bestBid * (1 - MAX_DEVIATION);
    for (const [price] of book.bids) {
        if (parseFloat(price) < bidFloor) book.bids.delete(price);
    }

    const askCeiling = bestAsk * (1 + MAX_DEVIATION);
    for (const [price] of book.asks) {
        if (parseFloat(price) > askCeiling) book.asks.delete(price);
    }

    book.lastPrune = Date.now();
    // logger.debug(`[CLEANUP] Pruned order book`);
}

function cleanUpAndReconnect() {
    if (pingInterval) clearInterval(pingInterval);
    setTimeout(connectGate, config.reconnectInterval);
}

connectGate();
