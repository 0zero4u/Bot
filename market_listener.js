/**
 * market_listener.js
 * Source: BINANCE SPOT (stream.binance.com)
 * Output: 
 * - Type 'B' (BookTicker - Price)
 * - Type 'T' (AggTrade - CVD Volume)
 * * FEATURES:
 * - Correct Spot URL (Port 9443)
 * - Watchdog Safety
 * - CVD Data Parsing
 */
const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// CONFIG
const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 2000, 
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(','),
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

// --- WATCHDOG ---
function heartbeat() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
        logger.warn(`[Binance Spot] 🚨 WATCHDOG TIMEOUT. Reconnecting...`);
        if (binanceWs) binanceWs.terminate();
        connectBinance();
    }, config.watchdogTimeout);
}

// --- 1. CONNECT TO TRADER BOT ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);

    internalWs.on('open', () => logger.info(`✓ Connected to Trader Bot.`));
    internalWs.on('close', () => setTimeout(connectToInternal, config.reconnectInterval));
    internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

// --- 2. CONNECT TO BINANCE SPOT ---
function connectBinance() {
    // Note: Spot streams must be Lowercase
    const streams = config.assets.flatMap(a => [
        `${a.toLowerCase()}usdt@bookTicker`,
        `${a.toLowerCase()}usdt@aggTrade`
    ]).join('/');

    // CORRECT URL FOR SPOT
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    logger.info(`[Binance Spot] Connecting...`);
    
    if (binanceWs) {
        try { binanceWs.terminate(); } catch(e){}
    }

    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => {
        logger.info('[Binance Spot] ✓ Connected (Price + CVD).');
        heartbeat(); 
    });

    binanceWs.on('message', (data) => {
        heartbeat(); 
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
                // SPOT LOGIC: 
                // m = true -> Buyer is Maker -> Taker is Seller -> SELL SIDE
                // m = false -> Seller is Maker -> Taker is Buyer -> BUY SIDE
                const isSell = msg.data.m; 
                
                const payload = {
                    type: 'T',                    
                    s: asset,
                    p: parseFloat(msg.data.p),
                    q: parseFloat(msg.data.q),
                    side: isSell ? 'sell' : 'buy', // Correctly interpreted
                    t: msg.data.T
                };
                internalWs.send(JSON.stringify(payload));
            }
        } catch (e) {}
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance Spot] Disconnected. Reconnecting...');
        clearTimeout(watchdog);
        setTimeout(connectBinance, config.reconnectInterval);
    });

    binanceWs.on('error', (e) => {
        logger.error(`[Binance Spot] Error: ${e.message}`);
        binanceWs.terminate();
    });
}

connectToInternal();
connectBinance();
