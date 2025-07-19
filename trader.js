// trader.js
// Definitive Final Version of Delta Exchange Trading Bot
// Version 6.0.3 - Optimized to use L1 orderbook stream for faster execution.

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// --- Configuration ---
const config = {
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
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
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    deltaApiKey: process.env.DELTA_API_KEY,
    deltaApiSecret: process.env.DELTA_API_SECRET,
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
    logLevel: process.env.LOG_LEVEL || 'info',
    cancelOnDisconnectTimeoutMs: parseInt(process.env.CANCEL_ON_DISCONNECT_TIMEOUT_MS || '60000'),
};

// --- Logging Setup ---
const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) })
    ]
});

// --- Input Validation ---
function validateConfig() {
    const required = ['deltaApiKey', 'deltaApiSecret', 'productId', 'productSymbol', 'leverage'];
    if (required.some(key => !config[key])) {
        logger.error(`FATAL: Missing required configuration: ${required.filter(key => !config[key]).join(', ')}`);
        process.exit(1);
    }
    if (!config.useBracketOrders) {
        logger.error('FATAL: This bot logic requires USE_BRACKET_ORDERS="true" in your .env file to function correctly.');
        process.exit(1);
    }
    if (config.orderPlacementStrategy === 'limit_next_bbo') {
        logger.error('FATAL: The "limit_next_bbo" strategy requires the l2_orderbook stream. This version is optimized for L1. Please use v6.0.2 or change strategy.');
        process.exit(1);
    }
}
validateConfig();

// --- Utility Functions Matching Python Implementation (for signature generation) ---
function utilQueryString(query) {
    if (!query || Object.keys(query).length === 0) {
        return '';
    }
    const queryStrings = [];
    for (const [key, value] of Object.entries(query)) {
        queryStrings.push(`${key}=${encodeURIComponent(String(value))}`);
    }
    return '?' + queryStrings.join('&');
}

function utilBodyString(body) {
    if (!body) return '';
    return JSON.stringify(body, null, 0);
}

function utilParseResponse(response) {
    if (response.data && response.data.success) {
        return response.data.result;
    } else if (response.data && response.data.error) {
        throw new Error(response.data.error);
    } else {
        throw new Error('Unknown API error');
    }
}

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
                'User-Agent': 'Bybit-Delta-Trading-Bot/6.0.3'
            }
        });
    }

    getTimestamp() {
        return String(Math.floor(Date.now() / 1000));
    }

    generateSignature(method, path, timestamp, query = null, body = null) {
        const queryString = utilQueryString(query);
        const bodyString = utilBodyString(body);
        const signatureData = method + timestamp + path + queryString + bodyString;
        return crypto.createHmac('sha256', this.apiSecret)
            .update(signatureData, 'utf8')
            .digest('hex');
    }

    generateWsSignature(timestamp) {
        const message = 'GET' + timestamp + '/dapi/ws/v1';
        return crypto.createHmac('sha256', this.apiSecret)
            .update(message, 'utf8')
            .digest('hex');
    }

    async makeRequest(method, path, data = null, query = null) {
        const timestamp = this.getTimestamp();
        const signature = this.generateSignature(method, path, timestamp, query, data);

        const headers = {
            'api-key': this.apiKey,
            'timestamp': timestamp,
            'signature': signature,
            'Content-Type': 'application/json'
        };

        try {
            const response = await this.axios({
                method,
                url: path,
                data: data ? utilBodyString(data) : undefined,
                params: query,
                headers
            });

            return utilParseResponse(response);
        } catch (error) {
            logger.error('Delta Exchange API Error:', {
                request: { method, path, payload: data, query, timestamp },
                response: {
                    status: error.response?.status,
                    data: error.response?.data,
                    headers: error.response?.headers
                },
                message: error.message
            });
            throw error;
        }
    }

    async setLeverage(productId, leverage) {
        logger.info(`Attempting to set leverage for product ${productId} to ${leverage}x...`);
        const payload = { leverage: String(leverage) };
        const path = `/v2/products/${productId}/orders/leverage`;
        return this.makeRequest('POST', path, payload);
    }

    async setCancelOnDisconnectTimer(timeoutMs) {
        logger.debug(`Setting/Resetting Cancel-on-Disconnect timer to ${timeoutMs}ms.`);
        const payload = {
            cancel_after: Math.floor(timeoutMs / 1000)
        };
        return this.makeRequest('POST', '/v2/orders/cancel_after', payload);
    }

    async placeOrder(orderData) {
        return this.makeRequest('POST', '/v2/orders', orderData);
    }
}

