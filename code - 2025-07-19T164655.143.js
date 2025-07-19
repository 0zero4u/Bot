// trader.js
// Definitive Final Version of Delta Exchange Trading Bot
// Version 6.0.17 - Implemented position snapshot handling and IOC retry cooldown.

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// --- Configuration ---
const config = {
    port: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    deltaBaseUrl: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    deltaWsUrl: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.india.delta.exchange',
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
    priceThreshold: parseFloat(process.env.PRICE_THRESHOLD || '1.00'),
    orderSize: parseInt(process.env.ORDER_SIZE || '1'),
    leverage: process.env.DELTA_LEVERAGE || '50',
    orderPlacementStrategy: process.env.ORDER_PLACEMENT_STRATEGY || 'limit_bbo',
    useBracketOrders: process.env.USE_BRACKET_ORDERS === 'true',
    takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET || '100.0'),
    stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET || '50.0'),
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    retryCooldownSeconds: parseInt(process.env.RETRY_COOLDOWN_SECONDS || '15'), // New
    deltaApiKey: process.env.DELTA_API_KEY,
    deltaApiSecret: process.env.DELTA_API_SECRET,
    reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
    logLevel: process.env.LOG_LEVEL || 'info',
    cancelOnDisconnectTimeoutMs: parseInt(process.env.CANCEL_ON_DISCONNECT_TIMEOUT_MS || '60000'),
    heartbeatIntervalMs: 35000,
};

// --- Logging Setup ---
const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) })
    ]
});

// --- Input Validation ---
function validateConfig() {
    const required = ['deltaApiKey', 'deltaApiSecret', 'productId', 'productSymbol', 'leverage'];
    if (required.some(key => !config[key])) {
        logger.error(`FATAL: Missing required configuration: ${required.filter(key => !config[key]).join(', ')}`);
        process.exit(1);
    }
}
validateConfig();

// --- Utility Functions ---
function utilQueryString(query) { if (!query || Object.keys(query).length === 0) return ''; const q = []; for (const [k, v] of Object.entries(query)) { q.push(`${k}=${encodeURIComponent(String(v))}`); } return '?' + q.join('&'); }
function utilBodyString(body) { if (!body) return ''; return JSON.stringify(body); }
function utilParseResponse(response) { if (response.data?.success) { return response.data.result; } else if (response.data?.error) { throw new Error(response.data.error); } else { throw new Error('Unknown API error'); } }

