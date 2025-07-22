// trader.js
// Version 11.2.0 - FINAL: Added state correction hook and robust error handling.

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

        // State Synchronization Flag to prevent trading on startup before the state is known.
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
        this.logger.info(`--- Bot Initializing (v11.2.0) ---`);
        this.logger.info(`Strategy: ${this.strategy.getName()}, Product: ${this.config.productSymbol}`);
        await this.initWebSocket();
        this.setupHttpServer();
    }
    
    // --- Heartbeat Logic ---
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

    // --- WebSocket and Server Setup ---
    async initWebSocket() { 
        this.ws = new WebSocket(this.config.wsURL);
        this.ws.on('open', () => this.authenticateWebSocket());
        this.ws.on('message', (data) => this.handleWebSocketMessage(JSON.parse(data.toString())));
        this.ws.on('error', (error) => this.logger.error('WebSocket error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected: ${code} - ${reason}. Reconnecting...`);
            this.stopHeartbeat();
            this.authenticated = false; this.isOrderbookReady = false;
            this.isStateSynced = false; // Reset the sync flag on disconnect
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
            return;
        }

        if (message.type === 'pong') {
            this.logger.debug('Received pong from server.');
            this.resetHeartbeatTimeout();
            return;
        }

        switch (message.type) {
            case 'orders':
                if (message.data) {
                    message.data.forEach(update => this.handleBracketManagement(update));
                }
                break;
            case 'positions':
                if (!this.isStateSynced) {
                    this.logger.info('Initial position snapshot received. State is now fully synchronized.');
                    this.isStateSynced = true; // Unlock the signal handler
                }
                if (message.product_symbol === this.config.productSymbol) {
                    const wasOpen = this.hasOpenPosition;
                    this.hasOpenPosition = parseFloat(message.size) !== 0;

                    if (!wasOpen && this.hasOpenPosition) {
                        this.logger.warn(`[PositionManager] POSITION OPENED or an existing position was detected. Size=${message.size}`);
                    } else if (wasOpen && !this.hasOpenPosition) {
                        this.logger.info(`[PositionManager] POSITION for ${this.config.productSymbol} is now CLOSED.`);
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
        // This gatekeeper prevents all trading until the bot knows its true position state.
        if (!this.isStateSynced || !this.isOrderbookReady || !this.authenticated) {
            this.logger.debug('Ignoring signal: State not yet synchronized with the exchange.');
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
            
            // This check now reliably knows the true position state from the WebSocket.
            if (this.hasOpenPosition) {
                if (this.strategy.onPriceUpdate) {
                    await this.strategy.onPriceUpdate(currentPrice, priceDifference);
                }
                return;
            }

            // This check now reliably knows the true cooldown state.
            if (!this.isOrderInProgress && !this.isCoolingDown) {
                if (priceDifference >= this.config.priceThreshold) {
                    const timeElapsed = Date.now() - (this.priceMoveStartTime || Date.now());
                    if (this.priceMoveStartTime === null) this.priceMoveStartTime = Date.now();

                    if (timeElapsed <= this.config.urgencyTimeframeMs) {
                        this.logger.info(`[UrgencyCheck] URGENT SIGNAL: Price moved $${priceDifference.toFixed(2)} in ${timeElapsed}ms.`);
                        if (this.strategy.onPriceUpdate) {
                            await this.strategy.onPriceUpdate(currentPrice, priceDifference);
                        }
                        this.priceMoveStartTime = null;
                    } else {
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
    
    async placeOrder(orderData) {
        return this.client.placeOrder(orderData);
    }

    // --- STATE CORRECTION HOOK ---
    // Called by a strategy if it receives an error indicating a state mismatch.
    forceStateCorrection() {
        if (!this.hasOpenPosition) {
            this.logger.warn('[StateManager] FORCING state correction. hasOpenPosition is now TRUE based on exchange feedback.');
            this.hasOpenPosition = true;
            // The next 'positions' websocket update will synchronize the full position details.
        }
    }

    // --- BRACKET ORDER MANAGEMENT LOGIC ---
    // This logic is for other strategies like BboBracketStrategy and is not actively
    // used by MomentumRiderStrategy, but is kept for modularity.
    registerPendingOrder(clientOrderId) {
        this.pendingOrders.set(clientOrderId, true);
        this.logger.info(`[OrderManager] Registered pending order with clientOrderId: ${clientOrderId}`);
    }

    confirmRegisteredOrder(clientOrderId, orderResult) {
        if (this.pendingOrders.has(clientOrderId)) {
            this.registerOrder(orderResult, 'main', clientOrderId);
            this.pendingOrders.delete(clientOrderId);
        }
    }
    
    cancelPendingOrder(clientOrderId) {
        if (this.pendingOrders.has(clientOrderId)) {
            this.pendingOrders.delete(clientOrderId);
            this.logger.warn(`[OrderManager] Canceled pending order registration for ${clientOrderId}`);
        }
    }

    registerOrder(orderResult, type, clientOrderId) {
        this.managedOrders.set(orderResult.id, {
            type: type, 
            clientOrderId: clientOrderId,
            state: orderResult.state,
            linkedOrders: new Set(),
        });
        this.logger.info(`[OrderManager] Registered managed order ${orderResult.id} of type '${type}'.`);
    }

    handleBracketManagement(orderUpdate) {
        if (this.pendingOrders.has(orderUpdate.client_order_id)) {
            this.confirmRegisteredOrder(orderUpdate.client_order_id, orderUpdate);
        }

        if (!this.managedOrders.has(orderUpdate.id)) return;

        const managedOrder = this.managedOrders.get(orderUpdate.id);
        const previousState = managedOrder.state;
        managedOrder.state = orderUpdate.state;

        if (managedOrder.type === 'main' && previousState !== 'filled' && orderUpdate.state === 'filled') {
            this.logger.info(`[OrderManager] Main order ${orderUpdate.id} filled.`);
            if (this.config.strategy.includes('BboBracket')) {
                this.logger.info(`[OrderManager] BboBracketStrategy detected. Attaching child TP/SL orders.`);
                this.placeBracketOrders(orderUpdate);
            }
        }

        if ((managedOrder.type === 'take_profit' || managedOrder.type === 'stop_loss') && previousState !== 'filled' && orderUpdate.state === 'filled') {
            this.logger.info(`[OrderManager] A bracket order ${orderUpdate.id} (${managedOrder.type}) was filled. This position is now closed.`);
            this.cancelSiblingOrders(orderUpdate);
        }
    }

    async placeBracketOrders(mainOrder) {
        const side = mainOrder.side === 'buy' ? 'sell' : 'buy';
        const entryPrice = parseFloat(mainOrder.avg_fill_price);
        const tpPrice = mainOrder.side === 'buy' ? entryPrice + this.config.takeProfitOffset : entryPrice - this.config.takeProfitOffset;
        const slPrice = mainOrder.side === 'buy' ? entryPrice - this.config.stopLossOffset : entryPrice + this.config.stopLossOffset;

        const tpOrder = {
            product_id: mainOrder.product_id, size: mainOrder.size, side,
            order_type: 'limit_order', limit_price: tpPrice.toString(),
            reduce_only: true, stop_order_type: 'take_profit_order',
        };
        const slOrder = {
            product_id: mainOrder.product_id, size: mainOrder.size, side,
            order_type: 'market_order', stop_price: slPrice.toString(),
            stop_order_type: 'stop_loss_order', reduce_only: true,
        };

        try {
            this.logger.info(`[OrderManager] Attempting to place TP with payload: ${JSON.stringify(tpOrder)}`);
            this.logger.info(`[OrderManager] Attempting to place SL with payload: ${JSON.stringify(slOrder)}`);
            
            const [tpResponse, slResponse] = await Promise.all([this.placeOrder(tpOrder), this.placeOrder(slOrder)]);

            if (tpResponse.result && slResponse.result) {
                this.logger.info(`[OrderManager] Placed TP (${tpResponse.result.id}) and SL (${slResponse.result.id}) orders.`);
                this.registerOrder(tpResponse.result, 'take_profit', uuidv4());
                this.registerOrder(slResponse.result, 'stop_loss', uuidv4());
                
                const managedMain = this.managedOrders.get(mainOrder.id);
                managedMain.linkedOrders.add(tpResponse.result.id);
                managedMain.linkedOrders.add(slResponse.result.id);
                this.managedOrders.get(tpResponse.result.id).linkedOrders.add(slResponse.result.id);
                this.managedOrders.get(slResponse.result.id).linkedOrders.add(tpResponse.result.id);
            } else {
                const tpError = !tpResponse.result ? JSON.stringify(tpResponse) : "Success";
                const slError = !slResponse.result ? JSON.stringify(slResponse) : "Success";
                throw new Error(`One or both bracket orders failed. TP Reason: ${tpError} | SL Reason: ${slError}`);
            }
        } catch (error) {
            this.logger.error('[OrderManager] CRITICAL: Failed to place bracket orders.', { error: error.message });
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

    // --- High-level, safe cancellation helper ---
    // This replaces direct client calls in strategies and shutdown hooks.
    async safeCancelAll(productId) {
        try {
            await this.client.cancelAllOrders(productId);
            this.logger.info(`[PositionManager] All open orders for product ${productId} cancelled cleanly.`);
        } catch (e) {
            this.logger.error(`[PositionManager] A call to cancelAllOrders for product ${productId} failed – manual check advised`, { message: e.message });
        }
    }
}

// --- Startup and Process Handlers ---
let bot; // Declare bot instance in a higher scope

(async () => {
    try {
        validateConfig();
        bot = new TradingBot(config); // Assign the instance
        await bot.start();
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();

// Hook into process exit events to attempt a clean shutdown.
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
});```

### `MomentumRiderStrategy (11).js`

The `tryEnterPosition` function's error handling is now enhanced. It specifically catches the `bracket_order_position_exists` error, calls the new `forceStateCorrection` method to prevent a loop, and logs other exchange rejections clearly.

```javascript
// strategies/MomentumRiderStrategy.js
// Version 5.4.0 - FINAL: Implemented reactive state correction for position mismatch errors.

const { v4: uuidv4 } = require('uuid');

class MomentumRiderStrategy {
    constructor(bot) {
        this.bot = bot;
        this.logger = bot.logger;
        this.position = null;
        this.isExitInProgress = false;
        this.lastEntrySignalPrice = null;
    }

    getName() { return "MomentumRiderStrategy"; }

    async onPriceUpdate(currentPrice, priceDifference) {
        if (this.position) {
            this.manageOpenPosition(currentPrice);
        } else {
            await this.tryEnterPosition(currentPrice);
        }
    }

    onPositionUpdate(positionUpdate) {
        const positionSize = parseFloat(positionUpdate.size);
        const positionIsOpen = positionSize !== 0;

        if (positionIsOpen && !this.position) {
            this.position = {
                side: positionSize > 0 ? 'buy' : 'sell',
                entryPrice: parseFloat(positionUpdate.entry_price),
                size: Math.abs(positionSize),
                peakPrice: this.lastEntrySignalPrice || parseFloat(positionUpdate.entry_price)
            };
            this.logger.info(`[${this.getName()}] POSITION SYNCED. Algorithmic trailing stop is now active.`, {
                entry: this.position.entryPrice,
                peak: this.position.peakPrice
            });
        
        } else if (!positionIsOpen && this.position) {
            this.logger.info(`[${this.getName()}] STRATEGY POSITION CLEARED.`);
            this.position = null;
            this.isExitInProgress = false;
            this.lastEntrySignalPrice = null;
        }
    }

    manageOpenPosition(currentPrice) {
        if (!this.position || this.isExitInProgress || !this.position.peakPrice) return;

        let drawdown = 0;
        if (this.position.side === 'buy') {
            if (currentPrice > this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = this.position.peakPrice - currentPrice;
        } else { 
            if (currentPrice < this.position.peakPrice) this.position.peakPrice = currentPrice;
            drawdown = currentPrice - this.position.peakPrice;
        }

        if (drawdown >= this.bot.config.momentumReversalThreshold) {
            this.logger.warn(`[${this.getName()}] ALGORITHMIC TRAILING STOP TRIGGERED! Peak: ${this.position.peakPrice}, Current: ${currentPrice}. Exiting.`);
            this.exitPosition();
        }
    }

    async tryEnterPosition(currentPrice) {
        this.bot.isOrderInProgress = true;
        try {
            const side = currentPrice > this.bot.priceAtLastTrade ? 'buy' : 'sell';
            
            if (!this.bot.isOrderbookReady || !this.bot.orderBook.bids?.[0]?.[0] || !this.bot.orderBook.asks?.[0]?.[0]) {
                throw new Error("Delta L1 order book is not ready. Cannot calculate a safe SL.");
            }

            const deltaReferencePrice = side === 'buy' 
                ? parseFloat(this.bot.orderBook.bids[0][0]) 
                : parseFloat(this.bot.orderBook.asks[0][0]);
            
            const stopLossPrice = side === 'buy' 
                ? deltaReferencePrice - this.bot.config.stopLossOffset 
                : deltaReferencePrice + this.bot.config.stopLossOffset;

            if (stopLossPrice <= 0) {
                this.logger.error(`[${this.getName()}] ABORTING: Invalid Stop-Loss Price (<=0) calculated from Delta BBO.`, { deltaReferencePrice, stopLossPrice });
                return;
            }
            
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.bot.config.orderSize, 
                side, 
                order_type: 'market_order',
                bracket_stop_loss_price: stopLossPrice.toString()
            };
            
            this.logger.info(`[${this.getName()}] Placing ATOMIC market order with fail-safe SL based on Delta BBO.`, {
                signalPrice: currentPrice,
                deltaBBO: deltaReferencePrice,
                stopLoss: stopLossPrice.toFixed(4)
            });
            this.lastEntrySignalPrice = currentPrice;
            
            const response = await this.bot.placeOrder(orderData);

            if (response.result) {
                this.logger.info(`[${this.getName()}] Atomic entry order placed successfully. Exchange is managing the fail-safe SL.`);
                this.bot.priceAtLastTrade = currentPrice;
            } else { 
                this.lastEntrySignalPrice = null;
                // Throw the raw response to be parsed by the catch block
                throw new Error(JSON.stringify(response)); 
            }
        } catch (error) {
            this.lastEntrySignalPrice = null; // Reset signal price on any error
            let response;
            try {
                response = JSON.parse(error.message);
            } catch (e) {
                this.logger.error(`[${this.getName()}] Unparseable or critical error during position entry:`, { message: error.message });
                return; // Can't analyze further
            }

            // --- REACTIVE FIX ---
            // Check for the specific error indicating a state mismatch
            if (response && response.error_code === 'bracket_order_position_exists') {
                this.logger.warn(`[${this.getName()}] State mismatch detected: Exchange reports an open position. Forcing state correction.`);
                this.bot.forceStateCorrection();
            } else {
                // Log any other legitimate rejections from the exchange
                this.logger.error(`[${this.getName()}] Exchange rejected order to enter position:`, { response });
            }
        } finally {
            this.bot.isOrderInProgress = false;
        }
    }

    async exitPosition() {
        if (!this.position || this.isExitInProgress) return;
        this.isExitInProgress = true;
        
        this.logger.warn(`[${this.getName()}] Algorithmic exit triggered. Cancelling all open orders for ${this.bot.config.productSymbol} to remove any hard SL.`);
        
        // Use the high-level, safe helper on the bot instance.
        await this.bot.safeCancelAll(this.bot.config.productId);
        this.logger.info(`[${this.getName()}] Proceeding with market exit order.`);

        const exitSide = this.position.side === 'buy' ? 'sell' : 'buy';
        try {
            const orderData = { 
                product_id: this.bot.config.productId, 
                size: this.position.size, 
                side: exitSide, 
                order_type: 'market_order',
                reduce_only: true 
            };
            const response = await this.bot.placeOrder(orderData);
            if (!response.result) {
                throw new Error(`Exchange rejected algorithmic exit order: ${JSON.stringify(response)}`);
            }
            this.logger.info(`[${this.getName()}] Algorithmic exit order to close position has been placed.`);
        } catch (error) {
            this.logger.error(`[${this.getName()}] CRITICAL: Failed to place algorithmic exit order. Manual intervention may be required.`, { message: error.message });
        }
    }
}
module.exports = MomentumRiderStrategy;