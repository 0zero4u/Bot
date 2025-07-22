// binance_listener.js
// v2.0.0 - Migrated from Bybit to Binance Spot stream.

const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// --- Configuration ---
const config = {
  // Binance symbols are typically lowercase, e.g., 'btcusdt'
  symbol: process.env.BINANCE_SYMBOL || 'btcusdt',
  // Base URL for Binance WebSocket streams
  binanceStreamUrl: process.env.BINANCE_STREAM_URL || 'wss://stream.binance.com:9443/ws',
  reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
  internalReceiverUrl: `ws://localhost:${process.env.INTERNAL_WS_PORT || 8082}`,
  minimumTickSize: parseFloat(process.env.MINIMUM_TICK_SIZE || '0.1'),
  logLevel: process.env.LOG_LEVEL || 'info',
  logThrottleMs: 30 * 1000 // 30 seconds for throttling logs
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
let binanceWsClient = null;
let lastSentSpotBidPrice = null;
let canLog = true; // Log throttling flag

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

function connectToBinance() {
  // For Binance, the stream is specified in the URL. We use the book ticker stream for the top-of-book data.
  const streamUrl = `${config.binanceStreamUrl}/${config.symbol}@bookTicker`;
  binanceWsClient = new WebSocket(streamUrl);

  binanceWsClient.on('open', () => {
    logger.info(`Binance WebSocket connection established. Subscribed to: ${config.symbol}@bookTicker`);
    lastSentSpotBidPrice = null;
    // Note: The 'ws' library automatically handles pong responses to Binance's pings.
    // No manual ping sending is required.
  });

  binanceWsClient.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Check if the message contains book ticker data (specifically the best bid price 'b')
      if (message && message.b) {
        const currentSpotBidPrice = parseFloat(message.b);
        if (isNaN(currentSpotBidPrice)) return;

        if (lastSentSpotBidPrice === null) {
          lastSentSpotBidPrice = currentSpotBidPrice;
          return; // Initialize the price on first message
        }

        const priceDifference = currentSpotBidPrice - lastSentSpotBidPrice;

        if (Math.abs(priceDifference) >= config.minimumTickSize) {
          // The format { type: 'S', p: price } is preserved for the internal client
          const payload = { type: 'S', p: currentSpotBidPrice };
          
          // Always send the signal to the bot.
          sendToInternalClient(payload);
          lastSentSpotBidPrice = currentSpotBidPrice;

          // Only log the message if the throttle period has passed.
          if (canLog) {
            logger.info(`Significant price move detected. Sending price ${currentSpotBidPrice} to trader. (Logs will be throttled for ${config.logThrottleMs / 1000}s)`);
            canLog = false;
            setTimeout(() => {
                canLog = true;
            }, config.logThrottleMs);
          }
        }
      }
    } catch (error) {
      logger.error('Error processing Binance message:', error.message);
    }
  });

  binanceWsClient.on('error', (error) => {
    logger.error('Binance WebSocket error:', error.message);
  });

  binanceWsClient.on('close', () => {
    logger.warn('Binance WebSocket connection closed. Reconnecting...');
    setTimeout(connectToBinance, config.reconnectInterval);
  });
}

// --- Start Connections ---
logger.info('Starting Binance listener...');
connectToInternalReceiver();
connectToBinance();
