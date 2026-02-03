const WebSocket = require('ws');
const winston = require('winston');
const zmq = require('zeromq');
require('dotenv').config();

const config = {
    // IPC (Inter-Process Communication) is significantly faster than TCP ports
    ipcUrl: 'ipc:///tmp/market_feed.sock', 
    reconnectInterval: 5000,
    maxReconnectDelay: 60000,
    // DYNAMIC: Load assets from .env (e.g., "XRP,BTC,ETH")
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

// ==========================================
// ZERO MQ & COALESCING BUFFER SETUP
// ==========================================

// 1. Initialize ZMQ Publisher
const sock = zmq.socket('pub');
try {
    sock.bindSync(config.ipcUrl);
    logger.info(`🚀 ZMQ Publisher bound to ${config.ipcUrl}`);
} catch (e) {
    logger.error(`FATAL: Could not bind ZMQ to ${config.ipcUrl}. Error: ${e.message}`);
    process.exit(1);
}

// 2. High-Performance Coalescing Buffer
// We use a Map to store only the LATEST price for every Asset+Source combo.
const priceBuffer = new Map();
let isFlushPending = false;

// 3. Stats for Monitoring (Optional, helpful for tuning)
let stats = { in: 0, out: 0 };
setInterval(() => {
    if (stats.in > 0) {
        logger.info(`📊 Load Stats: Input ${stats.in/5} msg/s | Output ${stats.out/5} msg/s | Compression: ${((1 - stats.out/stats.in)*100).toFixed(1)}%`);
        stats.in = 0;
        stats.out = 0;
    }
}, 5000);

/**
 * Buffers a price update.
 * If 50 updates arrive in 1ms, this logic ensures we only send the LAST one.
 */
function sendPrice(asset, price, source) {
    stats.in++;

    // Update the buffer (Overwrites old price instantly)
    priceBuffer.set(`${asset}:${source}`, { s: asset, p: price, x: source });

    // Schedule a flush if one isn't already pending.
    // setImmediate executes after I/O events, allowing the buffer to fill up 
    // before we spend CPU cycles sending it.
    if (!isFlushPending) {
        isFlushPending = true;
        setImmediate(flushBuffer);
    }
}

function flushBuffer() {
    for (const data of priceBuffer.values()) {
        // FASTEST: JSON.stringify is native C++ in Node.
        // We send a 2-part message: [Topic, Payload]
        sock.send(['market', JSON.stringify(data)]);
        stats.out++;
    }
    
    priceBuffer.clear();
    isFlushPending = false;
}

// ==========================================
// EXCHANGE CONNECTION LOGIC
// ==========================================

// Connection references
let binanceWs = null;
let okxWs = null;
let gateWs = null;
let bitgetWs = null;

// Reconnection tracking
const reconnectAttempts = { BINANCE: 0, OKX: 0, GATE: 0, BITGET: 0 };

function reconnectWithBackoff(exchange, connectFn) {
    const attempts = reconnectAttempts[exchange];
    const delay = Math.min(config.reconnectInterval * Math.pow(1.5, attempts), config.maxReconnectDelay);
    
    logger.warn(`[${exchange}] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${attempts + 1})`);
    reconnectAttempts[exchange]++;
    
    setTimeout(connectFn, delay);
}

function resetReconnectCounter(exchange) {
    if (reconnectAttempts[exchange] > 0) {
        logger.info(`[${exchange}] Reconnection successful.`);
        reconnectAttempts[exchange] = 0;
    }
}

// ------------------------------------------
// 1. BINANCE FUTURES LISTENER (USDT)
// ------------------------------------------
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
        try {
            // JSON.parse is required to filter data. It is very fast (~0.002ms).
            const msg = JSON.parse(data);
            
            // Validate: Must be a trade event
            if (!msg.data || msg.data.e !== 'trade') return;

            const rawSymbol = msg.data.s; // 'XRPUSDT'
            const asset = rawSymbol.replace('USDT', ''); // 'XRP'
            const price = parseFloat(msg.data.p);
            
            sendPrice(asset, price, 'BINANCE');
        } catch(e) {
            // Ignore parse errors to prevent crash
        }
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] ✗ Connection closed.');
        reconnectWithBackoff('BINANCE', connectBinance);
    });
    
    binanceWs.on('error', (e) => logger.error(`[Binance] Error: ${e.message}`));
}

// ------------------------------------------
// 2. OKX (SWAP) LISTENER (USDT)
// ------------------------------------------
function connectOKX() {
    const url = 'wss://ws.okx.com:8443/ws/v5/public';
    logger.info(`[OKX] Connecting to ${url}`);
    okxWs = new WebSocket(url);
    let pingInterval = null;

    okxWs.on('open', () => {
        logger.info('[OKX] ✓ Connected.');
        resetReconnectCounter('OKX');
        
        // Ping to keep alive
        pingInterval = setInterval(() => {
            if(okxWs && okxWs.readyState === WebSocket.OPEN) okxWs.send('ping');
        }, 20000); 

        const args = config.assets.map(a => ({ channel: 'tickers', instId: `${a}-USDT-SWAP` }));
        okxWs.send(JSON.stringify({ op: 'subscribe', args: args }));
    });

    okxWs.on('message', (data) => {
        try {
            const strData = data.toString();
            if (strData === 'pong') return;
            
            const msg = JSON.parse(strData);
            
            // Check for ticker update
            if (msg.data && msg.data[0] && msg.data[0].last) {
                const instId = msg.arg.instId; 
                const asset = instId.split('-')[0]; // Extract 'XRP'
                const price = parseFloat(msg.data[0].last);
                
                sendPrice(asset, price, 'OKX');
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

// ------------------------------------------
// 3. GATE.IO (FUTURES) LISTENER (USDT)
// ------------------------------------------
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
            
            // Gate.io sometimes sends arrays, sometimes objects
            if (msg.event === 'update' && msg.channel === 'futures.tickers' && msg.result) {
                const tickers = Array.isArray(msg.result) ? msg.result : [msg.result];
                tickers.forEach(t => {
                    if (t && t.contract && t.last) {
                        const asset = t.contract.split('_')[0]; 
                        const price = parseFloat(t.last);
                        sendPrice(asset, price, 'GATE');
                    }
                });
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

// ------------------------------------------
// 4. BITGET (FUTURES) LISTENER (USDT)
// ------------------------------------------
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
                    const instId = msg.arg.instId; // XRPUSDT
                    const asset = instId.replace('USDT', '');
                    const price = parseFloat(msg.data[0].last);
                    
                    sendPrice(asset, price, 'BITGET');
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
// GRACEFUL SHUTDOWN
// ==========================================
function gracefulShutdown() {
    logger.info('🛑 Shutting down...');
    
    // Close ZMQ
    try {
        sock.close();
        logger.info('✓ Closed ZMQ Publisher');
    } catch(e) {}

    const closeWS = (ws) => { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); };
    closeWS(binanceWs);
    closeWS(okxWs);
    closeWS(gateWs);
    closeWS(bitgetWs);
    
    setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ==========================================
// START
// ==========================================
logger.info('🚀 Starting ZMQ Market Listener (IPC Mode)');
logger.info(`📡 Assets: ${config.assets.join(', ')}`);

connectBinance();
connectOKX();
connectGate();
connectBitget();
