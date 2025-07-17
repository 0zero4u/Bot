// trader.js
// Final Enhanced Delta Exchange trading bot with automatic leverage setting, order book integration, and risk controls for the India platform.

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
require('dotenv').config();

// --- Enhanced Configuration ---
const config = {
  // Connection & Platform
  port: process.env.INTERNAL_WS_PORT || 8082,
  deltaBaseUrl: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
  deltaWsUrl: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',

  // Trading - CRITICAL: These are for Delta Exchange
  productId: parseInt(process.env.DELTA_PRODUCT_ID),
  productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
  priceThreshold: parseFloat(process.env.PRICE_THRESHOLD || '40.00'),
  orderSize: parseInt(process.env.ORDER_SIZE || '100'),

  // Strategy & Risk Management
  leverage: parseInt(process.env.DELTA_LEVERAGE || '25'),
  orderPlacementStrategy: process.env.ORDER_PLACEMENT_STRATEGY || 'limit_bbo',
  useBracketOrders: process.env.USE_BRACKET_ORDERS === 'true',
  takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET || '100.0'),
  stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET || '50.0'),
  orderTimeoutMs: parseInt(process.env.ORDER_TIMEOUT_MS || '30000'),

  // Credentials & System
  deltaApiKey: process.env.DELTA_API_KEY,
  deltaApiSecret: process.env.DELTA_API_SECRET,
  reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
  logLevel: process.env.LOG_LEVEL || 'info'
};

// --- Logging Setup ---
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
  const required = ['deltaApiKey', 'deltaApiSecret', 'productId', 'productSymbol', 'leverage'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    logger.error(`Missing required configuration: ${missing.join(', ')}`);
    logger.error('Please check your .env file and ensure all required fields are set.');
    process.exit(1);
  }
}
validateConfig();


// --- Delta Exchange API Client ---
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
        'User-Agent': 'Bybit-Delta-Trading-Bot/3.0.0'
      }
    });
  }

  generateSignature(method, path, timestamp, body = '') {
    const message = method.toUpperCase() + timestamp + path + body;
    return crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');
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
      const response = await this.axios({ method, url: path, data: data, headers });
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
  
  async setLeverage(productId, leverage) {
    logger.info(`Attempting to set leverage for product ${productId} to ${leverage}x...`);
    const payload = {
        product_id: productId,
        leverage: leverage,
    };
    return this.makeRequest('POST', '/v2/orders/leverage', payload);
  }

  async placeOrder(orderData) {
    return this.makeRequest('POST', '/v2/orders', orderData);
  }
  
  async getOrderStatus(orderId) {
    return this.makeRequest('GET', `/v2/orders/${orderId}`);
  }

  async cancelOrder(orderId) {
      return this.makeRequest('DELETE', `/v2/orders/${orderId}`);
  }
}

// --- Order Management ---
class OrderManager {
    constructor(deltaClient) {
        this.deltaClient = deltaClient;
        this.openOrders = new Map();
    }

    trackOrder(orderId, orderInfo) {
        logger.info(`Tracking order ${orderId}. Will verify or cancel in ${config.orderTimeoutMs / 1000}s.`);
        const cancelTimer = setTimeout(() => {
            this.verifyAndCancel(orderId);
        }, config.orderTimeoutMs);

        this.openOrders.set(orderId, { ...orderInfo, cancelTimer });
    }

    async verifyAndCancel(orderId) {
        if (!this.openOrders.has(orderId)) return;

        try {
            const orderStatus = await this.deltaClient.getOrderStatus(orderId);
            if (['filled', 'closed', 'cancelled'].includes(orderStatus.state)) {
                logger.info(`Order ${orderId} is now ${orderStatus.state}. No action needed.`);
            } else {
                logger.warn(`Order ${orderId} is still '${orderStatus.state}' after timeout. Cancelling...`);
                await this.deltaClient.cancelOrder(orderId);
                logger.info(`Order ${orderId} cancelled successfully.`);
            }
        } catch (error) {
            logger.error(`Error verifying/cancelling order ${orderId}. It might have been filled/cancelled already.`, { error: error.message });
        } finally {
            this.clearOrder(orderId);
        }
    }

    clearOrder(orderId) {
        if (this.openOrders.has(orderId)) {
            clearTimeout(this.openOrders.get(orderId).cancelTimer);
            this.openOrders.delete(orderId);
        }
    }
}


// --- Trading Bot ---
class TradingBot {
  constructor() {
    this.deltaClient = new DeltaExchangeClient(config.deltaApiKey, config.deltaApiSecret, config.deltaBaseUrl);
    this.orderManager = new OrderManager(this.deltaClient);

    this.priceAtLastTrade = null;
    this.isOrderInProgress = false;
    this.orderBook = { bids: [], asks: [] };
    this.orderHistory = [];
    this.startTime = new Date();

    this.initialize();
  }

  async initialize() {
    try {
        await this.deltaClient.setLeverage(config.productId, config.leverage);
        logger.info(`✅ Successfully set leverage to ${config.leverage}x for product ID ${config.productId}.`);

        this.setupWebSocketServer();
        this.connectToDeltaWs();
        this.setupHealthCheck();
        
        logger.info(`🚀 Delta Trading Bot started successfully on ${config.deltaBaseUrl}`);
        logger.info(`Trading ${config.productSymbol} (ID: ${config.productId}) with ${config.leverage}x leverage.`);

    } catch (error) {
        logger.error(`❌ FATAL: Failed to set leverage. The bot cannot continue.`);
        logger.error(`Please check your API key permissions and ensure leverage can be set for product ${config.productId}.`);
        process.exit(1);
    }
  }

