// trader.js
// Version 13.0.1 - FINAL: Further log reduction. Moved frequent operational logs to debug level.

const WebSocket = require('ws');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Comprehensive Configuration ---
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
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    logLevel: process.env.LOG_LEVEL || 'info',
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
    urgencyTimeframeMs: parseInt(process.env.URGENCY_TIMEFRAME_MS || '1000'),
    pingIntervalMs: parseInt(process.env.PING_INTERVAL_MS || '30000'),
    heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '40000'),
    priceAggressionOffset: parseFloat(process.env.PRICE_AGGRESSION_OFFSET || '0.5'),
    takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET || '100.0'),
    stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET || '50.0'),
    momentumReversalThreshold: parseFloat(process.env.MOMENTUM_REVERSAL_THRESHOLD || '1.0'),
    trailAmount: parseFloat(process.env.TRAIL_AMOUNT || '20.0'),
    timeInForce: process.env.TIME_IN_FORCE || 'gtc',
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

class TradingBot {
    constructor(botConfig) {
        this.config = { ...botConfig };
        this.logger = logger;
        this.client = new DeltaClient(this.config.apiKey, this.config.apiSecret, this.config.baseURL, this.logger);
        
        this.ws = null; this.authenticated = false; this.priceAtLastTrade = null;
        this.isOrderInProgress = false; this.isCoolingDown = false;
        this.orderBook = { bids: [], asks: [] }; this.isOrderbookReady = false;
        this.hasOpenPosition = false; this.priceMoveStartTime = null;

        this.isStateSynced = false;
        this.pingInterval = null; this.heartbeatTimeout = null;
        this.managedOrders = new Map(); this.pendingOrders = new Map();

        try {
            const StrategyClass = require(`./strategies/${this.config.strategy}Strategy.js`);
            this.strategy = new StrategyClass(this);
            this.logger.info(`Successfully loaded strategy: ${this.strategy.getName()}`);
        } catch (e) {
            this.logger.error(`FATAL: Could not load strategy: ${e.message}`);
            process.exit(1);
        }
    }

    async start() {
        this.logger.info(`--- Bot Initializing (v13.0.1) ---`);
        this.logger.info(`Strategy: ${this.strategy.getName()}, Product: ${this.config.productSymbol}`);
        await this.syncPositionState();
        await this.initWebSocket();
        this.setupHttpServer();
    }
    
