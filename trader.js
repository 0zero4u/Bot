// trader.js
// Definitive Final Version of Delta Exchange Trading Bot
// Version 7.0.7 - Implemented asynchronous, stateful bracket order registration.

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// --- Configuration ---
const config = {
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
    priceThreshold: parseFloat(process.env.PRICE_THRESHOLD || '1.00'),
    orderSize: parseInt(process.env.ORDER_SIZE || '1'),
    leverage: process.env.DELTA_LEVERAGE || '50',
    takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET || '100.0'),
    stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET || '50.0'),
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    logLevel: process.env.LOG_LEVEL || 'info',
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
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
    const required = ['apiKey', 'apiSecret', 'productId', 'productSymbol', 'leverage'];
    if (required.some(key => !config[key])) {
        logger.error(`FATAL: Missing required configuration: ${required.filter(key => !config[key]).join(', ')}`);
        process.exit(1);
    }
}
validateConfig();

// --- TradingBot Class ---
class TradingBot {
    constructor(botConfig) {
        this.config = { ...botConfig };
        this.logger = logger;
        this.axios = axios.create({ baseURL: this.config.baseURL, timeout: 10000 });
        
        this.liveOrders = new Map();
        this.ws = null;
        this.authenticated = false;
        this.cleanupTimeouts = new Map();
        this.priceAtLastTrade = null;
        this.isOrderInProgress = false;
        this.isCoolingDown = false;
        this.orderBook = { bids: [], asks: [] };
        this.isOrderbookReady = false;
    }
    
    async start() {
        this.logger.info('--- Bot Initializing (v7.0.7) ---');
        await this.initWebSocket();
        this.setupHttpServer();
    }

    async initWebSocket() {
        this.ws = new WebSocket(this.config.wsURL);
        this.ws.on('open', () => {
            this.logger.info('WebSocket connected, authenticating...');
            this.authenticateWebSocket();
        });
        this.ws.on('message', (data) => {
            try { this.handleWebSocketMessage(JSON.parse(data.toString())); } 
            catch (error) { this.logger.error('WebSocket message parsing error:', error); }
        });
        this.ws.on('error', (error) => this.logger.error('WebSocket connection error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected: ${code} - ${reason}. Reconnecting...`);
            this.authenticated = false;
            this.isOrderbookReady = false;
            setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
        });
    }

