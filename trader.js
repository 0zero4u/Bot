// trader.js
// v75.Dynamic - [PRODUCTION] High-Performance Engine + Folder-Based Strategy Loading
// Retains v75 WebSocket logic & Order Lock + v71 Dynamic strategy pathing.

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Tick', // e.g., 'Tick', 'Advance', 'Fast'
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
    orderSize: process.env.ORDER_SIZE || '1',
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
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'trader.log' })
    ]
});

class TradingBot {
    constructor(config) {
        this.config = config;
        this.logger = logger;
        this.client = new DeltaClient(config, logger);
        
        // State Management
        this.isOrderInProgress = false;
        this.positions = {}; 
        this.markPrices = new Map();
        
        // --- v71 DYNAMIC STRATEGY LOADER ---
        try {
            // This logic allows you to switch strategies in .env without changing code
            // It expects files to be in the /strategies folder
            const StrategyPath = `./strategies/${this.config.strategy}Strategy.js`;
            const StrategyClass = require(StrategyPath);
            this.strategy = new StrategyClass(this);
            logger.info(`✓ Successfully loaded strategy: ${this.config.strategy}Strategy`);
        } catch (err) {
            logger.error(`CRITICAL ERROR: Failed to load strategy file. Ensure the file exists in /strategies/ folder.`);
            logger.error(`Error Details: ${err.message}`);
            process.exit(1);
        }
        
        this.ws = null;
        this.heartbeatTimeout = null;
    }

    async start() {
        logger.info('Initializing System...');
        this.setupInternalServer();
        this.connectDeltaWebSocket();
    }

    // --- 1. SIGNAL RECEIVER (v75 Logic) ---
    setupInternalServer() {
        const WebSocketServer = require('ws').Server;
        const wss = new WebSocketServer({ port: this.config.port });

        wss.on('connection', ws => {
            this.logger.info('Listener Feed Connected.');
            ws.on('message', m => this.handleSignalMessage(m));
        });
        this.logger.info(`Data Server listening on port ${this.config.port}`);
    }

    async handleSignalMessage(message) {
        try {
            const msg = JSON.parse(message);

            // Update local mark prices for calculations
            if (msg.s && msg.p) this.markPrices.set(msg.s, parseFloat(msg.p));

            // Route to Dynamic Strategy
            if (msg.type === 'trade' && this.strategy.onTradeUpdate) {
                await this.strategy.onTradeUpdate(msg.s, msg);
            } else if (msg.type === 'depth' && this.strategy.onDepthUpdate) {
                await this.strategy.onDepthUpdate(msg.s, msg);
            }
        } catch (error) {
            this.logger.error("Signal Error:", error);
        }
    }

    // --- 2. DELTA PRIVATE WS (v75 Logic - Orders/Positions) ---
    connectDeltaWebSocket() {
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = crypto.createHmac('sha256', this.config.apiSecret)
            .update(`GET${timestamp}/users/connector`)
            .digest('hex');

        const authUrl = `${this.config.wsURL}?api_key=${this.config.apiKey}&timestamp=${timestamp}&signature=${signature}`;
        this.ws = new WebSocket(authUrl);

        this.ws.on('open', () => {
            this.logger.info('✓ Delta Private Channel Connected');
            this.heartbeat();
            
            const payload = {
                "type": "subscribe",
                "payload": {
                    "channels": [
                        { "name": "orders", "symbols": ["all"] },
                        { "name": "positions", "symbols": ["all"] }
                    ]
                }
            };
            this.ws.send(JSON.stringify(payload));
        });

        this.ws.on('message', (data) => {
            this.heartbeat();
            try {
                const msg = JSON.parse(data);
                
                // v75 Order Locking Logic: Unlocks when order reaches final state
                if (msg.type === 'orders') {
                    const updates = Array.isArray(msg.data) ? msg.data : [msg.data];
                    updates.forEach(order => {
                        if (['filled', 'cancelled', 'closed', 'rejected'].includes(order.state)) {
                            this.logger.info(`[WS] Order ${order.state.toUpperCase()} for ${order.symbol}`);
                            this.isOrderInProgress = false; 
                        }
                    });
                }

                if (msg.type === 'positions') {
                    const updates = Array.isArray(msg.data) ? msg.data : [msg.data];
                    updates.forEach(pos => {
                        if (pos.symbol) this.positions[pos.symbol] = parseFloat(pos.size);
                    });
                }
            } catch (e) {}
        });

        this.ws.on('close', () => {
            this.logger.warn('Delta WS Closed. Reconnecting...');
            setTimeout(() => this.connectDeltaWebSocket(), this.config.reconnectInterval);
        });
    }

    heartbeat() {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            if (this.ws) this.ws.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    // --- 3. ORDER EXECUTION ---
    async placeOrder(orderData) {
        if (this.isOrderInProgress) {
            this.logger.debug("Order skipped: Lock active.");
            return;
        }

        this.isOrderInProgress = true;
        try {
            const response = await this.client.placeOrder(orderData);
            
            if (response && response.success) {
                this.logger.info(`[ORDER SENT] ID: ${response.result.id}`);
                // Safety release in case WebSocket misses a message
                setTimeout(() => { this.isOrderInProgress = false; }, 5000);
            } else {
                this.logger.error(`[ORDER FAILED] ${JSON.stringify(response)}`);
                this.isOrderInProgress = false;
            }
            return response;
        } catch (error) {
            this.logger.error(`[ORDER EXCEPTION] ${error.message}`);
            this.isOrderInProgress = false;
        }
    }
}

// --- Bootstrap ---
(async () => {
    const bot = new TradingBot(config);
    await bot.start();
    
    process.on('uncaughtException', (err) => logger.error('Critical Uncaught Exception:', err));
    process.on('unhandledRejection', (reason) => logger.error('Unhandled Rejection:', reason));
})();
                                                           
