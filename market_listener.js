const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// ==========================================
// CONFIG
// ==========================================
const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 80}`,
    reconnectInterval: 5000,
    maxReconnectDelay: 60000,
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',')
};

// ==========================================
// LOGGING
// ==========================================
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.simple()
    ),
    transports: [new winston.transports.Console()]
});

// ==========================================
// CONNECTION REFERENCES
// ==========================================
let internalWs = null;
let binanceWs = null;

// ==========================================
// RECONNECTION TRACKING
// ==========================================
const reconnectAttempts = { BINANCE: 0 };

// ==========================================
// INTERNAL BOT CONNECTION
// ==========================================
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);

    internalWs.on('open', () => {
        logger.info(`✓ Connected to Internal Bot Receiver. Tracking: ${config.assets.join(', ')}`);
    });

    internalWs.on('close', () => {
        logger.warn('⚠ Internal Bot WebSocket closed. Reconnecting...');
        setTimeout(connectToInternal, config.reconnectInterval);
    });

    internalWs.on('error', (e) =>
        logger.error(`✗ Internal WS Error: ${e.message}`)
    );
}

// ==========================================
// SEND TO INTERNAL
// ==========================================
function sendToInternal(payload) {
    if (internalWs && internalWs.readyState === WebSocket.OPEN) {
        internalWs.send(JSON.stringify(payload));
    }
}

// ==========================================
// BINANCE FUTURES — BOOK TICKER ONLY
// ==========================================
function connectBinance() {
    const streamType = 'bookTicker';

    const streams = config.assets
        .map(a => `${a.toLowerCase()}usdt@${streamType}`)
        .join('/');

    const url = `wss://fstream.binance.com/stream?streams=${streams}`;

    logger.info('[Binance] Mode: 📘 BOOK TICKER (Best Bid / Ask)');
    logger.info(`[Binance] Connecting to ${url}`);

    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => {
        logger.info('[Binance] ✓ Connected.');
        resetReconnectCounter('BINANCE');
    });

    binanceWs.on('message', (data) => {
        if (!data) return;

        try {
            const msg = JSON.parse(data);
            if (!msg.data || msg.data.e !== 'bookTicker') return;

            const asset = msg.data.s.replace('USDT', '');

            sendToInternal({
                type: 'B',                     // BookTicker
                s: asset,
                bb: parseFloat(msg.data.b),   // Best Bid Price
                ba: parseFloat(msg.data.a),   // Best Ask Price
                bq: parseFloat(msg.data.B),   // Best Bid Qty
                aq: parseFloat(msg.data.A)    // Best Ask Qty
            });
        } catch (e) {
            logger.error(`[Binance] Parse error: ${e.message}`);
        }
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] ✗ Connection closed.');
        reconnectWithBackoff('BINANCE', connectBinance);
    });

    binanceWs.on('error', (e) =>
        logger.error(`[Binance] Error: ${e.message}`)
    );
}

// ==========================================
// RECONNECTION LOGIC
// ==========================================
function reconnectWithBackoff(exchange, connectFn) {
    const attempts = reconnectAttempts[exchange];
    const delay = Math.min(
        config.reconnectInterval * Math.pow(1.5, attempts),
        config.maxReconnectDelay
    );

    logger.warn(`[${exchange}] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${attempts + 1})`);
    reconnectAttempts[exchange]++;

    setTimeout(connectFn, delay);
}

function resetReconnectCounter(exchange) {
    if (reconnectAttempts[exchange] > 0) {
        logger.info(`[${exchange}] Reconnection successful after ${reconnectAttempts[exchange]} attempts`);
        reconnectAttempts[exchange] = 0;
    }
}

// ==========================================
// HEALTH MONITOR
// ==========================================
function monitorConnections() {
    setInterval(() => {
        const status = {
            internal: internalWs?.readyState === WebSocket.OPEN,
            binance: binanceWs?.readyState === WebSocket.OPEN
        };

        const connected = Object.values(status).filter(Boolean).length;

        logger.info(`📊 Health: ${connected}/2 active`);

        if (!status.internal) logger.error('🚨 Internal Bot WS DOWN');
    }, 60000);
}

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
function gracefulShutdown() {
    logger.info('🛑 Shutting down...');
    [internalWs, binanceWs].forEach(ws => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    });
    setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) =>
    logger.error(`💥 Uncaught: ${err.message}`)
);

// ==========================================
// START
// ==========================================
connectToInternal();
connectBinance();
setTimeout(monitorConnections, 10000);
    
