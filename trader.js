// trader.js
// v62.0 - [FIXED] V2 Auth Success Detection

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto'); 
require('dotenv').config();

const DeltaClient = require('./client.js');

const config = {
    strategy: process.env.STRATEGY || 'Advance', 
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
    priceAggressionOffset: parseFloat(process.env.PRICE_AGGRESSION_OFFSET || '0.01'),
};

const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
        winston.format.timestamp(), 
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) })
    ]
});

class TradingBot {
    constructor(botConfig) {
        this.config = { ...botConfig };
        this.logger = logger;
        this.client = new DeltaClient(this.config.apiKey, this.config.apiSecret, this.config.baseURL, this.logger);
        this.ws = null; this.authenticated = false;
        this.isOrderInProgress = false; 
        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP').split(',');
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
        this.logger.info(`--- Bot Initializing (v62.0 - Final Fixes) ---`);
        await this.syncPositionState();
        await this.initWebSocket();
        this.setupHttpServer();
        this.startRestKeepAlive();
    }

    startRestKeepAlive() {
        if (this.restKeepAliveInterval) clearInterval(this.restKeepAliveInterval);
        this.restKeepAliveInterval = setInterval(async () => {
            try { await this.client.getWalletBalance(); } 
            catch (error) { this.logger.warn(`[Keep-Alive] Failed: ${error.message}`); }
        }, 25000); 
    }
    
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
            this.logger.warn('Heartbeat timeout! Terminating.');
            if (this.ws) this.ws.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    stopHeartbeat() {
        clearTimeout(this.heartbeatTimeout);
        clearInterval(this.pingInterval);
    }

    async initWebSocket() { 
        this.ws = new WebSocket(this.config.wsURL);
        this.ws.on('open', () => this.authenticateWebSocket());
        this.ws.on('message', (data) => this.handleWebSocketMessage(JSON.parse(data.toString())));
        this.ws.on('error', (err) => this.logger.error('WebSocket error:', err.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected. Reconnecting...`);
            this.stopHeartbeat();
            this.authenticated = false;
            setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
        });
    }

    authenticateWebSocket() {
        const timestampStr = Math.floor(Date.now() / 1000).toString(); 
        const signature = crypto.createHmac('sha256', this.config.apiSecret)
            .update('GET' + timestampStr + '/live').digest('hex');

        this.ws.send(JSON.stringify({ 
            type: 'key-auth', 
            payload: { 'api-key': this.config.apiKey, timestamp: timestampStr, signature }
        }));
    }

    subscribeToChannels() {
        const symbols = this.targetAssets.map(asset => `${asset}USD`);
        this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [
            { name: 'orders', symbols: ['all'] },
            { name: 'positions', symbols: ['all'] },
            { name: 'all_trades', symbols: symbols }
        ]}}));
    }

    handleWebSocketMessage(message) {
        // [FIXED] Recognizes Delta's V2 success response correctly
        if (
            (message.type === 'success' && message.message === 'Authenticated') || 
            message.status === 'authenticated' || 
            message.result === true
        ) {
            this.logger.info('✅ WebSocket AUTHENTICATED Successfully.');
            this.authenticated = true; 
            this.subscribeToChannels();
            this.startHeartbeat();
            this.syncPositionState(); 
            return;
        }
        
        if (message.type === 'error' && !this.authenticated) {
            this.logger.error(`❌ AUTH FAILED: ${JSON.stringify(message)}`);
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
                if (Array.isArray(message.data)) message.data.forEach(pos => this.handlePositionUpdate(pos));
                else if (message.size !== undefined) this.handlePositionUpdate(message);
                break;
            case 'all_trades':
                const asset = this.targetAssets.find(a => message.symbol.startsWith(a));
                if (asset) {
                    const dataPoints = message.data || (Array.isArray(message) ? message : [message]);
                    if (Array.isArray(dataPoints)) {
                        const lastTrade = dataPoints[dataPoints.length - 1];
                        if (lastTrade && lastTrade.price && this.strategy.onTradeUpdate) {
                            this.strategy.onTradeUpdate(message.symbol, parseFloat(lastTrade.price));
                        }
                    } else if (message.price && this.strategy.onTradeUpdate) {
                        this.strategy.onTradeUpdate(message.symbol, parseFloat(message.price));
                    }
                }
                break;
        }
    }

    handlePositionUpdate(pos) {
        if (pos.size !== undefined && pos.size !== null) {
            this.hasOpenPosition = parseFloat(pos.size) !== 0;
            if (this.strategy.onPositionUpdate) this.strategy.onPositionUpdate(pos);
        }
    }

    async handleSignalMessage(message) {
        if (!this.authenticated) return;
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'S' && data.p) {
                const asset = data.s || 'BTC'; 
                const price = parseFloat(data.p);
                if (this.targetAssets.includes(asset) && this.strategy.onPriceUpdate) {
                    await this.strategy.onPriceUpdate(asset, price, data.x || 'UNKNOWN');
                }
            }
        } catch (error) { this.logger.error("Signal error:", error); }
    }
    
    setupHttpServer() {
        const httpServer = new WebSocket.Server({ port: this.config.port });
        httpServer.on('connection', ws => {
            ws.on('message', m => this.handleSignalMessage(m));
        });
        this.logger.info(`Signal server started on port ${this.config.port}`);
    }
    
    async placeOrder(orderData) { return this.client.placeOrder(orderData); }

    async syncPositionState() {
        try {
            const response = await this.client.getPositions();
            const positions = response.result || [];
            const myPosition = positions.find(p => p.product_id == this.config.productId);
            this.hasOpenPosition = myPosition ? parseFloat(myPosition.size) !== 0 : false;
            this.isStateSynced = true;
            if (this.strategy.onPositionUpdate) this.strategy.onPositionUpdate(myPosition || { size: 0 });
            this.logger.info(`Position State Synced. Open: ${this.hasOpenPosition}`);
        } catch (error) { this.logger.error('Sync failed:', error.message); }
    }
    
    handleOrderUpdate(orderUpdate) {
        if (orderUpdate.state === 'filled') this.logger.info(`[Trader] Order ${orderUpdate.id} FILLED.`);
    }
}

(async () => {
    try {
        const bot = new TradingBot(config);
        await bot.start();
        process.on('uncaughtException', (err) => { logger.error('Uncaught Exception:', err); process.exit(1); });
    } catch (error) { logger.error("Start failed:", error); process.exit(1); }
})();
    
