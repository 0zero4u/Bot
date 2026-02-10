// trader.js
// v65.0 - 
// 

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Micro',
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
    orderSize: parseInt(process.env.ORDER_SIZE || '1'),
    leverage: process.env.DELTA_LEVERAGE || '50',
    logLevel: process.env.LOG_LEVEL || 'info',
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
    pingIntervalMs: parseInt(process.env.PING_INTERVAL_MS || '30000'),
    heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '40000'),
};

// --- Logging Setup ---
const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
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

function validateConfig() {
    const required = ['apiKey', 'apiSecret', 'leverage'];
    const missing = required.filter(key => !config[key]);
    if (missing.length > 0) {
        logger.error(`FATAL: Missing config: ${missing.join(', ')}`);
        process.exit(1);
    }
    logger.info(`API Key Loaded: ${config.apiKey.substring(0, 4)}...${config.apiKey.slice(-4)}`);
}
validateConfig();

class TradingBot {
    constructor(botConfig) {
        this.config = { ...botConfig };
        this.logger = logger;
        this.client = new DeltaClient(this.config.apiKey, this.config.apiSecret, this.config.baseURL, this.logger);

        this.ws = null; this.authenticated = false;
        this.isOrderInProgress = false;

        // [CRITICAL] Per-Asset Position Tracking
        // Format: { 'BTC': true, 'XRP': false }
        this.activePositions = {};

        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        
        // Initialize State
        this.targetAssets.forEach(asset => {
            this.activePositions[asset] = false;
        });

        this.isStateSynced = false;
        this.pingInterval = null; this.heartbeatTimeout = null;
        this.restKeepAliveInterval = null;

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
        this.logger.info(`--- Bot Initializing (v65.0 - Micro Production) ---`);
        await this.syncPositionState();
        await this.initWebSocket();
        this.setupHttpServer();
        this.startRestKeepAlive();
    }

    startRestKeepAlive() {
        if (this.restKeepAliveInterval) clearInterval(this.restKeepAliveInterval);
        this.restKeepAliveInterval = setInterval(async () => {
            try {
                await this.client.getWalletBalance();
            } catch (error) {
                this.logger.warn(`[Keep-Alive] Check Failed: ${error.message}`);
            }
        }, 25000);
    }

    // --- WebSocket Heartbeat ---
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
        this.logger.info(`Connecting to: ${this.config.wsURL}`);
        this.ws = new WebSocket(this.config.wsURL);

