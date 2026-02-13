/**
 * market_listener.js
 * Source: BINANCE SPOT (stream.binance.com)
 * Output: 
 * - Type 'B' (BookTicker - Price)
 * - Type 'T' (AggTrade - CVD Volume)
 * * FEATURES:
 * - Default Asset: XRP (Restricted for precision/testing)
 * - 10s Heartbeat Log
 * - Watchdog Safety
 */
const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// CONFIG
const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 2000, 
    // UPDATED: Now defaults to XRP only
    assets: (process.env.TARGET_ASSETS || 'XRP').split(','),
    watchdogTimeout: 5000    
};

// LOGGING
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

let internalWs = null;
let binanceWs = null;
let watchdog = null;

// --- WATCHDOG (THE SAFETY NET) ---
function heartbeat() {
    clearTimeout(watchdog);
    // If no message received for 5 seconds, kill and reconnect
    watchdog = setTimeout(() => {
        logger.warn(`[Binance Spot] 🚨 WATCHDOG TIMEOUT. Reconnecting...`);
        if (binanceWs) binanceWs.terminate();
        connectBinance();
    }, config.watchdogTimeout);
}

// --- 1. CONNECT TO TRADER BOT ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);

    internalWs.on('open', () => {
        logger.info(`✓ Connected to Trader Bot. Forwarding: ${config.assets.join(', ')}`);
    });

    internalWs.on('close', () => {
        logger.warn('⚠ Internal Bot Disconnected. Retrying...');
        setTimeout(connectToInternal, config.reconnectInterval);
    });

    internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

// --- 2. CONNECT TO BINANCE SPOT ---
function connectBinance() {
    // Note: Spot streams must be lowercase (e.g., xrpusdt@bookTicker)
    const streams = config.assets.flatMap(a => [
        `${a.toLowerCase()}usdt@bookTicker`,
        `${a.toLowerCase()}usdt@aggTrade`
    ]).join('/');

    // CORRECT URL FOR BINANCE SPOT
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    logger.info(`[Binance Spot] Connecting to Stream for assets: ${config.assets.join(', ')}`);
    
    if (binanceWs) {
        try { binanceWs.terminate(); } catch(e){}
    }

    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => {
        logger.info('[Binance Spot] ✓ Connected (Price + CVD).');
        heartbeat(); 
    });

    binanceWs.on('message', (data) => {
        heartbeat(); // Reset watchdog on every message

        if (!internalWs || internalWs.readyState !== WebSocket.OPEN) return;

        try {
            const msg = JSON.parse(data);
            if (!msg.data) return;

            const eventType = msg.data.e;
            const asset = msg.data.s.replace('USDT', '');

            // 1. PRICE UPDATE (BookTicker)
            if (eventType === 'bookTicker') {
                const payload = {
                    type: 'B',
                    s: asset,
                    bb: parseFloat(msg.data.b),
                    bq: parseFloat(msg.data.B),
                    ba: parseFloat(msg.data.a),
                    aq: parseFloat(msg.data.A)
                };
                internalWs.send(JSON.stringify(payload));
            } 
            // 2. CVD UPDATE (AggTrade)
            else if (eventType === 'aggTrade') {
                // m = true -> Buyer is Maker -> Taker is Seller -> SELL SIDE
                // m = false -> Seller is Maker -> Taker is Buyer -> BUY SIDE
                const isSell = msg.data.m; 
                
                const payload = {
                    type: 'T',                    
                    s: asset,
                    p: parseFloat(msg.data.p),
                    q: parseFloat(msg.data.q),
                    side: isSell ? 'sell' : 'buy',
                    t: msg.data.T
                };
                internalWs.send(JSON.stringify(payload));
            }

        } catch (e) {
            // Squelch parsing errors
        }
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance Spot] Disconnected from Binance. Reconnecting...');
        clearTimeout(watchdog);
        setTimeout(connectBinance, config.reconnectInterval);
    });

    binanceWs.on('error', (e) => {
        logger.error(`[Binance Spot] WebSocket Error: ${e.message}`);
        binanceWs.terminate();
    });
}

// --- 3. ALIVENESS LOG (Every 10 Seconds) ---
setInterval(() => {
    if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        logger.info(`[Listener] 💓 Alive | Mode: Spot | Watchdog: OK | Assets: ${config.assets.join(',')}`);
    }
}, 10000);

// START
connectToInternal();
connectBinance();
                    
