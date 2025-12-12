
const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const config = {
  // We stream all 3 assets. 
  // NOTE: Using Binance Futures streams. Symbols are lowercase.
  symbols: ['btcusdt', 'ethusdt', 'solusdt'], 
  binanceStreamUrl: process.env.BINANCE_FUTURES_STREAM_URL || 'wss://fstream.binance.com/ws',
  reconnectInterval: 5000,
  internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
};

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

function connectToInternal() {
  internalWs = new WebSocket(config.internalReceiverUrl);
  
  internalWs.on('open', () => {
    logger.info('Connected to internal Bot Receiver.');
  });
  
  internalWs.on('close', () => {
    logger.warn('Internal Bot WebSocket closed. Reconnecting...');
    setTimeout(connectToInternal, config.reconnectInterval);
  });
  
  internalWs.on('error', (e) => logger.error(`Internal WS Error: ${e.message}`));
}

function connectToBinance() {
  // Construct Multi-stream URL: /stream?streams=<symbol>@trade/<symbol>@trade...
  const streams = config.symbols.map(s => `${s}@trade`).join('/');
  const url = `${config.binanceStreamUrl}/stream?streams=${streams}`;
  
  logger.info(`Connecting to Binance Multi-Stream: ${url}`);
  binanceWs = new WebSocket(url);

  binanceWs.on('open', () => {
    logger.info(`Connected to Multi-Stream: ${config.symbols.join(', ')}`);
  });
  
  binanceWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Binance Payload: { stream: 'btcusdt@trade', data: { s: 'BTCUSDT', p: '123.45', ... } }
      if (!msg.data || msg.data.e !== 'trade') return;

      const rawSymbol = msg.data.s; // e.g., 'BTCUSDT'
      const price = parseFloat(msg.data.p);
      
      // Normalize Symbol to our internal format: 'BTC', 'ETH', 'SOL'
      let asset = null;
      if (rawSymbol.startsWith('BTC')) asset = 'BTC';
      else if (rawSymbol.startsWith('ETH')) asset = 'ETH';
      else if (rawSymbol.startsWith('SOL')) asset = 'SOL';
      
      if (asset && internalWs && internalWs.readyState === WebSocket.OPEN) {
          // SEND TAGGED PAYLOAD: { type: 'S', s: 'BTC', p: 50000 }
          internalWs.send(JSON.stringify({ type: 'S', s: asset, p: price }));
      }

    } catch (e) {
      logger.error(`Parse Error: ${e.message}`);
    }
  });

  binanceWs.on('close', () => {
    logger.warn('Binance Stream closed. Reconnecting...');
    setTimeout(connectToBinance, config.reconnectInterval);
  });

  binanceWs.on('error', (e) => {
    logger.error(`Binance WS Error: ${e.message}`);
  });
}

// Start Listeners
connectToInternal();
connectToBinance();
  
