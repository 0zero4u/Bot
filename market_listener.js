/**
 * market_listener.js
 * Source: Binance Futures (Low Latency)
 * Output: Type 'B' (BookTicker)
 * UPDATES: 
 * - Confirmed: 'ws' lib handles Ping/Pong automatically.
 * - Added: WATCHDOG to detect "Silent Freezes" (Critical for HFT).
 */
const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// CONFIG
const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 2000, // Faster reconnect for HFT
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(','),
    watchdogTimeout: 5000    // 5s silence = Dead Connection
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
let msgCount = 0;

// --- WATCHDOG (THE SAFETY NET) ---
function heartbeat() {
    clearTimeout(watchdog);
    // If no message received for 5 seconds, kill and reconnect
    watchdog = setTimeout(() => {
        logger.warn(`[Binance] 🚨 WATCHDOG TRIGGERED: No data for ${config.watchdogTimeout}ms. Terminating...`);
        if (binanceWs) binanceWs.terminate(); 
    }, config.watchdogTimeout);
}

// --- 1. CONNECT TO TRADER BOT ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);

    internalWs.on('open', () => {
        logger.info(`✓ Connected to Trader Bot. Forwarding: ${config.assets.join(', ')}`);
        // Keep connection alive
        setInterval(() => {
            if (internalWs.readyState === WebSocket.OPEN) internalWs.ping();
        }, 30000);
    });

    internalWs.on('close', () => {
        logger.warn('⚠ Internal Bot Disconnected. Retrying...');
        setTimeout(connectToInternal, config.reconnectInterval);
    });

    internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

// --- 2. CONNECT TO BINANCE (FAST FEED) ---
function connectBinance() {
    const streams = config.assets
        .map(a => `${a.toLowerCase()}usdt@bookTicker`) // USDT Futures usually have more liquidity/speed
        .join('/');

    // Using fstream (Futures) for speed. Use stream.binance.com for Spot.
    const url = `wss://fstream.binance.com/stream?streams=${streams}`;

    logger.info(`[Binance] Connecting to: ${url}`);
    
    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => {
        logger.info('[Binance] ✓ Connected & Streaming.');
        heartbeat(); // Start the watchdog
    });

    binanceWs.on('message', (data) => {
        heartbeat(); // Reset watchdog on every message

        if (!internalWs || internalWs.readyState !== WebSocket.OPEN) return;

        try {
            const msg = JSON.parse(data);
            if (!msg.data) return;

            // Robust Parsing: "BTCUSDT" -> "BTC"
            let asset = msg.data.s.toUpperCase().replace('USDT', '');

            const payload = {
                type: 'B',                     
                s: asset,                      
                bb: parseFloat(msg.data.b),    
                bq: parseFloat(msg.data.B),    
                ba: parseFloat(msg.data.a),    
                aq: parseFloat(msg.data.A)     
            };

            internalWs.send(JSON.stringify(payload));

            // Activity Logger (Every 100 ticks)
            msgCount++;
            if (msgCount % 100 === 0) {
                process.stdout.write(`\r[Stream] Processed ${msgCount} ticks... Last: ${asset} @ ${payload.bb}`);
            }

        } catch (e) {
            // Squelch errors
        }
    });

    // Native 'ping' event from Binance (Handled by lib, but we can log it)
    binanceWs.on('ping', () => {
        // logger.debug('[Binance] Received Ping (Lib will Auto-Pong)');
        heartbeat();
    });

    binanceWs.on('close', () => {
        logger.warn('\n[Binance] Disconnected. Reconnecting...');
        clearTimeout(watchdog);
        setTimeout(connectBinance, config.reconnectInterval);
    });
    
    binanceWs.on('error', (e) => {
        logger.error(`[Binance] Error: ${e.message}`);
    });
}

// START
connectToInternal();
connectBinance();
