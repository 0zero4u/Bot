const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

// --- Rust Native Client ---
const { DeltaNativeClient } = require('fast-client');
const DeltaClient = DeltaNativeClient; 

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Tick',
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
        
        this.client = new DeltaClient(
            this.config.apiKey, 
            this.config.apiSecret, 
            this.config.baseURL
        );

        this.ws = null; 
        this.authenticated = false;
        this.isOrderInProgress = false;

        this.activePositions = {};
        this.orderLatencies = new Map(); 

        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        
        this.targetAssets.forEach(asset => {
            this.activePositions[asset] = false;
        });

        this.isStateSynced = false;
        this.pingInterval = null; 
        this.heartbeatTimeout = null;
        this.restKeepAliveInterval = null;

        // =========================================================
        // 🔥 OPTION B — ROBUST STRATEGY LOADER (FULLY SAFE)
        // =========================================================
        try {
            const cleanName = this.config.strategy
                .trim()
                .replace(/Strategy(\.js)?$/i, '')
                .replace(/\.js$/i, '');

            const strategyPath = path.resolve(
                __dirname,
                'strategies',
                `${cleanName}Strategy.js`
            );

            this.logger.info(`Loading Strategy from: ${strategyPath}`);

            const StrategyClass = require(strategyPath);

            if (typeof StrategyClass !== 'function') {
                throw new Error(
                    `Strategy does not export a class. Got: ${typeof StrategyClass}`
                );
            }

            this.strategy = new StrategyClass(this);

            if (typeof this.strategy.getName !== 'function') {
                throw new Error(
                    `Strategy missing required method getName()`
                );
            }

            this.logger.info(
                `✅ Successfully loaded strategy: ${this.strategy.getName()}`
            );

        } catch (e) {
            this.logger.error(`FATAL: Could not load strategy: ${e.message}`);
            process.exit(1);
        }
    }

    recordOrderPunch(clientOrderId) {
        this.orderLatencies.set(clientOrderId, Date.now());
        setTimeout(() => {
            if (this.orderLatencies.has(clientOrderId)) {
                this.orderLatencies.delete(clientOrderId);
            }
        }, 60000);
    }

    async start() {
        this.logger.info(`--- Bot Initializing (v69.0 - Strategy Safe Loader) ---`);

        try {
            await this.client.getWalletBalance();
            this.logger.info("🔥 Native connection warmed.");
        } catch (e) {
            this.logger.warn("Warmup failed (non-fatal).");
        }

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
                this.logger.warn(`[Keep-Alive] Failed: ${error}`);
            }
        }, 29000);
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
            this.logger.warn('Heartbeat timeout. Terminating.');
            if (this.ws) this.ws.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    stopHeartbeat() {
        clearTimeout(this.heartbeatTimeout);
        clearInterval(this.pingInterval);
    }

    async initWebSocket() {
        this.logger.info(`Connecting to: ${this.config.wsURL}`);
        this.ws = new WebSocket(this.config.wsURL);

        this.ws.on('open', () => this.authenticateWebSocket());
        this.ws.on('message', (data) => this.handleWebSocketMessage(JSON.parse(data.toString())));
        this.ws.on('error', (error) => this.logger.error('WebSocket error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`WebSocket disconnected: ${code} - ${reason}`);
            this.stopHeartbeat();
            this.authenticated = false;
            setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
        });
    }

    authenticateWebSocket() {
        const timestampStr = Math.floor(Date.now() / 1000).toString();
        const signatureData = 'GET' + timestampStr + '/live';

        const signature = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update(signatureData)
            .digest('hex');

        this.ws.send(JSON.stringify({
            type: 'key-auth',
            payload: {
                'api-key': this.config.apiKey,
                timestamp: timestampStr,
                signature: signature
            }
        }));
    }

    subscribeToChannels() {
        const symbols = this.targetAssets.map(asset => `${asset}USD`);

        this.ws.send(JSON.stringify({
            type: 'subscribe',
            payload: {
                channels: [
                    { name: 'orders', symbols: ['all'] },
                    { name: 'positions', symbols: ['all'] },
                    { name: 'all_trades', symbols: symbols },
                    { name: 'user_trades', symbols: ['all'] }
                ]
            }
        }));
    }

    handleWebSocketMessage(message) {
        if (
            (message.type === 'success' && message.message === 'Authenticated') ||
            (message.type === 'key-auth' && message.status === 'authenticated') ||
            (message.success === true && message.status === 'authenticated')
        ) {
            this.logger.info('✅ WebSocket AUTHENTICATED');
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

        if (message.type === 'user_trades') {
            this.measureLatency(message);
        }
    }

    measureLatency(trade) {
        const clientOid = trade.client_order_id;
        if (clientOid && this.orderLatencies.has(clientOid)) {
            const latency = Date.now() - this.orderLatencies.get(clientOid);
            this.logger.info(`[LATENCY] ${trade.symbol} | ${latency}ms`);
            this.orderLatencies.delete(clientOid);
        }
    }

    async syncPositionState() {
        try {
            const response = await this.client.getPositions();
            const positions = response.result || [];

            this.targetAssets.forEach(a => this.activePositions[a] = false);

            positions.forEach(pos => {
                const size = parseFloat(pos.size);
                if (size !== 0) {
                    const asset = this.targetAssets.find(a =>
                        pos.product_symbol.startsWith(a)
                    );
                    if (asset) this.activePositions[asset] = true;
                }
            });

            this.logger.info(`Position State Synced`);
        } catch (error) {
            this.logger.error(`Failed to sync position state: ${error}`);
        }
    }

    getPosition(symbol) {
        return this.activePositions[symbol];
    }

    async placeOrder(orderData) {
        if (orderData.client_order_id) {
            this.recordOrderPunch(orderData.client_order_id);
        }
        return this.client.placeOrder(orderData);
    }
}

(async () => {
    try {
        const bot = new TradingBot(config);
        await bot.start();
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
        