// --- TradingBot Class ---
class TradingBot {
    constructor() {
        this.deltaClient = new DeltaExchangeClient(config.deltaApiKey, config.deltaApiSecret, config.deltaBaseUrl);
        this.priceAtLastTrade = null;
        this.isOrderInProgress = false;
        this.orderBook = { bids: [], asks: [] };
        this.orderHistory = [];
        this.startTime = new Date();
        this.activeOrderClientId = null;
        this.isPositionOpen = false;
        this.isCoolingDown = false;
        this.isOrderbookReady = false;
        this.initialize();
    }

    async initialize() {
        logger.info('--- Bot Initializing (L1 Optimized) ---');
        try {
            await this.deltaClient.setLeverage(config.productId, config.leverage);
            logger.info(`✅ Successfully set leverage to ${config.leverage}x`);

            await this.deltaClient.setCancelOnDisconnectTimer(config.cancelOnDisconnectTimeoutMs);
            logger.info(`✅ Successfully set Cancel-on-Disconnect timer.`);

            this.setupWebSocketServer();
            this.connectToDeltaWs();
            this.setupHealthCheck();

            logger.info(`🚀 Bot started successfully. Waiting for L1 orderbook and signals.`);
        } catch (error) {
            logger.error(`❌ FATAL: Failed to initialize bot.`, error.message);
            process.exit(1);
        }
    }

    connectToDeltaWs() {
        const ws = new WebSocket(config.deltaWsUrl);

        ws.on('open', () => {
            logger.info(`Delta WebSocket opened. Authenticating...`);
            const timestamp = this.deltaClient.getTimestamp();
            const signature = this.deltaClient.generateWsSignature(timestamp);

            const authMessage = {
                type: 'auth',
                payload: {
                    api_key: this.deltaClient.apiKey,
                    timestamp: timestamp,
                    signature: signature
                }
            };
            ws.send(JSON.stringify(authMessage));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'auth' && msg.success) {
                logger.info('✅ Delta WebSocket authenticated. Subscribing for live updates...');
                ws.send(JSON.stringify({
                    type: 'subscribe',
                    payload: {
                        channels: [
                            { name: 'l1_orderbook', symbols: [config.productSymbol] }, // Changed to l1_orderbook
                            { name: 'orders', symbols: [config.productSymbol] }
                        ]
                    }
                }));
            } else if (msg.type === 'l1_orderbook') { // Handle L1 updates
                // Reformat L1 data to match the expected L2 structure for compatibility
                this.orderBook.bids = [[msg.best_bid_price, msg.best_bid_size]];
                this.orderBook.asks = [[msg.best_ask_price, msg.best_ask_size]];
                if (!this.isOrderbookReady) {
                    this.isOrderbookReady = true;
                    logger.info('✅ L1 Order book synchronized via WebSocket stream.');
                }
            } else if (msg.type === 'orders') {
                this.handleOrderUpdate(msg);
            } else if (msg.type === 'subscription' && !msg.success) {
                logger.error('❌ Failed to subscribe to Delta channels:', msg);
            } else if (msg.type === 'auth' && !msg.success) {
                logger.error('❌ Delta WebSocket authentication failed:', msg);
                ws.close();
            }
        });

        ws.on('close', () => {
            logger.warn('Delta WebSocket closed. Reconnecting...');
            this.isOrderbookReady = false; // Reset flag on disconnect
            setTimeout(() => this.connectToDeltaWs(), config.reconnectInterval);
        });

