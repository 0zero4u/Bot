// trader.js
// Version 12.0.0 - FINAL: Corrected order_type payloads to align with V2 API spec.

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
        this.logger.info(`--- Bot Initializing (v12.0.0) ---`);
        this.logger.info(`Strategy: ${this.strategy.getName()}, Product: ${this.config.productSymbol}`);
        await this.syncPositionState();
        await this.initWebSocket();
        this.setupHttpServer();
    }
    
    startHeartbeat() {
        this.logger.info('Starting heartbeat mechanism.');
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
        this.logger.info('Stopping heartbeat mechanism.');
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

                    if (!wasOpen && this.hasOpenPosition) this.logger.warn(`[PositionManager-WS] POSITION OPENED. Size=${message.size}`);
                    else if (wasOpen && !this.hasOpenPosition) {
                        this.logger.info(`[PositionManager-WS] POSITION for ${this.config.productSymbol} is now CLOSED.`);
                        this.startCooldown();
                    }

                    if (this.strategy.onPositionUpdate) this.strategy.onPositionUpdate(message);
                }
                break;
            case 'l1_orderbook':
                if (!this.isOrderbookReady) { this.isOrderbookReady = true; this.logger.info('L1 Order book synchronized.'); }
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
            this.logger.info('[StateManager] Cooldown finished. Resetting price reference.');
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
    
    async placeOrder(orderData) {
        return this.client.placeOrder(orderData);
    }

    async forceStateCorrection() {
        this.logger.warn('[StateManager] Forcing state correction via REST API sync.');
        await this.syncPositionState();
    }
    
    async syncPositionState() {
        this.logger.info('[StateManager] Syncing position state via REST API...');
        try {
            const response = await this.client.getPositions();
            const positions = response.result || [];
            const productPosition = positions.find(p => p.product_id === this.config.productId);
            
            const oldState = this.hasOpenPosition;
            if (productPosition && parseFloat(productPosition.size) !== 0) {
                this.hasOpenPosition = true;
                this.logger.info(`[StateManager] REST Sync: Position found. Size: ${productPosition.size}.`);
            } else {
                this.hasOpenPosition = false;
                this.logger.info(`[StateManager] REST Sync: No position found.`);
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
    
    registerPendingOrder(clientOrderId, type = 'main') { /* ... */ }
    confirmRegisteredOrder(clientOrderId, orderResult) { /* ... */ }
    cancelPendingOrder(clientOrderId) { /* ... */ }
    registerOrder(orderResult, type, clientOrderId) { /* ... */ }

    handleOrderUpdate(orderUpdate) {
        if (this.pendingOrders.has(orderUpdate.client_order_id)) this.confirmRegisteredOrder(orderUpdate.client_order_id, orderUpdate);
        if (!this.managedOrders.has(orderUpdate.id)) return;

        const managedOrder = this.managedOrders.get(orderUpdate.id);
        const previousState = managedOrder.state;
        managedOrder.state = orderUpdate.state;

        if (managedOrder.type === 'main' && previousState !== 'filled' && orderUpdate.state === 'filled') {
            this.logger.info(`[OrderManager] Main order ${orderUpdate.id} filled.`);
            if (this.strategy.hasBracketOrders) this.placeBracketOrders(orderUpdate);
            else if (this.strategy.hasFailSafeStop) this.placeStopLossOrder(orderUpdate);
        }

        if ((managedOrder.type === 'take_profit' || managedOrder.type === 'stop_loss') && previousState !== 'filled' && orderUpdate.state === 'filled') {
            this.logger.info(`[OrderManager] Bracket order ${orderUpdate.id} (${managedOrder.type}) filled. Position closed.`);
            this.cancelSiblingOrders(orderUpdate);
        }
    }
    
    async placeStopLossOrder(mainOrder) {
        const side = mainOrder.side === 'buy' ? 'sell' : 'buy';
        const slPrice = this.strategy.lastCalculatedStopLoss;
        if (!slPrice) {
            this.logger.error('[OrderManager] CRITICAL: lastCalculatedStopLoss not set in strategy.');
            this.isOrderInProgress = false;
            return;
        }
        
        // --- FIX APPLIED ---
        const slOrder = { 
            product_id: mainOrder.product_id, 
            size: mainOrder.size, 
            side, 
            order_type: 'market_order', // ✅ Correct as per API docs
            stop_order_type: 'stop_loss_order',
            stop_price: slPrice.toString(), 
            stop_trigger_method: 'last_traded_price',
            reduce_only: true 
        };
        const clientOrderId = `sl-${uuidv4()}`;

        try {
            this.logger.info(`[OrderManager] Placing Fail-Safe SL: ${JSON.stringify(slOrder)}`);
            this.registerPendingOrder(clientOrderId, 'stop_loss');
            const slResponse = await this.placeOrder({ ...slOrder, client_order_id: clientOrderId });
            
            if (!slResponse.result) throw new Error(`SL order failed: ${JSON.stringify(slResponse)}`);
            this.logger.info(`[OrderManager] Placed SL (${slResponse.result.id}) order.`);

        } catch (error) {
            this.logger.error('[OrderManager] CRITICAL: Failed to place fail-safe SL.', { error: error.message });
            this.logger.warn('[OrderManager] Attempting emergency-exit due to failed SL placement.');
            await this.strategy.exitPosition();
        } finally {
            this.isOrderInProgress = false;
        }
    }

    async placeBracketOrders(mainOrder) {
        const side = mainOrder.side === 'buy' ? 'sell' : 'buy';
        const entryPrice = parseFloat(mainOrder.avg_fill_price);
        const tpPrice = mainOrder.side === 'buy' ? entryPrice + this.config.takeProfitOffset : entryPrice - this.config.takeProfitOffset;
        const slPrice = mainOrder.side === 'buy' ? entryPrice - this.config.stopLossOffset : entryPrice + this.config.stopLossOffset;

        // --- FIX APPLIED for Take-Profit Order ---
        const tpOrder = { product_id: mainOrder.product_id, size: mainOrder.size, side, order_type: 'limit_order', limit_price: tpPrice.toString(), reduce_only: true, post_only: true };
        // --- FIX APPLIED for Stop-Loss Order ---
        const slOrder = { product_id: mainOrder.product_id, size: mainOrder.size, side, order_type: 'market_order', stop_order_type: 'stop_loss_order', stop_price: slPrice.toString(), stop_trigger_method: 'last_traded_price', reduce_only: true };

        try {
            this.logger.info(`[OrderManager] Placing TP: ${JSON.stringify(tpOrder)}`);
            this.logger.info(`[OrderManager] Placing SL: ${JSON.stringify(slOrder)}`);
            const [tpResponse, slResponse] = await Promise.all([this.placeOrder(tpOrder), this.placeOrder(slOrder)]);
            if (!tpResponse.result || !slResponse.result) {
                 throw new Error(`One or both bracket orders failed. TP: ${JSON.stringify(tpResponse)} | SL: ${JSON.stringify(slResponse)}`);
            }
            this.logger.info(`[OrderManager] Placed TP (${tpResponse.result.id}) and SL (${slResponse.result.id}) orders.`);
            this.registerOrder(tpResponse.result, 'take_profit', uuidv4());
            this.registerOrder(slResponse.result, 'stop_loss', uuidv4());
            const managedMain = this.managedOrders.get(mainOrder.id);
            managedMain.linkedOrders.add(tpResponse.result.id).add(slResponse.result.id);
            this.managedOrders.get(tpResponse.result.id).linkedOrders.add(slResponse.result.id);
            this.managedOrders.get(slResponse.result.id).linkedOrders.add(tpResponse.result.id);
        } catch (error) {
            this.logger.error('[OrderManager] CRITICAL: Failed to place bracket orders.', { error: error.message });
        } finally {
            this.isOrderInProgress = false;
        }
    }

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
            this.logger.info(`[PositionManager] All open orders for product ${productId} cancelled.`);
        } catch (e) {
            let errorMessage = e.message;
            if (e.response && e.response.data) errorMessage = JSON.stringify(e.response.data);
            this.logger.error(`[PositionManager] cancelAllOrders for product ${productId} failed.`, { message: errorMessage });
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
            logger.warn('Attempting to cancel all orders before shutdown...');
            await bot.safeCancelAll(bot.config.productId);
            process.exit(1);
        });

        process.on('unhandledRejection', async (reason) => {
            logger.error('Unhandled Rejection:', { reason });
            logger.warn('Attempting to cancel all orders before shutdown...');
            await bot.safeCancelAll(bot.config.productId);
            process.exit(1);
        });
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
