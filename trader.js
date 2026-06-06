/**
 * trader.js
 * v74.0 - Migrated to new Delta public WebSocket
 * - Endpoint: wss://public-socket.india.delta.exchange
 * - Channels: trades (was all_trades), ob_l1 (was l1_orderbook)
 */

const WebSocket = require('ws');
const winston = require('winston');
const crypto = require('crypto');
require('dotenv').config();

// --- Rust Native Client Integration ---
let DeltaClient;
let BinanceListener;
let BinanceTradeListener;
try {
    const fastClient = require('fast-client');
    DeltaClient = fastClient.DeltaNativeClient;
    BinanceListener = fastClient.BinanceListener;
    BinanceTradeListener = fastClient.BinanceTradeListener;
} catch (e) {
    console.warn("Native client not found, please ensure 'fast-client' is installed and built.");
    process.exit(1);
}

// --- Configuration ---
const config = {
    strategy: process.env.STRATEGY || 'Advance', 
    baseURL: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsURL: process.env.DELTA_WEBSOCKET_URL || 'wss://public-socket.india.delta.exchange',
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

        this.activePositions = {};
        this.orderLatencies = new Map(); 
        this.orderAckWaiters = new Map(); // client_order_id → { resolve, reject, timer }
        
        // --- ASSET LOADING ---
        this.targetAssets = (process.env.TARGET_ASSETS || 'BTC,ETH,XRP,SOL')
            .split(',')
            .map(a => a.trim().toUpperCase());
        
        this.targetAssets.forEach(asset => {
            this.activePositions[asset] = false;
        });

        // Build O(1) symbol lookup Map for position/trade asset matching
        // Pre-maps all common symbol formats (e.g. "XRP"→"XRP", "XRPUSD"→"XRP")
        // to avoid O(n) linear scans on every incoming message.
        this.symbolLookup = new Map();
        this.targetAssets.forEach(a => {
            this.symbolLookup.set(a, a);
            this.symbolLookup.set(`${a}USD`, a);
            this.symbolLookup.set(`${a}USDT`, a);
            this.symbolLookup.set(`${a}-USD`, a);
            this.symbolLookup.set(`${a}-PERP`, a);
        });

        // Pre-compute static WebSocket subscribe messages to avoid JSON
        // serialization + allocation on every (re)connection.
        this.publicSubscribeMsg = JSON.stringify({
            type: 'subscribe',
            payload: { channels: [{ name: 'trades', symbols: this.targetAssets.map(a => `${a}USD`) }] }
        });
        this.privateSubscribeMsg = JSON.stringify({
            type: 'subscribe',
            payload: {
                channels: [
                    { name: 'orders', symbols: ['all'] },
                    { name: 'positions', symbols: ['all'] },
                    { name: 'user_trades', symbols: ['all'] }
                ]
            }
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
        this.logger.info(`--- Bot Initializing (v73.3 - NATIVE RUST ARCHITECTURE) ---`);
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

        this.logger.info("⚡ Checking strategy requirements for Binance feeds...");

        const needsDepth = this.strategy && typeof this.strategy.onDepthUpdate === 'function' && this.strategy.onDepthUpdate.toString().length > 50;
        const needsTrades = this.strategy && typeof this.strategy.onBinanceTrade === 'function' && this.strategy.onBinanceTrade.toString().length > 50;

        if (needsDepth) {
            this.logger.info("📊 Starting Binance bookTicker (strategy uses onDepthUpdate)...");
            const binanceFeed = new BinanceListener();
            binanceFeed.start(this.targetAssets, (err, update) => {
                if (err) { this.logger.error(`[Binance Depth Error] ${err}`); return; }
                if (!update) return;
                if (!this.authenticated) {
                    const now = Date.now();
                    if (now - this.lastAuthWarning > 5000) {
                        this.logger.warn(`[Data Drop] ⚠️ Binance Depth received but Delta NOT authenticated.`);
                        this.lastAuthWarning = now;
                    }
                    return;
                }
                this.strategy.onDepthUpdate(update);
            });
        } else {
            this.logger.info("⏭️ Skipping Binance bookTicker (strategy doesn't use onDepthUpdate)");
        }

        if (needsTrades) {
            this.logger.info("📊 Starting Binance @trade (strategy uses onBinanceTrade)...");
            const binanceTrades = new BinanceTradeListener();
            binanceTrades.start(this.targetAssets, (err, update) => {
                if (err) { this.logger.error(`[Binance Trade Error] ${err}`); return; }
                if (!update) return;
                this.strategy.onBinanceTrade(update);
            });
        } else {
            this.logger.info("⏭️ Skipping Binance @trade (strategy doesn't use onBinanceTrade)");
        }

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
        // Use native WebSocket ping/pong control frames (opcode 0x9/0xA)
        // instead of JSON text frames — avoids JSON serialization, GC pressure,
        // and is handled at the TCP level for lower latency.
        this.wsPrivate.on('pong', () => {
            this.resetHeartbeatTimeout();
        });
        this.pingInterval = setInterval(() => {
            if (this.wsPrivate && this.wsPrivate.readyState === WebSocket.OPEN) {
                this.wsPrivate.ping();
            }
        }, this.config.pingIntervalMs);
    }

    resetHeartbeatTimeout() {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn('Heartbeat timeout! No pong received. Terminating.');
            if (this.wsPrivate) this.wsPrivate.terminate();
        }, this.config.heartbeatTimeoutMs);
    }

    stopHeartbeat() {
        clearTimeout(this.heartbeatTimeout);
        clearInterval(this.pingInterval);
    }

    async initWebSocket() {
        this.logger.info(`Connecting to PUBLIC endpoint for trades...`);
        this.ws = new WebSocket('wss://public-socket.india.delta.exchange');

        this.ws.on('open', () => {
            this.ws.send(this.publicSubscribeMsg);
            this.logger.info(`✅ Public WS: Subscribed to trades`);
        });

        this.ws.on('message', (data) => {
            const msg = JSON.parse(data); // Buffer accepted directly by JSON.parse in Node 20+
            this.logger.debug(`[WS RAW] type=${msg.type}`);
            this.handleWebSocketMessage(msg);
        });
        this.ws.on('error', (error) => this.logger.error('Public WS error:', error.message));
        this.ws.on('close', (code, reason) => {
            this.logger.warn(`Public WS disconnected: ${code}. Reconnecting...`);
            setTimeout(() => this.initWebSocket(), this.config.reconnectInterval);
        });
        this.ws.on('unexpected-response', (req, res) => {
            this.logger.error(`[WS] Unexpected response: ${res.statusCode}`);
        });

        this.initPrivateWebSocket();
    }

    initPrivateWebSocket() {
        this.logger.info(`Connecting to PRIVATE endpoint for orders...`);
        this.wsPrivate = new WebSocket('wss://socket.india.delta.exchange');

        this.wsPrivate.on('open', () => {
            this.logger.info(`✅ Private WS connected, authenticating...`);
            this.authenticatePrivate();
        });

        this.wsPrivate.on('message', (data) => this.handlePrivateMessage(JSON.parse(data)));
        this.wsPrivate.on('error', (error) => this.logger.error('Private WS error:', error.message));
        this.wsPrivate.on('close', (code, reason) => {
            this.logger.warn(`Private WS disconnected: ${code}. Reconnecting...`);
            this.authenticated = false;
            setTimeout(() => this.initPrivateWebSocket(), this.config.reconnectInterval);
        });
    }

    authenticatePrivate() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = crypto
            .createHmac('sha256', this.config.apiSecret)
            .update('GET' + timestamp + '/live')
            .digest('hex');

        this.wsPrivate.send(JSON.stringify({
            type: 'key-auth',
            payload: { 'api-key': this.config.apiKey, timestamp, signature }
        }));
    }

    subscribePrivateChannels() {
        this.wsPrivate.send(this.privateSubscribeMsg);
        this.logger.info(`✅ Private WS: Subscribed to orders, positions, user_trades`);
    }

    handlePrivateMessage(message) {
        if (message.type === 'key-auth' && message.status === 'authenticated') {
            if (!this.authenticated) {
                this.logger.info(`✅ Private WS AUTHENTICATED`);
                this.authenticated = true;
                this.subscribePrivateChannels();
                this.startHeartbeat();
            }
            return;
        }

        switch (message.type) {
            case 'orders':
                if (message.action === 'snapshot') return;
                const updates = message.data || (message.action ? [message] : []);
                updates.forEach(update => {
                    // Resolve pending order waiters on WS 'create' ack (~130ms faster than REST)
                    if (update.action === 'create' && update.client_order_id && this.orderAckWaiters.has(update.client_order_id)) {
                        const waiter = this.orderAckWaiters.get(update.client_order_id);
                        clearTimeout(waiter.timer);
                        waiter.resolve({
                            success: true,
                            meta: {},
                            result: {
                                id: update.id,
                                client_order_id: update.client_order_id,
                                product_id: update.product_id,
                                side: update.side,
                                size: update.size,
                                ws_acked: true
                            }
                        });
                        this.orderAckWaiters.delete(update.client_order_id);
                        this.logger.info(`[WS-ACK] Order ${update.id} acked @ ${Date.now()}ms (WS beat REST)`);
                    }
                    this.handleOrderUpdate(update);
                    if (this.strategy && typeof this.strategy.onOrderUpdate === 'function') {
                        this.strategy.onOrderUpdate(update);
                    }
                });
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
                if (this.strategy && typeof this.strategy.onUserTrade === 'function') {
                    this.strategy.onUserTrade(message);
                }
                break;
        }
    }

    handleWebSocketMessage(message) {
        switch (message.type) {
            case 'trades':
                if (message.sy) {
                    this.forwardTradeToStrategy({
                        price: message.p,
                        size: message.s,
                        symbol: message.sy,
                        timestamp: message.t
                    });
                }
                break;
        }
    }

    forwardQuoteToStrategy(message) {
        if (this.strategy && typeof this.strategy.onExchange1Quote === 'function') {
            const data = message.data || message;
            
            // Map flat L1 orderbook structure
            this.strategy.onExchange1Quote({
                symbol: message.symbol || data.symbol || message.product_symbol,
                bid: data.best_bid || data.bid || 0,
                ask: data.best_ask || data.ask || 0,
                bid_size: data.best_bid_size || data.bid_size || 0,
                ask_size: data.best_ask_size || data.ask_size || 0
            });
        }
    }

    forwardTradeToStrategy(tradeData) {
        if (this.strategy && typeof this.strategy.onLaggerTrade === 'function') {
            tradeData.side = tradeData.side || tradeData.taker_side || (tradeData.buyer_role === 'taker' ? 'buy' : 'sell');
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
        const asset = this.symbolLookup.get(pos.product_symbol) ||
            this.targetAssets.find(a => pos.product_symbol.startsWith(a));
        
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
                    const asset = this.symbolLookup.get(pos.product_symbol) ||
                        this.targetAssets.find(a => pos.product_symbol.startsWith(a));
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
        const totalStart = process.hrtime.bigint();
        
        if (orderData.client_order_id) {
            this.recordOrderPunch(orderData.client_order_id);
        }
        
        // Race REST response vs WebSocket order 'create' ack.
        // WS arrives ~130ms before REST because Delta broadcasts the event
        // immediately after matching, before DB sync + REST gateway.
        const cid = orderData.client_order_id;
        
        const restCall = (async () => {
            const result = await this.client.placeOrder(orderData);
            return { source: 'rest', result };
        })();

        const wsCall = new Promise((resolve, reject) => {
            if (!cid) return reject(new Error('No client_order_id'));
            const timer = setTimeout(() => {
                this.orderAckWaiters.delete(cid);
                reject(new Error('WS ack timeout'));
            }, 2000);
            this.orderAckWaiters.set(cid, { resolve, reject, timer });
        });

        const winner = await Promise.race([restCall, wsCall]);

        // Cancel the loser
        if (winner.source === 'ws') {
            // WS won — discard REST result in background (order already confirmed)
            this.orderAckWaiters.delete(cid);
            restCall.then(r => {
                if (r.result && !r.result.success) {
                    this.logger.warn(`[ORDER] REST says fail but WS said create — order ${cid} might have issues`);
                }
            }).catch(() => {});
            const t1 = process.hrtime.bigint();
            const wsMs = Number(t1 - totalStart) / 1e6;
            this.logger.info(`[TIMING] WS-race won: ${wsMs.toFixed(0)}ms (saved ~${(750 - wsMs).toFixed(0)}ms vs REST)`);
            return winner.result;
        } else {
            // REST won (or WS not available) — clean up waiter
            if (cid) {
                const w = this.orderAckWaiters.get(cid);
                if (w) { clearTimeout(w.timer); this.orderAckWaiters.delete(cid); }
            }
            const t1 = process.hrtime.bigint();
            const restMs = Number(t1 - totalStart) / 1e6;
            this.logger.info(`[TIMING] REST: ${restMs.toFixed(0)}ms`);
            if (winner.result && !winner.result.success) {
                this.logger.error(`[ORDER REJECT] ${JSON.stringify(winner.result)}`);
            }
            return winner.result;
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
                                  
