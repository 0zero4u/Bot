
const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 80}`,
    reconnectInterval: 5000,
    maxReconnectDelay: 60000,
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',')
};

// --- LOGGING ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.simple()
    ),
    transports: [new winston.transports.Console()]
});

// Connection references
let internalWs = null;
let binanceWs = null;

// Reconnection tracking
const reconnectAttempts = { BINANCE: 0 };

// --- OPTIMIZATION STATE ---
const lastPriceCache = new Map(); 
const updateBuffer = new Map();   
let isFlushScheduled = false;

// --- INTERNAL BOT CONNECTION ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);
    
    internalWs.on('open', () => {
        logger.info(`✓ Connected to Internal Bot Receiver. Tracking: ${config.assets.join(', ')}`);
    });
    
    internalWs.on('close', () => {
        logger.warn('⚠ Internal Bot WebSocket closed. Reconnecting...');
        setTimeout(connectToInternal, config.reconnectInterval);
    });
    
    internalWs.on('error', (e) => logger.error(`✗ Internal WS Error: ${e.message}`));
}

// --- CORE LOGIC (Deduplication & Coalescing) ---
function sendPrice(asset, price, source) {
    const key = `${asset}:${source}`;
    const lastPrice = lastPriceCache.get(key);
    
    if (lastPrice === price) return; 

    lastPriceCache.set(key, price);

    const payload = { type: 'S', s: asset, p: price, x: source };
    updateBuffer.set(key, payload);

    if (!isFlushScheduled) {
        isFlushScheduled = true;
        setImmediate(flushBuffer);
    }
}

function flushBuffer() {
    if (internalWs && internalWs.readyState === WebSocket.OPEN) {
        for (const payload of updateBuffer.values()) {
            internalWs.send(JSON.stringify(payload));
        }
    }
    updateBuffer.clear();
    isFlushScheduled = false;
}

// --- RECONNECTION LOGIC ---
function reconnectWithBackoff(exchange, connectFn) {
    const attempts = reconnectAttempts[exchange];
    const delay = Math.min(config.reconnectInterval * Math.pow(1.5, attempts), config.maxReconnectDelay);
    
    logger.warn(`[${exchange}] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${attempts + 1})`);
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
// 1. BINANCE FUTURES LISTENER (USDT)
// ==========================================
function connectBinance() {
    const streams = config.assets.map(a => `${a.toLowerCase()}usdt@trade`).join('/');
    const url = `wss://fstream.binance.com/stream?streams=${streams}`;
    
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
            if (!msg.data || msg.data.e !== 'trade') return;

            const rawSymbol = msg.data.s; 
            const asset = rawSymbol.replace('USDT', ''); 
            const price = parseFloat(msg.data.p);
            
            if (price > 0) sendPrice(asset, price, 'BINANCE');
        } catch(e) {}
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] ✗ Connection closed.');
        reconnectWithBackoff('BINANCE', connectBinance);
    });
    
    binanceWs.on('error', (e) => logger.error(`[Binance] Error: ${e.message}`));
}

// ==========================================
// HEALTH & SHUTDOWN
// ==========================================
function monitorConnections() {
    setInterval(() => {
        const status = {
            internal: internalWs?.readyState === WebSocket.OPEN,
            binance: binanceWs?.readyState === WebSocket.OPEN
        };
        const connected = Object.values(status).filter(v => v).length;
        logger.info(`📊 Health: ${connected}/2 active | Buffer Size: ${updateBuffer.size}`);
        
        if (!status.internal) logger.error('🚨 Internal Bot WS DOWN');
    }, 60000);
}

function gracefulShutdown() {
    logger.info('🛑 Shutting down...');
    [internalWs, binanceWs].forEach(ws => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    });
    setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) => logger.error(`💥 Uncaught: ${err.message}`));

// START
connectToInternal();
connectBinance();
setTimeout(monitorConnections, 10000);
