/**
 * trader.js
 * ALIGNED WITH LEAD STRATEGY v16 + MARKET LISTENER v3
 * Fixes:
 * 1. LOGGING: Inspects and logs full JSON of order failures (Fixes "MISS: [object Object]" blindness).
 * 2. DATA: Automatically appends "USD" to assets for 'all_trades' subscription.
 * 3. SETUP: Explicitly starts Strategy (enables Heartbeat/Warmup).
 */

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

// --- Rust Native Client Integration ---
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
    strategy: process.env.STRATEGY || 'Advance', 
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    apiKey: process.env.DELTA_API_KEY,
    apiSecret: process.env.DELTA_API_SECRET,
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
        this.lastAuthWarning = 0; 

        // Position & Execution State
        this.activePositions = {};
        this.orderLatencies = new Map(); 
        
        // --- ASSET LOADING ---
        // 1. Load from Env, Split, Trim, Uppercase
        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL')
            .split(',')
            .map(a => a.trim().toUpperCase());
        
        this.targetAssets.forEach(asset => {
            this.activePositions[asset] = false;
        });

        this.pingInterval = null; 
        this.heartbeatTimeout = null;
        this.restKeepAliveInterval = null;

        // Load Strategy
        try {
            const StrategyClass = require(`./strategies/${this.config.strategy}Strategy.js`);
            this.strategy = new StrategyClass(this);
            this.logger.info(`✅ Strategy Loaded: ${this.strategy.getName()}`);
        } catch (e) {
            this.logger.error(`FATAL: Could not load strategy: ${e.message}`);
            process.exit(1);
        }
    }

    // --- Latency Helper ---
    recordOrderPunch(clientOrderId) {
        this.orderLatencies.set(clientOrderId, Date.now());
        setTimeout(() => {
            if (this.orderLatencies.has(clientOrderId)) {
                this.orderLatencies.delete(clientOrderId);
            }
        }, 60000);
    }

    async start() {
        this.logger.info(`--- Bot Initializing (v72.0 - Debug Enhanced) ---`);
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

        // Start Strategy
        if (this.strategy && typeof this.strategy.start === 'function') {
            this.logger.info(`🚀 Starting Strategy Logic...`);
            await this.strategy.start();
        }
    }

    startRestKeepAlive() {
        if (this.restKeepAliveInterval) clearInterval(this.restKeepAliveInterval);
        this.restKeepAliveInterval = setInterval(async () => {
            try {
                await this.client.getWalletBalance();
            } catch (error) { }
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
        // Maps ['XRP'] -> ['XRPUSD']
        const tradeSymbols = this.targetAssets.map(asset => `${asset}USD`);
        
        this.logger.info(`Subscribing to: Orders, Positions, User Trades`);
        this.logger.info(`Subscribing to All Trades for: ${tradeSymbols.join(', ')}`);
        
        this.ws.send(JSON.stringify({ 
            type: 'subscribe', 
            payload: { 
                channels: [
                    { name: 'orders', symbols: ['all'] },
                    { name: 'positions', symbols: ['all'] },
                    { name: 'user_trades', symbols: ['all'] },
                    { name: 'all_trades', symbols: tradeSymbols } 
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
            this.logger.info('✅ WebSocket AUTHENTICATED Successfully.');
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

        switch (message.type) {
            case 'all_trades':
                if (Array.isArray(message.data)) {
                     if(message.data.length > 0) this.forwardTradeToStrategy(message.data[0]);
                } else {
                     this.forwardTradeToStrategy(message);
                }
                break;

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
            
            case 'user_trades':
                this.measureLatency(message);
                break;
        }
    }

    // Forward 'all_trades' to Strategy
    forwardTradeToStrategy(tradeData) {
        if (this.strategy && this.strategy.onLaggerTrade) {
            this.strategy.onLaggerTrade(tradeData);
        }
    }

    measureLatency(trade) {
        const clientOid = trade.client_order_id;
        if (clientOid && this.orderLatencies.has(clientOid)) {
            const t0 = this.orderLatencies.get(clientOid);
            const t1 = parseInt(trade.timestamp) / 1000;
            const latency = t1 - t0;
            this.logger.info(`[LATENCY] ⚡ ${trade.symbol} | OID:${clientOid} | Delay: ${latency.toFixed(2)}ms`);
            this.orderLatencies.delete(clientOid);
        }
    }

    handlePositionUpdate(pos) {
        if (!pos.product_symbol) return;
        const asset = this.targetAssets.find(a => pos.product_symbol.startsWith(a));
        
        if (asset) {
            const size = parseFloat(pos.size);
            const isOpen = size !== 0;

            if (this.activePositions[asset] !== isOpen) {
                this.activePositions[asset] = isOpen;
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
                    }
                }
            });
            this.logger.info(`Position State Synced: ${JSON.stringify(this.activePositions)}`);
        } catch (error) {
            this.logger.error(`Failed to sync position state: ${error}`);
        }
    }

    // --- SIGNAL HANDLING ---
    async handleSignalMessage(message) {
        if (!this.authenticated) {
            const now = Date.now();
            if (now - this.lastAuthWarning > 5000) { 
                this.logger.warn(`[Data Drop] ⚠️ Receiving Market Data but Bot NOT Authenticated yet. Ignoring.`);
                this.lastAuthWarning = now;
            }
            return;
        }

        try {
            const data = JSON.parse(message.toString());
            
            if (data.type === 'B') {
                const asset = data.s;
                if (!this.targetAssets.includes(asset)) return;
                
                const depthPayload = {
                    bids: [[ data.bb, data.bq ]], 
                    asks: [[ data.ba, data.aq ]]  
                };
                
                if (this.strategy.onDepthUpdate) {
                    this.strategy.onDepthUpdate(asset, depthPayload);
                }
            } 
        } catch (error) {
            this.logger.error("Error handling signal message:", error);
        }
    }
    
    setupHttpServer() {
        const httpServer = new WebSocket.Server({ port: this.config.port });
        httpServer.on('connection', ws => {
            this.logger.info('External Data Feed Connected');
            ws.on('message', m => this.handleSignalMessage(m));
            ws.on('error', (err) => this.logger.error('Signal listener error:', err));
        });
        this.logger.info(`Internal Data Server running on port ${this.config.port}`);
    }
    
    // ⚡ IMPROVED ORDER PLACEMENT & LOGGING
    async placeOrder(orderData) {
        if (orderData.client_order_id) {
            this.recordOrderPunch(orderData.client_order_id);
        }
        try {
            const result = await this.client.placeOrder(orderData);
            
            // 🔍 LOG REJECT DETAILS IF FAILED
            // This prevents "MISS: [object Object]" blindness
            if (result && !result.success) {
                 this.logger.error(`[ORDER REJECT] Native Client returned failure: ${JSON.stringify(result)}`);
            }
            
            return result;
        } catch (error) {
            // Handle exceptions (e.g., network error, crash)
            const errMsg = error.message || JSON.stringify(error);
            this.logger.error(`[ORDER FAIL] Native Client Exception: ${errMsg}`);
            throw error; 
        }
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
        });
    } catch (error) {
        logger.error("Failed to start bot:", error);
        process.exit(1);
    }
})();
    
