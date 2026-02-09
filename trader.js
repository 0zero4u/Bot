// trader.js
// v72.6 - [PRODUCTION] Global Logger + Smart Loader + Client Fixes
// Fixes: 
// 1. Corrected DeltaClient instantiation arguments to prevent crash.
// 2. Updated placeOrder to use client's native method.

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Check for client.js
if (!fs.existsSync('./client.js')) {
    console.error("[FATAL] 'client.js' not found.");
    process.exit(1);
}
const DeltaClient = require('./client.js');

// --- CONFIGURATION ---
const config = {
    strategy: process.env.STRATEGY || 'TickStrategy',
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

// --- GLOBAL LOGGER ---
const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'trader.log' })
    ]
});

// --- SMART STRATEGY LOADER ---
let StrategyClass;
function loadStrategy(strategyName) {
    const candidates = [
        `./${strategyName}.js`,
        `../strategies/${strategyName}.js`,
        `./strategies/${strategyName}.js`,
        `./${strategyName}Strategy.js`,
        `../strategies/${strategyName}Strategy.js`
    ];

    for (const relativePath of candidates) {
        try {
            const absolutePath = path.resolve(__dirname, relativePath);
            if (fs.existsSync(absolutePath)) {
                logger.info(`[Loader] Found strategy at: ${absolutePath}`);
                const loadedModule = require(absolutePath);
                
                // Handle different export styles
                if (typeof loadedModule === 'function') return loadedModule;
                if (loadedModule[strategyName]) return loadedModule[strategyName];
                if (loadedModule.default) return loadedModule.default;
                
                // Guess first export
                const keys = Object.keys(loadedModule);
                if (keys.length > 0 && typeof loadedModule[keys[0]] === 'function') {
                    return loadedModule[keys[0]];
                }
            }
        } catch (e) { /* continue */ }
    }
    throw new Error(`Could not find '${strategyName}' in any standard directory.`);
}

try {
    StrategyClass = loadStrategy(config.strategy);
} catch (e) {
    logger.error(`[FATAL] STRATEGY LOAD ERROR: ${e.message}`);
    process.exit(1);
}

// --- MAIN TRADING BOT ---
class TradingBot {
    constructor(config) {
        this.config = config;
        this.isOrderInProgress = false;
        
        // Use the Global Logger
        this.logger = logger; 

        // Initialize API Client - FIXED ARGS
        try {
            this.client = new DeltaClient(
                config.apiKey, 
                config.apiSecret, 
                config.baseURL, 
                logger
            ); 
        } catch (err) {
            logger.error(`[FATAL] Client Init Failed: ${err.message}`);
            process.exit(1);
        }

        // Initialize Strategy
        try {
            this.strategy = new StrategyClass(this);
        } catch (err) {
            logger.error(`[FATAL] Strategy Init Failed: ${err.message}`);
            process.exit(1);
        }

        // WebSocket State
        this.internalWsServer = null; 
        this.deltaWs = null;          
        this.pingInterval = null;
        this.heartbeatTimeout = null;
    }

    async start() {
        this.logger.info(`Starting Delta Trader v72.6...`);
        this.logger.info(`Strategy: ${this.config.strategy}`);
        
        this.setupInternalServer();
        this.connectDeltaWebSocket();
    }

    // --- 1. Internal Server (Data Ingestion) ---
    setupInternalServer() {
        this.internalWsServer = new WebSocket.Server({ port: this.config.port });

        this.internalWsServer.on('connection', (ws) => {
            this.logger.info(`Market Listener connected on port ${this.config.port}`);

            ws.on('message', async (message) => {
                if (this.isOrderInProgress) return; 

                try {
                    const data = JSON.parse(message);
                    if (this.strategy && typeof this.strategy.execute === 'function') {
                        await this.strategy.execute(data);
                    }
                } catch (e) {
                    this.logger.error(`Strategy Execution Error: ${e.message}`);
                }
            });

            ws.on('error', (err) => {
                this.logger.error(`Internal WS Connection Error: ${err.message}`);
            });
        });

        this.internalWsServer.on('error', (err) => {
            this.logger.error(`Internal Server Error (Port ${this.config.port}): ${err.message}`);
            if (err.code === 'EADDRINUSE') {
                this.logger.error(`Port ${this.config.port} is already in use. Exiting.`);
                process.exit(1);
            }
        });
    }

