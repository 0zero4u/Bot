
/**
 * trader.js
 * v73.2 - NATIVE ARCHITECTURE (Aligned with AdvanceStrategy V83.0)
 * Updates:
 * 1. FIXED: Subscribes to L2 Orderbook updates for Exchange 1 Bid/Ask Liquidity.
 * 2. FIXED: Correctly passes single `update` object to strategy.onDepthUpdate.
 * 3. FIXED: Properly normalizes `all_trades` and forwards to strategy.onLaggerTrade.
 * 4. ADDED: Quote routing via forwardQuoteToStrategy().
 */

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

// --- Rust Native Client Integration ---
let DeltaClient;
let BinanceListener; 
try {
    const fastClient = require('fast-client');
    DeltaClient = fastClient.DeltaNativeClient;
    BinanceListener = fastClient.BinanceListener; 
} catch (e) {
    console.warn("Native client not found, please ensure 'fast-client' is installed and built.");
    process.exit(1);
}

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Advance', 
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

    hasOpenPosition(asset) {
        return this.activePositions[asset] === true;
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
        this.logger.info(`--- Bot Initializing (v73.2 - NATIVE RUST ARCHITECTURE) ---`);
        this.logger.info("🔥 Warming up Rust Native Connection...");
        try {
            await this.client.getWalletBalance();
            this.logger.info("🔥 Connection Warmed. Native Socket is open.");
        } catch (e) {
            this.logger.warn("Warmup failed (non-fatal), continuing...");
        }

        await this.syncPositionState();
        await this.initWebSocket();
        this.startRestKeepAlive();

        this.logger.info("⚡ Booting Native Rust Binance Listener...");
        const binanceFeed = new BinanceListener();
        
        binanceFeed.start(this.targetAssets, (err, update) => {
            if (err) {
                this.logger.error(`[Binance Thread Error] ${err}`);
                return;
            }
            if (!update) return;

            if (!this.authenticated) {
                const now = Date.now();
                if (now - this.lastAuthWarning > 5000) { 
                    this.logger.warn(`[Data Drop] ⚠️ Receiving Binance Data but Delta NOT Authenticated yet. Ignoring.`);
                    this.lastAuthWarning = now;
                }
                return;
            }

            // FIXED: Passing native object directly to strategy as expected by AdvanceStrategy.js
            if (this.strategy && typeof this.strategy.onDepthUpdate === 'function') {
                this.strategy.onDepthUpdate(update);
            }
        });

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
        // Typically Delta uses the USDT suffix for perps (e.g. BTCUSDT) or USD
        const tradeSymbols = this.targetAssets.map(asset => `${asset}USD`);
        const orderbookSymbols = this.targetAssets.map(asset => `${asset}USDT`); // Delta perps
        
        this.logger.info(`Subscribing to: Orders, Positions, User Trades`);
        this.logger.info(`Subscribing to L2 Orderbook & Trades for: ${this.targetAssets.join(', ')}`);
        
        this.ws.send(JSON.stringify({ 
            type: 'subscribe', 
            payload: { 
                channels: [
                    { name: 'orders', symbols: ['all'] },
                    { name: 'positions', symbols: ['all'] },
                    { name: 'user_trades', symbols: ['all'] },
                    { name: 'all_trades', symbols: tradeSymbols },
                    // ADDED: Crucial L2 Orderbook subscription for Exchange 1 liquidity tracking
                    { name: 'l2_updates', symbols: tradeSymbols },
                    { name: 'l2_updates', symbols: orderbookSymbols } 
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
            case 'l2_updates':
            case 'v2/ticker':
                // ADDED: Route Exchange 1 Quotes directly to strategy
                this.forwardQuoteToStrategy(message);
                break;

            case 'all_trades':
                // FIXED: Normalize array vs single trade and map the symbol
                const tradesData = Array.isArray(message.data) ? message.data : [message.data || message];
                tradesData.forEach(t => {
                    if (t) {
                        this.forwardTradeToStrategy({
                            ...t,
                            symbol: message.symbol || t.symbol || message.product_symbol
                        });
                    }
                });
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

    // --- ADDED: Forward Quote logic for Exchange 1 Liquidity ---
    forwardQuoteToStrategy(message) {
        if (this.strategy && typeof this.strategy.onExchange1Quote === 'function') {
            const data = message.data || message;
            
            // Map Delta's nested arrays to flat quote structure
            let mappedBid = data.best_bid || data.bid || 0;
            let mappedAsk = data.best_ask || data.ask || 0;
            let mappedBidSize = data.best_bid_size || data.bid_size || 0;
            let mappedAskSize = data.best_ask_size || data.ask_size || 0;

            if (data.buy && data.buy.length > 0) {
                mappedBid = data.buy[0].limit_price || data.buy[0].price;
                mappedBidSize = data.buy[0].size;
            }
            if (data.sell && data.sell.length > 0) {
                mappedAsk = data.sell[0].limit_price || data.sell[0].price;
                mappedAskSize = data.sell[0].size;
            }

            this.strategy.onExchange1Quote({
                symbol: message.symbol || data.symbol || message.product_symbol,
                bid: mappedBid,
                ask: mappedAsk,
                bid_size: mappedBidSize,
                ask_size: mappedAskSize
            });
        }
    }

    forwardTradeToStrategy(tradeData) {
        if (this.strategy && typeof this.strategy.onLaggerTrade === 'function') {
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
    
    async placeOrder(orderData) {
        if (orderData.client_order_id) {
            this.recordOrderPunch(orderData.client_order_id);
        }
        try {
            const result = await this.client.placeOrder(orderData);
            
            if (result && !result.success) {
                 this.logger.error(`[ORDER REJECT] Native Client returned failure: ${JSON.stringify(result)}`);
            }
            
            return result;
        } catch (error) {
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
