
/**
 * market_listener.js
 * Source: Binance Futures (Low Latency)
 * Output: Type 'B' (BookTicker)
 */
const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// CONFIG
const config = {
    // Connects to the trader.js websocket server
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 5000,
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',')
};

// LOGGING
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.simple()
    ),
    transports: [new winston.transports.Console()]
});

let internalWs = null;
let binanceWs = null;

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

// --- 2. CONNECT TO BINANCE (FAST FEED) ---
function connectBinance() {
    // bookTicker is the fastest L1 update (Best Bid/Ask only)
    const streams = config.assets
        .map(a => `${a.toLowerCase()}usdt@bookTicker`)
        .join('/');

    const url = `wss://fstream.binance.com/stream?streams=${streams}`;

    logger.info(`[Binance] Connecting to Low-Latency Stream...`);
    
    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => logger.info('[Binance] ✓ Connected & Streaming.'));

    binanceWs.on('message', (data) => {
        if (!internalWs || internalWs.readyState !== WebSocket.OPEN) return;

        try {
            const msg = JSON.parse(data);
            if (!msg.data) return;

            // Extract Asset Name (e.g., "BTCUSDT" -> "BTC")
            const asset = msg.data.s.replace('USDT', '');

            // Standardize Payload for MicroStrategy
            const payload = {
                type: 'B',                     // 'B' for Binance BookTicker
                s: asset,                      // Symbol
                bb: parseFloat(msg.data.b),    // Best Bid Price
                bq: parseFloat(msg.data.B),    // Best Bid Qty
                ba: parseFloat(msg.data.a),    // Best Ask Price
                aq: parseFloat(msg.data.A)     // Best Ask Qty
            };

            internalWs.send(JSON.stringify(payload));

        } catch (e) {
            // Squelch parsing errors to keep log clean
        }
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] Disconnected. Reconnecting...');
        setTimeout(connectBinance, config.reconnectInterval);
    });
}

// START
connectToInternal();
connectBinance();
