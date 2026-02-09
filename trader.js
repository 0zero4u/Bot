// trader.js
// v72.4 - [PRODUCTION] Smart Import Fix + Constructor Checkpoints
// Changes: Handles named exports vs default exports automatically.

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Check for client.js existence
if (!fs.existsSync('./client.js')) {
    console.error("[FATAL] 'client.js' not found in the same directory as trader.js");
    process.exit(1);
}
const DeltaClient = require('./client.js');

// --- Configuration ---
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

// --- Super-Smart Strategy Loader ---
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
                console.log(`[Loader] Found strategy file at: ${absolutePath}`);
                const loadedModule = require(absolutePath);
                
                // --- SMART IMPORT FIX ---
                // If the module is { TickStrategy: [Class] }, extract it.
                // If the module is [Class], use it directly.
                if (typeof loadedModule === 'function') {
                    return loadedModule;
                } else if (loadedModule[strategyName]) {
                    return loadedModule[strategyName];
                } else if (loadedModule.default) {
                    return loadedModule.default;
                } else {
                    // Try to find ANY class in the export
                    const keys = Object.keys(loadedModule);
                    if (keys.length > 0 && typeof loadedModule[keys[0]] === 'function') {
                        console.log(`[Loader] Guessing strategy class is '${keys[0]}'`);
                        return loadedModule[keys[0]];
                    }
                }
                throw new Error(`File found but could not identify a Class export.`);
            }
        } catch (e) {
            // Ignore and continue searching
        }
    }
    throw new Error(`Could not find '${strategyName}' in any standard directory.`);
}

try {
    StrategyClass = loadStrategy(config.strategy);
} catch (e) {
    console.error(`\n[FATAL] STRATEGY LOAD ERROR`);
    console.error(e.message);
    process.exit(1);
}

// --- Main Trading Bot Class ---
class TradingBot {
    constructor(config) {
        console.log("[Init] Initializing TradingBot..."); // Checkpoint 1
        this.config = config;
        this.isOrderInProgress = false;
        
        // Initialize Logger
        this.logger = winston.createLogger({
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

        // Initialize API Client
        console.log("[Init] Loading DeltaClient..."); // Checkpoint 2
        try {
            this.client = new DeltaClient(config, this.logger);
        } catch (err) {
            console.error("[FATAL] Failed to initialize DeltaClient:", err.message);
            throw err;
        }

        // Initialize Strategy
        console.log("[Init] Loading Strategy Instance..."); // Checkpoint 3
        try {
            this.strategy = new StrategyClass(this);
        } catch (err) {
            console.error("[FATAL] Failed to initialize Strategy:", err.message);
            console.error("Make sure your Strategy class constructor does not crash.");
            throw err;
        }
        
        console.log("[Init] Bot Ready."); // Checkpoint 4

        // WebSocket State
        this.internalWsServer = null; 
        this.deltaWs = null;          
        this.pingInterval = null;
        this.heartbeatTimeout = null;
    }

    async start() {
        this.logger.info(`Starting Delta Trader v72.4...`);
        this.logger.info(`Strategy Active: ${this.config.strategy}`);
        
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
            const method = 'POST';
            const path = '/v2/orders';
            const body = JSON.stringify(orderData);
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const signaturePayload = method + timestamp + path + body;
            const signature = crypto.createHmac('sha256', this.config.apiSecret).update(signaturePayload).digest('hex');

            const headers = {
                'Content-Type': 'application/json',
                'api-key': this.config.apiKey,
                'signature': signature,
                'timestamp': timestamp
            };

            const response = await this.client.post(path, orderData, headers);
            
            if (response && response.success) {
                this.logger.info(`[SUCCESS] Order ID: ${response.result.id}`);
                setTimeout(() => { 
                    if(this.isOrderInProgress) {
                        this.logger.warn("Auto-releasing Order Lock (Timeout)");
                        this.isOrderInProgress = false; 
                    }
                }, 5000);
            } else {
                this.logger.error(`[FAIL] ${JSON.stringify(response)}`);
                this.isOrderInProgress = false; 
            }
            return response;

        } catch (error) {
            this.logger.error(`[EXCEPTION] ${error.message}`);
            this.isOrderInProgress = false;
        }
    }
}

// --- Start the Bot ---
(async () => {
    const startupLogger = winston.createLogger({
        level: 'info',
        format: winston.format.simple(),
        transports: [new winston.transports.Console()]
    });

    try {
        const bot = new TradingBot(config);
        await bot.start();
        
        process.on('uncaughtException', async (err) => {
            startupLogger.error(`Uncaught Exception: ${err.message}`);
            console.error(err); 
        });
        
        process.on('unhandledRejection', (reason, p) => {
            startupLogger.error(`Unhandled Rejection: ${reason}`);
        });

    } catch (error) {
        startupLogger.error(`Failed to start bot: ${error.message}`);
        console.error(error); 
        process.exit(1);
    }
})();
                
