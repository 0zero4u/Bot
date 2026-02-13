/**
 * market_listener.js
 * Source: Binance Futures (Low Latency)
 * Output: Type 'B' (BookTicker)
 * Status: Optimized for XRP Default
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// CONFIG
const config = {
    // Connects to the trader.js websocket server
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 5000,
    
    // FIX: Default is now just XRP. .trim() ensures no spaces break the stream
    assets: (process.env.TARGET_ASSETS || 'XRP')
        .split(',')
        .map(a => a.trim().toUpperCase())
};

// LOGGING
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [Listener] ${message}`;
        })
    ),
    transports: [new winston.transports.Console()]
});

let internalWs = null;
let binanceWs = null;
let lastLogTime = 0;

// --- 1. CONNECT TO TRADER BOT ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);

    internalWs.on('open', () => {
        logger.info(`✅ Connected to Trader Bot. Ready to forward: ${config.assets.join(', ')}`);
    });

    internalWs.on('close', () => {
        setTimeout(connectToInternal, config.reconnectInterval);
    });

    internalWs.on('error', (e) => {
        logger.warn(`Trader Bot Connection Pending... (${e.message})`);
    });
}

// --- 2. CONNECT TO BINANCE (FAST FEED) ---
function connectBinance() {
    // bookTicker is the fastest L1 update (Best Bid/Ask only)
    const streams = config.assets
        .map(a => `${a.toLowerCase()}usdt@bookTicker`)
        .join('/');

    const url = `wss://fstream.binance.com/stream?streams=${streams}`;

    logger.info(`[Binance] Connecting to streams: ${streams}`);
    
    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => logger.info('[Binance] 🔥 Connected & Streaming Data.'));

    binanceWs.on('message', (data) => {
        // Drop data if internal pipe is broken
        if (!internalWs || internalWs.readyState !== WebSocket.OPEN) return;

        try {
            const msg = JSON.parse(data);
            if (!msg.data) return;

            // Extract Asset Name (e.g., "XRPUSDT" -> "XRP")
            const rawSymbol = msg.data.s;
            const asset = rawSymbol.replace('USDT', '');

            // Standardize Payload for Strategy
            const payload = {
                type: 'B',                     // 'B' for Binance BookTicker
                s: asset,                      // Symbol
                bb: parseFloat(msg.data.b),    // Best Bid Price
                bq: parseFloat(msg.data.B),    // Best Bid Qty
                ba: parseFloat(msg.data.a),    // Best Ask Price
                aq: parseFloat(msg.data.A)     // Best Ask Qty
            };

            internalWs.send(JSON.stringify(payload));
            
            // Log heartbeat every 5 seconds so you know it's alive
            const now = Date.now();
            if (now - lastLogTime > 5000) {
                logger.info(`[Stream] Forwarding ${asset} @ ${payload.bb}`);
                lastLogTime = now;
            }

        } catch (e) {
            // Squelch parsing errors to keep log clean
        }
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] ⚠️ Disconnected. Reconnecting in 5s...');
        setTimeout(connectBinance, config.reconnectInterval);
    });

    binanceWs.on('error', (e) => logger.error(`[Binance] Error: ${e.message}`));
}

// START
logger.info(`--- Market Listener v3 (XRP Default) ---`);
connectToInternal();
connectBinance();
