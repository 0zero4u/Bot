

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
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
let okxWs = null;
let gateWs = null;
let bitgetWs = null;

// Reconnection tracking
const reconnectAttempts = { BINANCE: 0, OKX: 0, GATE: 0, BITGET: 0 };

// --- OPTIMIZATION STATE ---
// 1. DEDUPLICATION CACHE: Prevents processing exact duplicate prices
const lastPriceCache = new Map(); // Key: "ASSET:SOURCE", Value: Price (float)

// 2. COALESCING BUFFER: key-value storage for the "next" update to send
const updateBuffer = new Map();   // Key: "ASSET:SOURCE", Value: Payload Object
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

/**
 * CORE OPTIMIZATION:
 * 1. Checks if price changed (Deduplication).
 * 2. Updates a buffer map (Coalescing).
 * 3. Schedules a flush on the next event loop tick.
 */
function sendPrice(asset, price, source) {
    // Generate unique key for this asset/source combo
    const key = `${asset}:${source}`;

    // --- STAGE 1: DEDUPLICATION ---
    // If the price is exactly the same as the last one we processed, ignore it.
    // This saves JSON.stringify and Network I/O costs.
    const lastPrice = lastPriceCache.get(key);
    if (lastPrice === price) {
        return; 
    }

    // Update Cache
    lastPriceCache.set(key, price);

    // --- STAGE 2: COALESCING BUFFER ---
    // We create the payload object but DO NOT serialize (stringify) it yet.
    // If another update comes for this key before flush, this object is overwritten.
    const payload = { type: 'S', s: asset, p: price, x: source };
    updateBuffer.set(key, payload);

    // --- STAGE 3: SCHEDULER ---
    // Use setImmediate to process the buffer after I/O callbacks are done.
    if (!isFlushScheduled) {
        isFlushScheduled = true;
        setImmediate(flushBuffer);
    }
}

/**
 * Flushes the Coalesced Buffer to the Internal WebSocket.
 * This runs once per event loop tick.
 */
function flushBuffer() {
    if (internalWs && internalWs.readyState === WebSocket.OPEN) {
        // Iterate through unique updates
        for (const payload of updateBuffer.values()) {
            // Only JSON.stringify the WINNING price for this tick
            internalWs.send(JSON.stringify(payload));
        }
    }
    
    // Clear buffer and reset flag
    updateBuffer.clear();
    isFlushScheduled = false;
}

/**
 * Reconnect with exponential backoff
 */
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
        // Fast-fail check before parsing
        if (!data) return;

        try {
            const msg = JSON.parse(data); // Native parsing is fastest
            if (!msg.data || msg.data.e !== 'trade') return;

            const rawSymbol = msg.data.s; 
            const asset = rawSymbol.replace('USDT', ''); 
            const price = parseFloat(msg.data.p);
            
            // Standard check
            if (price > 0) {
                sendPrice(asset, price, 'BINANCE');
            }
        } catch(e) {
            // Suppress errors for speed, or log only critical ones
        }
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] ✗ Connection closed.');
        reconnectWithBackoff('BINANCE', connectBinance);
    });
    
    binanceWs.on('error', (e) => logger.error(`[Binance] Error: ${e.message}`));
}

// ==========================================
// 2. OKX (SWAP) LISTENER (USDT)
// ==========================================
function connectOKX() {
    const url = 'wss://ws.okx.com:8443/ws/v5/public';
    logger.info(`[OKX] Connecting to ${url}`);
    okxWs = new WebSocket(url);
    let pingInterval = null;

    okxWs.on('open', () => {
        logger.info('[OKX] ✓ Connected.');
        resetReconnectCounter('OKX');
        
        pingInterval = setInterval(() => {
            if(okxWs && okxWs.readyState === WebSocket.OPEN) okxWs.send('ping');
        }, 30000);

        const args = config.assets.map(a => ({ channel: 'tickers', instId: `${a}-USDT-SWAP` }));
        okxWs.send(JSON.stringify({ op: 'subscribe', args: args }));
    });

    okxWs.on('message', (data) => {
        try {
            const strData = data.toString();
            if (strData === 'pong') return;
            
            const msg = JSON.parse(strData);
            
            // Optimized path for ticker data
            if (msg.data && msg.data[0]) {
                const instId = msg.arg.instId; 
                const asset = instId.split('-')[0];
                const price = parseFloat(msg.data[0].last);
                
                if (price > 0) sendPrice(asset, price, 'OKX');
            }
        } catch (e) {}
    });

    okxWs.on('close', () => {
        if (pingInterval) clearInterval(pingInterval);
        logger.warn('[OKX] ✗ Connection closed.');
        reconnectWithBackoff('OKX', connectOKX);
    });
    
    okxWs.on('error', (e) => logger.error(`[OKX] Error: ${e.message}`));
}

