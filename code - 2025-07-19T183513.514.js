/**
 * Delta Trader Bot - v4.1 (Definitive, Completed)
 * 
 * This version includes a complete client, honors all configuration flags,
 * and is provided with the necessary package.json and .env templates to run.
 * 
 * KEY FEATURE: Uses Delta Exchange's atomic bracket orders for safer execution.
 */

// ==============  LOAD ENVIRONMENT VARIABLES (Must be at the top) ==============
require('dotenv').config();

// ============================  STANDARD LIBS  ============================
const WebSocket = require('ws');
const axios = require('axios').default;
const crypto =require('crypto');
const qs = require('querystring');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

// ============================  CONFIGURATION  ============================
const config = {
    // Internal Bot Settings
    internalWsPort: parseInt(process.env.INTERNAL_WS_PORT || '8082'),
    logLevel: process.env.LOG_LEVEL || 'info',

    // Delta Exchange Credentials & URLs
    deltaApiKey: process.env.DELTA_API_KEY,
    deltaApiSecret: process.env.DELTA_API_SECRET,
    deltaBaseUrl: process.env.DELTA_BASE_URL,
    deltaWsUrl: process.env.DELTA_WEBSOCKET_URL,

    // Delta Trading Parameters
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
    leverage: process.env.DELTA_LEVERAGE,
    orderSize: parseFloat(process.env.ORDER_SIZE),
    
    // Strategy & Risk Management
    priceThreshold: parseFloat(process.env.PRICE_THRESHOLD),
    useBracketOrders: process.env.USE_BRACKET_ORDERS === 'true',
    takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET),
    stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET),
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    
    // Connection Management
    cancelOnDisconnectTimeoutMs: parseInt(process.env.CANCEL_ON_DISCONNECT_TIMEOUT_MS || '60000'),
    reconnectIntervalMs: parseInt(process.env.RECONNECT_INTERVAL || '5000'),
};

// ============================  LOGGER SETUP (Winston) ============================
const logger = winston.createLogger({
    level: config.logLevel,
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [new winston.transports.Console()],
});

// =========================  DELTA REST CLIENT (Completed) ==========================
class DeltaExchangeClient {
    constructor(key, secret) {
        this.key = key; this.secret = secret;
        this.instance = axios.create({ baseURL: config.deltaBaseUrl, timeout: 15000 });
    }

    _sign(method, path, params = {}, body = '') {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const query = qs.stringify(params);
        const preHash = `${method.toUpperCase()}${timestamp}${path}${query ? '?' + query : ''}${body}`;
        return crypto.createHmac('sha256', this.secret).update(preHash).digest('hex');
    }

    async _request(method, path, query = {}, body = undefined) {
        const bodyString = body ? JSON.stringify(body) : '';
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = this._sign(method, path, query, bodyString);
        const headers = { 'api-key': this.key, 'timestamp': timestamp, 'signature': signature, 'Content-Type': 'application/json' };

        try {
            const { data } = await this.instance.request({ method, url: path, headers, params: query, data: bodyString });
            return data;
        } catch (err) {
            logger.error(`API Error on ${method.toUpperCase()} ${path}: ${err.response?.data?.error || err.message}`);
            throw err.response?.data || new Error('Network or API error');
        }
    }

    setLeverage(productId, leverage) {
        return this._request('POST', `/v2/products/${productId}/leverage`, {}, { leverage });
    }
    
    setCancelOnDisconnect(timeoutMs) {
        const payload = { cancel_after: Math.floor(timeoutMs / 1000) };
        return this._request('POST', '/v2/orders/cancel_after', {}, payload);
    }
    
    placeOrder(orderData) {
        return this._request('POST', '/v2/orders', {}, orderData);
    }

    getOpenOrders(productId) {
        return this._request('GET', '/v2/orders', { state: 'open', product_id: productId });
    }

    cancelOrder(orderId, productId) {
        return this._request('DELETE', '/v2/orders', {}, { id: orderId, product_id: productId });
    }

    cancelAll(productId) {
        return this._request('DELETE', '/v2/orders', {}, { product_id: productId });
    }
}

// ============================  TRADING BOT CLASS (Advanced) ============================
class TradingBot {
    constructor() {
        this._validateConfig();
        this.deltaClient = new DeltaExchangeClient(config.deltaApiKey, config.deltaApiSecret);
        this.orderBook = { best_bid: null, best_ask: null };
        this.isOrderbookReady = false;
        this.isPositionOpen = false;
        this.isCoolingDown = false;
        this.lastTradePrice = null;
        this.activeEntryId = null;
    }

    _validateConfig() {
        const required = ['deltaApiKey', 'deltaApiSecret', 'productId', 'productSymbol', 'leverage', 'priceThreshold'];
        for (const key of required) {
            if (!config[key]) {
                logger.error(`FATAL: Configuration error. '${key}' is missing or invalid in .env file.`);
                process.exit(1);
            }
        }
        logger.info('Configuration validated.');
    }

    async initialize() {
        logger.info('--- Bot Initializing (v4.1 - Definitive) ---');
        logger.info(`Loaded Config: Product=${config.productId}, Symbol=${config.productSymbol}, Leverage=${config.leverage}x, Threshold=$${config.priceThreshold}`);
        try {
            await this.deltaClient.setLeverage(config.productId, config.leverage);
            logger.info(`✅ Leverage successfully set to ${config.leverage}x.`);
            await this.deltaClient.setCancelOnDisconnect(config.cancelOnDisconnectTimeoutMs);
            logger.info(`✅ Cancel-on-Disconnect safety timer set.`);
            
            this.connectToDeltaWs();
            this.setupInternalServer();
        } catch (error) {
            logger.error(`❌ FATAL: Failed to initialize bot. The API rejected a startup command.`);
            logger.error(`❌ Please check your .env file: Is the Product ID (${config.productId}) and Leverage (${config.leverage}x) correct for your account region?`);
            process.exit(1);
        }
    }
    
