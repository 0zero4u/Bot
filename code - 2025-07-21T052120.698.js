// trader.js
// Version 9.0.0 - FINAL PRODUCTION VERSION
// Relies on WebSocket snapshot for initial state sync, as per official documentation.

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
    
    async start() {
        this.logger.info(`--- Bot Initializing (v9.0.0) ---`);
        this.logger.info(`Strategy: ${this.strategy.getName()}, Product: ${this.config.productSymbol}`);
        // State will sync via WebSocket snapshot upon successful subscription.
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
        this.ws.on('message', (data) => {
            try { this.handleWebSocketMessage(JSON.parse(data.toString())); } 
            catch (error) { this.logger.error('WebSocket message parsing error:', error); }
        });
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
            this.logger.info('WebSocket authentication successful. Subscribing to channels...');
            this.authenticated = true; this.subscribeToChannels(); this.enableHeartbeat(); this.startHeartbeatCheck();
            return;
        }
        switch (message.type) {
            case 'heartbeat':
                this.startHeartbeatCheck();
                break;
            case 'orders':
                if (this.strategy.onOrderUpdate && message.data) {
                    message.data.forEach(update => this.strategy.onOrderUpdate(update));
                }
                break;
            case 'positions':
                // This handles both the initial snapshot and all subsequent position updates.
                if (message.product_symbol === this.config.productSymbol) {
                    const wasOpen = this.hasOpenPosition;
                    this.hasOpenPosition = parseFloat(message.size) !== 0;

                    if (wasOpen && !this.hasOpenPosition) this.logger.info(`[PositionManager] Position for ${this.config.productSymbol} is now CLOSED.`);
                    else if (!wasOpen && this.hasOpenPosition) this.logger.warn(`[PositionManager] Found EXISTING position on startup/reconnect: Size=${message.size}`);

                    if (this.strategy.onPositionUpdate) this.strategy.onPositionUpdate(message);
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

    async handleSignalMessage(message) {
        if (!this.isOrderbookReady || !this.authenticated) {
            if(this.canLog('bot_not_ready')) this.logger.warn("Signal received, but bot is not ready.");
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
            
            // The strategy is now responsible for handling price updates based on its internal state.
            if (this.strategy.onPriceUpdate) {
                await this.strategy.onPriceUpdate(currentPrice, priceDifference);
            }

        } catch (error) {
            this.logger.error("Error handling signal message:", error);
            this.isOrderInProgress = false; // Failsafe
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