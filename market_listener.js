
const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 5000,
    maxReconnectDelay: 60000,
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(','),
    // Force 'tick' logic if strategy implies it, or keep dynamic
    strategy: process.env.STRATEGY || 'Tick' 
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

let internalWs = null;
let binanceWs = null;
let reconnectAttempts = 0;

// --- INTERNAL BOT CONNECTION ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);
    
    internalWs.on('open', () => {
        logger.info(`✓ Connected to Internal Bot Receiver.`);
    });
    
    internalWs.on('close', () => {
        logger.warn('⚠ Internal Bot WebSocket closed. Reconnecting...');
        setTimeout(connectToInternal, config.reconnectInterval);
    });
    
    internalWs.on('error', (e) => logger.error(`✗ Internal WS Error: ${e.message}`));
}

function sendToInternal(payload) {
    if (internalWs && internalWs.readyState === WebSocket.OPEN) {
        internalWs.send(JSON.stringify(payload));
    }
}

// ==========================================
// BINANCE LISTENER (COMBINED STREAM)
// ==========================================
function connectBinance() {
    // We combine Streams: depth5@100ms AND trade
    // URL Format: stream?streams=<symbol>@depth5@100ms/<symbol>@trade
    
    const streams = config.assets.map(asset => {
        const s = asset.toLowerCase() + 'usdt';
        return `${s}@depth5@100ms/${s}@trade`;
    }).join('/');

    const url = `wss://fstream.binance.com/stream?streams=${streams}`;
    
    logger.info(`[Binance] Connecting to Combined Stream (Depth+Trade)...`);
    logger.info(`[Binance] URL: ${url}`);
    
    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => {
        logger.info('[Binance] ✓ Connected.');
        reconnectAttempts = 0;
    });
    
    binanceWs.on('message', (data) => {
        if (!data) return;
        try {
            const msg = JSON.parse(data);
            if (!msg.data) return;

            // msg.data.s is usually "BTCUSDT"
            const rawSymbol = msg.data.s; 
            const asset = rawSymbol ? rawSymbol.replace('USDT', '') : null;
            if (!asset) return;

            // 1. Handle DEPTH (For TickStrategy OBI)
            if (msg.data.e === 'depthUpdate') {
                sendToInternal({
                    type: 'D',          
                    s: asset,
                    b: msg.data.b,      // Bids [[price, qty], ...]
                    a: msg.data.a       // Asks [[price, qty], ...]
                });
            } 
            // 2. Handle TRADES (For TickStrategy Causal Trigger)
            // Note: We map this to 'S' (Signal) so standard trader.js passes it to onPriceUpdate
            else if (msg.data.e === 'trade') {
                sendToInternal({
                    type: 'S',          // Standard 'Signal' type for trader.js
                    s: asset,
                    p: msg.data.p,      // Price
                    x: 'BINANCE',       // Source
                    // We append extra data (Volume/Maker) 
                    // Note: Standard trader.js might ignore this, but TickStrategy can use it 
                    // if we modify trader.js or if strategy taps into it.
                    q: msg.data.q,      
                    m: msg.data.m       
                });
            }
        } catch(e) {}
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] ✗ Connection closed.');
        const delay = Math.min(config.reconnectInterval * Math.pow(1.5, reconnectAttempts), config.maxReconnectDelay);
        reconnectAttempts++;
        setTimeout(connectBinance, delay);
    });
    
    binanceWs.on('error', (e) => logger.error(`[Binance] Error: ${e.message}`));
}

// START
connectToInternal();
connectBinance();
                 
