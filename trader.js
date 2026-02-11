/**
 * trader.js
 * v68.0 [ALL_TRADES FIXED + LATENCY TRACKING]
 * 1. Protocol: Supports market_listener v4.0 'depthUpdate' AND 'B' types.
 * 2. Execution: Uses Rust Native Client.
 * 3. Correction: Routes 'all_trades' to strategy for Kalman Filter correction.
 */

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

// --- Rust Native Client Integration ---
// Fallback if fast-client is missing during dev, but required for prod
let DeltaClient;
try {
    const { DeltaNativeClient } = require('fast-client');
    DeltaClient = DeltaNativeClient;
} catch (e) {
    console.warn("Native client not found, please ensure 'fast-client' is installed.");
    process.exit(1);
}

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Lead', // Default to Lead Strategy
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
    // These are general defaults; strategy defines specific assets
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

// --- Validation ---
function validateConfig() {
    const required = ['apiKey', 'apiSecret'];
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
        
        // Initialize Rust Client
        this.client = new DeltaClient(
            this.config.apiKey, 
            this.config.apiSecret, 
            this.config.baseURL
        );

        this.ws = null; 
        this.authenticated = false;

        // Position & Latency Tracking
        this.activePositions = {};
        this.orderLatencies = new Map(); 

        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL').split(',');
        
        // Initialize State
        this.targetAssets.forEach(asset => {
            this.activePositions[asset] = false;
        });

        this.isStateSynced = false;
        this.pingInterval = null; 
        this.heartbeatTimeout = null;
        this.restKeepAliveInterval = null;

        // Load Strategy
        try {
            const StrategyClass = require(`./strategies/${this.config.strategy}Strategy.js`);
            this.strategy = new StrategyClass(this);
            this.logger.info(`Successfully loaded strategy: ${this.strategy.getName()}`);
        } catch (e) {
            this.logger.error(`FATAL: Could not load strategy: ${e.message}`);
            process.exit(1);
        }
    }

    // --- Latency Helper ---
    recordOrderPunch(clientOrderId) {
        // Record T0: The moment we decided to send
        this.orderLatencies.set(clientOrderId, Date.now());
        
        // Auto-cleanup after 60s
        setTimeout(() => {
            if (this.orderLatencies.has(clientOrderId)) {
                this.orderLatencies.delete(clientOrderId);
            }
        }, 60000);
    }

    async start() {
        this.logger.info(`--- Bot Initializing (v68.0 - All Trades Fix) ---`);

        // --- 1. WARM UP CONNECTION ---
        this.logger.info("🔥 Warming up Rust Native Connection...");
        try {
            await this.client.getWalletBalance();
            this.logger.info("🔥 Connection Warmed. Native Socket is open.");
        } catch (e) {
            this.logger.warn("Warmup failed (non-fatal), continuing...");
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
                // Periodically fetch balance to keep Rust TCP pool active
                await this.client.getWalletBalance();
            } catch (error) {
                this.logger.warn(`[Keep-Alive] Check Failed: ${error}`);
            }
        }, 29000);
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
        const timestampNum = Math.floor(Date.now() / 1000);
        const timestampStr = timestampNum.toString();

        const signatureData = 'GET' + timestampStr + '/live';
        const signature = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update(signatureData)
            .digest('hex');

        const payload = {
            type: 'key-auth',
            payload: {
                'api-key': this.config.apiKey,
                timestamp: timestampStr,
                signature: signature
            }
        };

        this.ws.send(JSON.stringify(payload));
    }

    subscribeToChannels() {
        const symbols = this.targetAssets.map(asset => `${asset}USD`); // Adjust based on Delta format (e.g. BTCUSD or BTCUSDT)
        this.logger.info(`Subscribing to Execution Channels: ${symbols.join(', ')}`);

        this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [
            { name: 'orders', symbols: ['all'] },
            { name: 'positions', symbols: ['all'] },
            { name: 'all_trades', symbols: symbols },
            { name: 'user_trades', symbols: ['all'] } 
        ]}}));
    }

    handleWebSocketMessage(message) {
        // 1. Auth Handling
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

        if (message.type === 'error' && !this.authenticated) {
            this.logger.error(`❌ AUTH FAILED. Error Code: ${message.error ? message.error.code : 'Unknown'}`);
        }

        if (message.type === 'pong') {
            this.resetHeartbeatTimeout();
            return;
        }

        // 2. Data Handling
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
            
            // [CRITICAL FIX] Handle Public Trades for Kalman Correction
            case 'all_trades':
                if (this.strategy.onLaggerTrade) {
                    // Normalize data: Delta sometimes sends single object, sometimes array in 'data', sometimes implicit
                    let trades = [];
                    if (Array.isArray(message.data)) {
                        trades = message.data;
                    } else if (message.symbol && message.price) {
                        trades = [message];
                    } else if (message.data && message.data.price) {
                        trades = [message.data];
                    }

                    // Enforce symbol presence
                    trades.forEach(trade => {
                        // Inherit symbol from parent if missing in trade object
                        if (!trade.symbol && message.symbol) {
                            trade.symbol = message.symbol;
                        }
                        this.strategy.onLaggerTrade(trade);
                    });
                }
                break;

            case 'user_trades':
                this.measureLatency(message);
                break;
        }
    }

    // --- Latency Calculation Logic ---
    measureLatency(trade) {
        const clientOid = trade.client_order_id;
        
        // Only track if it's OUR order
        if (clientOid && this.orderLatencies.has(clientOid)) {
            const t0 = this.orderLatencies.get(clientOid); // Punch Time (Local)
            const t1 = parseInt(trade.timestamp) / 1000;   // Engine Time (Exchange)
            const latency = t1 - t0;

            let logMsg = `[LATENCY] ⚡ ${trade.symbol} | OID:${clientOid} | T0:${t0} | T1:${t1.toFixed(0)} | Delay: ${latency.toFixed(2)}ms`;
            
            if (latency < 0) logMsg += " ⚠️ (Clock Drift Detected!)";
            else if (latency < 60) logMsg += " 🚀 (Fast)";
            else if (latency > 250) logMsg += " 🐢 (Slow)";

            this.logger.info(logMsg);
            this.orderLatencies.delete(clientOid);
        }
    }

    // --- State Management ---
    handlePositionUpdate(pos) {
        if (!pos.product_symbol) return;
        const asset = this.targetAssets.find(a => pos.product_symbol.startsWith(a));
        
        if (asset) {
            const size = parseFloat(pos.size);
            const isOpen = size !== 0;

            if (this.activePositions[asset] !== isOpen) {
                this.activePositions[asset] = isOpen;

                // IMMEDIATELY RESET STRATEGY COOLDOWN IF CLOSED
                if (!isOpen && this.strategy.onPositionClose) {
                    this.strategy.onPositionClose(asset);
                }

                this.logger.info(`[POS UPDATE] ${asset} is now ${isOpen ? 'OPEN' : 'CLOSED'} (Size: ${size})`);
            }
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
                    const asset = this.targetAssets.find(a => pos.product_symbol.startsWith(a));
                    if (asset) {
                        this.activePositions[asset] = true;
                        this.logger.info(`[SYNC] Found OPEN position for ${asset}: ${size}`);
                    }
                }
            });
            this.isStateSynced = true;
            this.logger.info(`Position State Synced: ${JSON.stringify(this.activePositions)}`);
        } catch (error) {
            this.logger.error(`Failed to sync position state: ${error}`);
        }
    }

    hasOpenPosition(symbol) {
        if (symbol) return this.activePositions[symbol] === true;
        return Object.values(this.activePositions).some(status => status === true);
    }

    // --- External Feed Handler ---
    async handleSignalMessage(message) {
        if (!this.authenticated) return;

        try {
            const data = JSON.parse(message.toString());
            
            // 1. market_listener v4.0 (Raw BookTicker format from Binance)
            // Expects: { type: 'B', s: 'BTC', bb: ..., ba: ... }
            if (data.type === 'B') {
                const asset = data.s;
                if (!this.targetAssets.includes(asset)) return;

                const depthPayload = {
                    bids: [[ data.bb, data.bq ]], 
                    asks: [[ data.ba, data.aq ]]  
                };

                if (this.strategy.onDepthUpdate) {
                    // Fire-and-forget to avoid blocking event loop
                    this.strategy.onDepthUpdate(asset, depthPayload);
                }
            }
            
            // 2. Generic depthUpdate (Forward compatibility)
            else if (data.type === 'depthUpdate') {
                if (this.strategy.execute) {
                    await this.strategy.execute(data);
                }
            }
        } catch (error) {
            this.logger.error("Error handling signal message:", error);
        }
    }
    
    setupHttpServer() {
        const httpServer = new WebSocket.Server({ port: this.config.port });
        httpServer.on('connection', ws => {
            this.logger.info('External Data Feed Connected (Market Listener)');
            ws.on('message', m => this.handleSignalMessage(m));
            ws.on('close', () => this.logger.warn('External Feed Disconnected'));
            ws.on('error', (err) => this.logger.error('Signal listener error:', err));
        });
        this.logger.info(`Internal Data Server running on port ${this.config.port}`);
    }
    
    async placeOrder(orderData) {
        // Record timestamp for latency tracking logic
        if (orderData.client_order_id) {
            this.recordOrderPunch(orderData.client_order_id);
        }
        return this.client.placeOrder(orderData);
    }
    
    handleOrderUpdate(orderUpdate) {
        if (orderUpdate.state === 'filled') {
            this.logger.info(`[Trader] Order ${orderUpdate.id} FILLED.`);
        }
    }
}

// --- Main Execution ---
(async () => {
    try {
        const bot = new TradingBot(config);
        await bot.start();
        
        process.on('uncaughtException', async (err) => {
            logger.error('Uncaught Exception:', err);
            // Don't exit on minor errors, but careful with state
        });
        
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
    
