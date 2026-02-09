// trader.js
// v72.0 - [PRODUCTION] TickStrategy + Delta (Orders & Positions Channels)
// Changes: Removed Ticker, Added 'orders'/'positions' subscriptions ["all"]

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

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
        
        // State
        this.isOrderInProgress = false;
        this.positions = {}; // Tracks open size per asset { 'BTCUSD': 100 }
        this.markPrices = new Map();
        
        // Initialize Strategy
        const StrategyClass = strategies[config.strategy] || strategies['TickStrategy'];
        this.strategy = new StrategyClass(this);
        
        // Delta WS State
        this.ws = null;
        this.pingInterval = null;
        this.heartbeatTimeout = null;

        logger.info(`Loaded Strategy: ${this.strategy.getName ? this.strategy.getName() : config.strategy}`);
    }

    async start() {
        logger.info('Starting Trading Bot...');
        
        // 1. Setup Internal WebSocket Server (Receives Gate.io Data)
        this.setupHttpServer();

        // 2. Connect to Delta WebSocket (Execution & Positions)
        this.connectDeltaWebSocket();

        logger.info('Bot initialization complete.');
    }

    // ============================================================
    // 1. GATE.IO SIGNAL HANDLER (Internal Server)
    // ============================================================
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

    async handleSignalMessage(message) {
        try {
            const msg = (typeof message === 'string') ? JSON.parse(message) : message;

            // Update Mark Price Cache (From Gate.io Trade Feed)
            // Since we removed Delta Ticker, this is our primary price source now.
            if (msg.s && msg.p) this.markPrices.set(msg.s, parseFloat(msg.p));

            // --- STRATEGY ROUTING ---
            
            // 1. Trade Update (Gate.io)
            if (msg.type === 'trade') {
                if (this.strategy.onTradeUpdate) {
                    await this.strategy.onTradeUpdate(msg.s, msg);
                }
            }
            // 2. Depth Update (Gate.io)
            else if (msg.type === 'depth') {
                if (this.strategy.onDepthUpdate) {
                    await this.strategy.onDepthUpdate(msg.s, msg);
                }
            }
            // 3. Binance Backup (Ignore for TickStrategy)
            else if (msg.type === 'B' && this.config.strategy !== 'TickStrategy') {
                if (this.strategy.onPriceUpdate) {
                    const mid = (msg.bb + msg.ba) / 2;
                    this.strategy.onPriceUpdate(msg.s, mid, 'binance');
                }
            }

        } catch (error) {
            if (error instanceof SyntaxError) return;
            this.logger.error("Signal Error:", error);
        }
    }

    // ============================================================
    // 2. DELTA WEBSOCKET (Orders & Positions)
    // ============================================================
    connectDeltaWebSocket() {
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = crypto.createHmac('sha256', this.config.apiSecret)
            .update(`GET${timestamp}/users/connector`)
            .digest('hex');

        const authUrl = `${this.config.wsURL}?api_key=${this.config.apiKey}&timestamp=${timestamp}&signature=${signature}`;

        this.logger.info('Connecting to Delta Exchange WebSocket...');
        this.ws = new WebSocket(authUrl);

        this.ws.on('open', () => {
            this.logger.info('✓ Delta WebSocket Authenticated & Connected');
            this.heartbeat();
            
            // SUBSCRIBE: Orders & Positions (All Symbols)
            // As per your specific requirement to remove ticker and use "all"
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
            this.logger.info('✓ Subscribed to [orders, positions] for ["all"]');
        });

        this.ws.on('message', (data) => {
            this.heartbeat();
            try {
                const msg = JSON.parse(data);
                
                // --- A. HANDLE ORDERS (Manage Lock) ---
                if (msg.type === 'orders') {
                    // Normalize data (array or object)
                    const updates = Array.isArray(msg.data) ? msg.data : (msg.data ? [msg.data] : []);
                    
                    updates.forEach(order => {
                        // Unlock if order is finished
                        if (['filled', 'cancelled', 'closed', 'rejected'].includes(order.state)) {
                            this.logger.info(`[Delta] Order ${order.state.toUpperCase()}: ${order.symbol}`);
                            this.isOrderInProgress = false; 
                        }
                    });
                }

                // --- B. HANDLE POSITIONS (Manage State) ---
                if (msg.type === 'positions') {
                    // Positions stream usually sends the full position state or updates
                    const updates = Array.isArray(msg.data) ? msg.data : (msg.data ? [msg.data] : []);

                    updates.forEach(pos => {
                        // Delta sends 'size' (signed) or 'size' + 'entry_price'
                        // We track the size to know if we are exposed
                        if (pos.symbol) {
                            const newSize = parseFloat(pos.size);
                            this.positions[pos.symbol] = newSize;
                            this.logger.info(`[Delta] Position Update: ${pos.symbol} = ${newSize}`);
                        }
                    });
                }

            } catch (e) {
                // Ignore parsing errors for pings/keeps-alives
            }
        });

        this.ws.on('close', () => {
            this.logger.warn('Delta WS Disconnected. Reconnecting...');
            this.cleanupWs();
            setTimeout(() => this.connectDeltaWebSocket(), this.config.reconnectInterval);
        });

        this.ws.on('error', (err) => {
            this.logger.error('Delta WS Error:', err.message);
        });
    }

    heartbeat() {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn('Delta WS Heartbeat Timeout. Terminating...');
            if (this.ws) this.ws.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    cleanupWs() {
        clearTimeout(this.heartbeatTimeout);
        clearInterval(this.pingInterval);
    }

    // ============================================================
    // 3. EXECUTION (With Safety Locks)
    // ============================================================
    
    getMarkPrice(symbol) {
        return this.markPrices.get(symbol) || 0;
    }

    async placeOrder(orderData) {
        // 1. Global Lock
        if (this.isOrderInProgress) {
            this.logger.warn(`[Skip] Global Order Lock Active`);
            return;
        }

        // 2. Position Lock (Optional: Prevent stacking trades)
        // If strategy is HFT, you might want to only allow 1 trade at a time per asset.
        /*
        const currentSize = this.positions[this.config.productSymbol];
        if (currentSize && Math.abs(currentSize) > 0) {
             // Logic to block new entry if position exists?
             // For now, we trust the Strategy to manage logic.
        }
        */

        this.isOrderInProgress = true;

        try {
            this.logger.info(`[ORDER] ${orderData.side.toUpperCase()} ${orderData.size} @ ${orderData.limit_price}`);
            
            const response = await this.client.placeOrder(orderData);
            
            if (response && response.success) {
                this.logger.info(`[SUCCESS] Order ID: ${response.result.id}`);
                // Lock remains TRUE until WebSocket confirms 'filled/cancelled'
                // Safety release after 5s just in case WS misses the packet
                setTimeout(() => { 
                    if(this.isOrderInProgress) {
                        this.logger.warn("Auto-releasing Order Lock (Timeout)");
                        this.isOrderInProgress = false; 
                    }
                }, 5000);
            } else {
                this.logger.error(`[FAIL] ${JSON.stringify(response)}`);
                this.isOrderInProgress = false; // Release immediately on API error
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
    try {
        const bot = new TradingBot(config);
        await bot.start();
        
        process.on('uncaughtException', async (err) => {
            logger.error('Uncaught Exception:', err);
        });
        
        process.on('unhandledRejection', (reason, p) => {
            logger.error('Unhandled Rejection at Promise', p, 'reason:', reason);
        });

    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