        this.ws.on('open', () => this.authenticateWebSocket());
        this.ws.on('message', (data) => this.handleWebSocketMessage(JSON.parse(data.toString())));
        this.ws.on('error', (error) => this.logger.error('WebSocket error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected: ${code} - ${reason}. Reconnecting...`);
            this.stopHeartbeat();
            this.authenticated = false;
            setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
        });
    }

    authenticateWebSocket() {
        const timestampNum = Math.floor(Date.now() / 1000);
        const timestampStr = timestampNum.toString();

        const signatureData = 'GET' + timestampStr + '/live';
        const signature = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update(signatureData)
            .digest('hex');

        const payload = {
            type: 'key-auth',
            payload: {
                'api-key': this.config.apiKey,
                timestamp: timestampStr,
                signature: signature
            }
        };

        this.ws.send(JSON.stringify(payload));
    }

    subscribeToChannels() {
        const symbols = this.targetAssets.map(asset => `${asset}USD`);
        this.logger.info(`Subscribing to Execution Channels: ${symbols.join(', ')}`);

        this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [
            // Track Orders (Fills)
            { name: 'orders', symbols: ['all'] },
            // Track Positions (Open/Close State)
            { name: 'positions', symbols: ['all'] },
            // Track Public Trades (Optional)
            { name: 'all_trades', symbols: symbols }
        ]}}));
    }

    handleWebSocketMessage(message) {
        // 1. Auth Handling
        if (
            (message.type === 'success' && message.message === 'Authenticated') ||
            (message.type === 'key-auth' && message.status === 'authenticated') ||
            (message.success === true && message.status === 'authenticated')
        ) {
            this.logger.info('✅ WebSocket AUTHENTICATED Successfully.');
            this.authenticated = true;
            this.subscribeToChannels();
            this.startHeartbeat();
            this.syncPositionState();
            return;
        }

        if (message.type === 'error' && !this.authenticated) {
            this.logger.error(`❌ AUTH FAILED. Error Code: ${message.error ? message.error.code : 'Unknown'}`);
        }

        if (message.type === 'pong') {
            this.resetHeartbeatTimeout();
            return;
        }

        // 2. Data Handling
        switch (message.type) {
            case 'orders':
                if (message.data) message.data.forEach(update => this.handleOrderUpdate(update));
                break;
                
            case 'positions':
                // Handle Position Updates (Array or Single Object)
                if (Array.isArray(message.data)) {
                    message.data.forEach(pos => this.handlePositionUpdate(pos));
                } else if (message.size !== undefined) {
                    this.handlePositionUpdate(message);
                }
                break;
        }
    }

    // --- State Management ---

    handlePositionUpdate(pos) {
        if (!pos.product_symbol) return;
        
        // Find which asset this update belongs to (e.g. BTCUSD -> BTC)
        const asset = this.targetAssets.find(a => pos.product_symbol.startsWith(a));
        
        if (asset) {
            const size = parseFloat(pos.size);
            const isOpen = size !== 0;

            // Update State Map
            if (this.activePositions[asset] !== isOpen) {
                this.activePositions[asset] = isOpen;
                this.logger.info(`[POS UPDATE] ${asset} is now ${isOpen ? 'OPEN' : 'CLOSED'} (Size: ${size})`);
            }
        }
    }

    async syncPositionState() {
        try {
            const response = await this.client.getPositions();
            const positions = response.result || [];
            
            // 1. Reset all to Closed
            this.targetAssets.forEach(a => this.activePositions[a] = false);

            // 2. Mark Open ones
            positions.forEach(pos => {
                const size = parseFloat(pos.size);
                if (size !== 0) {
                    const asset = this.targetAssets.find(a => pos.product_symbol.startsWith(a));
                    if (asset) {
                        this.activePositions[asset] = true;
                        this.logger.info(`[SYNC] Found OPEN position for ${asset}: ${size}`);
                    }
                }
            });
            
            this.isStateSynced = true;
            this.logger.info(`Position State Synced: ${JSON.stringify(this.activePositions)}`);
        } catch (error) {
            this.logger.error('Failed to sync position state:', error.message);
        }
    }

    /**
     * Helper: Checks if we have an open position for a specific asset.
     */
    hasOpenPosition(symbol) {
        if (symbol) {
            return this.activePositions[symbol] === true;
        }
        // Fallback: Check if ANY position is open
        return Object.values(this.activePositions).some(status => status === true);
    }

    // --- External Feed Handler (Binance) ---
    async handleSignalMessage(message) {
        if (!this.authenticated) return;

        try {
            const data = JSON.parse(message.toString());
            
            // [PAYLOAD ADAPTER] BINANCE LOW-LATENCY FEED
            // Comes from market_listener.js (Type 'B')
            if (data.type === 'B') {
                const asset = data.s; // e.g. 'BTC'
                
                // 1. Check if this is a target asset
                if (!this.targetAssets.includes(asset)) return;

                // 2. Format for MicroStrategy
                // { bids: [[Price, Vol]], asks: [[Price, Vol]] }
                const depthPayload = {
                    bids: [[ data.bb, data.bq ]], 
                    asks: [[ data.ba, data.aq ]]  
                };

                // 3. Inject into Strategy
                if (this.strategy.onDepthUpdate) {
                    await this.strategy.onDepthUpdate(asset, depthPayload);
                }
            }
            
        } catch (error) {
            this.logger.error("Error handling signal message:", error);
        }
    }
    
    setupHttpServer() {
        const httpServer = new WebSocket.Server({ port: this.config.port });
        httpServer.on('connection', ws => {
            this.logger.info('External Data Feed Connected (Binance)');
            ws.on('message', m => this.handleSignalMessage(m));
            ws.on('close', () => this.logger.warn('External Feed Disconnected'));
            ws.on('error', (err) => this.logger.error('Signal listener error:', err));
        });
        this.logger.info(`Internal Data Server running on port ${this.config.port}`);
    }
    
    async placeOrder(orderData) {
        return this.client.placeOrder(orderData);
    }
    
    handleOrderUpdate(orderUpdate) {
        if (orderUpdate.state === 'filled') {
            this.logger.info(`[Trader] Order ${orderUpdate.id} FILLED.`);
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
