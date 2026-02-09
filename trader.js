// trader.js
// v72.2 - [PRODUCTION] Smart Strategy Loader + Startup Fix + Delta Orders/Positions
// Changes: Auto-resolves 'Tick' -> 'TickStrategy.js', Fixes Logger Crash

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'TickStrategy', // Default
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

// --- Smart Strategy Loader ---
// This block fixes the "MODULE_NOT_FOUND" error by trying both names
let StrategyClass;
try {
    // Attempt 1: Load exactly what is in config (e.g., "TickStrategy")
    StrategyClass = require(`./${config.strategy}.js`);
} catch (e) {
    try {
        // Attempt 2: If failed, try appending "Strategy" (e.g., "Tick" -> "TickStrategy")
        console.log(`[Loader] Standard load failed for '${config.strategy}'. Trying '${config.strategy}Strategy'...`);
        StrategyClass = require(`./${config.strategy}Strategy.js`);
        // Update config to match the found file for logging consistency
        config.strategy = `${config.strategy}Strategy`; 
    } catch (e2) {
        console.error(`\n[FATAL] CRITICAL ERROR: Could not load strategy.`);
        console.error(`1. Checked: ./${config.strategy}.js`);
        console.error(`2. Checked: ./${config.strategy}Strategy.js`);
        console.error(`Ensure the file exists and the name matches EXACTLY.\n`);
        process.exit(1);
    }
}

// --- Main Trading Bot Class ---
class TradingBot {
    constructor(config) {
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
        this.client = new DeltaClient(config, this.logger);

        // Initialize Strategy
        this.strategy = new StrategyClass(this);

        // WebSocket State
        this.internalWsServer = null; 
        this.deltaWs = null;          
        this.pingInterval = null;
        this.heartbeatTimeout = null;
    }

    async start() {
        this.logger.info(`Starting Delta Trader v72.2...`);
        this.logger.info(`Strategy Loaded: ${this.config.strategy}`);
        this.logger.info(`Product: ${this.config.productSymbol} (ID: ${this.config.productId})`);

        // 1. Setup Internal WebSocket Server (Listener -> Trader)
        this.setupInternalServer();

        // 2. Connect to Delta WebSocket (For Execution Updates)
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
                    
                    // Route data to Strategy
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
                
                if (msg.type === 'v2/ticker') {
                   // Ignore ticker
                } else if (msg.type === 'orders') {
                    this.handleOrderUpdate(msg);
                } else if (msg.type === 'positions') {
                    this.handlePositionUpdate(msg);
                }

            } catch (e) {
                // Squelch heartbeat/pong parse errors
            }
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
             
             // Lock Release Logic
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

    // --- Heartbeat Logic ---
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

    // --- Execution Methods ---
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
                // Safety Release
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
    // 1. Create a simple global logger for startup errors
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
                   
