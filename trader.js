// trader.js
// Definitive Final Version of Delta Exchange Trading Bot
// Version 6.1.0 - Switched to position-based monitoring for robust order cleanup.

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
    heartbeatIntervalMs: 35000,
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
        logger.error('FATAL: The "limit_next_bbo" strategy is not supported in this L1-optimized version.');
        process.exit(1);
    }
}
validateConfig();

// --- Utility Functions ---
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
    if (!body) {
        return '';
    }
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
                'User-Agent': 'Bybit-Delta-Trading-Bot/6.1.0'
            }
        });
    }

    getTimestamp() {
        return String(Math.floor(Date.now() / 1000));
    }

    generateSignature(method, path, timestamp, query = null, body = null) {
        const signatureData = method + timestamp + path + utilQueryString(query) + utilBodyString(body);
        return crypto.createHmac('sha256', this.apiSecret)
            .update(signatureData, 'utf8')
            .digest('hex');
    }

    generateWsSignature(timestamp) {
        const message = 'GET' + timestamp + '/live';
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
                request: {
                    method,
                    path,
                    payload: data,
                    query
                },
                response: {
                    status: error.response?.status,
                    data: error.response?.data
                },
                message: error.message
            });
            throw error;
        }
    }

    async setLeverage(productId, leverage) {
        const payload = { leverage: String(leverage) };
        return this.makeRequest('POST', `/v2/products/${productId}/orders/leverage`, payload);
    }

    async setCancelOnDisconnectTimer(timeoutMs) {
        const payload = { cancel_after: Math.floor(timeoutMs / 1000) };
        return this.makeRequest('POST', '/v2/orders/cancel_after', payload);
    }

    async placeOrder(orderData) {
        return this.makeRequest('POST', '/v2/orders', orderData);
    }

    async getLiveOrders(productId) {
        const query = { product_id: productId };
        return this.makeRequest('GET', '/v2/orders', null, query);
    }

    async batchCancelOrders(productId, orders) {
        const payload = { product_id: productId, orders: orders };
        return this.makeRequest('DELETE', '/v2/orders/batch', payload);
    }
}

// --- TradingBot Class ---
class TradingBot {
    constructor() {
        this.deltaClient = new DeltaExchangeClient(config.deltaApiKey, config.deltaApiSecret, config.deltaBaseUrl);
        this.ws = null;
        this.heartbeatTimer = null;
        this.priceAtLastTrade = null;
        this.isOrderInProgress = false;
        this.orderBook = { bids: [], asks: [] };
        this.startTime = new Date();
        this.isPositionOpen = false;
        this.isCoolingDown = false;
        this.isOrderbookReady = false;
        this.initialize();
    }

    async initialize() {
        logger.info('--- Bot Initializing (v6.1.0) ---');
        try {
            await this.deltaClient.setLeverage(config.productId, config.leverage);
            logger.info(`Leverage set to ${config.leverage}x`);
            await this.deltaClient.setCancelOnDisconnectTimer(config.cancelOnDisconnectTimeoutMs);
            logger.info(`Cancel-on-Disconnect timer set.`);
            this.setupWebSocketServer();
            this.connectToDeltaWs();
            this.setupHealthCheck();
            logger.info(`Bot started. Waiting for connections.`);
        } catch (error) {
            logger.error(`FATAL: Failed to initialize bot.`, error.message);
            process.exit(1);
        }
    }

    resetHeartbeatTimer() {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = setTimeout(() => {
            logger.error('Heartbeat not received in time. Forcing reconnect...');
            if (this.ws) this.ws.terminate();
        }, config.heartbeatIntervalMs);
    }

    connectToDeltaWs() {
        this.ws = new WebSocket(config.deltaWsUrl);

        this.ws.on('open', () => {
            logger.info(`Delta WebSocket opened. Sending setup messages...`);
            this.resetHeartbeatTimer();

            const timestamp = this.deltaClient.getTimestamp();
            const signature = this.deltaClient.generateWsSignature(timestamp);
            this.ws.send(JSON.stringify({
                type: 'auth',
                'api-key': config.deltaApiKey,
                'timestamp': timestamp,
                'signature': signature
            }));

            this.ws.send(JSON.stringify({ type: 'enable_heartbeat' }));

            this.ws.send(JSON.stringify({
                type: 'subscribe',
                payload: {
                    channels: [{ name: 'l1_orderbook', symbols: [config.productSymbol] }]
                }
            }));
        });

        this.ws.on('message', (data) => {
            this.resetHeartbeatTimer();
            const msg = JSON.parse(data.toString());

            if (msg.type === 'auth' && msg.success) {
                logger.info('Delta WebSocket authenticated. Subscribing to private channels...');
                this.ws.send(JSON.stringify({
                    type: 'subscribe',
                    payload: {
                        channels: [{ name: 'positions', symbols: [config.productSymbol] }]
                    }
                }));
            } else if (msg.type === 'l1_orderbook') {
                this.orderBook.bids = [[msg.best_bid, msg.bid_qty]];
                this.orderBook.asks = [[msg.best_ask, msg.ask_qty]];
                if (!this.isOrderbookReady) {
                    this.isOrderbookReady = true;
                    logger.info('L1 Order book synchronized.');
                }
            } else if (msg.type === 'positions') {
                this.handlePositionUpdate(msg);
            } else if (msg.type === 'heartbeat') {
                logger.info('Heartbeat received.');
            } else if (msg.type === 'subscription') {
                if (msg.success) {
                    logger.info(`Subscribed to ${msg.channel_name}`);
                } else {
                    logger.error(`Failed to subscribe to ${msg.channel_name}:`, msg);
                }
            } else if (msg.type === 'auth' && !msg.success) {
                logger.error('Delta WebSocket auth failed:', msg);
                this.ws.close();
            }
        });

        this.ws.on('close', () => {
            logger.warn('Delta WebSocket closed. Reconnecting...');
            clearTimeout(this.heartbeatTimer);
            this.isOrderbookReady = false;
            setTimeout(() => this.connectToDeltaWs(), config.reconnectInterval);
        });

        this.ws.on('error', (err) => logger.error('Delta WebSocket error:', err));
    }

