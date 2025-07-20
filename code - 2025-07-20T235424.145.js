// trader.js
// Definitive Final Version of Delta Exchange Trading Bot
// Version 8.4.0 - Added Slippage Control Configuration

const WebSocket = require('ws');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'BboBracket',
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
    priceThreshold: parseFloat(process.env.PRICE_THRESHOLD || '30.00'),
    orderSize: parseInt(process.env.ORDER_SIZE || '1'),
    leverage: process.env.DELTA_LEVERAGE || '50',
    // Strategy-specific configs
    takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET || '100.0'),
    stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET || '50.0'),
    adverseMovementThreshold: parseFloat(process.env.ADVERSE_MOVEMENT_THRESHOLD || '15.0'),
    timeInForce: process.env.TIME_IN_FORCE || 'gtc',
    trailAmount: parseFloat(process.env.TRAIL_AMOUNT || '20.0'),
    
    // --- NEW SLIPPAGE CONTROLS ---
    // For limit orders: How many price units "into" the book to place the order for a higher fill rate.
    priceAggressionOffset: parseFloat(process.env.PRICE_AGGRESSION_OFFSET || '0.5'),
    // For market-like orders: The max distance from BBO to place the limit order, protecting against volatility.
    slippageProtectionOffset: parseFloat(process.env.SLIPPAGE_PROTECTION_OFFSET || '5.0'),

    // General configs
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    logLevel: process.env.LOG_LEVEL || 'info',
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
    urgencyTimeframeMs: parseInt(process.env.URGENCY_TIMEFRAME_MS || '1000'),
    logThrottleIntervalMs: parseInt(process.env.LOG_THROTTLE_INTERVAL_MS || '60000'),
};

// --- Logging Setup ---
const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(winston.format.colorize(), winston.format.simple())
        })
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

// --- TradingBot Class (The Runner) ---
class TradingBot {
    constructor(botConfig) {
        this.config = { ...botConfig };
        this.logger = logger;
        this.client = new DeltaClient(this.config.apiKey, this.config.apiSecret, this.config.baseURL, this.logger);
        
        this.liveOrders = new Map();
        this.ws = null;
        this.authenticated = false;
        this.cleanupTimeouts = new Map();
        this.priceAtLastTrade = null;
        this.isOrderInProgress = false;
        this.isCoolingDown = false;
        this.orderBook = { bids: [], asks: [] };
        this.isOrderbookReady = false;
        this.hasOpenPosition = false;
        this.priceMoveStartTime = null;

        // State for managing throttled logs
        this.logThrottleTimestamps = new Map();

        try {
            const StrategyClass = require(`./strategies/${this.config.strategy}Strategy.js`);
            this.strategy = new StrategyClass(this);
            this.logger.info(`Successfully loaded strategy: ${this.strategy.getName()}`);
        } catch (e) {
            this.logger.error(`FATAL: Could not load strategy from file: ${this.config.strategy}Strategy.js.`, { error: e.message });
            process.exit(1);
        }
    }

    canLog(key) {
        const now = Date.now();
        const lastLogTime = this.logThrottleTimestamps.get(key) || 0;
        if (now - lastLogTime > this.config.logThrottleIntervalMs) {
            this.logThrottleTimestamps.set(key, now);
            return true;
        }
        return false;
    }
    
    async start() {
        this.logger.info(`--- Bot Initializing (v8.4.0) ---`);
        this.logger.info(`Strategy: ${this.strategy.getName()}, Product: ${this.config.productSymbol}`);
        this.logger.info(`Urgency Check: Price must move >= $${this.config.priceThreshold} in <= ${this.config.urgencyTimeframeMs}ms to trigger.`);
        this.logger.info(`Repetitive logs will be throttled to one per ${this.config.logThrottleIntervalMs / 1000} seconds.`);
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
        const signature = require('crypto').createHmac('sha256', this.config.apiSecret).update(signatureData).digest('hex');
        const authMessage = { type: 'auth', payload: { 'api-key': this.config.apiKey, timestamp, signature }};
        this.ws.send(JSON.stringify(authMessage));
    }