    connectToDeltaWs() {
        if (!config.deltaWsUrl) {
            logger.error("FATAL: DELTA_WEBSOCKET_URL is not defined in .env file.");
            process.exit(1);
        }
        this.ws = new WebSocket(config.deltaWsUrl + '/stream');
        this.ws.on('open', () => {
            logger.info('Connected to Delta Exchange WebSocket.');
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                payload: { channels: [ { name: 'l1_orderbook', symbols: [config.productSymbol] }, { name: 'orders', symbols: [config.productSymbol] } ] }
            }));
        });
        this.ws.on('message', (data) => this._onDeltaMessage(data));
        this.ws.on('close', () => {
            logger.warn(`Delta WS closed. Reconnecting in ${config.reconnectIntervalMs / 1000}s...`);
            this.isOrderbookReady = false;
            setTimeout(() => this.connectToDeltaWs(), config.reconnectIntervalMs);
        });
        this.ws.on('error', (err) => logger.error(`Delta WS Error: ${err.message}`));
    }
    
    _onDeltaMessage(raw) {
        const msg = JSON.parse(raw);
        if (msg.type === 'l1_orderbook') {
            this.orderBook = { best_bid: parseFloat(msg.best_bid), best_ask: parseFloat(msg.best_ask) };
            if (!this.isOrderbookReady) {
                logger.info(`✅ L1 Order book synchronized. BID: ${this.orderBook.best_bid}, ASK: ${this.orderBook.best_ask}`);
                this.isOrderbookReady = true;
            }
        } else if (msg.type === 'orders') {
            if (msg.id === this.activeEntryId && msg.state === 'filled') {
                logger.info(`✅ POSITION OPEN: Entry order ${this.activeEntryId} was filled.`);
                this.isPositionOpen = true;
            } else if (this.isPositionOpen && (msg.order_type === 'stop_loss_order' || msg.order_type === 'take_profit_order') && msg.state === 'filled') {
                logger.info(`✅ POSITION CLOSED: Bracket order (${msg.order_type}) was filled.`);
                this.isPositionOpen = false;
                this.activeEntryId = null;
                this._startCooldown();
            }
        }
    }

    setupInternalServer() {
        const wss = new WebSocket.Server({ port: config.internalWsPort });
        logger.info(`Internal signal server listening on ws://localhost:${config.internalWsPort}`);
        wss.on('connection', ws => {
            logger.info('Price listener connected.');
            ws.on('message', m => this._onInternalSignal(m));
        });
    }

    async _onInternalSignal(message) {
        if (!this.isOrderbookReady) return logger.warn("Signal received, but order book is not ready. Ignoring.");
        if (this.isPositionOpen || this.isCoolingDown) return;

        try {
            const price = parseFloat(JSON.parse(message).p);
            if (!this.lastTradePrice) {
                this.lastTradePrice = price;
                return logger.info(`Initial baseline price set: $${price}`);
            }

            const priceDiff = Math.abs(price - this.lastTradePrice);
            if (priceDiff >= config.priceThreshold) {
                const side = price > this.lastTradePrice ? 'buy' : 'sell';
                await this.executeTrade(side, price);
                this.lastTradePrice = price; // Reset baseline after trade
            }
        } catch (error) {
            logger.error(`Error processing internal signal: ${error.message}`);
        }
    }

    async executeTrade(side, price) {
        logger.info(`TRADE TRIGGER: Side=${side}, Price=${price}. Preparing order.`);
        const orderData = this._prepareOrder(side);
        if (!orderData) return logger.error("Trade aborted: Could not get a valid price from the order book.");
        
        try {
            const resp = await this.deltaClient.placeOrder(orderData);
            this.activeEntryId = resp.result.id;
            logger.info(`✅ Entry order placed. ID: ${this.activeEntryId}, Side: ${side}, Price: ${orderData.limit_price}`);
        } catch (e) {
            // Error is already logged by the client, no need to re-log e.message
        }
    }
    
    _prepareOrder(side) {
        const entryPrice = side === 'buy' ? this.orderBook.best_ask : this.orderBook.best_bid;
        if (!entryPrice) return null;

        const order = {
            product_id: config.productId,
            size: String(config.orderSize),
            side: side,
            order_type: 'limit_order',
            limit_price: String(entryPrice),
            client_order_id: `entry-${uuidv4()}`
        };

        // If bracket orders are enabled in config, add the SL/TP prices.
        if (config.useBracketOrders) {
            const takeProfitPrice = side === 'buy' ? entryPrice + config.takeProfitOffset : entryPrice - config.takeProfitOffset;
            const stopLossPrice = side === 'buy' ? entryPrice - config.stopLossOffset : entryPrice + config.stopLossOffset;
            order.bracket_take_profit_price = String(takeProfitPrice);
            order.bracket_stop_loss_price = String(stopLossPrice);
            logger.info(`Bracket order prepared: TP=${takeProfitPrice}, SL=${stopLossPrice}`);
        }

        return order;
    }

    _startCooldown() {
        this.isCoolingDown = true;
        logger.info(`--- COOLDOWN ${config.cooldownSeconds}s STARTED ---`);
        setTimeout(() => {
            this.isCoolingDown = false;
            logger.info(`--- COOLDOWN ENDED. Ready for new signals. ---`);
        }, config.cooldownSeconds * 1000);
    }
}

// ============================  START BOT  ===============================
try {
    const bot = new TradingBot();
    bot.initialize();
} catch (e) {
    logger.error(`Fatal error on startup: ${e.message}`);
    process.exit(1);
}