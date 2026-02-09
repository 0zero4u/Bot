// trader.js
// v70.0 - [PRODUCTION] TickStrategy Orchestrator
// Features: Dual-Feed Routing (Trades + Depth), Signal Hygiene, Delta Execution

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

const DeltaClient = require('./client.js');

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'TickStrategy', // Default: TickStrategy v3.1
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
};

// --- Logging Setup ---
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

// --- Dynamic Strategy Loader ---
const strategies = {
    'Micro': require('./MicroStrategy'),
    'TickStrategy': require('./TickStrategy'),
    'OrderBookPressure': require('./OrderBookPressureStrategy'),
    'FastStrategy': require('./FastStrategy')
};

class TradingBot {
    constructor(config) {
        this.config = config;
        this.logger = logger;
        this.client = new DeltaClient(config, logger);
        
        this.isOrderInProgress = false;
        this.markPrices = new Map(); // Cache for fallback pricing
        
        // Initialize Strategy
        const StrategyClass = strategies[config.strategy] || strategies['TickStrategy'];
        this.strategy = new StrategyClass(this);
        
        logger.info(`Loaded Strategy: ${this.strategy.getName ? this.strategy.getName() : config.strategy}`);
    }

    async start() {
        logger.info('Starting Trading Bot...');
        
        // 1. Setup Internal WebSocket Server (Receives Gate.io Data)
        this.setupHttpServer();

        // 2. Initialize Delta Client (optional pre-checks can go here)
        logger.info('Bot initialization complete. Waiting for signals...');
    }

    /**
     * CORE ROUTING LOGIC
     * Routes Gate.io 'trade' and 'depth' events to the strategy.
     * Filters out incompatible Binance data if TickStrategy is active.
     */
    async handleSignalMessage(message) {
        try {
            // Parse message if string, else use as object
            const msg = (typeof message === 'string') ? JSON.parse(message) : message;

            // --- 1. REAL-TIME TRADES (High Priority) ---
            if (msg.type === 'trade') {
                const asset = msg.s;
                // Update Mark Price Cache (Fastest source)
                this.markPrices.set(asset, parseFloat(msg.p));

                if (this.strategy.onTradeUpdate) {
                    // msg: { type: 'trade', s: 'BTC', p: 50000, q: 0.5, side: 'buy' }
                    await this.strategy.onTradeUpdate(asset, msg);
                }
                return;
            }

            // --- 2. ORDER BOOK DEPTH (20ms) ---
            if (msg.type === 'depth') {
                const asset = msg.s;
                if (this.strategy.onDepthUpdate) {
                    // msg: { type: 'depth', s: 'BTC', bids: [...], asks: [...] }
                    await this.strategy.onDepthUpdate(asset, msg);
                }
                return;
            }

            // --- 3. BINANCE BOOKTICKER (Kill Switch) ---
            if (msg.type === 'B') {
                if (config.strategy === 'TickStrategy') {
                    // IGNORE: Binance BookTicker lacks depth data needed for Hawkes OBI
                    return; 
                }
                // Legacy strategies (MicroStrategy) might still use this
                if (this.strategy.onPriceUpdate) {
                    const mid = (msg.bb + msg.ba) / 2;
                    this.strategy.onPriceUpdate(msg.s, mid, 'binance');
                }
                return;
            }

        } catch (error) {
            // Squelch JSON parse errors to prevent log flooding on bad packets
            if (error instanceof SyntaxError) return;
            this.logger.error("Signal Error:", error);
        }
    }

    setupHttpServer() {
        const WebSocketServer = require('ws').Server;
        const wss = new WebSocketServer({ port: this.config.port });

        wss.on('connection', ws => {
            this.logger.info('Data Feed Connected (Gate.io Listener)');
            
            ws.on('message', m => this.handleSignalMessage(m));
            
            ws.on('close', () => this.logger.warn('Data Feed Disconnected'));
            
            ws.on('error', (err) => this.logger.error('Socket error:', err));
        });

        this.logger.info(`Internal Data Server running on port ${this.config.port}`);
    }

    /**
     * Helper: Get latest known price for an asset
     * Used by Strategy for Limit Order placement if Trade Feed is slightly delayed
     */
    getMarkPrice(symbol) {
        return this.markPrices.get(symbol) || 0;
    }

    /**
     * EXECUTION WRAPPER
     */
    async placeOrder(orderData) {
        if (this.isOrderInProgress) {
            // Fail-safe: Strategy should handle this, but double-check here
            return;
        }

        try {
            this.logger.info(`[ORDER] ${orderData.side.toUpperCase()} ${orderData.size} @ ${orderData.limit_price}`);
            
            const response = await this.client.placeOrder(orderData);
            
            if (response && response.success) {
                this.logger.info(`[SUCCESS] Order ID: ${response.result.id}`);
            } else {
                this.logger.error(`[FAIL] Exchange Response: ${JSON.stringify(response)}`);
            }
            return response;

        } catch (error) {
            this.logger.error(`[EXCEPTION] ${error.message}`);
        }
    }
}

// --- Start the Bot ---
(async () => {
    try {
        const bot = new TradingBot(config);
        await bot.start();
        
        // Keep process alive and handle crashes gracefully
        process.on('uncaughtException', async (err) => {
            logger.error('Uncaught Exception:', err);
            // Optional: process.exit(1) to restart via PM2
        });
        
        process.on('unhandledRejection', (reason, p) => {
            logger.error('Unhandled Rejection at Promise', p, 'reason:', reason);
        });

    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
    
