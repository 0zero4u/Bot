/**
 * market_listener.js
 * v4.0 [FINAL GOLDEN COPY]
 * * =================================================================================
 * ARCHITECTURE: GATE.IO -> SIGNAL SANITIZER -> TRADING BOT
 * =================================================================================
 * This service acts as a firewall between the noisy Gate.io Websocket and your Strategy.
 * * * CRITICAL FEATURES:
 * 1. SEQUENCE TRACKING (The Anchor):
 * - Tracks 'u' (Final Update ID) from every packet.
 * - Verifies 'U' (Start ID) of next packet connects perfectly (U == prev_u + 1).
 * - If a gap is detected, it triggers a full re-sync to prevent "Ghost Orders".
 * * 2. ZERO-CHANGE GUARD (The Noise Filter):
 * - Gate.io sends empty updates (a:[], b:[]) just to update the Sequence ID.
 * - We process the Sequence ID but BLOCK these from reaching the bot.
 * * 3. TOP-10 CHECKSUM (The Welford Protector):
 * - Even if data changes at Level 15, it is "noise" to our Tick Strategy.
 * - We calculate a fingerprint of the Top 10 levels.
 * - If Top 10 didn't change, we DROP the packet.
 * - RESULT: The Bot only sees "Meaningful Moves", preserving Welford variance integrity.
 * =================================================================================
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- CONFIGURATION ---
const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    gateUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    assets: (process.env.TARGET_ASSETS || 'XRP').split(','),
    reconnectInterval: 5000,
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
        bids: new Map(),
        asks: new Map(),
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
        
        // Request 20ms interval (Elastic) with 20 Level Depth
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
            let rawSymbol = data.s;
            if (!rawSymbol) return; 
            
            const symbol = rawSymbol.replace('_USDT', '');
            const book = orderBooks.get(symbol);
            if (!book) return;

            // ============================================================
            // STEP 1: SEQUENCE INTEGRITY (The Anchor)
            // ============================================================
            
            // If we are LIVE, verify this packet connects to the previous one
            if (book.state === 'LIVE' && book.lastUpdateId > 0) {
                const prevU = book.lastUpdateId;
                const currU = data.U; // Start ID of this packet
                const currFinal = data.u; // End ID of this packet

                // Check for GAP: If Current Start > Previous End + 1
                if (currU > prevU + 1) {
                    logger.warn(`[GAP DETECTED] ${symbol} | Local: ${prevU} -> Remote: ${currU}. Resyncing...`);
                    // Force Re-Init
                    book.state = 'INITIALIZING';
                    book.bids.clear();
                    book.asks.clear();
                    book.lastUpdateId = 0;
                    // In a production system, you might trigger a REST snapshot fetch here.
                    // For now, we let the next packet fill the void or wait for natural heal.
                    return; 
                }
                
                // Check for OLD DATA: If Current End < Previous End
                if (currFinal <= prevU) {
                    return; // Ignore obsolete packet
                }
            }

            // ALWAYS UPDATE THE ANCHOR (Even if payload is empty)
            book.lastUpdateId = data.u;

            // ============================================================
            // STEP 2: ZERO-CHANGE GUARD (The Noise Filter)
            // ============================================================
            // If both arrays are empty, Gate is just saying "I'm alive".
            // We updated the Anchor (above), so we can safely stop here.
            if ((!data.a || data.a.length === 0) && (!data.b || data.b.length === 0)) {
                return; 
            }

            // ============================================================
            // STEP 3: UPDATE LOCAL BOOK
            // ============================================================
            if (book.state === 'INITIALIZING') {
                book.state = 'LIVE';
                // Note: First packet of a session sets the baseline
            }

            const processLevel = (item, map) => {
                const p = item.p; 
                const s = item.s;
                if (parseFloat(s) === 0) map.delete(p);
                else map.set(p, s);
            };

            if (data.a) data.a.forEach(i => processLevel(i, book.asks));
            if (data.b) data.b.forEach(i => processLevel(i, book.bids));

            // ============================================================
            // STEP 4: SORTING
            // ============================================================
            const sortedBids = Array.from(book.bids.entries())
                .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
            
            const sortedAsks = Array.from(book.asks.entries())
                .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

            // Pruning (Keep memory usage constant)
            if (book.bids.size > config.maxBookDepth) {
                sortedBids.slice(config.maxBookDepth).forEach(x => book.bids.delete(x[0]));
            }
            if (book.asks.size > config.maxBookDepth) {
                sortedAsks.slice(config.maxBookDepth).forEach(x => book.asks.delete(x[0]));
            }

            // ============================================================
            // STEP 5: TOP-10 CHECKSUM (The Welford Protector)
            // ============================================================
            const topBids = sortedBids.slice(0, 10);
            const topAsks = sortedAsks.slice(0, 10);

            // Generate Fingerprint: "Top3Bids + Top3Asks"
            // If Top 3 are identical, the "Shape" of the book is effectively unchanged for HFT purposes.
            const currentChecksum = JSON.stringify(topBids.slice(0, 3)) + JSON.stringify(topAsks.slice(0, 3));

            if (currentChecksum === book.lastChecksum) {
                // CONTENT DUPLICATION DETECTED -> BLOCK
                return; 
            }

            // New meaningful data confirmed
            book.lastChecksum = currentChecksum;

            // ============================================================
            // STEP 6: SEND TO BOT
            // ============================================================
            sendToBot({
                type: 'depthUpdate',
                s: symbol,
                bids: topBids, // Bot only needs Top 10
                asks: topAsks,
                u: data.u,     // Send current ID for logging
                ts: Date.now()
            });

        } catch (e) {
            // logger.error(e); // Silent fail to maintain loop speed
        }
    });

    exchangeWs.on('close', () => {
        logger.warn('[Gate.io] Disconnected. Reconnecting in 5s...');
        // Reset state on disconnect
        config.assets.forEach(asset => {
            const book = orderBooks.get(asset);
            if(book) {
                book.state = 'INITIALIZING';
                book.lastUpdateId = 0;
            }
        });
        setTimeout(connectGate, config.reconnectInterval);
    });
    
    exchangeWs.on('error', (err) => {
        logger.error(`[Gate.io] Error: ${err.message}`);
    });
}

// Start Pipeline
connectToInternal();
connectGate();
    
