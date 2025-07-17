// bybit_listener.js
// Enhanced Bybit WebSocket listener to forward price ticks to the Delta trading bot

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- Configuration ---
const config = {
  symbol: process.env.BYBIT_SYMBOL || 'BTCUSDT',
  bybitStreamUrl: process.env.BYBIT_STREAM_URL || 'wss://stream.bybit.com/v5/public/spot',
  reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
  internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
  minimumTickSize: parseFloat(process.env.MINIMUM_TICK_SIZE || '0.1'),
  logLevel: process.env.LOG_LEVEL || 'info'
};

// --- Logging Setup ---
const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console()
  ]
});

let internalWsClient = null;
let bybitWsClient = null;
let lastSentSpotBidPrice = null;

function connectToInternalReceiver() {
  if (internalWsClient && (internalWsClient.readyState === WebSocket.OPEN || internalWsClient.readyState === WebSocket.CONNECTING)) {
    return;
  }

  internalWsClient = new WebSocket(config.internalReceiverUrl);

  internalWsClient.on('open', () => {
    logger.info('Connected to internal trader WebSocket');
  });

  internalWsClient.on('close', () => {
    logger.warn('Internal trader WebSocket closed. Reconnecting...');
    setTimeout(connectToInternalReceiver, config.reconnectInterval);
  });

  internalWsClient.on('error', (error) => {
    logger.error('Internal trader WebSocket error:', error.message);
  });
}

function sendToInternalClient(payload) {
  if (internalWsClient && internalWsClient.readyState === WebSocket.OPEN) {
    try {
      internalWsClient.send(JSON.stringify(payload));
    } catch (error) {
      logger.error('Failed to send message to trader:', error.message);
    }
  }
}

function connectToBybit() {
  bybitWsClient = new WebSocket(config.bybitStreamUrl);

  bybitWsClient.on('open', () => {
    logger.info('Bybit WebSocket connection established');
    lastSentSpotBidPrice = null;

    const subscriptionMessage = {
      op: 'subscribe',
      args: [`orderbook.1.${config.symbol}`]
    };

    bybitWsClient.send(JSON.stringify(subscriptionMessage));
    logger.info(`Subscribed to: ${subscriptionMessage.args[0]}`);
  });

  bybitWsClient.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.op === 'ping') {
        bybitWsClient.send(JSON.stringify({ op: 'pong', req_id: message.req_id }));
        return;
      }

      if (message.topic && message.topic.startsWith('orderbook.1') && message.data) {
        const topBid = message.data.b && message.data.b[0];
        if (!topBid) return;

        const currentSpotBidPrice = parseFloat(topBid[0]);
        if (!currentSpotBidPrice) return;

        if (lastSentSpotBidPrice === null) {
          lastSentSpotBidPrice = currentSpotBidPrice;
          return;
        }

        const priceDifference = currentSpotBidPrice - lastSentSpotBidPrice;

        if (Math.abs(priceDifference) >= config.minimumTickSize) {
          const payload = { type: 'S', p: currentSpotBidPrice };
          sendToInternalClient(payload);
          lastSentSpotBidPrice = currentSpotBidPrice;
        }
      }
    } catch (error) {
      logger.error('Error processing Bybit message:', error.message);
    }
  });

  bybitWsClient.on('error', (error) => {
    logger.error('Bybit WebSocket error:', error.message);
  });

  bybitWsClient.on('close', () => {
    logger.warn('Bybit WebSocket connection closed. Reconnecting...');
    setTimeout(connectToBybit, config.reconnectInterval);
  });
}

// --- Start Connections ---
logger.info('Starting Bybit listener');
connectToInternalReceiver();
connectToBybit();