    // --- 2. Delta WebSocket (Execution Updates) ---
    connectDeltaWebSocket() {
        this.deltaWs = new WebSocket(this.config.wsURL);

        this.deltaWs.on('open', () => {
            this.logger.info('Connected to Delta Exchange WebSocket.');
            this.startHeartbeat();
            this.subscribeDeltaChannels();
        });

        this.deltaWs.on('message', (data) => {
            this.heartbeat(); 
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'orders') {
                    this.handleOrderUpdate(msg);
                } else if (msg.type === 'positions') {
                    this.handlePositionUpdate(msg);
                }
            } catch (e) {}
        });

        this.deltaWs.on('close', () => {
            this.logger.warn('Delta WebSocket Disconnected. Reconnecting...');
            this.stopHeartbeat();
            setTimeout(() => this.connectDeltaWebSocket(), this.config.reconnectInterval);
        });

        this.deltaWs.on('error', (err) => {
            this.logger.error(`Delta WS Error: ${err.message}`);
        });
    }

    subscribeDeltaChannels() {
        const payload = {
            type: 'subscribe',
            payload: {
                channels: [
                    { name: 'orders', symbols: ['all'] },
                    { name: 'positions', symbols: ['all'] }
                ]
            }
        };
        this.sendToDelta(payload);
    }

    handleOrderUpdate(msg) {
        if(msg.data) {
             this.logger.info(`[ORDER UPDATE] ${msg.data.status} | ID: ${msg.data.id} | ${msg.data.side} ${msg.data.size}`);
             if (['filled', 'cancelled', 'closed'].includes(msg.data.status)) {
                 if (this.isOrderInProgress) {
                     this.logger.info("Order finalized. Releasing Lock.");
                     this.isOrderInProgress = false;
                 }
             }
        }
    }

    handlePositionUpdate(msg) {
        if(msg.data) {
            this.logger.info(`[POSITION UPDATE] ${msg.data.product_symbol} | Size: ${msg.data.size}`);
        }
    }

    sendToDelta(data) {
        if (this.deltaWs && this.deltaWs.readyState === WebSocket.OPEN) {
            this.deltaWs.send(JSON.stringify(data));
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.deltaWs && this.deltaWs.readyState === WebSocket.OPEN) {
                this.deltaWs.ping();
            }
        }, this.config.pingIntervalMs);
        this.heartbeat(); 
    }

    stopHeartbeat() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    }

    heartbeat() {
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn("Heartbeat Timeout. Terminating connection...");
            if (this.deltaWs) this.deltaWs.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    async placeOrder(orderData) {
        if (this.isOrderInProgress) {
            this.logger.warn("Order blocked: Internal Lock is active.");
            return null;
        }

        this.isOrderInProgress = true;

        try {
            // Updated to use Client's built-in method
            const response = await this.client.placeOrder(orderData);
            
            // Client.js returns the body object on success
            if (response && response.result) {
                this.logger.info(`[SUCCESS] Order ID: ${response.result.id}`);
                
                // Auto-release lock after short delay (safety net)
                setTimeout(() => { 
                    if(this.isOrderInProgress) {
                        this.logger.warn("Auto-releasing Order Lock (Safety Timeout)");
                        this.isOrderInProgress = false; 
                    }
                }, 5000);
            } else {
                this.logger.error(`[FAIL] ${JSON.stringify(response)}`);
                this.isOrderInProgress = false; 
            }
            return response;

        } catch (error) {
            // Log full error details
            const errMsg = error.response ? JSON.stringify(error.response.body) : error.message;
            this.logger.error(`[EXCEPTION] Order Failed: ${errMsg}`);
            this.isOrderInProgress = false;
            return null;
        }
    }
}

// --- STARTUP LOGIC ---
(async () => {
    try {
        const bot = new TradingBot(config);
        await bot.start();
        
        process.on('uncaughtException', async (err) => {
            logger.error(`Uncaught Exception: ${err.message}`);
            console.error(err); 
        });
        
        process.on('unhandledRejection', (reason, p) => {
            logger.error(`Unhandled Rejection: ${reason}`);
        });

    } catch (error) {
        logger.error(`Failed to start bot: ${error.message}`);
        console.error(error); 
        process.exit(1);
    }
})();

