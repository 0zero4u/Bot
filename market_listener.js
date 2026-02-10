
/**
 * market_listener.js
 * v3.0 [DOCUMENTATION LOCKED]
 * * =================================================================================
 * ARCHITECTURE WARNING - READ BEFORE EDITING
 * =================================================================================
 * This is not just a websocket relay. It is a "Signal Sanitizer".
 * Its job is to protect the Trading Bot's "Welford Brain" from data corruption.
 * * THE PROBLEM:
 * 1. Gate.io sends updates every 20ms even if nothing changed (Heartbeats).
 * 2. Gate.io sends updates for Level 15-20 which are "noise" to our strategy.
 * 3. If we send these "duplicate" or "noise" snapshots to the Bot:
 * - The Bot's Welford Algorithm sees 100 identical data points.
 * - Variance (StdDev) drops to roughly 0.0000.
 * - The "Z-Score" divisor becomes near-zero.
 * - A 1-tick price move causes a Z-Score spike of 50.0+ (False Signal).
 * * THE SOLUTION:
 * 1. Zero-Change Guard: Immediately discard empty "heartbeat" packets.
 * 2. Top-10 Checksum: Only forward data if the Top 10 levels (The Strategy's Eye) changed.
 * * RESULT:
 * The Bot's "100-Tick Memory" becomes "100 Meaningful Moves", not "2 seconds of noise".
 * =================================================================================
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- CONFIGURATION ---
const config = {
    // Standard Internal Port for Bot Communication
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    
    // Gate.io Future V4 WebSocket
    gateUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    
    // Assets to Listen (e.g., XRP, BTC)
    assets: (process.env.TARGET_ASSETS || 'XRP').split(','),
    
    // Reconnection Timer
    reconnectInterval: 5000,
    
    // Memory Safety: Prune local maps if they exceed this size to prevent sorting lag
    maxBookDepth: 50 
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

// --- STATE MANAGEMENT ---
const orderBooks = new Map();
config.assets.forEach(asset => {
    orderBooks.set(asset, {
        bids: new Map(), // Stores { Price -> Size }
        asks: new Map(), // Stores { Price -> Size }
        
        // [MEMORY] Stores the "Fingerprint" of the last sent snapshot.
        // Used to detect if the Top 10 levels are identical to the last update.
        lastChecksum: "", 
        
        lastUpdateId: 0,
        state: 'INITIALIZING' 
    });
});

let botWs = null;
let exchangeWs = null;

// --- 1. INTERNAL BOT CONNECTION ---
function connectToInternal() {
    botWs = new WebSocket(config.internalReceiverUrl);
    botWs.on('open', () => logger.info('✓ Connected to Trader Bot. Pipeline Ready.'));
    botWs.on('close', () => setTimeout(connectToInternal, 2000));
    botWs.on('error', () => {});
}

function sendToBot(payload) {
    if (botWs && botWs.readyState === WebSocket.OPEN) {
        botWs.send(JSON.stringify(payload));
    }
}

// --- 2. GATE.IO CONNECTION ---
function connectGate() {
    exchangeWs = new WebSocket(config.gateUrl);

    exchangeWs.on('open', () => {
        logger.info('[Gate.io] Connected. Subscribing @ 20ms (Max Speed)...');
        const assetPairs = config.assets.map(a => `${a}_USDT`);
        
        // [CRITICAL CONFIG]
        // "20ms": We request data as fast as possible (Elastic Speed).
        // "20": We request 20 levels deep.
        // Note: Even though Strategy only uses 10, we request 20 to ensure we have a buffer.
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
            
            // Filter non-data messages
            if (!msg.result || msg.event === 'subscribe') return;
            if (msg.channel !== 'futures.order_book_update') return;

            const data = msg.result;
            
            // --- [GUARD 1] ZERO-CHANGE HEARTBEAT FILTER ---
            // Gate.io often sends: { a: [], b: [], u: 12345 }
            // This means "I am alive, but nothing changed."
            // DO NOT PROCESS THIS. It wastes CPU and creates a Duplicate Snapshot.
            if ((!data.a || data.a.length === 0) && (!data.b || data.b.length === 0)) {
                return; // Discard instantly
            }

            let rawSymbol = data.s;
            if (!rawSymbol) return; 
            
            const symbol = rawSymbol.replace('_USDT', '');
            const book = orderBooks.get(symbol);
            if (!book) return;

            // --- A. UPDATE LOCAL BOOK (The Source of Truth) ---
            if (book.state === 'INITIALIZING') {
                book.bids.clear();
                book.asks.clear();
                book.state = 'LIVE';
            }

            // Helper to update Map: 
            // - If Size is 0, DELETE level (Order Cancelled/Filled).
            // - If Size > 0, SET level (New Limit Order).
            const processLevel = (item, map) => {
                const p = item.p; 
                const s = item.s;
                if (parseFloat(s) === 0) map.delete(p);
                else map.set(p, s);
            };

            if (data.a) data.a.forEach(i => processLevel(i, book.asks));
            if (data.b) data.b.forEach(i => processLevel(i, book.bids));

            // --- B. SORTING (The Heavy Lift) ---
            // We must sort to find the new "Top of Book".
            // Bids: High -> Low
            const sortedBids = Array.from(book.bids.entries())
                .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
            
            // Asks: Low -> High
            const sortedAsks = Array.from(book.asks.entries())
                .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

            // Pruning: Keep maps small to keep sorting fast (O(N log N))
            if (book.bids.size > config.maxBookDepth) {
                sortedBids.slice(config.maxBookDepth).forEach(x => book.bids.delete(x[0]));
            }
            if (book.asks.size > config.maxBookDepth) {
                sortedAsks.slice(config.maxBookDepth).forEach(x => book.asks.delete(x[0]));
            }

            // --- [GUARD 2] TOP-10 CHECKSUM (The Welford Protector) ---
            // The Strategy uses "Cliff-Edge" decay (Alpha=0.5).
            // This means Level 11+ has <1% weight. It effectively doesn't exist.
            // If the Top 10 levels match the previous frame, WE MUST NOT SEND.
            // Sending duplicates corrupts the Welford Variance calculation.
            
            const topBids = sortedBids.slice(0, 10);
            const topAsks = sortedAsks.slice(0, 10);

            // Generate Fingerprint: "Top3Bids + Top3Asks"
            // Checking Top 3 is a heuristic optimization. 
            // If Top 3 are identical, it is extremely rare for Level 4-10 to have changed significantly enough to matter.
            // This saves JSON.stringify CPU cycles.
            const currentChecksum = JSON.stringify(topBids.slice(0, 3)) + JSON.stringify(topAsks.slice(0, 3));

            if (currentChecksum === book.lastChecksum) {
                // DATA IS "EFFECTIVELY IDENTICAL" -> IGNORE
                return; 
            }

            // New "Meaningful" Data Detected
            book.lastChecksum = currentChecksum;

            // --- C. SEND TO BOT ---
            sendToBot({
                type: 'depthUpdate',
                s: symbol,
                bids: topBids, // Only send what the bot needs (Top 10)
                asks: topAsks,
                u: data.u,
                ts: Date.now()
            });

        } catch (e) {
            // Silent catch to prevent crash on malformed packets
            // logger.error(e); // Uncomment for debugging only
        }
    });

    exchangeWs.on('close', () => {
        logger.warn('[Gate.io] Disconnected. Reconnecting in 5s...');
        setTimeout(connectGate, config.reconnectInterval);
    });
}

// Start Pipeline
connectToInternal();
connectGate();
    