        ws.on('error', (err) => logger.error('Delta WebSocket error:', err));
    }

    handleOrderUpdate(order) {
        if (this.isPositionOpen && order.client_order_id === this.activeOrderClientId) {
            if (order.state === 'filled' &&
                (order.order_type === 'stop_loss_order' || order.order_type === 'take_profit_order')) {
                logger.info(`✅ POSITION CLOSED: ${order.order_type} for main order ${this.activeOrderClientId} was filled.`);
                this.isPositionOpen = false;
                this.activeOrderClientId = null;
                this.startCooldown();
            }
        }
    }

    startCooldown() {
        this.isCoolingDown = true;
        logger.info(`--- COOLDOWN STARTED --- No new trades for ${config.cooldownSeconds} seconds.`);
        setTimeout(() => {
            this.isCoolingDown = false;
            logger.info(`--- COOLDOWN ENDED --- Bot is now active and listening for signals.`);
        }, config.cooldownSeconds * 1000);
    }

    setupWebSocketServer() {
        this.wss = new WebSocket.Server({ port: config.port });
        logger.info(`Internal WebSocket server started on port ${config.port}`);
        this.wss.on('connection', ws => {
            logger.info('Bybit listener connected');
            ws.on('message', message => this.handlePriceMessage(message));
            ws.on('close', () => logger.warn('Bybit listener disconnected'));
            ws.on('error', (error) => logger.error('Internal WebSocket error:', error));
        });
    }

    async handlePriceMessage(message) {
        if (!this.isOrderbookReady) {
            logger.warn("Price signal received, but L1 order book is not yet synchronized. Ignoring.");
            return;
        }

        try {
            const data = JSON.parse(message.toString());
            if (data.type !== 'S' || !data.p) return;

            const currentPrice = parseFloat(data.p);

            if (this.priceAtLastTrade === null) {
                this.priceAtLastTrade = currentPrice;
                logger.info(`Initial baseline price set to: $${this.priceAtLastTrade.toFixed(2)}`);
                return;
            }

            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);

            if (priceDifference >= config.priceThreshold &&
                !this.isOrderInProgress &&
                !this.isPositionOpen &&
                !this.isCoolingDown) {
                await this.executeTrade(currentPrice, priceDifference);
            }
        } catch (error) {
            logger.error("Error handling price message:", error.message, error.stack);
        }
    }

    async executeTrade(currentPrice, priceDifference) {
        this.isOrderInProgress = true;

        try {
            logger.info(`TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)} met threshold.`);

            const side = currentPrice > this.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const orderData = this.prepareOrderData(side, clientOrderId);

            if (!orderData) {
                logger.warn("Could not prepare order data. Skipping trade.");
                return;
            }

            const orderResponse = await this.deltaClient.placeOrder(orderData);

            logger.info('Order placed successfully:', {
                clientOrderId,
                exchangeOrderId: orderResponse.id
            });

            this.isPositionOpen = true;
            this.activeOrderClientId = clientOrderId;

            logger.info(`🔥 POSITION OPENED (Client ID: ${clientOrderId}). Bot will not place new trades until this position is closed.`);

            this.priceAtLastTrade = currentPrice;
            logger.info(`Trade baseline reset to: $${currentPrice.toFixed(2)}`);

        } catch (error) {
            logger.error('Failed to execute trade:', error.message);
        } finally {
            this.isOrderInProgress = false;
        }
    }

    prepareOrderData(side, clientOrderId) {
        const baseOrder = {
            product_id: config.productId,
            size: config.orderSize,
            side,
            client_order_id: clientOrderId
        };

        const book = side === 'buy' ? this.orderBook.asks : this.orderBook.bids;

        if (!book || book.length === 0 || !book[0][0]) {
            logger.warn(`No L1 order book data for side '${side}'. Cannot place limit order.`);
            return null;
        }

        // With L1 stream, we can only ever use the BBO.
        const price = parseFloat(book[0][0]);

        const takeProfitPrice = side === 'buy' ?
            price + config.takeProfitOffset :
            price - config.takeProfitOffset;

        const stopLossPrice = side === 'buy' ?
            price - config.stopLossOffset :
            price + config.stopLossOffset;

        return {
            ...baseOrder,
            order_type: 'bracket_order',
            limit_price: price.toFixed(4),
            bracket_take_profit_price: takeProfitPrice.toFixed(4),
            bracket_stop_loss_price: stopLossPrice.toFixed(4)
        };
    }

    setupHealthCheck() {
        setInterval(async () => {
            try {
                await this.deltaClient.setCancelOnDisconnectTimer(config.cancelOnDisconnectTimeoutMs);
                logger.info('Health Check:', {
                    uptime: `${Math.floor((Date.now() - this.startTime.getTime()) / 1000)}s`,
                    positionOpen: this.isPositionOpen,
                    inCooldown: this.isCoolingDown,
                    orderbookReady: this.isOrderbookReady,
                    currentBaseline: this.priceAtLastTrade,
                    cancelOnDisconnect: 'refreshed'
                });
            } catch (error) {
                logger.error('Health check failed:', error.message);
            }
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

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection:', reason);
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
