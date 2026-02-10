/**
 * trader.js
 * v73.0 - [PERFECT SYNC]
 * * FIX 1: Removed 'isOrderInProgress' blocker on data feed. 
 * Strategy must ALWAYS receive data to keep Welford stats fresh.
 * * FIX 2: Normalizes Position Symbols (removes '_USDT') so Strategy can find them.
 */

const WebSocket = require('ws');
const winston = require('winston');
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
    logLevel: process.env.LOG_LEVEL || 'info',
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
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
        `./strategies/${strategyName}.js`
    ];
    for (const relativePath of candidates) {
        try {
            const absolutePath = path.resolve(__dirname, relativePath);
            if (fs.existsSync(absolutePath)) {
                logger.info(`[Loader] Found strategy at: ${absolutePath}`);
                return require(absolutePath);
            }
        } catch (e) {}
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
        this.logger = logger; 
        
        // Store Positions Memory
        this.positions = {}; 

        try {
            this.client = new DeltaClient(config.apiKey, config.apiSecret, config.baseURL, logger); 
        } catch (err) {
            logger.error(`[FATAL] Client Init Failed: ${err.message}`);
            process.exit(1);
        }

        try {
            this.strategy = new StrategyClass(this);
        } catch (err) {
            logger.error(`[FATAL] Strategy Init Failed: ${err.message}`);
            process.exit(1);
        }

        this.internalWsServer = null; 
        this.deltaWs = null;          
        this.heartbeatTimeout = null;
    }

    async start() {
        this.logger.info(`Starting Delta Trader v73.0 [Sync Fix]...`);
        this.setupInternalServer();
        this.connectDeltaWebSocket();
    }

    /**
     * Helper for Strategy to check Position
     * Normalizes input symbol to match storage key (e.g. 'BTC' -> 'BTC')
     */
    getPosition(symbol) {
        // Strategy sends 'BTC', storage has 'BTC' (thanks to fix below)
        return this.positions[symbol] || 0.0;
    }
    
    hasOpenPosition(symbol) {
        const size = this.positions[symbol];
        return size && parseFloat(size) !== 0;
    }

    setupInternalServer() {
        this.internalWsServer = new WebSocket.Server({ port: this.config.port });
        this.internalWsServer.on('connection', (ws) => {
            this.logger.info(`Market Listener connected on port ${this.config.port}`);
            ws.on('message', async (message) => {
                // [FIX 1] REMOVED "if (this.isOrderInProgress) return;"
                // We MUST process data to keep Strategy Memory (Welford) fresh!
                // The Strategy itself handles the execution lock.
                try {
                    const data = JSON.parse(message);
                    if (this.strategy && typeof this.strategy.execute === 'function') {
                        await this.strategy.execute(data);
                    }
                } catch (e) {
                    this.logger.error(`Strategy Execution Error: ${e.message}`);
                }
            });
        });
    }

    connectDeltaWebSocket() {
        this.deltaWs = new WebSocket(this.config.wsURL);

        this.deltaWs.on('open', () => {
            this.logger.info('Connected to Delta Exchange WebSocket.');
            this.sendToDelta({ type: "enable_heartbeat" });
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
        this.sendToDelta({
            type: 'subscribe',
            payload: {
                channels: [
                    { name: 'orders', symbols: ['all'] },
                    { name: 'positions', symbols: ['all'] }
                ]
            }
        });
    }

    handleOrderUpdate(msg) {
        if(msg.data) {
             this.logger.info(`[ORDER] ${msg.data.status} | ${msg.data.side} ${msg.data.size}`);
             // Unlock on final states
             if (['filled', 'cancelled', 'closed'].includes(msg.data.status)) {
                 if (this.isOrderInProgress) {
                     this.isOrderInProgress = false;
                 }
             }
        }
    }

    /**
     * [FIX 2] Normalize Symbols in Position Storage
     * Delta sends "BTCUSDT" or "BTC_USDT". Strategy uses "BTC".
     * We strip "_USDT" and "USDT" to ensure keys match.
     */
    handlePositionUpdate(msg) {
        const updatePosition = (rawSymbol, size) => {
            // Normalize: BTCUSDT -> BTC, BTC_USDT -> BTC
            const cleanSymbol = rawSymbol.replace('_USDT', '').replace('USDT', '');
            
            // Only log changes
            if (this.positions[cleanSymbol] !== size) {
                this.positions[cleanSymbol] = size;
                if (size !== 0) {
                     this.logger.info(`[POS UPDATE] ${cleanSymbol} | Size: ${size}`);
                }
            } else {
                this.positions[cleanSymbol] = size;
            }
        };

        // Case 1: Snapshot
        if (msg.action === 'snapshot' && Array.isArray(msg.result)) {
            msg.result.forEach(pos => {
                const sym = pos.symbol || pos.product_symbol;
                updatePosition(sym, parseFloat(pos.size));
            });
            return;
        }

        // Case 2: Update
        const data = msg.data || msg; 
        if (data && (data.symbol || data.product_symbol) && data.size !== undefined) {
            const sym = data.symbol || data.product_symbol;
            updatePosition(sym, parseFloat(data.size));
        }
    }

    sendToDelta(data) {
        if (this.deltaWs && this.deltaWs.readyState === WebSocket.OPEN) {
            this.deltaWs.send(JSON.stringify(data));
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeat(); 
    }

    stopHeartbeat() {
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    }

    heartbeat() {
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn("Heartbeat Timeout (No Data). Reconnecting...");
            if (this.deltaWs) this.deltaWs.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    async placeOrder(orderData) {
        if (this.isOrderInProgress) {
            this.logger.warn("Order Blocked: Internal Lock Active.");
            return null;
        }
        this.isOrderInProgress = true;

        try {
            const response = await this.client.placeOrder(orderData);
            if (response && response.result) {
                this.logger.info(`[SUCCESS] Order ID: ${response.result.id}`);
                // Safety release in case socket update misses (5s timeout)
                setTimeout(() => { 
                    if(this.isOrderInProgress) {
                        this.isOrderInProgress = false; 
                    }
                }, 5000);
            } else {
                this.logger.error(`[FAIL] ${JSON.stringify(response)}`);
                this.isOrderInProgress = false; 
            }
            return response;
        } catch (error) {
            const errMsg = error.response ? JSON.stringify(error.response.body) : error.message;
            this.logger.error(`[EXCEPTION] Order Failed: ${errMsg}`);
            this.isOrderInProgress = false;
            return null;
        }
    }
}

// Start
(async () => {
    try {
        const bot = new TradingBot(config);
        await bot.start();
    } catch (error) {
        logger.error(`Failed to start bot: ${error.message}`);
        process.exit(1);
    }
})();
            
