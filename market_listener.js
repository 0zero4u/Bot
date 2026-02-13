/**
 * market_listener.js
 * UNIVERSAL DATA FEEDER (Binance Futures -> Trader)
 * Fixes: Trims spaces from asset names, ensures correct stream formatting, logs data flow.
 */

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- Configuration ---
const config = {
    // Internal Server (The Trader Bot)
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    
    // Binance Connection
    // We use FSTREAM (Futures) because it has higher volume/relevance for Delta trading
    binanceBaseUrl: 'wss://fstream.binance.com/stream?streams=', 
    
    reconnectInterval: 5000,
    
    // FIX: .trim() removes spaces that cause silent stream failures
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL')
        .split(',')
        .map(a => a.trim().toUpperCase()) 
};

// --- Logger ---
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
let stats = { rx: 0, tx: 0 }; // Statistics counter

// --- 1. Connect to Trader Bot (Internal) ---
function connectToInternal() {
    logger.info(`Connecting to Trader Bot at ${config.internalReceiverUrl}...`);
    internalWs = new WebSocket(config.internalReceiverUrl);

    internalWs.on('open', () => {
        logger.info(`✅ Connected to Trader Bot (Outbound Pipeline Open)`);
    });

    internalWs.on('close', () => {
        logger.warn(`⚠️ Disconnected from Trader Bot. Retrying in ${config.reconnectInterval}ms...`);
        setTimeout(connectToInternal, config.reconnectInterval);
    });

    internalWs.on('error', (e) => {
        logger.error(`Trader Bot Connection Error: ${e.message}`);
    });
}

// --- 2. Connect to Binance (External) ---
function connectBinance() {
    // Construct Streams: xrpusdt@bookTicker / xrpusdt@aggTrade
    const streams = config.assets.flatMap(asset => [
        `${asset.toLowerCase()}usdt@bookTicker`,
        `${asset.toLowerCase()}usdt@aggTrade`
    ]).join('/');

    const url = `${config.binanceBaseUrl}${streams}`;
    logger.info(`Connecting to Binance Futures...`);
    logger.info(`Streams: ${streams}`);

    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => {
        logger.info('✅ Connected to Binance (Inbound Data flowing)');
    });

    binanceWs.on('message', (data) => {
        // 1. Parse Data
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) { return; }

        if (!msg.data) return; // Ignore control messages

        stats.rx++;

        // 2. Check Internal Connection
        if (!internalWs || internalWs.readyState !== WebSocket.OPEN) {
            if (stats.rx % 100 === 0) logger.warn(`[Data Drop] Trader Bot not connected. Dropping ${stats.rx}th packet.`);
            return;
        }

        try {
            // 3. Extract Symbol (Robust Method)
            // msg.data.s is usually "XRPUSDT". We want "XRP".
            const rawSymbol = msg.data.s; 
            const asset = rawSymbol.replace('USDT', ''); 
            
            // 4. Transform & Forward
            if (msg.data.e === 'bookTicker') {
                // TYPE 'B': PRICE UPDATE
                const payload = JSON.stringify({
                    type: 'B',
                    s: asset,
                    bb: parseFloat(msg.data.b), // Best Bid Px
                    bq: parseFloat(msg.data.B), // Best Bid Qty
                    ba: parseFloat(msg.data.a), // Best Ask Px
                    aq: parseFloat(msg.data.A)  // Best Ask Qty
                });
                internalWs.send(payload);
                stats.tx++;
            } 
            else if (msg.data.e === 'aggTrade') {
                // TYPE 'T': TRADE UPDATE (For CVD)
                const isSell = msg.data.m; // m=true means Buyer was Maker (Taker Sold)
                const payload = JSON.stringify({
                    type: 'T',
                    s: asset,
                    p: parseFloat(msg.data.p),
                    q: parseFloat(msg.data.q),
                    side: isSell ? 'sell' : 'buy',
                    t: msg.data.T
                });
                internalWs.send(payload);
                stats.tx++;
            }
        } catch (e) {
            logger.error(`Parse Error: ${e.message}`);
        }
    });

    binanceWs.on('close', () => {
        logger.warn('⚠️ Binance Disconnected. Reconnecting...');
        setTimeout(connectBinance, config.reconnectInterval);
    });

    binanceWs.on('error', (e) => logger.error(`Binance Error: ${e.message}`));
}

// --- 3. Heartbeat / Watchdog ---
setInterval(() => {
    logger.info(`[Watchdog] RX (Binance): ${stats.rx} | TX (Trader): ${stats.tx} | Assets: ${config.assets.join(',')}`);
    // Reset stats to see "per interval" flow or keep cumulative (keeping cumulative here)
}, 10000);

// --- Start ---
connectToInternal();
connectBinance();
            
