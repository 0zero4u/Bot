// trader.js
// v62.0 - [FIXED] Auth Response Handling & Deep Debug

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto'); 
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Advance', 
    port: parseInt(process.env.INTERNAL_WS_PORT || '80'),
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
    priceAggressionOffset: parseFloat(process.env.PRICE_AGGRESSION_OFFSET || '0.01'),
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
        
        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
        this.logger.info(`Trading Targets (USDT): ${this.targetAssets.join(', ')}`);

        this.hasOpenPosition = false;
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
        this.logger.info(`--- Bot Initializing (v62.0 - Auth Response Fix) ---`);
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
        // [DEBUG] Capture time exactly
        const timestampNum = Math.floor(Date.now() / 1000); 
        const timestampStr = timestampNum.toString(); 
        
        // 1. Generate Signature
        const signatureData = 'GET' + timestampStr + '/live';
        const signature = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update(signatureData)
            .digest('hex');

        this.logger.info(`[Auth Debug] Timestamp: ${timestampStr}`);
        this.logger.info(`[Auth Debug] Pre-Hash String: "${signatureData}"`);
        this.logger.info(`[Auth Debug] Signature: ${signature}`);

        // 2. Send Auth Payload
        const payload = { 
            type: 'key-auth', 
            payload: { 
                'api-key': this.config.apiKey, 
                timestamp: timestampStr, 
                signature: signature 
            }
        };

        this.logger.info(`[Auth Debug] Sending Payload: ${JSON.stringify(payload)}`);
        this.ws.send(JSON.stringify(payload));
    }

    subscribeToChannels() {
        const symbols = this.targetAssets.map(asset => `${asset}USD`);
        this.logger.info(`Subscribing to All Trades: ${symbols.join(', ')}`);
        
        this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [
            { name: 'orders', symbols: ['all'] },
            { name: 'positions', symbols: ['all'] },
            { name: 'all_trades', symbols: symbols }
        ]}}));
    }

    handleWebSocketMessage(message) {
        // [DEBUG] LOG EVERYTHING until authenticated
        if (!this.authenticated) {
            this.logger.info(`[WS RAW]: ${JSON.stringify(message)}`);
        }

        // [FIXED] Updated Success Check for V2 'key-auth' response
        // Accepts: { type: 'success', message: 'Authenticated' } OR { type: 'key-auth', status: 'authenticated' }
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
        
        // Handle Error
        if (message.type === 'error' && !this.authenticated) {
            this.logger.error(`❌ AUTH FAILED. Error Code: ${message.error ? message.error.code : 'Unknown'}`);
            this.logger.error(`❌ Message: ${message.message}`);
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
                if (Array.isArray(message.data)) {
                    message.data.forEach(pos => this.handlePositionUpdate(pos));
                } else if (message.size !== undefined) {
                    this.handlePositionUpdate(message);
                }
                break;
            case 'all_trades':
                const asset = this.targetAssets.find(a => message.symbol.startsWith(a));
                if (asset) {
                    const dataPoints = message.data || (Array.isArray(message) ? message : [message]);
                    if (Array.isArray(dataPoints)) {
                        const lastTrade = dataPoints[dataPoints.length - 1];
                        if (lastTrade && lastTrade.price) {
                             if (this.strategy.onTradeUpdate) {
                                this.strategy.onTradeUpdate(message.symbol, parseFloat(lastTrade.price));
                            }
                        }
                    } else if (message.price) {
                        if (this.strategy.onTradeUpdate) {
                            this.strategy.onTradeUpdate(message.symbol, parseFloat(message.price));
                        }
                    }
                }
                break;
        }
    }

    handlePositionUpdate(pos) {
        if (pos.size !== undefined && pos.size !== null) {
            this.hasOpenPosition = parseFloat(pos.size) !== 0;
            if (this.strategy.onPositionUpdate) {
                this.strategy.onPositionUpdate(pos);
            }
        }
    }

    async handleSignalMessage(message) {
        if (!this.authenticated) {
             const now = Date.now();
             if (!this._lastAuthWarn || now - this._lastAuthWarn > 10000) {
                 this.logger.warn('⚠️ Signal received but Bot is NOT Authenticated yet.');
                 this._lastAuthWarn = now;
             }
             return;
        }

        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'S' && data.p) {
                const asset = data.s || 'BTC'; 
                const price = parseFloat(data.p);
                const source = data.x || 'UNKNOWN';
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
    
    async placeOrder(orderData) {
        return this.client.placeOrder(orderData);
    }

    async syncPositionState() {
        try {
            const response = await this.client.getPositions();
            const positions = response.result || [];
            
            const myPosition = positions.find(p => p.product_id == this.config.productId);
            const currentSize = myPosition ? parseFloat(myPosition.size) : 0;
            
            this.hasOpenPosition = currentSize !== 0;
            this.isStateSynced = true;

            if (this.strategy.onPositionUpdate) {
                this.strategy.onPositionUpdate(myPosition || { size: 0 });
            }

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
                                    
