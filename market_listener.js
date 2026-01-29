// market_listener.js
// Version 10.0.0 - Multi-Exchange Aggregator (Binance, OKX, Gate, Bitget)
// Sends source-tagged prices to the main Trader bot to prevent cross-exchange noise.

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    // Port must match the one in trader.js
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 5000,
    // The assets we want to track across all exchanges
    assets: ['BTC', 'ETH', 'SOL'] 
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

// --- INTERNAL BOT CONNECTION ---
function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);
    
    internalWs.on('open', () => {
        logger.info('Connected to Internal Bot Receiver.');
    });
    
    internalWs.on('close', () => {
        logger.warn('Internal Bot WebSocket closed. Reconnecting...');
        setTimeout(connectToInternal, config.reconnectInterval);
    });
    
    internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

/**
 * Sends a normalized price update to the main bot.
 * @param {string} asset - e.g., 'BTC'
 * @param {number} price - e.g., 50000.50
 * @param {string} source - e.g., 'BINANCE', 'OKX', 'GATE', 'BITGET'
 */
function sendPrice(asset, price, source) {
    if (internalWs && internalWs.readyState === WebSocket.OPEN) {
        // Payload: { type: 'S', s: 'BTC', p: 89000, x: 'BINANCE' }
        const payload = JSON.stringify({ type: 'S', s: asset, p: price, x: source });
        internalWs.send(payload);
    }
}

// ==========================================
// 1. BINANCE FUTURES LISTENER
// ==========================================
function connectBinance() {
    // Stream format: btcusdt@trade / ethusdt@trade
    const streams = config.assets.map(a => `${a.toLowerCase()}usdt@trade`).join('/');
    const url = `wss://fstream.binance.com/stream?streams=${streams}`;
    
    logger.info(`[Binance] Connecting to ${url}`);
    const ws = new WebSocket(url);

    ws.on('open', () => logger.info('[Binance] Connected.'));
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            // Format: { stream: 'btcusdt@trade', data: { s: 'BTCUSDT', p: '...' } }
            if (!msg.data || msg.data.e !== 'trade') return;

            const rawSymbol = msg.data.s; // 'BTCUSDT'
            const asset = rawSymbol.replace('USDT', ''); 
            const price = parseFloat(msg.data.p);
            
            sendPrice(asset, price, 'BINANCE');
        } catch(e) {}
    });

    ws.on('close', () => {
        logger.warn('[Binance] Closed. Reconnecting...');
        setTimeout(connectBinance, config.reconnectInterval);
    });
    
    ws.on('error', (e) => logger.error(`[Binance] Error: ${e.message}`));
}

// ==========================================
// 2. OKX (SWAP) LISTENER
// ==========================================
function connectOKX() {
    const url = 'wss://ws.okx.com:8443/ws/v5/public';
    logger.info(`[OKX] Connecting to ${url}`);
    const ws = new WebSocket(url);
    
    // Heartbeat for OKX
    const pingInterval = setInterval(() => {
        if(ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 20000);

    ws.on('open', () => {
        logger.info('[OKX] Connected.');
        // Subscribe to Tickers: BTC-USDT-SWAP
        const args = config.assets.map(a => ({ channel: 'tickers', instId: `${a}-USDT-SWAP` }));
        ws.send(JSON.stringify({ op: 'subscribe', args: args }));
    });

    ws.on('message', (data) => {
        try {
            const strData = data.toString();
            if (strData === 'pong') return;
            
            const msg = JSON.parse(strData);
            // msg: { arg: { instId: 'BTC-USDT-SWAP' }, data: [{ last: '...' }] }
            if (msg.data && msg.data[0]) {
                const instId = msg.arg.instId; 
                const asset = instId.split('-')[0]; // Extract 'BTC'
                const price = parseFloat(msg.data[0].last);
                
                sendPrice(asset, price, 'OKX');
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        clearInterval(pingInterval);
        logger.warn('[OKX] Closed. Reconnecting...');
        setTimeout(connectOKX, config.reconnectInterval);
    });
    ws.on('error', (e) => logger.error(`[OKX] Error: ${e.message}`));
}

// ==========================================
// 3. GATE.IO (FUTURES) LISTENER
// ==========================================
function connectGate() {
    const url = 'wss://fx-ws.gateio.ws/v4/ws/usdt';
    logger.info(`[Gate.io] Connecting to ${url}`);
    const ws = new WebSocket(url);
    
    // Heartbeat for Gate
    const pingInterval = setInterval(() => {
        if(ws.readyState === WebSocket.OPEN) {
             ws.send(JSON.stringify({ time: Date.now(), channel: 'spot.ping', event: 'ping' }));
        }
    }, 10000);

    ws.on('open', () => {
        logger.info('[Gate.io] Connected.');
        const symbols = config.assets.map(a => `${a}_USDT`);
        // Subscribe
        ws.send(JSON.stringify({
            time: Date.now(),
            channel: 'futures.tickers',
            event: 'subscribe',
            payload: symbols
        }));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            // msg: { event: 'update', result: { contract: 'BTC_USDT', last: '...' } }
            if (msg.event === 'update' && msg.result) {
                const rawSymbol = msg.result.contract; 
                const asset = rawSymbol.split('_')[0]; // Extract 'BTC'
                const price = parseFloat(msg.result.last);
                
                sendPrice(asset, price, 'GATE');
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        clearInterval(pingInterval);
        logger.warn('[Gate.io] Closed. Reconnecting...');
        setTimeout(connectGate, config.reconnectInterval);
    });
    ws.on('error', (e) => logger.error(`[Gate] Error: ${e.message}`));
}

// ==========================================
// 4. BITGET (MIX/FUTURES) LISTENER
// ==========================================
function connectBitget() {
    const url = 'wss://ws-api.bitget.com/mix/v1/stream';
    logger.info(`[Bitget] Connecting to ${url}`);
    const ws = new WebSocket(url);

    const pingInterval = setInterval(() => {
        if(ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 30000);

    ws.on('open', () => {
        logger.info('[Bitget] Connected.');
        const args = config.assets.map(a => ({
            instType: 'mc', // mc = mix contract (futures)
            channel: 'ticker',
            instId: `${a}USDT`
        }));
        ws.send(JSON.stringify({ op: 'subscribe', args: args }));
    });

    ws.on('message', (data) => {
        try {
            const strData = data.toString();
            if (strData === 'pong') return;
            
            const msg = JSON.parse(strData);
            // msg: { action: 'snapshot', arg: { instId: 'BTCUSDT' }, data: [{ last: '...' }] }
            if ((msg.action === 'snapshot' || msg.action === 'update') && msg.data && msg.data[0]) {
                const instId = msg.arg.instId; // BTCUSDT
                const asset = instId.replace('USDT', '');
                const price = parseFloat(msg.data[0].last);
                
                sendPrice(asset, price, 'BITGET');
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        clearInterval(pingInterval);
        logger.warn('[Bitget] Closed. Reconnecting...');
        setTimeout(connectBitget, config.reconnectInterval);
    });
    ws.on('error', (e) => logger.error(`[Bitget] Error: ${e.message}`));
}

// --- INIT ALL CONNECTIONS ---
connectToInternal();
connectBinance();
connectOKX();
connectGate();
connectBitget();