// --- Delta Exchange API Client ---
class DeltaExchangeClient {
    constructor(apiKey, apiSecret, baseUrl) { this.apiKey = apiKey; this.apiSecret = apiSecret; this.baseUrl = baseUrl; this.axios = axios.create({ baseURL: baseUrl, timeout: 10000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Bybit-Delta-Trading-Bot/6.0.17' } }); }
    getTimestamp() { return String(Math.floor(Date.now() / 1000)); }
    generateSignature(method, path, timestamp, query = null, body = null) {
        const queryString = utilQueryString(query); const bodyString = utilBodyString(body);
        const signatureData = method + timestamp + path + queryString + bodyString;
        return crypto.createHmac('sha256', this.apiSecret).update(signatureData, 'utf8').digest('hex');
    }
    generateWsSignature(timestamp) { const message = 'GET' + timestamp + '/live'; return crypto.createHmac('sha256', this.apiSecret).update(message, 'utf8').digest('hex'); }
    async makeRequest(method, path, data = null, query = null) {
        const timestamp = this.getTimestamp(); const signature = this.generateSignature(method, path, timestamp, query, data);
        const headers = { 'api-key': this.apiKey, 'timestamp': timestamp, 'signature': signature, 'Content-Type': 'application/json' };
        try { const response = await this.axios({ method, url: path, data: data || undefined, params: query, headers }); return utilParseResponse(response); }
        catch (error) { logger.error('Delta Exchange API Error:', { request: { method, path, payload: data, query }, response: { status: error.response?.status, data: error.response?.data }, message: error.message }); throw error; }
    }
    async setLeverage(productId, leverage) { const p = { leverage: String(leverage) }; return this.makeRequest('POST', `/v2/products/${productId}/orders/leverage`, p); }
    async setCancelOnDisconnectTimer(timeoutMs) { const p = { cancel_after: Math.floor(timeoutMs / 1000) }; return this.makeRequest('POST', '/v2/orders/cancel_after', p); }
    async placeOrder(orderData) { return this.makeRequest('POST', '/v2/orders', orderData); }
    async cancelAllOpenOrders(productId) {
        logger.info(`Cancelling all existing open orders for product ID ${productId}...`);
        const payload = { product_id: productId };
        return this.makeRequest('DELETE', '/v2/orders/all', payload, null);
    }
}

// --- TradingBot Class ---
class TradingBot {
    constructor() {
        this.deltaClient = new DeltaExchangeClient(config.deltaApiKey, config.deltaApiSecret, config.deltaBaseUrl);
        this.ws = null; this.heartbeatTimer = null; this.priceAtLastTrade = null; this.isOrderInProgress = false;
        this.orderBook = { bids: [], asks: [] }; this.startTime = new Date();
        this.activeOrderClientId = null;
        this.isPositionOpen = false; this.isCoolingDown = false; this.isRetryCoolingDown = false; this.isOrderbookReady = false;
        this.initialize();
    }

    async initialize() {
        logger.info('--- Bot Initializing (v6.0.17) ---');
        try {
            await this.deltaClient.setLeverage(config.productId, config.leverage); logger.info(`✅ Leverage set to ${config.leverage}x`);
            await this.deltaClient.setCancelOnDisconnectTimer(config.cancelOnDisconnectTimeoutMs); logger.info(`✅ Cancel-on-Disconnect timer set.`);
            this.setupWebSocketServer(); this.connectToDeltaWs(); this.setupHealthCheck();
            logger.info(`🚀 Bot started. Waiting for connections.`);
        } catch (error) { logger.error(`❌ FATAL: Failed to initialize bot.`, error.message); process.exit(1); }
    }

    resetHeartbeatTimer() {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = setTimeout(() => { logger.error('💔 Heartbeat not received. Reconnecting...'); if (this.ws) this.ws.terminate(); }, config.heartbeatIntervalMs);
    }

    connectToDeltaWs() {
        this.ws = new WebSocket(config.deltaWsUrl);
        this.ws.on('open', () => {
            logger.info(`Delta WebSocket opened. Sending setup messages...`); this.resetHeartbeatTimer();
            const timestamp = this.deltaClient.getTimestamp(); const signature = this.deltaClient.generateWsSignature(timestamp);
            this.ws.send(JSON.stringify({ type: 'auth', payload: { 'api-key': config.deltaApiKey, 'timestamp': timestamp, 'signature': signature } }));
            this.ws.send(JSON.stringify({ type: 'enable_heartbeat' }));
            this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: 'l1_orderbook', symbols: [config.productSymbol] }] } }));
        });
        this.ws.on('message', (data) => {
            this.resetHeartbeatTimer(); const msg = JSON.parse(data.toString());
            if (msg.type === 'auth' && msg.success) {
                logger.info('✅ Delta WebSocket authenticated. Subscribing to private channels...');
                this.ws.send(JSON.stringify({ type: 'subscribe', payload: { channels: [{ name: 'orders', symbols: [config.productSymbol] }, { name: 'positions', symbols: [config.productSymbol] }] } }));
            }
            else if (msg.type === 'l1_orderbook') { this.orderBook.bids = [[msg.best_bid, msg.bid_qty]]; this.orderBook.asks = [[msg.best_ask, msg.ask_qty]]; if (!this.isOrderbookReady) { this.isOrderbookReady = true; logger.info('✅ L1 Order book synchronized.'); } }
            else if (msg.type === 'positions' && msg.action === 'snapshot') {
                logger.info('✅ Received position snapshot.');
                msg.result.forEach(pos => this.handlePositionUpdate(pos));
            }
            else if (msg.type === 'position_update') { this.handlePositionUpdate(msg); }
            else if (msg.type === 'orders') { this.handleOrderUpdate(msg); }
            else if (msg.type === 'heartbeat') { logger.info('❤️ Heartbeat received.'); }
            else if (msg.type === 'subscription') { if (msg.success) { logger.info(`✅ Subscribed to ${msg.channel_name}`); } else { logger.error(`❌ Failed to subscribe to ${msg.channel_name}:`, msg); } }
            else if (msg.type === 'auth' && !msg.success) { logger.error('❌ Delta WebSocket auth failed:', msg); this.ws.close(); }
        });
        this.ws.on('close', () => { logger.warn('Delta WebSocket closed. Reconnecting...'); clearTimeout(this.heartbeatTimer); this.isOrderbookReady = false; this.isPositionOpen = false; this.activeOrderClientId = null; this.isRetryCoolingDown = false; setTimeout(() => this.connectToDeltaWs(), config.reconnectInterval); });
        this.ws.on('error', (err) => logger.error('Delta WebSocket error:', err));
    }

    handlePositionUpdate(position) {
        if (position.product_id !== config.productId) return;
        const wasPositionOpen = this.isPositionOpen;
        this.isPositionOpen = position.size !== 0;
        if (this.isPositionOpen && !wasPositionOpen) {
            logger.info(`🔥 POSITION OPENED: Size ${position.size} for ${position.symbol}.`);
        } else if (!this.isPositionOpen && wasPositionOpen) {
            logger.info(`✅ POSITION CLOSED for ${position.symbol}. Releasing lock.`);
            this.activeOrderClientId = null;
            this.startCooldown();
        }
    }

    handleOrderUpdate(order) {
        logger.info(`Order Update: Client ID ${order.client_order_id} | Status: ${order.state}`);
        if (this.activeOrderClientId && order.client_order_id === this.activeOrderClientId) {
            if (order.state === 'cancelled' || order.state === 'rejected') {
                logger.info(`Pending order ${this.activeOrderClientId} failed or was cancelled by IOC. Releasing lock and starting retry cooldown.`);
                this.activeOrderClientId = null;
                this.startRetryCooldown();
            }
        }
    }

    startCooldown() {
        this.isCoolingDown = true; logger.info(`--- Main Cooldown (${config.cooldownSeconds}s) STARTED ---`);
        setTimeout(() => { this.isCoolingDown = false; logger.info(`--- Main Cooldown ENDED ---`); }, config.cooldownSeconds * 1000);
    }

    startRetryCooldown() {
        this.isRetryCoolingDown = true; logger.info(`--- Retry Cooldown (${config.retryCooldownSeconds}s) STARTED ---`);
        setTimeout(() => { this.isRetryCoolingDown = false; logger.info(`--- Retry Cooldown ENDED ---`); }, config.retryCooldownSeconds * 1000);
    }

    setupWebSocketServer() {
        this.wss = new WebSocket.Server({ port: config.port });
        logger.info(`Internal WebSocket server started on port ${config.port}`);
        this.wss.on('connection', ws => { logger.info('Bybit listener connected'); ws.on('message', m => this.handlePriceMessage(m)); ws.on('close', () => logger.warn('Bybit listener disconnected')); ws.on('error', (e) => logger.error('Internal WebSocket error:', e)); });
    }

    async handlePriceMessage(message) {
        if (!this.isOrderbookReady) { return; }
        try {
            const data = JSON.parse(message.toString()); if (data.type !== 'S' || !data.p) return;
            const currentPrice = parseFloat(data.p);
            if (this.priceAtLastTrade === null) { this.priceAtLastTrade = currentPrice; logger.info(`Initial baseline price set: $${currentPrice.toFixed(2)}`); return; }
            const priceDifference = Math.abs(currentPrice - this.priceAtLastTrade);
            if (priceDifference >= config.priceThreshold && !this.isOrderInProgress && !this.isPositionOpen && !this.activeOrderClientId && !this.isCoolingDown && !this.isRetryCoolingDown) {
                await this.executeTrade(currentPrice, priceDifference);
            }
        } catch (error) { logger.error("Error handling price message:", error.message, error.stack); }
    }

    async executeTrade(currentPrice, priceDifference) {
        this.isOrderInProgress = true;
        try {
            try {
                const cancelled = await this.deltaClient.cancelAllOpenOrders(config.productId);
                if (cancelled && cancelled.length > 0) logger.info(`Successfully cancelled ${cancelled.length} lingering order(s).`);
            } catch (cancelError) {
                logger.error(`❌ CRITICAL: Failed to cancel open orders. Aborting trade.`, cancelError.message);
                this.isOrderInProgress = false; return;
            }

            logger.info(`TRADE TRIGGER: Price diff $${priceDifference.toFixed(2)}`);
            const side = currentPrice > this.priceAtLastTrade ? 'buy' : 'sell';
            const clientOrderId = uuidv4();
            const orderData = this.prepareOrderData(side, clientOrderId);
            if (!orderData) { logger.warn("Could not prepare order data. Skipping."); this.isOrderInProgress = false; return; }

            const orderResponse = await this.deltaClient.placeOrder(orderData);
            logger.info(`✅ IOC Order placed successfully: ${clientOrderId}. Locking new trades until order resolves.`);
            
            this.activeOrderClientId = clientOrderId;
            
            this.priceAtLastTrade = currentPrice;
            logger.info(`Trade baseline reset to: $${currentPrice.toFixed(2)}`);
        } catch (error) {
            logger.error('Failed to execute trade:', error.message);
            this.activeOrderClientId = null;
        } finally {
            this.isOrderInProgress = false;
        }
    }

    prepareOrderData(side, clientOrderId) {
        const baseOrder = {
            product_id: config.productId, size: config.orderSize, side, client_order_id: clientOrderId,
            time_in_force: 'ioc',
        };
        const book = side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
        if (!book || book.length === 0 || !book[0][0]) { logger.warn(`No L1 data for side '${side}'.`); return null; }
        const price = parseFloat(book[0][0]);
        const takeProfitPrice = side === 'buy' ? price + config.takeProfitOffset : price - config.takeProfitOffset;
        const stopLossPrice = side === 'buy' ? price - config.stopLossOffset : price + config.stopLossOffset;
        return {
            ...baseOrder,
            order_type: 'limit_order',
            limit_price: price.toFixed(4),
            bracket_take_profit_price: takeProfitPrice.toFixed(4),
            bracket_stop_loss_price: stopLossPrice.toFixed(4)
        };
    }

    setupHealthCheck() {
        setInterval(async () => {
            try { await this.deltaClient.setCancelOnDisconnectTimer(config.cancelOnDisconnectTimeoutMs); logger.info('Health Check: Cancel-on-Disconnect refreshed.'); }
            catch (error) { logger.error('Health check failed:', error.message); }
        }, 300000);
    }
}

// --- Start Bot & Process Handlers ---
try { new TradingBot(); } catch (error) { logger.error("Failed to construct bot:", error); process.exit(1); }
process.on('uncaughtException', (err) => { logger.error('Uncaught Exception:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error('Unhandled Rejection:', reason); process.exit(1); });
process.on('SIGTERM', () => { logger.info('SIGTERM received, shutting down.'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT received, shutting down.'); process.exit(0); });