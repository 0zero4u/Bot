const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    // Port must match the one in trader.js
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
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

// Connection references
let internalWs = null;
let binanceWs = null;
let okxWs = null;
let gateWs = null;
let bitgetWs = null;

// Reconnection tracking
const reconnectAttempts = {
    BINANCE: 0,
    OKX: 0,
    GATE: 0,
    BITGET: 0
};

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
 * Sends a normalized price update to the main bot.
 * @param {string} asset - e.g., 'XRP'
 * @param {number} price - e.g., 0.55
 * @param {string} source - e.g., 'BINANCE'
 */
function sendPrice(asset, price, source) {
    if (internalWs && internalWs.readyState === WebSocket.OPEN) {
        // Payload: { type: 'S', s: 'XRP', p: 0.55, x: 'BINANCE' }
        const payload = JSON.stringify({ type: 'S', s: asset, p: price, x: source });
        internalWs.send(payload);
    } else {
        // Suppress repetitive log warnings if disconnected to avoid spam
    }
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

/**
 * Reset reconnection counter on successful connection
 */
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
    // Stream format: xrpusdt@trade / btcusdt@trade
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
            const msg = JSON.parse(data.toString());
            // Format: { stream: 'xrpusdt@trade', data: { s: 'XRPUSDT', p: '...', e: 'trade' } }
            if (!msg.data || msg.data.e !== 'trade') return;

            const rawSymbol = msg.data.s; // 'XRPUSDT'
            const asset = rawSymbol.replace('USDT', ''); // 'XRP'
            const price = parseFloat(msg.data.p);
            
            if (!isNaN(price) && price > 0) {
                sendPrice(asset, price, 'BINANCE');
            }
        } catch(e) {
            logger.error(`[Binance] Parse error: ${e.message}`);
        }
    });

    binanceWs.on('close', () => {
        logger.warn('[Binance] ✗ Connection closed.');
        reconnectWithBackoff('BINANCE', connectBinance);
    });
    
    binanceWs.on('error', (e) => {
        logger.error(`[Binance] Error: ${e.message}`);
    });
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
            if(okxWs && okxWs.readyState === WebSocket.OPEN) {
                okxWs.send('ping');
            }
        }, 30000); 

        // Subscribe to Tickers: XRP-USDT-SWAP
        const args = config.assets.map(a => ({ 
            channel: 'tickers', 
            instId: `${a}-USDT-SWAP` 
        }));
        okxWs.send(JSON.stringify({ op: 'subscribe', args: args }));
    });

    okxWs.on('message', (data) => {
        try {
            const strData = data.toString();
            if (strData === 'pong') return;
            
            const msg = JSON.parse(strData);
            
            if (msg.event === 'subscribe') {
                logger.info(`[OKX] Subscribed to ${msg.arg?.instId || 'channels'}`);
                return;
            }
            
            if (msg.event === 'error') {
                logger.error(`[OKX] Subscription error: ${msg.msg}`);
                return;
            }
            
            if (msg.data && msg.data[0] && msg.data[0].last) {
                const instId = msg.arg.instId; 
                const asset = instId.split('-')[0]; // Extract 'XRP'
                const price = parseFloat(msg.data[0].last);
                
                if (!isNaN(price) && price > 0) {
                    sendPrice(asset, price, 'OKX');
                }
            }
        } catch (e) {
            logger.error(`[OKX] Parse error: ${e.message}`);
        }
    });

    okxWs.on('close', () => {
        if (pingInterval) clearInterval(pingInterval);
        logger.warn('[OKX] ✗ Connection closed.');
        reconnectWithBackoff('OKX', connectOKX);
    });
    
    okxWs.on('error', (e) => {
        logger.error(`[OKX] Error: ${e.message}`);
    });
}

