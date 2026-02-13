const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
    internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
    reconnectInterval: 5000,
    assets: (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',')
};

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
    transports: [new winston.transports.Console()]
});

let internalWs = null;
let binanceWs = null;

function connectToInternal() {
    internalWs = new WebSocket(config.internalReceiverUrl);
    internalWs.on('open', () => logger.info(`✓ Connected to Trader Bot.`));
    internalWs.on('close', () => setTimeout(connectToInternal, config.reconnectInterval));
    internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

function connectBinance() {
    // Listen to BOTH bookTicker (Price) and aggTrade (Volume)
    const streams = config.assets.flatMap(a => [
        `${a.toLowerCase()}usdt@bookTicker`,
        `${a.toLowerCase()}usdt@aggTrade`
    ]).join('/');

    const url = `wss://fstream.binance.com/stream?streams=${streams}`;
    logger.info(`[Binance] Connecting...`);
    
    binanceWs = new WebSocket(url);
    binanceWs.on('open', () => logger.info('[Binance] ✓ Connected (Quotes + Trades).'));

    binanceWs.on('message', (data) => {
        if (!internalWs || internalWs.readyState !== WebSocket.OPEN) return;
        try {
            const msg = JSON.parse(data);
            if (!msg.data) return;
            const asset = msg.data.s.replace('USDT', '');

            if (msg.data.e === 'bookTicker') {
                // TYPE 'B': PRICE UPDATE
                internalWs.send(JSON.stringify({
                    type: 'B',
                    s: asset,
                    bb: parseFloat(msg.data.b),
                    bq: parseFloat(msg.data.B),
                    ba: parseFloat(msg.data.a),
                    aq: parseFloat(msg.data.A)
                }));
            } 
            else if (msg.data.e === 'aggTrade') {
                // TYPE 'T': CVD UPDATE
                const isSell = msg.data.m; // m=true means Buyer was Maker (Taker Sold)
                internalWs.send(JSON.stringify({
                    type: 'T',
                    s: asset,
                    p: parseFloat(msg.data.p),
                    q: parseFloat(msg.data.q),
                    side: isSell ? 'sell' : 'buy',
                    t: msg.data.T
                }));
            }
        } catch (e) {}
    });

    binanceWs.on('close', () => setTimeout(connectBinance, config.reconnectInterval));
}

connectToInternal();
connectBinance();
        
