// trader.js
// Enhanced Delta Exchange trading bot with improved error handling and API integration

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
require('dotenv').config();

// --- Enhanced Configuration ---
const config = {
  port: process.env.INTERNAL_WS_PORT || 8082,
  priceThreshold: parseFloat(process.env.PRICE_THRESHOLD || '40.00'),
  productId: parseInt(process.env.PRODUCT_ID || '27'),
  orderSize: parseInt(process.env.ORDER_SIZE || '100'),
  deltaApiKey: process.env.DELTA_API_KEY,
  deltaApiSecret: process.env.DELTA_API_SECRET,
  deltaBaseUrl: process.env.DELTA_BASE_URL || 'https://api.delta.exchange',
  reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
  logLevel: process.env.LOG_LEVEL || 'info'
};

// --- Enhanced Logging Setup ---
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
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// --- Input Validation ---
function validateConfig() {
  const required = ['deltaApiKey', 'deltaApiSecret'];
  const missing = required.filter(key => !config[key] || config[key].includes('your_actual'));

  if (missing.length > 0) {
    logger.error(`Missing required configuration: ${missing.join(', ')}`);
    logger.error('Please check your .env file and ensure all required fields are properly set.');
    process.exit(1);
  }
}

validateConfig();

// --- Enhanced Delta Exchange API Client ---
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
        'User-Agent': 'Bybit-Delta-Trading-Bot/1.2.0'
      }
    });
  }

  generateSignature(method, path, timestamp, body = '') {
    const message = method + timestamp + path + body;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
  }

  async makeRequest(method, path, data = null) {
    const timestamp = Date.now();
    const body = data ? JSON.stringify(data) : '';
    const signature = this.generateSignature(method, path, timestamp, body);

    const headers = {
      'api-key': this.apiKey,
      'timestamp': timestamp,
      'signature': signature
    };

    try {
      const response = await this.axios({
        method,
        url: path,
        data: data,
        headers
      });
      return response.data;
    } catch (error) {
      logger.error('Delta Exchange API Error:', {
        method,
        path,
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
      throw error;
    }
  }

  async getProducts() {
    return this.makeRequest('GET', '/v2/products');
  }

  async getAccountBalance() {
    return this.makeRequest('GET', '/v2/wallet/balances');
  }

  async placeOrder(orderData) {
    return this.makeRequest('POST', '/v2/orders', { order: orderData });
  }

  async getOrderStatus(orderId) {
    return this.makeRequest('GET', `/v2/orders/${orderId}`);
  }
}

// --- Enhanced Trading Logic ---
class TradingBot {
  constructor() {
    this.deltaClient = new DeltaExchangeClient(
      config.deltaApiKey,
      config.deltaApiSecret,
      config.deltaBaseUrl
    );

    this.priceAtLastTrade = null;
    this.isOrderInProgress = false;
    this.wss = null;
    this.orderHistory = [];
    this.startTime = new Date();

    this.setupWebSocketServer();
    this.setupHealthCheck();
  }

  setupWebSocketServer() {
    this.wss = new WebSocket.Server({ 
      port: config.port,
      perMessageDeflate: {
        zlibDeflateOptions: {
          threshold: 1024
        }
      }
    });

    logger.info(`WebSocket server started on port ${config.port}`);

    this.wss.on('connection', (ws) => {
      logger.info('Bybit listener connected');

      ws.on('message', async (message) => {
        try {
          await this.handlePriceMessage(message);
        } catch (error) {
          logger.error('Error handling price message:', error);
        }
      });

      ws.on('close', () => {
        logger.warn('Bybit listener disconnected');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
      });
    });

    this.wss.on('error', (error) => {
      logger.error('WebSocket server error:', error);
    });
  }

  async handlePriceMessage(message) {
    const data = JSON.parse(message.toString());

    if (data.type === 'S' && data.p) {
      const currentPrice = parseFloat(data.p);

      // Set initial baseline
      if (this.priceAtLastTrade === null) {
        this.priceAtLastTrade = currentPrice;
        logger.info(`Initial baseline price set to: $${this.priceAtLastTrade.toFixed(2)}`);
        return;
      }

      const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);

      // Check if trading conditions are met
      if (priceDifference >= config.priceThreshold && !this.isOrderInProgress) {
        await this.executeTrade(currentPrice, priceDifference);
      }
    }
  }

  async executeTrade(currentPrice, priceDifference) {
    this.isOrderInProgress = true;

    try {
      logger.info('=== TRADE TRIGGER ===');
      logger.info(`Price threshold of $${config.priceThreshold} met. Difference: $${priceDifference.toFixed(2)}`);
      logger.info(`Previous Baseline: $${this.priceAtLastTrade.toFixed(2)}, Current Price: $${currentPrice.toFixed(2)}`);

      const side = currentPrice > this.priceAtLastTrade ? 'buy' : 'sell';

      // Prepare order data
      const orderData = {
        product_id: config.productId,
        size: config.orderSize,
        side: side,
        limit_price: currentPrice.toFixed(2),
        order_type: 'limit_order',
        time_in_force: 'gtc'
      };

      // Place order
      const orderResponse = await this.deltaClient.placeOrder(orderData);

      // Track order
      const orderRecord = {
        timestamp: new Date().toISOString(),
        orderId: orderResponse.result?.id,
        side,
        price: currentPrice,
        size: config.orderSize,
        priceChange: priceDifference,
        status: 'placed'
      };

      this.orderHistory.push(orderRecord);

      logger.info('Order placed successfully:', {
        orderId: orderRecord.orderId,
        side: orderRecord.side,
        price: orderRecord.price,
        size: orderRecord.size
      });

      // Update baseline price
      this.priceAtLastTrade = currentPrice;
      logger.info(`Trade baseline reset to: $${currentPrice.toFixed(2)}`);

    } catch (error) {
      logger.error('Failed to execute trade:', error);

      // Add failed order to history
      this.orderHistory.push({
        timestamp: new Date().toISOString(),
        side: currentPrice > this.priceAtLastTrade ? 'buy' : 'sell',
        price: currentPrice,
        size: config.orderSize,
        priceChange: priceDifference,
        status: 'failed',
        error: error.message
      });
    } finally {
      this.isOrderInProgress = false;
    }
  }

  setupHealthCheck() {
    // Log status every 5 minutes
    setInterval(() => {
      const uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
      const recentOrders = this.orderHistory.filter(order => 
        new Date(order.timestamp) > new Date(Date.now() - 3600000) // Last hour
      );

      logger.info('Health Check:', {
        uptime: `${uptime}s`,
        currentBaseline: this.priceAtLastTrade,
        orderInProgress: this.isOrderInProgress,
        recentOrders: recentOrders.length,
        totalOrders: this.orderHistory.length
      });
    }, 300000); // 5 minutes
  }

  async getStatus() {
    try {
      const balance = await this.deltaClient.getAccountBalance();
      return {
        uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
        priceBaseline: this.priceAtLastTrade,
        orderInProgress: this.isOrderInProgress,
        totalOrders: this.orderHistory.length,
        recentOrders: this.orderHistory.slice(-5),
        balance: balance.result
      };
    } catch (error) {
      logger.error('Error getting status:', error);
      return { error: error.message };
    }
  }
}

// --- Error Handling ---
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// --- Graceful Shutdown ---
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// --- Start the Bot ---
const bot = new TradingBot();
logger.info('Delta Trading Bot started successfully');
logger.info(`Configuration: Threshold=$${config.priceThreshold}, ProductID=${config.productId}, OrderSize=${config.orderSize}`);