// ==========================================
// 3. GATE.IO (FUTURES) LISTENER (USDT) - FIXED
// ==========================================
function connectGate() {
    const url = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
    logger.info(`[Gate.io] Connecting to ${url}`);
    gateWs = new WebSocket(url);
    
    let pingInterval = null;

    gateWs.on('open', () => {
        logger.info('[Gate.io] ✓ Connected.');
        resetReconnectCounter('GATE');
        
        // Ping every 15 seconds
        pingInterval = setInterval(() => {
            if(gateWs && gateWs.readyState === WebSocket.OPEN) {
                gateWs.send(JSON.stringify({ 
                    time: Math.floor(Date.now() / 1000), 
                    channel: 'futures.ping' 
                }));
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
            
            if (msg.event === 'subscribe') {
                if (msg.error === null) {
                    logger.info(`[Gate.io] Subscribed to ${msg.channel}`);
                } else {
                    logger.error(`[Gate.io] Subscription error: ${JSON.stringify(msg.error)}`);
                }
                return;
            }
            
            // --- FIX START: Handle Array Response ---
            // msg: { event: 'update', result: [ { contract: 'BTC_USDT', last: '...' } ] }
            if (msg.event === 'update' && msg.channel === 'futures.tickers' && msg.result) {
                // Ensure we handle it as a list, even if API sends single object
                const tickers = Array.isArray(msg.result) ? msg.result : [msg.result];

                tickers.forEach(t => {
                    if (t && t.contract && t.last) {
                        const rawSymbol = t.contract; 
                        const asset = rawSymbol.split('_')[0]; // Extract 'XRP' from 'XRP_USDT'
                        const price = parseFloat(t.last);
                        
                        if (!isNaN(price) && price > 0) {
                            sendPrice(asset, price, 'GATE');
                        }
                    }
                });
            }
            // --- FIX END ---
        } catch (e) {
            logger.error(`[Gate.io] Parse error: ${e.message}`);
        }
    });

    gateWs.on('close', () => {
        if (pingInterval) clearInterval(pingInterval);
        logger.warn('[Gate.io] ✗ Connection closed.');
        reconnectWithBackoff('GATE', connectGate);
    });
    
    gateWs.on('error', (e) => {
        logger.error(`[Gate.io] Error: ${e.message}`);
    });
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
            if(bitgetWs && bitgetWs.readyState === WebSocket.OPEN) {
                bitgetWs.send('ping');
            }
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
            
            if (msg.event === 'subscribe') {
                logger.info(`[Bitget] Subscribed: ${msg.arg?.instId || 'channels'}`);
                return;
            }
            
            if (msg.event === 'error') {
                logger.error(`[Bitget] Error: ${msg.msg}`);
                return;
            }
            
            if ((msg.action === 'snapshot' || msg.action === 'update') && msg.data && msg.data[0]) {
                if (msg.data[0].last) {
                    const instId = msg.arg.instId; // XRPUSDT
                    const asset = instId.replace('USDT', ''); // XRP
                    const price = parseFloat(msg.data[0].last);
                    
                    if (!isNaN(price) && price > 0) {
                        sendPrice(asset, price, 'BITGET');
                    }
                }
            }
        } catch (e) {
            logger.error(`[Bitget] Parse error: ${e.message}`);
        }
    });

    bitgetWs.on('close', () => {
        if (pingInterval) clearInterval(pingInterval);
        logger.warn('[Bitget] ✗ Connection closed.');
        reconnectWithBackoff('BITGET', connectBitget);
    });
    
    bitgetWs.on('error', (e) => {
        logger.error(`[Bitget] Error: ${e.message}`);
    });
}

// ==========================================
// CONNECTION HEALTH MONITORING
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
        const total = Object.keys(status).length;
        
        logger.info(`📊 Health Check: ${connected}/${total} connections active | ${JSON.stringify(status)}`);
        
        // Alert if internal connection is down
        if (!status.internal) {
            logger.error('🚨 CRITICAL: Internal Bot WebSocket is DOWN!');
        }
    }, 60000); // Every 60 seconds
}

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
function gracefulShutdown() {
    logger.info('🛑 Shutting down gracefully...');
    
    const closeConnection = (ws, name) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
            logger.info(`✓ Closed ${name} connection`);
        }
    };
    
    closeConnection(internalWs, 'Internal');
    closeConnection(binanceWs, 'Binance');
    closeConnection(okxWs, 'OKX');
    closeConnection(gateWs, 'Gate.io');
    closeConnection(bitgetWs, 'Bitget');
    
    setTimeout(() => {
        logger.info('👋 Shutdown complete');
        process.exit(0);
    }, 1000);
}

// Handle process termination
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    logger.error(`💥 Uncaught Exception: ${err.message}`);
    logger.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`💥 Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// ==========================================
// INITIALIZATION
// ==========================================
logger.info('🚀 Starting Market Listener v11.2.0 (FIXED)');
logger.info(`📡 Assets: ${config.assets.join(', ')}`);
logger.info(`🔌 Internal Receiver: ${config.internalReceiverUrl}`);

// Connect to all services
connectToInternal();
connectBinance();
connectOKX();
connectGate();
connectBitget();

// Start health monitoring after 10 seconds
setTimeout(monitorConnections, 10000);

logger.info('✓ All connections initiated. Waiting for streams...');