    startHeartbeat() {
        this.logger.debug('Starting heartbeat mechanism.'); // MOVED to debug
        this.resetHeartbeatTimeout();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
                this.logger.debug('Sent ping to server.');
            }
        }, this.config.pingIntervalMs);
    }

    resetHeartbeatTimeout() {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn('Heartbeat timeout! No pong received in time. Terminating connection.');
            if (this.ws) this.ws.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    stopHeartbeat() {
        this.logger.debug('Stopping heartbeat mechanism.'); // MOVED to debug
        clearTimeout(this.heartbeatTimeout);
        clearInterval(this.pingInterval);
    }

    async initWebSocket() { 
        this.ws = new WebSocket(this.config.wsURL);
        this.ws.on('open', () => this.authenticateWebSocket());
        this.ws.on('message', (data) => this.handleWebSocketMessage(JSON.parse(data.toString())));
        this.ws.on('error', (error) => this.logger.error('WebSocket error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected: ${code} - ${reason}. Reconnecting...`);
            this.stopHeartbeat();
            this.authenticated = false; this.isOrderbookReady = false;
            this.isStateSynced = false;
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
            this.logger.info('WebSocket authentication successful. Subscribing and starting heartbeat...');
            this.authenticated = true; 
            this.subscribeToChannels();
            this.startHeartbeat();
            this.syncPositionState(); 
            return;
        }

        if (message.type === 'pong') {
            this.logger.debug('Received pong from server.');
            this.resetHeartbeatTimeout();
            return;
        }

        switch (message.type) {
            case 'orders':
                if (message.data) message.data.forEach(update => this.handleOrderUpdate(update));
                break;
            case 'positions':
                if (!this.isStateSynced) {
                    this.logger.info('Initial position snapshot received. State is now fully synchronized.');
                    this.isStateSynced = true;
                }
                if (message.product_symbol === this.config.productSymbol) {
                    const wasOpen = this.hasOpenPosition;
                    this.hasOpenPosition = parseFloat(message.size) !== 0;

                    if (!wasOpen && this.hasOpenPosition) {
                        this.logger.warn(`[PositionManager-WS] POSITION OPENED or an existing position was detected. Size=${message.size}`);
                    } else if (wasOpen && !this.hasOpenPosition) {
                        this.logger.info(`[PositionManager-WS] POSITION for ${this.config.productSymbol} is now CLOSED.`);
                        this.startCooldown();
                    }

                    if (this.strategy.onPositionUpdate) this.strategy.onPositionUpdate(message);
                }
                break;
            case 'l1_orderbook':
                if (!this.isOrderbookReady) { this.isOrderbookReady = true; this.logger.debug('L1 Order book synchronized.'); } // MOVED to debug
                this.orderBook.bids = [[message.best_bid, message.bid_qty]];
                this.orderBook.asks = [[message.best_ask, message.ask_qty]];
                break;
        }
    }

    async handleSignalMessage(message) {
        if (!this.isStateSynced || !this.isOrderbookReady || !this.authenticated) {
            this.logger.debug('Ignoring signal: State not yet synchronized.');
            return;
        }

        try {
            const data = JSON.parse(message.toString());
            if (data.type !== 'S' || !data.p) return;
            const currentPrice = parseFloat(data.p);
            
            if (this.priceAtLastTrade === null) {
                this.priceAtLastTrade = currentPrice;
                return;
            }

            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);
            
            if (this.hasOpenPosition) {
                if (this.strategy.onPriceUpdate) await this.strategy.onPriceUpdate(currentPrice, priceDifference);
                return;
            }

            if (!this.isOrderInProgress && !this.isCoolingDown && priceDifference >= this.config.priceThreshold) {
                const timeElapsed = Date.now() - (this.priceMoveStartTime || Date.now());
                if (this.priceMoveStartTime === null) this.priceMoveStartTime = Date.now();

                if (timeElapsed <= this.config.urgencyTimeframeMs) {
                    this.logger.info(`[UrgencyCheck] URGENT SIGNAL: Price moved $${priceDifference.toFixed(2)} in ${timeElapsed}ms.`);
                    if (this.strategy.onPriceUpdate) await this.strategy.onPriceUpdate(currentPrice, priceDifference);
                    this.priceMoveStartTime = null;
                } else {
                    this.priceAtLastTrade = currentPrice;
                    this.priceMoveStartTime = null;
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
            this.priceAtLastTrade = null; 
            this.priceMoveStartTime = null;
            // ELIMINATED redundant log: this.logger.info('[StateManager] Cooldown finished. Resetting price reference.');
        }, this.config.cooldownSeconds * 1000);
    }
    
    setupHttpServer() {
        const httpServer = new WebSocket.Server({ port: this.config.port });
        httpServer.on('connection', ws => {
            this.logger.debug('Signal listener connected'); // MOVED to debug
            ws.on('message', m => this.handleSignalMessage(m));
            ws.on('close', () => this.logger.warn('Signal listener disconnected'));
            ws.on('error', (err) => this.logger.error('Signal listener error:', err));
        });
        this.logger.info(`Signal server started on port ${this.config.port}`);
    }
    
    async placeOrder(orderData) {
        return this.client.placeOrder(orderData);
    }

    async forceStateCorrection() {
        this.logger.warn('[StateManager] Forcing state correction via REST API sync.');
        await this.syncPositionState();
    }
    
    async syncPositionState() {
        this.logger.debug('[StateManager] Syncing position state via REST API...'); // MOVED to debug
        try {
            const response = await this.client.getPositions();
            const positions = response.result || [];
            const productPosition = positions.find(p => p.product_id === this.config.productId);
            
            const oldState = this.hasOpenPosition;
            if (productPosition && parseFloat(productPosition.size) !== 0) {
                this.hasOpenPosition = true;
                this.logger.debug(`[StateManager] REST Sync: Position found. Size: ${productPosition.size}.`); // MOVED to debug
            } else {
                this.hasOpenPosition = false;
                this.logger.debug(`[StateManager] REST Sync: No position found.`); // MOVED to debug
            }

            if (oldState !== this.hasOpenPosition) {
                this.logger.warn(`[StateManager] Position state changed after REST sync: ${oldState} -> ${this.hasOpenPosition}`);
                if (this.hasOpenPosition && this.strategy.onPositionUpdate) {
                     this.strategy.onPositionUpdate(productPosition);
                }
            }
            this.isStateSynced = true;
        } catch (error) {
            this.logger.error('[StateManager] CRITICAL: Failed to sync position state from REST API.', { message: error.message });
            this.isStateSynced = false;
        }
    }
    
    registerPendingOrder(clientOrderId, type = 'main') {/* ... */}
    confirmRegisteredOrder(clientOrderId, orderResult) {/* ... */}
    cancelPendingOrder(clientOrderId) {/* ... */}
    registerOrder(orderResult, type, clientOrderId) {/* ... */}

    handleOrderUpdate(orderUpdate) {
        if (this.pendingOrders.has(orderUpdate.client_order_id)) {
            this.confirmRegisteredOrder(orderUpdate.client_order_id, orderUpdate);
        }

        if (!this.managedOrders.has(orderUpdate.id)) return;

        const managedOrder = this.managedOrders.get(orderUpdate.id);
        const previousState = managedOrder.state;
        managedOrder.state = orderUpdate.state;

        // --- FIX: Logic simplified. The strategy is now responsible for bracket orders. ---
        if (managedOrder.type === 'main' && previousState !== 'filled' && orderUpdate.state === 'filled') {
            this.logger.info(`[OrderManager] Main order ${orderUpdate.id} filled.`);
            // No longer calling placeBracketOrders or placeStopLossOrder from here.
            // This prevents conflicts with strategies that create atomic orders.
        }

        if ((managedOrder.type === 'take_profit' || managedOrder.type === 'stop_loss') && previousState !== 'filled' && orderUpdate.state === 'filled') {
            this.logger.info(`[OrderManager] A bracket order ${orderUpdate.id} (${managedOrder.type}) was filled. This position is now closed.`);
            this.cancelSiblingOrders(orderUpdate);
        }
    }
    
    // NOTE: These functions are now effectively deprecated for the MomentumRiderStrategy,
    // but are kept for potential use by other, simpler strategies in the future.
    async placeStopLossOrder(mainOrder) { /* ... */ }
    async placeBracketOrders(mainOrder) { /* ... */ }

    async cancelSiblingOrders(filledOrder) {
        const managedOrder = this.managedOrders.get(filledOrder.id);
        if (!managedOrder || managedOrder.linkedOrders.size === 0) return;

        const orderIdsToCancel = Array.from(managedOrder.linkedOrders);
        this.logger.info(`[OrderManager] Cancelling sibling order(s): ${orderIdsToCancel.join(', ')}`);
        try {
            await this.client.batchCancelOrders(filledOrder.product_id, orderIdsToCancel);
            orderIdsToCancel.forEach(id => this.managedOrders.delete(id));
            this.managedOrders.delete(filledOrder.id);
        } catch(error) {
            this.logger.error(`[OrderManager] Failed to cancel sibling orders:`, { message: error.message });
        }
    }

    async safeCancelAll(productId) {
        try {
            this.logger.info(`[PositionManager] Attempting to cancel all orders for product ${productId}.`);
            await this.client.cancelAllOrders(productId);
            this.logger.info(`[PositionManager] All open orders for product ${productId} cancelled successfully.`);
        } catch (e) {
            let errorMessage = e.message;
            if (e.response && e.response.data) {
                errorMessage = JSON.stringify(e.response.data);
            }
            this.logger.error(`[PositionManager] Call to cancelAllOrders for product ${productId} failed.`, { message: errorMessage });
        }
    }
}

// --- Startup and Process Handlers ---
(async () => {
    try {
        validateConfig();
        const bot = new TradingBot(config);
        await bot.start();
        
        process.on('uncaughtException', async (err) => {
            logger.error('Uncaught Exception:', { message: err.message, stack: err.stack });
            if (bot) {
                logger.warn('Attempting to cancel all orders before emergency shutdown...');
                await bot.safeCancelAll(bot.config.productId);
            }
            process.exit(1);
        });

        process.on('unhandledRejection', async (reason) => {
            logger.error('Unhandled Rejection:', { reason });
            if (bot) {
                logger.warn('Attempting to cancel all orders before emergency shutdown...');
                await bot.safeCancelAll(bot.config.productId);
            }
            process.exit(1);
        });
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