    subscribeToChannels() {
        const subscribeMessage = { type: 'subscribe', payload: { channels: [
            { name: 'orders', symbols: ['all'] },
            { name: 'positions', symbols: ['all'] },
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
                message.data?.forEach(update => {
                    this.handleOrderUpdate(update);
                    if (this.strategy.onOrderUpdate) {
                        this.strategy.onOrderUpdate(update);
                    }
                });
                break;
            case 'positions':
                if (message.product_symbol === this.config.productSymbol) {
                    const wasOpen = this.hasOpenPosition;
                    this.hasOpenPosition = message.size !== 0;
                    if (wasOpen && !this.hasOpenPosition) {
                        this.logger.info(`[PositionManager] Position for ${this.config.productSymbol} is now CLOSED.`);
                        this.liveOrders.clear();
                    } else if (!wasOpen && this.hasOpenPosition) {
                        this.logger.info(`[PositionManager] Position for ${this.config.productSymbol} is now OPEN.`);
                    }
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
                if (message.success) this.logger.info(`Subscribed to: ${message.channel_name}`);
                else this.logger.error(`Failed to subscribe to ${message.channel_name}`, message);
                break;
        }
    }
    
    registerOrder(order, type, parentId) {
        if (!order || !order.id) {
            this.logger.error(`Attempted to register invalid ${type} order.`, { orderData: order });
            return;
        }
        const orderInfo = { id: order.id, parentId: parentId, state: order.state, type: type };
        this.liveOrders.set(order.id, orderInfo);
        this.logger.info(`Registered ${type} order:`, orderInfo);
    }
    
    handleOrderUpdate(orderUpdate) {
        let registeredOrder = this.liveOrders.get(orderUpdate.id);
        if (!registeredOrder && orderUpdate.parent_client_order_id) {
            const parentOrder = [...this.liveOrders.values()].find(o => o.parentId === orderUpdate.parent_client_order_id);
            if (parentOrder) {
                const orderType = orderUpdate.order_type === 'take_profit_order' ? 'tp' : 'sl';
                this.registerOrder(orderUpdate, orderType, parentOrder.parentId);
                registeredOrder = this.liveOrders.get(orderUpdate.id);
            }
        }
        if (!registeredOrder) return;
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
                await this.client.batchCancelOrders(this.config.productId, orderIds);
                orderIds.forEach(id => this.liveOrders.delete(id));
                this.cleanupTimeouts.delete(key);
            } catch (error) { this.logger.error('Debounced batch cancel failed:', error); }
        }, delay);
        this.cleanupTimeouts.set(key, timeoutId);
    }
    
    async placeOrder(orderData) {
        return await this.client.placeOrder(orderData);
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
            if (this.canLog('bot_not_ready')) {
                this.logger.warn("Signal received, but bot is not ready. Ignoring subsequent signals for a while.");
            }
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

            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);

            if (priceDifference > 0 && this.priceMoveStartTime === null) {
                this.priceMoveStartTime = Date.now();
                if (this.canLog('trend_started')) {
                    this.logger.debug(`[UrgencyCheck] Potential trend started. Clock running.`);
                }
            } else if (priceDifference === 0 && this.priceMoveStartTime !== null) {
                this.priceMoveStartTime = null;
            }

            if (!this.isOrderInProgress && !this.isCoolingDown) {
                if (this.hasOpenPosition) {
                    if (this.canLog('position_open')) {
                        this.logger.debug(`[SignalHandler] Ignoring signal; position already open.`);
                    }
                    return;
                }
                
                if (priceDifference >= this.config.priceThreshold) {
                    if (this.priceMoveStartTime) {
                        const timeElapsed = Date.now() - this.priceMoveStartTime;

                        if (timeElapsed <= this.config.urgencyTimeframeMs) {
                            this.logger.info(`[UrgencyCheck] URGENT SIGNAL: Price moved $${priceDifference.toFixed(2)} in ${timeElapsed}ms. Triggering strategy.`);
                            await this.strategy.onPriceUpdate(currentPrice, priceDifference);
                            this.priceMoveStartTime = null;
                        } else {
                            if (this.canLog('stale_signal')) {
                                this.logger.warn(`[UrgencyCheck] STALE SIGNAL: Price moved $${priceDifference.toFixed(2)}, but it took too long (${timeElapsed}ms). Ignoring and resetting anchor.`);
                            }
                            this.priceAtLastTrade = currentPrice;
                            this.priceMoveStartTime = null;
                        }
                    } else {
                        if (this.canLog('threshold_no_start')) {
                            this.logger.warn(`[UrgencyCheck] Price threshold met without a start time. Resetting anchor to $${currentPrice.toFixed(2)}.`);
                        }
                        this.priceAtLastTrade = currentPrice;
                    }
                }
            }
        } catch (error) {
            this.logger.error("Error handling signal message:", error);
        }
    }
    
    startCooldown() {
        this.isCoolingDown = true;
        this.logger.info(`--- COOLDOWN ${this.config.cooldownSeconds}s STARTED ---`);
        this.priceMoveStartTime = null;
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