    async handlePositionUpdate(position) {
        const wasPositionOpen = this.isPositionOpen;
        const isCurrentlyOpen = position.size !== 0;
        this.isPositionOpen = isCurrentlyOpen;
        
        if (wasPositionOpen && !isCurrentlyOpen) {
            logger.info('POSITION CLOSED detected via position update.');
            await this.cancelAllOpenOrders();
            this.startCooldown();
        }
    }

    async cancelAllOpenOrders() {
        logger.info(`Cancelling all remaining open orders for product ${config.productId}...`);
        try {
            const liveOrders = await this.deltaClient.getLiveOrders(config.productId);
            if (liveOrders && liveOrders.length > 0) {
                const ordersToCancel = liveOrders.map(o => ({ id: o.id }));
                logger.info(`Found ${liveOrders.length} live order(s) to cancel.`);
                const cancelResponse = await this.deltaClient.batchCancelOrders(config.productId, ordersToCancel);
                logger.info(`Batch cancel successful.`, { response: cancelResponse });
            } else {
                logger.info(`No live orders found to cancel.`);
            }
        } catch (error) {
            logger.error(`Failed to cancel open orders: ${error.message}`);
        }
    }
    
    startCooldown() {
        this.isCoolingDown = true;
        logger.info(`--- COOLDOWN ${config.cooldownSeconds}s STARTED ---`);
        setTimeout(() => {
            this.isCoolingDown = false;
            logger.info(`--- COOLDOWN ENDED ---`);
        }, config.cooldownSeconds * 1000);
    }

    setupWebSocketServer() {
        this.wss = new WebSocket.Server({ port: config.port });
        logger.info(`Internal WebSocket server started on port ${config.port}`);
        this.wss.on('connection', ws => {
            logger.info('Bybit listener connected');
            ws.on('message', m => this.handlePriceMessage(m));
            ws.on('close', () => logger.warn('Bybit listener disconnected'));
            ws.on('error', (e) => logger.error('Internal WebSocket error:', e));
        });
    }

    async handlePriceMessage(message) {
        if (!this.isOrderbookReady) {
            logger.warn("Signal received, but L1 book not synchronized. Ignoring.");
            return;
        }
        try {
            const data = JSON.parse(message.toString());
            if (data.type !== 'S' || !data.p) return;
            const currentPrice = parseFloat(data.p);
            if (this.priceAtLastTrade === null) {
                this.priceAtLastTrade = currentPrice;
                logger.info(`Initial baseline price set: $${currentPrice.toFixed(2)}`);
                return;
            }
            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);
            if (priceDifference >= config.priceThreshold && !this.isOrderInProgress && !this.isPositionOpen && !this.isCoolingDown) {
                await this.executeTrade(currentPrice, priceDifference);
            }
        } catch (error) {
            logger.error("Error handling price message:", error.message, error.stack);
        }
    }

    async executeTrade(currentPrice, priceDifference) {
        this.isOrderInProgress = true;
        try {
            logger.info(`TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)}`);
            const side = currentPrice > this.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const orderData = this.prepareOrderData(side, clientOrderId);
            if (!orderData) {
                logger.warn("Could not prepare order data. Skipping.");
                return;
            }
            const orderResponse = await this.deltaClient.placeOrder(orderData);
            logger.info(`Order placed successfully: ${clientOrderId} (ID: ${orderResponse.id})`);
            this.isPositionOpen = true; // Set optimistic flag
            logger.info(`POSITION OPENED: ${clientOrderId}`);
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
            logger.warn(`No L1 data for side '${side}'.`);
            return null;
        }
        const price = parseFloat(book[0][0]);
        const takeProfitPrice = side === 'buy' ? price + config.takeProfitOffset : price - config.takeProfitOffset;
        const stopLossPrice = side === 'buy' ? price - config.stopLossOffset : price + config.stopLossOffset;
        return {
            ...baseOrder,
            order_type: 'limit_order',
            limit_price: price.toFixed(4),
            bracket_take_profit_price: takeProfitPrice.toFixed(4),
            bracket_stop_loss_price: stopLossPrice.toFixed(4)
        };
    }

    setupHealthCheck() {
        setInterval(async () => {
            try {
                await this.deltaClient.setCancelOnDisconnectTimer(config.cancelOnDisconnectTimeoutMs);
                logger.info('Health Check: Cancel-on-Disconnect refreshed.');
            } catch (error) {
                logger.error('Health check failed:', error.message);
            }
        }, 300000);
    }
}

// --- Start Bot & Process Handlers ---
try {
    new TradingBot();
} catch (error) {
    logger.error("Failed to construct bot:", error);
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
    logger.info('SIGTERM received, shutting down.');
    process.exit(0);
});
process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down.');
    process.exit(0);
});
