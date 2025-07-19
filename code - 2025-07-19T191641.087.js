// trader.js
// Definitive Final Version of Delta Exchange Trading Bot
// Version 6.2.0 - Implemented stateful, in-memory order registry for robust OCO management.

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// --- Utility Functions ---
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

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
}
validateConfig();

// --- More Utility Functions ---
function utilQueryString(query) {
    if (!query || Object.keys(query).length === 0) return '';
    return '?' + Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
}
function utilBodyString(body) {
    if (!body) return '';
    return JSON.stringify(body, null, 0);
}
function utilParseResponse(response) {
    if (response.data?.success) return response.data.result;
    if (response.data?.error) throw new Error(response.data.error);
    throw new Error('Unknown API error');
}

// --- Delta Exchange API Client ---
class DeltaExchangeClient {
    // ... (rest of the client class is unchanged)
    constructor(apiKey, apiSecret, baseUrl) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = baseUrl;
        this.axios = axios.create({
            baseURL: baseUrl,
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Bybit-Delta-Trading-Bot/6.2.0'
            }
        });
    }

    getTimestamp() { return String(Math.floor(Date.now() / 1000)); }

    generateSignature(method, path, timestamp, query = null, body = null) {
        const signatureData = method + timestamp + path + utilQueryString(query) + utilBodyString(body);
        return crypto.createHmac('sha256', this.apiSecret).update(signatureData, 'utf8').digest('hex');
    }

    generateWsSignature(timestamp) {
        const message = 'GET' + timestamp + '/live';
        return crypto.createHmac('sha256', this.apiSecret).update(message, 'utf8').digest('hex');
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
            const response = await this.axios({ method, url: path, data: data ? utilBodyString(data) : undefined, params: query, headers });
            return utilParseResponse(response);
        } catch (error) {
            logger.error('Delta Exchange API Error:', {
                request: { method, path, payload: data, query },
                response: { status: error.response?.status, data: error.response?.data },
                message: error.message
            });
            throw error;
        }
    }
    async setLeverage(productId, leverage) { return this.makeRequest('POST', `/v2/products/${productId}/orders/leverage`, { leverage: String(leverage) }); }
    async setCancelOnDisconnectTimer(timeoutMs) { return this.makeRequest('POST', '/v2/orders/cancel_after', { cancel_after: Math.floor(timeoutMs / 1000) }); }
    async placeOrder(orderData) { return this.makeRequest('POST', '/v2/orders', orderData); }
    async batchCancelOrders(productId, orders) { return this.makeRequest('DELETE', '/v2/orders/batch', { product_id: productId, orders: orders }); }
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
        this.isPositionOpen = false;
        this.isCoolingDown = false;
        this.isOrderbookReady = false;

        // --- NEW --- Order registry and debounced cancel function
        this.liveOrders = new Map();
        this.throttleBatchCancel = debounce(async (orderIdsToCancel) => {
            if (orderIdsToCancel.length === 0) return;
            logger.info(`Debounced cancel triggered for order ID(s): ${orderIdsToCancel.join(', ')}`);
            try {
                const payload = orderIdsToCancel.map(id => ({ id }));
                await this.deltaClient.batchCancelOrders(config.productId, payload);
                logger.info('Batch cancel successful for orders.', { ids: orderIdsToCancel });
            } catch (e) {
                logger.error('Batch cancel failed', { message: e.message, ids: orderIdsToCancel });
            }
        }, 250);

        this.initialize();
    }

    async initialize() {
        logger.info('--- Bot Initializing (v6.2.0) ---');
        try {
            await this.deltaClient.setLeverage(config.productId, config.leverage);
            logger.info(`Leverage set to ${config.leverage}x`);
            await this.deltaClient.setCancelOnDisconnectTimer(config.cancelOnDisconnectTimeoutMs);
            logger.info(`Cancel-on-Disconnect timer set.`);
            this.setupWebSocketServer();
            this.connectToDeltaWs();
        } catch (error) {
            logger.error(`FATAL: Failed to initialize bot.`, { message: error.message });
            process.exit(1);
        }
    }

    // --- NEW --- Registers all parts of a bracket order
    registerBracketOrder(response) {
        const mainOrder = response;
        const parentId = mainOrder.client_order_id; // The unique ID for this entire trade

        const register = (o, type) => {
            if (!o) return;
            const record = {
                id: o.id,
                clientOrderId: o.client_order_id,
                parentId: parentId,
                state: o.state,
                side: o.side,
                type: type,
            };
            this.liveOrders.set(record.id, record);
            logger.info(`Registered order:`, record);
        };

        register(mainOrder, 'main');
        register(mainOrder.stop_loss_order, 'sl');
        register(mainOrder.take_profit_order, 'tp');
    }

    // --- NEW --- Handles incoming order updates from WebSocket
    handleOrderUpdate(update) {
        const record = this.liveOrders.get(update.id);
        if (!record) return; // Not an order we are tracking

        logger.info(`Order update received:`, { id: update.id, oldState: record.state, newState: update.state });
        record.state = update.state;

        if (record.state === 'filled' || record.state === 'cancelled') {
            // An order was filled or cancelled, we need to clean up its siblings
            const parentId = record.parentId;
            const ordersToCancel = [];
            
            // Find all other open orders with the same parentId
            for (const [id, order] of this.liveOrders.entries()) {
                if (order.parentId === parentId && order.id !== record.id && order.state === 'open') {
                    ordersToCancel.push(order.id);
                }
            }

            if (ordersToCancel.length > 0) {
                this.throttleBatchCancel(ordersToCancel);
            }

            // Cleanup the registry
            this.liveOrders.delete(record.id);
            logger.info(`De-registered completed order ID: ${record.id}`);
        }
    }

    resetHeartbeatTimer() {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = setTimeout(() => {
            logger.error('Heartbeat not received. Forcing reconnect...');
            this.ws?.terminate();
        }, config.heartbeatIntervalMs);
    }

    connectToDeltaWs() {
        this.ws = new WebSocket(config.deltaWsUrl);

        this.ws.on('open', () => {
            logger.info(`Delta WebSocket opened.`);
            this.resetHeartbeatTimer();
            const timestamp = this.deltaClient.getTimestamp();
            const signature = this.deltaClient.generateWsSignature(timestamp);
            this.ws.send(JSON.stringify({ type: 'auth', 'api-key': config.deltaApiKey, timestamp, signature }));
            this.ws.send(JSON.stringify({ type: 'enable_heartbeat' }));
        });

        this.ws.on('message', (data) => {
            this.resetHeartbeatTimer();
            const msg = JSON.parse(data.toString());

            if (msg.type === 'auth' && msg.success) {
                logger.info('Delta WebSocket authenticated. Subscribing to channels...');
                const channels = [
                    { name: 'l1_orderbook', symbols: [config.productSymbol] },
                    { name: 'orders', symbols: [config.productSymbol] } // Ensure we listen to order updates
                ];
                this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels } }));
            } else if (msg.type === 'l1_orderbook') {
                this.orderBook.bids = [[msg.best_bid, msg.bid_qty]];
                this.orderBook.asks = [[msg.best_ask, msg.ask_qty]];
                if (!this.isOrderbookReady) {
                    this.isOrderbookReady = true;
                    logger.info('L1 Order book synchronized.');
                }
            } else if (msg.type === 'orders' && Array.isArray(msg.data)) {
                // --- MODIFIED --- Process each order update in the batch
                msg.data.forEach(update => this.handleOrderUpdate(update));
            } else if (msg.type === 'heartbeat') {
                logger.info('Heartbeat received.');
            } else if (msg.type === 'subscription' && !msg.success) {
                logger.error(`Failed to subscribe to ${msg.channel_name}:`, msg);
            }
        });

        this.ws.on('close', () => {
            logger.warn('Delta WebSocket closed. Reconnecting...');
            clearTimeout(this.heartbeatTimer);
            this.isOrderbookReady = false;
            setTimeout(() => this.connectToDeltaWs(), config.reconnectInterval);
        });

        this.ws.on('error', (err) => logger.error('Delta WebSocket error:', { message: err.message }));
    }

    startCooldown() {
        this.isCoolingDown = true;
        this.isPositionOpen = false; // Position is considered closed
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
        });
    }

    async handlePriceMessage(message) {
        if (!this.isOrderbookReady) return;
        try {
            const data = JSON.parse(message.toString());
            if (data.type !== 'S' || !data.p) return;
            
            const currentPrice = parseFloat(data.p);
            if (this.priceAtLastTrade === null) {
                this.priceAtLastTrade = currentPrice;
                return;
            }

            this.isPositionOpen = this.liveOrders.size > 0;
            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);
            if (priceDifference >= config.priceThreshold && !this.isOrderInProgress && !this.isPositionOpen && !this.isCoolingDown) {
                await this.executeTrade(currentPrice, priceDifference);
            }
        } catch (error) {
            logger.error("Error handling price message:", { message: error.message });
        }
    }

    async executeTrade(currentPrice, priceDifference) {
        this.isOrderInProgress = true;
        try {
            logger.info(`TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)}`);
            const side = currentPrice > this.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4(); // This is the parent ID for the bracket order
            const orderData = this.prepareOrderData(side, clientOrderId);
            
            if (!orderData) {
                logger.warn("Could not prepare order data. Skipping trade.");
                return;
            }

            const orderResponse = await this.deltaClient.placeOrder(orderData);
            logger.info(`Bracket order placed successfully via parent ${clientOrderId}`);
            
            // --- MODIFIED --- Register the entire bracket order
            this.registerBracketOrder(orderResponse);
            
            this.isPositionOpen = true;
            this.priceAtLastTrade = currentPrice;
            logger.info(`Trade baseline reset to: $${currentPrice.toFixed(2)}`);
            this.startCooldown();

        } catch (error) {
            logger.error('Failed to execute trade:', { message: error.message });
        } finally {
            this.isOrderInProgress = false;
        }
    }

    prepareOrderData(side, clientOrderId) {
        const book = side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
        if (!book || book.length === 0 || !book[0][0]) {
            logger.warn(`No L1 data for side '${side}'.`);
            return null;
        }
        const price = parseFloat(book[0][0]);
        const takeProfitPrice = side === 'buy' ? price + config.takeProfitOffset : price - config.takeProfitOffset;
        const stopLossPrice = side === 'buy' ? price - config.stopLossOffset : price + config.stopLossOffset;
        
        return {
            product_id: config.productId,
            size: config.orderSize,
            side,
            client_order_id: clientOrderId,
            order_type: 'limit_order',
            limit_price: price.toFixed(4),
            bracket_take_profit_price: takeProfitPrice.toFixed(4),
            bracket_stop_loss_price: stopLossPrice.toFixed(4)
        };
    }
}

// --- Start Bot & Process Handlers ---
try {
    new TradingBot();
} catch (error) {
    logger.error("Failed to construct bot:", { message: error.message });
    process.exit(1);
}
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', { reason });
    process.exit(1);
});
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down.'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT received, shutting down.'); process.exit(0); });