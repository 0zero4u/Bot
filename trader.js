const WebSocket = require('ws');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Advance', 
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
    // Note: productId in .env is overridden by Strategy logic, but kept here for fallback.
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL, 
    orderSize: parseInt(process.env.ORDER_SIZE || '1'),
    leverage: process.env.DELTA_LEVERAGE || '50',
    logLevel: process.env.LOG_LEVEL || 'info',
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
    pingIntervalMs: parseInt(process.env.PING_INTERVAL_MS || '30000'),
    heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '40000'),
    priceAggressionOffset: parseFloat(process.env.PRICE_AGGRESSION_OFFSET || '0.5'),
};

// --- Logging Setup ---
const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
        winston.format.timestamp(), 
        winston.format.errors({ stack: true }), 
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ 
            format: winston.format.combine(
                winston.format.colorize(), 
                winston.format.simple()
            ) 
        })
    ]
});

// --- Input Validation ---
function validateConfig() {
    const required = ['apiKey', 'apiSecret', 'leverage'];
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
        
        this.ws = null; this.authenticated = false;
        this.isOrderInProgress = false; 
        
        // DYNAMIC: Parse Target Assets from .env (e.g., XRP, BTC, ETH)
        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.logger.info(`Trading Targets (USDT): ${this.targetAssets.join(', ')}`);

        // DYNAMIC: Multi-Asset Orderbooks storage
        this.orderBooks = {};
        this.targetAssets.forEach(asset => {
            this.orderBooks[asset] = { bids: [], asks: [] };
        });

        this.hasOpenPosition = false;
        this.isStateSynced = false;
        this.pingInterval = null; this.heartbeatTimeout = null;
        this.managedOrders = new Map(); this.pendingOrders = new Map();

        // Load Strategy dynamically
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
        this.logger.info(`--- Bot Initializing (v11.0.0 - USDT Linear) ---`);
        this.logger.info(`Strategy: ${this.strategy.getName()}`);
        
        // 1. Check current positions on Delta
        await this.syncPositionState();
        
        // 2. Connect to Delta WebSocket for Prices & Order Updates
        await this.initWebSocket();
        
        // 3. Start Local WebSocket Server to listen for signals (market_listener.js)
        this.setupHttpServer();
    }
    
    // --- WebSocket Heartbeat (Keep-Alive) ---
    startHeartbeat() {
        this.resetHeartbeatTimeout();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, this.config.pingIntervalMs);
    }

    resetHeartbeatTimeout() {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn('Heartbeat timeout! No pong received. Terminating.');
            if (this.ws) this.ws.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    stopHeartbeat() {
        clearTimeout(this.heartbeatTimeout);
        clearInterval(this.pingInterval);
    }

    // --- WebSocket Connection ---
    async initWebSocket() { 
        this.ws = new WebSocket(this.config.wsURL);
        
        this.ws.on('open', () => this.authenticateWebSocket());
        this.ws.on('message', (data) => this.handleWebSocketMessage(JSON.parse(data.toString())));
        this.ws.on('error', (error) => this.logger.error('WebSocket error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected: ${code}. Reconnecting...`);
            this.stopHeartbeat();
            this.authenticated = false;
            setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
        });
    }

    authenticateWebSocket() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = require('crypto').createHmac('sha256', this.config.apiSecret).update('GET' + timestamp + '/live').digest('hex');
        this.ws.send(JSON.stringify({ type: 'auth', payload: { 'api-key': this.config.apiKey, timestamp, signature }}));
    }

    subscribeToChannels() {
        // UPDATED: Generate USDT symbols for Delta
        // Delta Linear Perps are usually "BTCUSDT", "XRPUSDT", etc.
        const symbols = this.targetAssets.map(asset => `${asset}USDT`);
        
        this.logger.info(`Subscribing to L1 Books: ${symbols.join(', ')}`);

        this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [
            { name: 'orders', symbols: ['all'] },
            { name: 'positions', symbols: ['all'] },
            { name: 'l1_orderbook', symbols: symbols }
        ]}}));
    }

    handleWebSocketMessage(message) {
        if (message.type === 'success' && message.message === 'Authenticated') {
            this.logger.info('WebSocket authenticated. Subscribing...');
            this.authenticated = true; 
            this.subscribeToChannels();
            this.startHeartbeat();
            this.syncPositionState(); 
            return;
        }

        if (message.type === 'pong') {
            this.resetHeartbeatTimeout();
            return;
        }

        switch (message.type) {
            case 'orders':
                if (message.data) message.data.forEach(update => this.handleOrderUpdate(update));
                break;
            
            case 'positions':
                if (message.size) {
                    this.hasOpenPosition = parseFloat(message.size) !== 0;
                    if (this.strategy.onPositionUpdate) this.strategy.onPositionUpdate(message);
                }
                break;
            
            case 'l1_orderbook':
                // DYNAMIC: Route L1 updates (e.g., XRPUSDT) to correct internal storage (XRP)
                // We check which of our target assets matches the start of the symbol
                const asset = this.targetAssets.find(a => message.symbol.startsWith(a));

                if (asset) {
                    // Update internal book for Strategy usage
                    this.orderBooks[asset] = {
                        bids: [[message.best_bid, message.bid_qty]],
                        asks: [[message.best_ask, message.ask_qty]]
                    };
                    
                    // Notify Strategy 
                    if (this.strategy.onOrderBookUpdate) {
                        this.strategy.onOrderBookUpdate(message.symbol, parseFloat(message.best_bid));
                    }
                }
                break;
        }
    }

    // --- Signal Handling from market_listener.js ---
    async handleSignalMessage(message) {
        if (!this.authenticated) return;

        try {
            const data = JSON.parse(message.toString());
            
            // Format: { type: 'S', s: 'XRP', p: 0.55, x: 'BINANCE' }
            if (data.type === 'S' && data.p) {
                const asset = data.s || 'BTC'; 
                const price = parseFloat(data.p);
                const source = data.x || 'UNKNOWN';
                
                // Only process if this asset is in our target list (e.g. XRP)
                if (this.targetAssets.includes(asset)) {
                    if (this.strategy.onPriceUpdate) {
                        await this.strategy.onPriceUpdate(asset, price, source);
                    }
                }
            }
        } catch (error) {
            this.logger.error("Error handling signal message:", error);
        }
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
    
    // --- Order Execution & Management ---
    
    async placeOrder(orderData) {
        return this.client.placeOrder(orderData);
    }

    async syncPositionState() {
        try {
            const response = await this.client.getPositions();
            const positions = response.result || [];
            const hasActive = positions.some(p => parseFloat(p.size) !== 0);
            this.hasOpenPosition = hasActive;
            
            this.isStateSynced = true;
            this.logger.info(`Position State Synced. Open Position: ${this.hasOpenPosition}`);
        } catch (error) {
            this.logger.error('Failed to sync position state:', error.message);
        }
    }
    
    registerPendingOrder(clientOrderId) { }
    confirmRegisteredOrder(clientOrderId, orderResult) { }
    cancelPendingOrder(clientOrderId) { }

    handleOrderUpdate(orderUpdate) {
        if (orderUpdate.state === 'filled') {
            this.logger.info(`[Trader] Order ${orderUpdate.id} FILLED on Delta.`);
        }
    }

    getOrderBook(asset) {
        return this.orderBooks[asset];
    }
    
    async safeCancelAll(productId) {
        try {
            await this.client.cancelAllOrders(productId);
        } catch (e) {
            this.logger.error(`CancelAll failed: ${e.message}`);
        }
    }
}

(async () => {
    try {
        const bot = new TradingBot(config);
        await bot.start();
        
        process.on('uncaughtException', async (err) => {
            logger.error('Uncaught Exception:', err);
            process.exit(1);
        });
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
