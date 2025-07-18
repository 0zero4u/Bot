// trader.js (Patched Version)
// Delta Exchange Trading Bot with Corrected Leverage Endpoint & Enhanced Logging

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// --- Enhanced Configuration ---
const config = {
  port: process.env.INTERNAL_WS_PORT || 8082,
  deltaBaseUrl: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
  deltaWsUrl: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
  productId: parseInt(process.env.DELTA_PRODUCT_ID),
  productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
  priceThreshold: parseFloat(process.env.PRICE_THRESHOLD || '1.00'),
  orderSize: parseInt(process.env.ORDER_SIZE || '1'),
  leverage: process.env.DELTA_LEVERAGE || '50',
  orderPlacementStrategy: process.env.ORDER_PLACEMENT_STRATEGY || 'limit_bbo',
  useBracketOrders: process.env.USE_BRACKET_ORDERS === 'true',
  takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET || '100.0'),
  stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET || '50.0'),
  cooldownSeconds: 30,
  deltaApiKey: process.env.DELTA_API_KEY,
  deltaApiSecret: process.env.DELTA_API_SECRET,
  reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
  logLevel: process.env.LOG_LEVEL || 'info',
  cancelOnDisconnectTimeoutMs: parseInt(process.env.CANCEL_ON_DISCONNECT_TIMEOUT_MS || '60000'),
};

// --- Logging ---
const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

// --- Input Validation ---
function validateConfig() {
  const required = ['deltaApiKey', 'deltaApiSecret', 'productId', 'productSymbol', 'leverage'];
  if (required.some(key => !config[key])) {
    logger.error(\`Missing required config: \${required.filter(key => !config[key]).join(', ')}\`);
    process.exit(1);
  }
  if (!config.useBracketOrders) {
    logger.error('USE_BRACKET_ORDERS must be "true". Exiting.');
    process.exit(1);
  }
}
validateConfig();

// --- API Client ---
class DeltaExchangeClient {
  constructor(apiKey, apiSecret, baseUrl) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = baseUrl;
    this.axios = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Bybit-Delta-Trading-Bot/5.0.1'
      }
    });
  }

  generateSignature(method, path, timestamp, body = '') {
    return crypto.createHmac('sha256', this.apiSecret)
      .update(method.toUpperCase() + timestamp + path + body)
      .digest('hex');
  }

  generateWsSignature(timestamp) {
    return crypto.createHmac('sha256', this.apiSecret)
      .update('GET' + timestamp + '/dapi/ws/v1')
      .digest('hex');
  }

  async makeRequest(method, path, data = null) {
    const timestamp = Date.now().toString();
    const body = data ? JSON.stringify(data) : '';
    const signature = this.generateSignature(method, path, timestamp, body);
    const headers = {
      'api-key': this.apiKey,
      'timestamp': timestamp,
      'signature': signature,
      'Content-Type': 'application/json'
    };
    try {
      const response = await this.axios({ method, url: path, data, headers });
      return response.data;
    } catch (error) {
      logger.error('Delta Exchange API Error:', {
        method, path, payload: data, headers,
        responseStatus: error.response?.status,
        responseData: error.response?.data,
        message: error.message
      });
      throw error;
    }
  }

  // ✅ Corrected leverage endpoint per API docs
  async setLeverage(productId, leverage) {
    const path = \`/v2/products/\${productId}/orders/leverage\`;
    logger.info(\`Setting leverage via \${path} to \${leverage}x...\`);
    return this.makeRequest('POST', path, {
      leverage: String(leverage)
    });
  }

  async setCancelOnDisconnectTimer(timeoutMs) {
    logger.debug(\`Setting Cancel-on-Disconnect to \${timeoutMs}ms.\`);
    return this.makeRequest('POST', '/v2/orders/cancel_after', {
      timeout: timeoutMs
    });
  }

  async placeOrder(orderData) {
    return this.makeRequest('POST', '/v2/orders', orderData);
  }
}

// (Rest of TradingBot class stays the same)
// You can paste your existing TradingBot class code here
// and it will now use the corrected leverage endpoint

// --- Start Bot ---
try {
  new TradingBot();
} catch (error) {
  logger.error('Failed to construct trading bot:', error);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down.');
  process.exit(0);
});