  connectToDeltaWs() {
      const ws = new WebSocket(config.deltaWsUrl);
      ws.on('open', () => {
          logger.info(`Delta Exchange WebSocket connected for ${config.productSymbol}.`);
          const subscribePayload = {
              type: 'subscribe',
              payload: {
                  channels: [{ name: 'l2_orderbook', symbols: [config.productSymbol] }]
              }
          };
          ws.send(JSON.stringify(subscribePayload));
          logger.info(`Subscribed to Delta order book: l2_orderbook for ${config.productSymbol}`);
      });

      ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'l2_orderbook' && msg.symbol === config.productSymbol) {
              this.orderBook.bids = msg.bids;
              this.orderBook.asks = msg.asks;
          }
      });

      ws.on('close', () => {
          logger.warn('Delta Exchange WebSocket closed. Reconnecting...');
          setTimeout(() => this.connectToDeltaWs(), config.reconnectInterval);
      });
      ws.on('error', (err) => logger.error('Delta Exchange WebSocket error:', err));
  }
  
  setupWebSocketServer() {
    this.wss = new WebSocket.Server({ port: config.port });
    logger.info(`Internal WebSocket server started on port ${config.port}`);
    this.wss.on('connection', (ws) => {
      logger.info('Bybit listener connected');
      ws.on('message', (message) => this.handlePriceMessage(message));
      ws.on('close', () => logger.warn('Bybit listener disconnected'));
      ws.on('error', (error) => logger.error('Internal WebSocket error:', error));
    });
  }

  async handlePriceMessage(message) {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === 'S' && data.p) {
            const currentPrice = parseFloat(data.p);
            if (this.priceAtLastTrade === null) {
                this.priceAtLastTrade = currentPrice;
                logger.info(`Initial baseline price set to: $${this.priceAtLastTrade.toFixed(2)}`);
                return;
            }
            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);
            if (priceDifference >= config.priceThreshold && !this.isOrderInProgress) {
                await this.executeTrade(currentPrice, priceDifference);
            }
        }
    } catch(error) {
        logger.error("Error handling price message:", error);
    }
  }

  async executeTrade(currentPrice, priceDifference) {
    this.isOrderInProgress = true;
    try {
      logger.info(`TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)} met threshold $${config.priceThreshold}`);
      const side = currentPrice > this.priceAtLastTrade ? 'buy' : 'sell';

      const orderData = this.prepareOrderData(side);
      if (!orderData) {
        logger.warn("Could not prepare order data (e.g., no order book). Skipping trade.");
        this.isOrderInProgress = false;
        return;
      }
      
      const orderResponse = await this.deltaClient.placeOrder(orderData);
      const orderId = orderResponse.id;

      logger.info('Order placed successfully:', { orderId, ...orderData });
      const orderRecord = {
          timestamp: new Date().toISOString(),
          orderId: orderId,
          status: 'placed',
          ...orderData
      };
      this.orderHistory.push(orderRecord);

      if(orderData.order_type !== 'market_order'){
        this.orderManager.trackOrder(orderId, orderData);
      }
      
      this.priceAtLastTrade = currentPrice;
      logger.info(`Trade baseline reset to: $${currentPrice.toFixed(2)}`);

    } catch (error) {
      logger.error('Failed to execute trade:', error.message);
    } finally {
      this.isOrderInProgress = false;
    }
  }

  prepareOrderData(side) {
    const baseOrder = {
        product_id: config.productId,
        size: config.orderSize,
        side: side
    };

    if (config.orderPlacementStrategy === 'market') {
        return { ...baseOrder, order_type: 'market_order' };
    }

    const book = side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
    if (!book || book.length === 0) {
        logger.warn(`No order book data available for side '${side}'. Cannot place limit order.`);
        return null;
    }

    let price;
    if (config.orderPlacementStrategy === 'limit_bbo') {
        price = parseFloat(book[0][0]);
    } else if (config.orderPlacementStrategy === 'limit_next_bbo') {
        price = book.length > 1 ? parseFloat(book[1][0]) : parseFloat(book[0][0]);
    } else {
        logger.error(`Unknown order placement strategy: ${config.orderPlacementStrategy}`);
        return null;
    }

    const limitOrder = {
        ...baseOrder,
        order_type: 'limit_order',
        limit_price: price.toFixed(4),
        post_only: true
    };

    if (config.useBracketOrders) {
        const takeProfitPrice = side === 'buy' ? price + config.takeProfitOffset : price - config.takeProfitOffset;
        const stopLossPrice = side === 'buy' ? price - config.stopLossOffset : price + config.stopLossOffset;

        return {
            ...limitOrder,
            order_type: 'bracket_order',
            take_profit_price: takeProfitPrice.toFixed(4),
            stop_loss_price: stopLossPrice.toFixed(4)
        };
    }

    return limitOrder;
  }

  setupHealthCheck() {
    setInterval(() => {
      const uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
      logger.info('Health Check:', {
        uptime: `${uptime}s`,
        currentBaseline: this.priceAtLastTrade,
        orderInProgress: this.isOrderInProgress,
        totalOrders: this.orderHistory.length
      });
    }, 300000); // 5 minutes
  }
}

// --- Start Bot & Process Handlers ---
try {
    new TradingBot();
} catch (error) {
    logger.error("Failed to construct trading bot:", error);
    process.exit(1);
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});