// ==========================================
// 3. GATE.IO (FUTURES) LISTENER (USDT)
// ==========================================
function connectGate() {
    const url = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
    logger.info(`[Gate.io] Connecting to ${url}`);
    gateWs = new WebSocket(url);
    let pingInterval = null;

    gateWs.on('open', () => {
        logger.info('[Gate.io] ✓ Connected.');
        resetReconnectCounter('GATE');
        
        pingInterval = setInterval(() => {
            if(gateWs && gateWs.readyState === WebSocket.OPEN) {
                gateWs.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' }));
            }
        }, 15000);

        const symbols = config.assets.map(a => `${a}_USDT`);
        gateWs.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: 'futures.tickers',
            event: 'subscribe',
            payload: symbols
        }));
    });

    gateWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.channel === 'futures.pong') return;
            
            if (msg.event === 'update' && msg.channel === 'futures.tickers' && msg.result) {
                const rawSymbol = msg.result.contract; 
                const asset = rawSymbol.split('_')[0]; 
                const price = parseFloat(msg.result.last);
                
                if (price > 0) sendPrice(asset, price, 'GATE');
            }
        } catch (e) {}
    });

    gateWs.on('close', () => {
        if (pingInterval) clearInterval(pingInterval);
        logger.warn('[Gate.io] ✗ Connection closed.');
        reconnectWithBackoff('GATE', connectGate);
    });
    
    gateWs.on('error', (e) => logger.error(`[Gate.io] Error: ${e.message}`));
}

// ==========================================
// 4. BITGET (FUTURES) LISTENER (USDT)
// ==========================================
function connectBitget() {
    const url = 'wss://ws.bitget.com/v2/ws/public';
    logger.info(`[Bitget] Connecting to ${url}`);
    bitgetWs = new WebSocket(url);
    let pingInterval = null;

    bitgetWs.on('open', () => {
        logger.info('[Bitget] ✓ Connected.');
        resetReconnectCounter('BITGET');
        
        pingInterval = setInterval(() => {
            if(bitgetWs && bitgetWs.readyState === WebSocket.OPEN) bitgetWs.send('ping');
        }, 30000);

        const args = config.assets.map(a => ({
            instType: 'USDT-FUTURES',
            channel: 'ticker',
            instId: `${a}USDT`
        }));
        bitgetWs.send(JSON.stringify({ op: 'subscribe', args: args }));
    });

    bitgetWs.on('message', (data) => {
        try {
            const strData = data.toString();
            if (strData === 'pong') return;
            const msg = JSON.parse(strData);
            
            if ((msg.action === 'snapshot' || msg.action === 'update') && msg.data && msg.data[0]) {
                if (msg.data[0].last) {
                    const instId = msg.arg.instId; 
                    const asset = instId.replace('USDT', '');
                    const price = parseFloat(msg.data[0].last);
                    
                    if (price > 0) sendPrice(asset, price, 'BITGET');
                }
            }
        } catch (e) {}
    });

    bitgetWs.on('close', () => {
        if (pingInterval) clearInterval(pingInterval);
        logger.warn('[Bitget] ✗ Connection closed.');
        reconnectWithBackoff('BITGET', connectBitget);
    });
    
    bitgetWs.on('error', (e) => logger.error(`[Bitget] Error: ${e.message}`));
}

// ==========================================
// HEALTH & SHUTDOWN
// ==========================================
function monitorConnections() {
    setInterval(() => {
        const status = {
            internal: internalWs?.readyState === WebSocket.OPEN,
            binance: binanceWs?.readyState === WebSocket.OPEN,
            okx: okxWs?.readyState === WebSocket.OPEN,
            gate: gateWs?.readyState === WebSocket.OPEN,
            bitget: bitgetWs?.readyState === WebSocket.OPEN
        };
        const connected = Object.values(status).filter(v => v).length;
        logger.info(`📊 Health: ${connected}/5 active | Buffer Size: ${updateBuffer.size}`);
        
        if (!status.internal) logger.error('🚨 Internal Bot WS DOWN');
    }, 60000);
}

function gracefulShutdown() {
    logger.info('🛑 Shutting down...');
    [internalWs, binanceWs, okxWs, gateWs, bitgetWs].forEach(ws => {
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
connectOKX();
connectGate();
connectBitget();
setTimeout(monitorConnections, 10000);
