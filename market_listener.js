/**
 * market_listener.js
 * GATE.IO FUTURES V4 ADAPTER (Order Book Maintainer)
 * * CORE RESPONSIBILITY:
 * 1. Connect to Gate.io Futures WS.
 * 2. Maintain a LOCAL Order Book (Map<price, size>).
 * 3. Handle Sequence/Gap detection strictly.
 * 4. Push sorted SNAPSHOTS to the internal Trading Bot.
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    gateWsUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(','),
    reconnectInterval: 5000,
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
let gateWs = null;
const orderBooks = new Map(); // Stores LocalOrderBook instances

class LocalOrderBook {
    constructor(symbol) {
        this.symbol = symbol; // Internal symbol (e.g., BTC)
        this.gateSymbol = `${symbol}_USDT`; // Gate symbol (e.g., BTC_USDT)
        
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
        logger.warn(`[${this.symbol}] Local Book Reset.`);
    }

    processUpdate(data) {
        const U = data.U; // Start Sequence
        const u = data.u; // End Sequence

        // 1. FIRST UPDATE (SNAPSHOT LOGIC)
        if (!this.firstReceived) {
            this.reset();
            this.applyChanges(data.b, this.bids);
            this.applyChanges(data.a, this.asks);
            this.lastUpdateId = u;
            this.firstReceived = true;
            this.ready = true;
            logger.info(`[${this.symbol}] ✓ Snapshot Initialized (ID: ${u})`);
            return true;
        }

        // 2. INCREMENTAL LOGIC (SEQUENCE CHECK)
        if (U > this.lastUpdateId + 1) {
            logger.error(`[${this.symbol}] 💥 Sequence Gap! Expected ${this.lastUpdateId + 1}, got ${U}. Resyncing...`);
            return false; // Triggers resubscribe
        }

        if (u < this.lastUpdateId) {
            return true; // Stale packet, ignore safely
        }

        // 3. APPLY UPDATES
        this.applyChanges(data.b, this.bids);
        this.applyChanges(data.a, this.asks);
        this.lastUpdateId = u;
        return true;
    }

    applyChanges(changes, bookMap) {
        if (!changes) return;
        for (const point of changes) {
            const p = parseFloat(point.p); // Price
            const s = parseFloat(point.s); // Size

            // Gate.io Rule: Size 0 means delete, >0 means set/update
            if (s === 0) {
                bookMap.delete(p);
            } else {
                bookMap.set(p, s);
            }
        }
    }

    getSnapshot(depth = 20) {
        if (!this.ready) return null;

        // Sort Bids (High to Low)
        const sortedBids = Array.from(this.bids.entries())
            .sort((a, b) => b[0] - a[0])
            .slice(0, depth)
            .map(([p, s]) => [p.toString(), s.toString()]); // Format as strings for compatibility

        // Sort Asks (Low to High)
        const sortedAsks = Array.from(this.asks.entries())
            .sort((a, b) => a[0] - b[0])
            .slice(0, depth)
            .map(([p, s]) => [p.toString(), s.toString()]);

        return {
            bids: sortedBids,
            asks: sortedAsks
        };
    }
}

// Initialize Books
config.assets.forEach(asset => orderBooks.set(asset, new LocalOrderBook(asset)));

// --- INTERNAL BOT CONNECTION ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);
    internalWs.on('open', () => logger.info(`✓ Connected to Internal Bot at ${config.internalReceiverUrl}`));
    internalWs.on('close', () => {
        logger.warn('Internal WS Closed. Retrying in 5s...');
        setTimeout(connectToInternal, 5000);
    });
    internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

function sendToBot(symbol, snapshot) {
    if (internalWs && internalWs.readyState === WebSocket.OPEN && snapshot) {
        const payload = {
            type: 'D', // Depth Message
            s: symbol,
            b: snapshot.bids,
            a: snapshot.asks
        };
        internalWs.send(JSON.stringify(payload));
    }
}

// --- GATE.IO CONNECTION ---
function connectGate() {
    logger.info(`[Gate.io] Connecting to ${config.gateWsUrl}...`);
    gateWs = new WebSocket(config.gateWsUrl);

    gateWs.on('open', () => {
        logger.info('[Gate.io] Connected. Subscribing...');
        const payload = config.assets.map(asset => [`${asset}_USDT`, "20ms", "20"]);
        
        // Gate.io Subscribe Message
        const msg = {
            time: Math.floor(Date.now() / 1000),
            channel: "futures.order_book_update",
            event: "subscribe",
            payload: payload.flat() // Flattening just in case, though API expects ["BTC_USDT", "20ms", "20", ...]
        };
        
        // Actually Gate expects flattened arguments in the payload array for multiple subs? 
        // Docs say: payload: ["BTC_USDT", "20ms", "20"] for single. 
        // For multiple, we usually send multiple subscribe commands or flattened. 
        // Let's safe-bet: Subscribe individually to ensure clarity.
        
        config.assets.forEach(asset => {
            const subMsg = {
                time: Math.floor(Date.now() / 1000),
                channel: "futures.order_book_update",
                event: "subscribe",
                payload: [`${asset}_USDT`, "20ms", "20"]
            };
            gateWs.send(JSON.stringify(subMsg));
        });
    });

    gateWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            // Check for Event: update (futures.order_book_update)
            if (msg.event === 'update' && msg.channel === 'futures.order_book_update') {
                const result = msg.result;
                const gateSymbol = result.s; // e.g., BTC_USDT
                const asset = gateSymbol.replace('_USDT', '');
                
                const book = orderBooks.get(asset);
                if (book) {
                    const success = book.processUpdate(result);
                    
                    if (!success) {
                        // Sequence Gap detected inside the book logic
                        // We must resubscribe ONLY this asset ideally, but simpler to reset book
                        book.reset();
                        gateWs.send(JSON.stringify({
                            time: Math.floor(Date.now() / 1000),
                            channel: "futures.order_book_update",
                            event: "unsubscribe",
                            payload: [gateSymbol, "20ms", "20"]
                        }));
                        setTimeout(() => {
                            gateWs.send(JSON.stringify({
                                time: Math.floor(Date.now() / 1000),
                                channel: "futures.order_book_update",
                                event: "subscribe",
                                payload: [gateSymbol, "20ms", "20"]
                            }));
                        }, 500);
                        return;
                    }

                    // Push Snapshot to Bot
                    sendToBot(asset, book.getSnapshot());
                }
            }
        } catch (e) {
            logger.error(`Parse Error: ${e.message}`);
        }
    });

    gateWs.on('close', () => {
        logger.warn('[Gate.io] Disconnected. Reconnecting...');
        config.assets.forEach(a => orderBooks.get(a).reset()); // Reset all books
        setTimeout(connectGate, config.reconnectInterval);
    });

    gateWs.on('error', (e) => logger.error(`[Gate.io] Error: ${e.message}`));
}

// --- START ---
connectToInternal();
connectGate();
    
