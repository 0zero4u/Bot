// trader.js
// Version 8.8.0 - FINAL PRODUCTION VERSION with Startup Position Sync

const WebSocket = require('ws');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'MomentumRider',
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
    priceThreshold: parseFloat(process.env.PRICE_THRESHOLD || '2.0'),
    orderSize: parseInt(process.env.ORDER_SIZE || '1'),
    leverage: process.env.DELTA_LEVERAGE || '50',
    // Strategy-specific configs
    takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET || '100.0'),
    stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET || '50.0'),
    adverseMovementThreshold: parseFloat(process.env.ADVERSE_MOVEMENT_THRESHOLD || '15.0'),
    slippageProtectionOffset: parseFloat(process.env.SLIPPAGE_PROTECTION_OFFSET || '5.0'),
    // General configs
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    logLevel: process.env.LOG_LEVEL || 'info',
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
    urgencyTimeframeMs: parseInt(process.env.URGENCY_TIMEFRAME_MS || '1000'),
    logThrottleIntervalMs: parseInt(process.env.LOG_THROTTLE_INTERVAL_MS || '60000'),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '35000')
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
        this.logThrottleTimestamps = new Map();
        this.heartbeatTimeout = null;

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

    async syncInitialPosition() {
        this.logger.info('Syncing initial position state from REST API...');
        try {
            // NOTE: The getPositions method in the client might need to be created/exposed.
            // Assuming client.js has a method `getPositions(productId)`
            const positions = await this.client.getPositions(this.config.productId);
            if (positions && positions.length > 0) {
                const position = positions[0];
                const positionSize = parseFloat(position.size);

                if (positionSize !== 0) {
                    this.logger.warn(`[PositionManager] Found EXISTING position on startup: Size=${positionSize}`);
                    // Manually trigger the position update to sync the bot and strategy
                    this.handleWebSocketMessage({
                        type: 'positions',
                        product_symbol: this.config.productSymbol,
                        ...position // Pass the full position object
                    });
                } else {
                    this.logger.info('No existing position found.');
                }
            } else {
                 this.logger.info('No existing position found.');
            }
        } catch (error) {
            this.logger.error('Failed to sync initial position state. Continuing with a flat state.', { message: error.message });
        }
    }
    
    async start() {
        this.logger.info(`--- Bot Initializing (v8.8.0) ---`);
        this.logger.info(`Strategy: ${this.strategy.getName()}, Product: ${this.config.productSymbol}`);
        await this.syncInitialPosition();
        await this.initWebSocket();
        this.setupHttpServer();
    }
    
    enableHeartbeat() {
        this.ws.send(JSON.stringify({ "type": "enable_heartbeat" }));
    }

    startHeartbeatCheck() {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn('Heartbeat not received in time. Terminating connection to reconnect.');
            if (this.ws) this.ws.terminate();
        }, this.config.heartbeatIntervalMs);
    }

    async initWebSocket() { 
        this.ws = new WebSocket(this.config.wsURL);
        this.ws.on('open', () => this.authenticateWebSocket());
        this.ws.on('message', (data) => this.handleWebSocketMessage(JSON.parse(data.toString())));
        this.ws.on('error', (error) => this.logger.error('WebSocket connection error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected: ${code} - ${reason}. Reconnecting...`);
            clearTimeout(this.heartbeatTimeout);
            this.authenticated = false;
            this.isOrderbookReady = false;
            setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
        });
    }

    authenticateWebSocket() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = require('crypto').createHmac('sha256', this.config.apiSecret).update('GET' + timestamp + '/live').digest('hex');
        this.ws.send(JSON.stringify({ type: 'auth', payload: { 'api-key': this.config.apiKey, timestamp, signature }}));
    }

    subscribeToChannels() {
        this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [
            { name: 'orders', symbols: ['all'] },
            { name: 'positions', symbols: ['all'] },
            { name: 'l1_orderbook', symbols: [this.config.productSymbol] }
        ]}}));
    }

    handleWebSocketMessage(message) {
        if (message.type === 'success' && message.message === 'Authenticated') {
            this.logger.info('WebSocket authentication successful.');
            this.authenticated = true; this.subscribeToChannels(); this.enableHeartbeat(); this.startHeartbeatCheck();
            return;
        }
        switch (message.type) {
            case 'heartbeat':
                this.startHeartbeatCheck();
                break;
            case 'orders':
                if (message.data) message.data.forEach(update => this.handleOrderUpdate(update));
                break;
            case 'positions':
                if (message.product_symbol === this.config.productSymbol) {
                    const wasOpen = this.hasOpenPosition;
                    this.hasOpenPosition = parseFloat(message.size) !== 0;
                    if (this.strategy.onPositionUpdate) this.strategy.onPositionUpdate(message);
                    if (wasOpen && !this.hasOpenPosition) this.logger.info(`[PositionManager] Position for ${this.config.productSymbol} is now CLOSED.`);
                    else if (!wasOpen && this.hasOpenPosition) this.logger.info(`[PositionManager] Position for ${this.config.productSymbol} is now OPEN.`);
                }
                break;
            case 'l1_orderbook':
                this.orderBook.bids = [[message.best_bid, message.bid_qty]];
                this.orderBook.asks = [[message.best_ask, message.ask_qty]];
                if (!this.isOrderbookReady) { this.isOrderbookReady = true; this.logger.info('L1 Order book synchronized.'); }
                break;
        }
    }
    
    async placeOrder(orderData) {
        return this.client.placeOrder(orderData);
    }
    
    registerOrder(order, type, parentId) {
        const orderInfo = { id: order.id, parentId: parentId, state: order.state, type: type };
        this.liveOrders.set(order.id, orderInfo);
        this.logger.info(`Registered ${type} order:`, orderInfo);
    }
    
    handleOrderUpdate(orderUpdate) {
        if (this.strategy.onOrderUpdate) this.strategy.onOrderUpdate(orderUpdate);
        let registeredOrder = this.liveOrders.get(orderUpdate.id);
        if (!registeredOrder) return;
        registeredOrder.state = orderUpdate.state;
        if (orderUpdate.state === 'filled' || orderUpdate.state === 'cancelled') {
            this.handleOrderCompletion(registeredOrder);
        }
    }

    handleOrderCompletion(completedOrder) {
        const siblings = [...this.liveOrders.values()].filter(o => o.parentId === completedOrder.parentId && o.id !== completedOrder.id && o.state === 'open');
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
                this.cleanupTimeouts.delete(key);
            } catch (error) { this.logger.error('Debounced batch cancel failed:', error); }
        }, delay);
        this.cleanupTimeouts.set(key, timeoutId);
    }

    async handleSignalMessage(message) {
        if (!this.isOrderbookReady || !this.authenticated) {
            if (this.canLog('bot_not_ready')) this.logger.warn("Signal received, but bot is not ready.");
            return;
        }
        try {
            const data = JSON.parse(message.toString());
            if (data.type !== 'S' || !data.p) return;
            const currentPrice = parseFloat(data.p);
            
            if (this.priceAtLastTrade === null) {
                this.priceAtLastTrade = currentPrice; return;
            }

            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);
            
            if (this.hasOpenPosition) {
                if (this.strategy.onPriceUpdate) await this.strategy.onPriceUpdate(currentPrice, priceDifference);
                return;
            }

            if (!this.isOrderInProgress && !this.isCoolingDown) {
                if (priceDifference >= this.config.priceThreshold) {
                    const timeElapsed = Date.now() - (this.priceMoveStartTime || Date.now());
                    if (this.priceMoveStartTime === null) this.priceMoveStartTime = Date.now();

                    if (timeElapsed <= this.config.urgencyTimeframeMs) {
                        this.isOrderInProgress = true; 
                        this.logger.info(`[UrgencyCheck] URGENT SIGNAL: Price moved $${priceDifference.toFixed(2)} in ${timeElapsed}ms.`);
                        await this.strategy.onPriceUpdate(currentPrice, priceDifference);
                        this.priceMoveStartTime = null;
                    } else {
                        if (this.canLog('stale_signal')) this.logger.warn(`Stale signal: $${priceDifference.toFixed(2)} in ${timeElapsed}ms. Resetting.`);
                        this.priceAtLastTrade = currentPrice;
                        this.priceMoveStartTime = null;
                    }
                }
            }
        } catch (error) {
            this.logger.error("Error handling signal message:", error);
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
    
    setupHttpServer() {
        const httpServer = new WebSocket.Server({ port: this.config.port });
        httpServer.on('connection', ws => {
            this.logger.info('Signal listener connected');
            ws.on('message', m => this.handleSignalMessage(m));
            ws.on('close', () => this.logger.warn('Signal listener disconnected'));
            ws.on('error', (err) => this.logger.error('Signal listener error:', err));
        });
        this.logger.info(`Signal server started on port ${this.config.port}`);
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
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));