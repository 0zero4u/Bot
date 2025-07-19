// trader.js
// Definitive Final Version of Delta Exchange Trading Bot
// Version 7.0.0 - Major refactor with stateful order registry, debounced cleanup, and robust WebSocket management.

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
        
        // Active order registry to track bracket relationships
        this.liveOrders = new Map();
        
        // WebSocket connection
        this.ws = null;
        this.authenticated = false;
        
        // Debounced cleanup to prevent race conditions
        this.cleanupTimeouts = new Map();

        // Rate limiting
        this.rateLimiter = {
            requests: [],
            maxRequestsPerMinute: 200, // A safe limit
        };

        // Bot state
        this.priceAtLastTrade = null;
        this.isOrderInProgress = false;
        this.isCoolingDown = false;
        this.orderBook = { bids: [], asks: [] };
        this.isOrderbookReady = false;
    }
    
    // --- Core Methods ---
    async start() {
        this.logger.info('--- Bot Initializing (v7.0.0) ---');
        await this.initWebSocket();
        this.setupHttpServer();
    }

    /**
     * Initialize WebSocket connection for real-time order monitoring
     */
    async initWebSocket() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.config.wsURL);

            this.ws.on('open', () => {
                this.logger.info('WebSocket connected, authenticating...');
                this.authenticateWebSocket();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleWebSocketMessage(message);

                    if (message.type === 'auth' && message.success === true) {
                        this.logger.info('WebSocket authentication successful.');
                        this.authenticated = true;
                        this.subscribeToChannels();
                        resolve();
                    } else if (message.type === 'auth' && message.success === false) {
                        this.logger.error('WebSocket authentication failed:', message);
                        reject(new Error('WebSocket authentication failed'));
                    }
                } catch (error) {
                    this.logger.error('WebSocket message parsing error:', error);
                }
            });

            this.ws.on('error', (error) => {
                this.logger.error('WebSocket error:', error);
                // The 'close' event will handle reconnection
            });

            this.ws.on('close', () => {
                this.logger.warn('WebSocket disconnected. Attempting to reconnect...');
                this.authenticated = false;
                this.isOrderbookReady = false;
                setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
            });
        });
    }

    /**
     * Authenticate WebSocket connection for private channels
     */
    authenticateWebSocket() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signatureData = 'GET' + timestamp + '/live';
        const signature = crypto.createHmac('sha256', this.config.apiSecret).update(signatureData).digest('hex');
        this.ws.send(JSON.stringify({ type: 'auth', 'api-key': this.config.apiKey, timestamp, signature }));
    }

    /**
     * Subscribe to private orders channel and public orderbook
     */
    subscribeToChannels() {
        const subscribeMessage = {
            type: 'subscribe',
            payload: {
                channels: [
                    { name: 'orders', symbols: [this.config.productSymbol] },
                    { name: 'l1_orderbook', symbols: [this.config.productSymbol] }
                ]
            }
        };
        this.ws.send(JSON.stringify(subscribeMessage));
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleWebSocketMessage(message) {
        switch (message.type) {
            case 'orders':
                if (message.data && Array.isArray(message.data)) {
                    message.data.forEach(orderUpdate => this.handleOrderUpdate(orderUpdate));
                }
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
                if (message.success) {
                    this.logger.info(`Successfully subscribed to channel: ${message.channel_name}`);
                } else {
                    this.logger.error(`Failed to subscribe to channel: ${message.channel_name}`, message);
                }
                break;
        }
    }
    
    /**
     * Register order in active order registry
     */
    registerOrder(order, type, parentId) {
        // If it's a child, but we don't know the parent yet, we can't link it.
        // The parentId must be the client_order_id of the main order.
        if (!parentId && (type === 'sl' || type === 'tp')) {
             this.logger.warn(`Orphan ${type} order received without a known parent:`, order);
             return; // Cannot register without a parent link
        }

        const orderInfo = {
            id: order.id,
            clientOrderId: order.client_order_id,
            parentId: parentId || order.client_order_id, // Main order is its own parent
            state: order.state,
            type: type,
        };
        this.liveOrders.set(order.id, orderInfo);
        this.logger.info(`Registered ${type} order:`, orderInfo);
    }
    
    /**
     * Handle real-time order updates from WebSocket
     */
    handleOrderUpdate(orderUpdate) {
        let registeredOrder = this.liveOrders.get(orderUpdate.id);
        
        // If the order isn't registered, it might be the TP/SL leg of a bracket order we just placed.
        if (!registeredOrder && orderUpdate.parent_client_order_id) {
             const parentOrder = [...this.liveOrders.values()].find(o => o.clientOrderId === orderUpdate.parent_client_order_id);
             if (parentOrder) {
                 const type = orderUpdate.order_type === 'stop_loss_order' ? 'sl' : 'tp';
                 this.registerOrder(orderUpdate, type, parentOrder.parentId);
                 registeredOrder = this.liveOrders.get(orderUpdate.id);
             }
        }
        
        if (!registeredOrder) return; // Not an order we are tracking.

        this.logger.info('Order update received:', { id: orderUpdate.id, oldState: registeredOrder.state, newState: orderUpdate.state });
        registeredOrder.state = orderUpdate.state;

        if (orderUpdate.state === 'filled' || orderUpdate.state === 'cancelled') {
            this.handleOrderCompletion(registeredOrder);
        }
    }

    /**
     * Handle order completion and cancel sibling orders
     */
    handleOrderCompletion(completedOrder) {
        const siblings = [...this.liveOrders.values()].filter(order =>
            order.parentId === completedOrder.parentId &&
            order.id !== completedOrder.id &&
            order.state === 'open'
        );

        if (siblings.length > 0) {
            this.logger.info(`Order ${completedOrder.id} (${completedOrder.type}) completed. Cancelling ${siblings.length} sibling(s).`);
            this.debouncedBatchCancel(siblings.map(s => s.id));
        }

        // Remove completed order from registry
        this.liveOrders.delete(completedOrder.id);
    }

    /**
     * Debounced batch cancel to prevent race conditions and redundant calls
     */
    debouncedBatchCancel(orderIds, delay = 250) {
        const uniqueKey = orderIds.sort().join(','); // Group identical batches
        if (this.cleanupTimeouts.has(uniqueKey)) {
            clearTimeout(this.cleanupTimeouts.get(uniqueKey));
        }

        const timeoutId = setTimeout(async () => {
            try {
                await this.batchCancelOrders(orderIds);
                orderIds.forEach(id => this.liveOrders.delete(id));
                this.cleanupTimeouts.delete(uniqueKey);
            } catch (error) {
                this.logger.error('Debounced batch cancel failed:', error);
            }
        }, delay);

        this.cleanupTimeouts.set(uniqueKey, timeoutId);
    }
    
    // --- API Request & Rate Limiting ---
    async request(method, path, data = null, query = null) {
        // Rate Limiter Check
        const now = Date.now();
        this.rateLimiter.requests = this.rateLimiter.requests.filter(ts => now - ts < 60000);
        if (this.rateLimiter.requests.length >= this.rateLimiter.maxRequestsPerMinute) {
            this.logger.error('Rate limit exceeded. Aborting request.');
            throw new Error('Rate limit exceeded');
        }
        this.rateLimiter.requests.push(now);

        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signatureData = method + timestamp + path + (query ? '?' + new URLSearchParams(query).toString() : '') + (data ? JSON.stringify(data) : '');
        const signature = crypto.createHmac('sha256', this.config.apiSecret).update(signatureData).digest('hex');
        
        try {
            const response = await this.axios({
                method,
                url: path,
                headers: { 'api-key': this.config.apiKey, timestamp, signature, 'Content-Type': 'application/json' },
                params: query,
                data: data
            });
            return response.data;
        } catch (error) {
            this.logger.error(`API request failed: ${method} ${path}`, { status: error.response?.status, data: error.response?.data });
            throw error;
        }
    }
    
    // --- API Wrapper Methods ---
    async placeOrder(orderData) {
        return await this.request('POST', '/v2/orders', orderData);
    }

    async batchCancelOrders(orderIds) {
        if (orderIds.length === 0) return;
        this.logger.info(`Batch cancelling ${orderIds.length} orders:`, orderIds);
        return await this.request('DELETE', '/v2/orders/batch', { product_id: this.config.productId, orders: orderIds.map(id => ({ id })) });
    }

    // --- Trading Logic ---
    setupHttpServer() {
        // This replaces the old 'setupWebSocketServer' for clarity
        const httpServer = new WebSocket.Server({ port: this.config.port });
        this.logger.info(`Signal server started on port ${this.config.port}`);
        httpServer.on('connection', ws => {
            this.logger.info('Signal listener connected');
            ws.on('message', m => this.handleSignalMessage(m));
            ws.on('close', () => this.logger.warn('Signal listener disconnected'));
        });
    }

    async handleSignalMessage(message) {
        if (!this.isOrderbookReady) {
            this.logger.warn("Signal received, but order book not ready. Ignoring.");
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
            const clientOrderId = uuidv4(); // This is the PARENT ID
            
            const book = side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
            if (!book || book.length === 0) throw new Error(`No L1 data for side '${side}'.`);
            const limitPrice = parseFloat(book[0][0]);
            
            const orderData = {
                product_id: this.config.productId,
                size: this.config.orderSize,
                side: side,
                order_type: 'limit_order',
                limit_price: limitPrice.toString(),
                client_order_id: clientOrderId,
                bracket_take_profit_price: (side === 'buy' ? limitPrice + this.config.takeProfitOffset : limitPrice - this.config.takeProfitOffset).toString(),
                bracket_stop_loss_price: (side === 'buy' ? limitPrice - this.config.stopLossOffset : limitPrice + this.config.stopLossOffset).toString(),
            };

            const response = await this.placeOrder(orderData);
            if (response.success && response.result) {
                this.logger.info(`Bracket order placed successfully via parent ${clientOrderId}`);
                // Register the main order immediately. The children (TP/SL) will be registered
                // as they stream in through the WebSocket 'orders' channel update.
                this.registerOrder(response.result, 'main', clientOrderId);
                
                this.priceAtLastTrade = currentPrice;
                this.logger.info(`Trade baseline reset to: $${currentPrice.toFixed(2)}`);
                this.startCooldown();
            } else {
                 throw new Error('Order placement failed: ' + JSON.stringify(response));
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

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection:', { reason });
    process.exit(1);
});
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down.'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT received, shutting down.'); process.exit(0); });