    authenticateWebSocket() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signatureData = 'GET' + timestamp + '/live';
        const signature = crypto.createHmac('sha256', this.config.apiSecret).update(signatureData).digest('hex');
        const authMessage = { type: 'auth', payload: { 'api-key': this.config.apiKey, timestamp, signature }};
        this.ws.send(JSON.stringify(authMessage));
    }

    subscribeToChannels() {
        const subscribeMessage = { type: 'subscribe', payload: { channels: [
            { name: 'orders', symbols: ['all'] },
            { name: 'l1_orderbook', symbols: [this.config.productSymbol] }
        ]}};
        this.ws.send(JSON.stringify(subscribeMessage));
    }

    handleWebSocketMessage(message) {
        if (message.type === 'success' && message.message === 'Authenticated') {
            this.logger.info('WebSocket authentication successful.');
            this.authenticated = true;
            this.subscribeToChannels();
            return;
        }
        switch (message.type) {
            case 'orders':
                message.data?.forEach(update => this.handleOrderUpdate(update));
                break;
            case 'l1_orderbook':
                this.orderBook.bids = [[message.best_bid, message.bid_qty]];
                this.orderBook.asks = [[message.best_ask, message.ask_qty]];
                if (!this.isOrderbookReady) {
                    this.isOrderbookReady = true;
                    this.logger.info('L1 Order book synchronized.');
                }
                break;
            case 'subscription':
                if (message.success) this.logger.info(`Subscribed to: ${message.channel_name}`);
                else this.logger.error(`Failed to subscribe to ${message.channel_name}`, message);
                break;
        }
    }
    
    registerOrder(order, type, parentId) {
        const orderInfo = { id: order.id, parentId: parentId, state: order.state, type: type };
        this.liveOrders.set(order.id, orderInfo);
        this.logger.info(`Registered ${type} order:`, orderInfo);
    }
    
    handleOrderUpdate(orderUpdate) {
        let registeredOrder = this.liveOrders.get(orderUpdate.id);

        // --- FIX --- Asynchronously link children to the parent when their update arrives
        if (!registeredOrder && orderUpdate.parent_client_order_id) {
            const parentOrder = [...this.liveOrders.values()].find(o => o.parentId === orderUpdate.parent_client_order_id);
            if (parentOrder) {
                const orderType = orderUpdate.order_type === 'take_profit_order' ? 'tp' : 'sl';
                this.registerOrder(orderUpdate, orderType, parentOrder.parentId);
                registeredOrder = this.liveOrders.get(orderUpdate.id);
            }
        }
        
        if (!registeredOrder) return;

        this.logger.info(`Order update for ${registeredOrder.type}:`, { id: orderUpdate.id, oldState: registeredOrder.state, newState: orderUpdate.state });
        registeredOrder.state = orderUpdate.state;
        if (orderUpdate.state === 'filled' || orderUpdate.state === 'cancelled') {
            this.handleOrderCompletion(registeredOrder);
        }
    }

    handleOrderCompletion(completedOrder) {
        const siblings = [...this.liveOrders.values()].filter(o =>
            o.parentId === completedOrder.parentId && o.id !== completedOrder.id && o.state === 'open'
        );
        if (siblings.length > 0) {
            this.logger.info(`Order ${completedOrder.id} (${completedOrder.type}) completed. Cancelling ${siblings.length} sibling(s).`);
            this.debouncedBatchCancel(siblings.map(s => s.id));
        }
        this.liveOrders.delete(completedOrder.id);
    }

    debouncedBatchCancel(orderIds, delay = 250) {
        const key = orderIds.sort().join(',');
        if (this.cleanupTimeouts.has(key)) clearTimeout(this.cleanupTimeouts.get(key));
        const timeoutId = setTimeout(async () => {
            try {
                await this.batchCancelOrders(orderIds);
                orderIds.forEach(id => this.liveOrders.delete(id));
                this.cleanupTimeouts.delete(key);
            } catch (error) { this.logger.error('Debounced batch cancel failed:', error); }
        }, delay);
        this.cleanupTimeouts.set(key, timeoutId);
    }
    
    async request(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signatureData = method + timestamp + path + (query ? '?' + new URLSearchParams(query).toString() : '') + (data ? JSON.stringify(data) : '');
        const signature = crypto.createHmac('sha256', this.config.apiSecret).update(signatureData).digest('hex');
        try {
            const response = await this.axios({ method, url: path,
                headers: { 'api-key': this.config.apiKey, timestamp, signature, 'Content-Type': 'application/json' },
                params: query, data: data
            });
            return response.data;
        } catch (error) {
            this.logger.error(`API request failed: ${method} ${path}`, { status: error.response?.status, data: error.response?.data });
            throw error;
        }
    }
    
    async placeOrder(orderData) {
        return await this.request('POST', '/v2/orders', orderData);
    }

    async batchCancelOrders(orderIds) {
        if (orderIds.length === 0) return;
        this.logger.info(`Batch cancelling orders:`, orderIds);
        return await this.request('DELETE', '/v2/orders/batch', { product_id: this.config.productId, orders: orderIds.map(id => ({ id })) });
    }

    setupHttpServer() {
        const httpServer = new WebSocket.Server({ port: this.config.port });
        this.logger.info(`Signal server started on port ${this.config.port}`);
        httpServer.on('connection', ws => {
            this.logger.info('Signal listener connected');
            ws.on('message', m => this.handleSignalMessage(m));
            ws.on('close', () => this.logger.warn('Signal listener disconnected'));
            ws.on('error', (err) => this.logger.error('Signal listener connection error:', err));
        });
    }

    async handleSignalMessage(message) {
        if (!this.isOrderbookReady || !this.authenticated) {
            this.logger.warn("Signal received, but bot is not ready. Ignoring.");
            return;
        }
        try {
            const data = JSON.parse(message.toString());
            if (data.type !== 'S' || !data.p) return;
            const currentPrice = parseFloat(data.p);
            if (this.priceAtLastTrade === null) {
                this.priceAtLastTrade = currentPrice;
                this.logger.info(`Initial baseline price set: $${currentPrice.toFixed(2)}`);
                return;
            }
            const hasOpenPosition = this.liveOrders.size > 0;
            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);
            if (priceDifference >= this.config.priceThreshold && !this.isOrderInProgress && !hasOpenPosition && !this.isCoolingDown) {
                await this.executeTrade(currentPrice, priceDifference);
            }
        } catch (error) {
            this.logger.error("Error handling signal message:", error);
        }
    }

    async executeTrade(currentPrice, priceDifference) {
        this.isOrderInProgress = true;
        try {
            this.logger.info(`TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)}`);
            const side = currentPrice > this.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const book = side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
            if (!book?.[0]?.[0]) throw new Error(`No L1 data for side '${side}'.`);
            const limitPrice = parseFloat(book[0][0]);
            
            const takeProfitPrice = side === 'buy' ? limitPrice + this.config.takeProfitOffset : limitPrice - this.config.takeProfitOffset;
            const stopLossPrice = side === 'buy' ? limitPrice - this.config.stopLossOffset : limitPrice + this.config.stopLossOffset;

            if (takeProfitPrice <= 0 || stopLossPrice <= 0) {
                this.logger.error('ABORTING TRADE: Calculated bracket price is invalid (<= 0). Check your offsets.', {
                    limitPrice, takeProfitPrice, stopLossPrice
                });
                return;
            }
            
            const orderData = {
                product_id: this.config.productId, size: this.config.orderSize, side: side,
                order_type: 'limit_order', limit_price: limitPrice.toString(), client_order_id: clientOrderId,
                bracket_take_profit_price: takeProfitPrice.toString(),
                bracket_stop_loss_price: stopLossPrice.toString(),
            };
            
            const response = await this.placeOrder(orderData);

            // --- FIX --- Only register the main order from the REST response.
            // The TP/SL orders will be registered when they arrive via WebSocket.
            if (response.success && response.result) {
                this.logger.info(`Main order placement successful.`);
                this.registerOrder(response.result, 'main', clientOrderId);
                this.priceAtLastTrade = currentPrice;
                this.logger.info(`Trade baseline reset to: $${currentPrice.toFixed(2)}`);
                this.startCooldown();
            } else {
                 throw new Error('Order placement API call failed or returned unexpected format: ' + JSON.stringify(response));
            }
        } catch (error) {
            this.logger.error('Failed to execute trade:', error.message);
        } finally {
            this.isOrderInProgress = false;
        }
    }

    startCooldown() {
        this.isCoolingDown = true;
        this.logger.info(`--- COOLDOWN ${this.config.cooldownSeconds}s STARTED ---`);
        setTimeout(() => {
            this.isCoolingDown = false;
            this.logger.info(`--- COOLDOWN ENDED ---`);
        }, this.config.cooldownSeconds * 1000);
    }
}

// --- Start Bot & Process Handlers ---
(async () => {
    try {
        validateConfig();
        const bot = new TradingBot(config);
        await bot.start();
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();

process.on('uncaughtException', (err) => logger.error('Uncaught Exception:', { message: err.message, stack: err.stack }) && process.exit(1));
process.on('unhandledRejection', (reason) => logger.error('Unhandled Rejection:', { reason }) && process.exit(1));
process.on('SIGTERM', () => logger.info('SIGTERM received, shutting down.') && process.exit(0));
process.on('SIGINT', () => logger.info('SIGINT received, shutting down.') && process.exit(0));
