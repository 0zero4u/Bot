/**
 * Delta Trader Bot - v3.0 (Advanced)
 * 
 * This version is aligned with a multi-process architecture where this script acts as the trader,
 * receiving signals from a separate price listener via an internal WebSocket.
 * 
 * Key Features:
 * - Loads comprehensive configuration from a .env file.
 * - Uses Winston for robust logging.
 * - Listens for internal trade signals on a WebSocket.
 * - Automatically sets leverage on startup.
 * - Includes critical fixes for authentication signatures and order cancellation.
 * - Places bracket orders (TP/SL) with unique client order IDs.
 */

// ==============  LOAD ENVIRONMENT VARIABLES (Must be at the top) ==============
require('dotenv').config();

// ============================  STANDARD LIBS  ============================
const WebSocket = require('ws');
const axios = require('axios').default;
const crypto = require('crypto');
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
    deltaBaseUrl: process.env.DELTA_BASE_URL || 'https://api.delta.exchange',
    deltaWsUrl: process.env.DELTA_WEBSOCKET_URL || 'wss://socket.delta.exchange',

    // Delta Trading Parameters
    productId: parseInt(process.env.DELTA_PRODUCT_ID),
    productSymbol: process.env.DELTA_PRODUCT_SYMBOL,
    leverage: process.env.DELTA_LEVERAGE,
    orderSize: parseFloat(process.env.ORDER_SIZE || '1.0'),
    
    // Strategy & Risk Management
    useBracketOrders: process.env.USE_BRACKET_ORDERS === 'true',
    takeProfitOffset: parseFloat(process.env.TAKE_PROFIT_OFFSET),
    stopLossOffset: parseFloat(process.env.STOP_LOSS_OFFSET),
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || '30'),
    
    // Connection Management
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

// =========================  DELTA REST CLIENT (Corrected) ==========================
class DeltaExchangeClient {
    constructor(key, secret) {
        if (!key || !secret) {
            throw new Error("API Key and Secret are required.");
        }
        this.key = key;
        this.secret = secret;
        this.instance = axios.create({ baseURL: config.deltaBaseUrl, timeout: 15000 });
    }

    _sign(method, path, params = {}, body = '') {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const query = qs.stringify(params);
        // CORRECTED SIGNATURE FORMAT: method + timestamp + path + query + body
        const preHash = `${method.toUpperCase()}${timestamp}${path}${query ? '?' + query : ''}${body}`;
        const signature = crypto.createHmac('sha256', this.secret).update(preHash).digest('hex');
        return { timestamp, signature };
    }

    async _request(method, path, query = {}, body = undefined) {
        const bodyString = body ? JSON.stringify(body) : '';
        const { timestamp, signature } = this._sign(method, path, query, bodyString);
        const headers = {
            'api-key': this.key,
            'timestamp': timestamp,
            'signature': signature,
            'Content-Type': 'application/json',
            'User-Agent': 'Delta-Trader-Bot-v3'
        };

        try {
            const { data } = await this.instance.request({ method, url: path, headers, params: query, data: bodyString });
            return data;
        } catch (err) {
            logger.error(`API Error on ${method} ${path}: ${err.response?.data?.error || err.message}`);
            throw err.response?.data || err;
        }
    }

    placeOrder(order) {
        return this._request('POST', '/v2/orders', {}, order);
    }

    getOpenOrders(productId) {
        return this._request('GET', '/v2/orders', { state: 'open', product_id: productId });
    }
    
    // CORRECTED: Sends DELETE with payload in body
    cancelOrder(orderId, productId) {
        const payload = { 'id': orderId, 'product_id': productId };
        return this._request('DELETE', '/v2/orders', {}, payload);
    }

    setLeverage(productId, leverage) {
        logger.info(`Setting leverage for product ${productId} to ${leverage}x.`);
        return this._request('POST', `/v2/products/${productId}/leverage`, {}, { leverage });
    }
}

// ============================  TRADER CLASS (Advanced) ============================
class Trader {
    constructor() {
        this.delta = new DeltaExchangeClient(config.deltaApiKey, config.deltaApiSecret);
        this.positionOpen = false;
        this.lastEntryId = null;
        this.inCooldown = false;
        this.ws = null;

        this._validateConfig();
    }

    _validateConfig() {
        const required = ['productId', 'productSymbol', 'leverage', 'deltaApiKey', 'deltaApiSecret'];
        for (const key of required) {
            if (!config[key]) {
                logger.error(`CRITICAL: Configuration error. '${key}' is missing from config or .env file.`);
                process.exit(1);
            }
        }
    }
    
    async initialize() {
        logger.info('Initializing Trader...');
        try {
            await this.delta.setLeverage(config.productId, parseInt(config.leverage));
        } catch (e) {
            logger.error('Failed to set leverage. Please check permissions and product ID. Exiting.');
            process.exit(1);
        }
        this._connectDeltaWS();
        this._startInternalServer();
    }

    _connectDeltaWS() {
        this.ws = new WebSocket(config.deltaWsUrl + '/stream');
        this.ws.on('open', () => logger.info('Connected to Delta Exchange WebSocket feed.'));
        this.ws.on('message', (data) => this._onDeltaMessage(data));
        this.ws.on('close', () => {
            logger.warn(`Delta WS closed. Reconnecting in ${config.reconnectIntervalMs / 1000}s...`);
            setTimeout(() => this._connectDeltaWS(), config.reconnectIntervalMs);
        });
        this.ws.on('error', (err) => logger.error(`Delta WS Error: ${err.message}`));
    }

    _onDeltaMessage(raw) {
        const msg = JSON.parse(raw);
        if (msg.type === 'orders' && msg.id === this.lastEntryId && msg.state === 'filled') {
            this.positionOpen = true;
            logger.info(`Entry order ${msg.id} was filled. Position is now OPEN.`);
        }
        if (msg.type === 'positions' && msg.symbol === config.productSymbol && msg.net_qty === 0 && this.positionOpen) {
            logger.info(`Position for ${config.productSymbol} is now CLOSED.`);
            this.positionOpen = false;
            this.lastEntryId = null;
            this._startCooldown();
        }
    }

    _startInternalServer() {
        const wss = new WebSocket.Server({ port: config.internalWsPort });
        logger.info(`Internal signal server started on ws://localhost:${config.internalWsPort}`);
        wss.on('connection', (ws) => {
            logger.info('Price listener connected to internal server.');
            ws.on('message', (message) => this._onInternalSignal(message));
        });
    }

    async _onInternalSignal(message) {
        try {
            const signal = JSON.parse(message);
            logger.info(`Received trade signal: ${signal.side} at price ${signal.price}`);
            if (this.positionOpen || this.inCooldown) {
                logger.warn(`Execution skipped: Position open (${this.positionOpen}) or in cooldown (${this.inCooldown}).`);
                return;
            }
            await this.executeTrade(signal.side, signal.price);
        } catch (e) {
            logger.error(`Failed to process internal signal: ${e.message}`);
        }
    }
    
    async executeTrade(side, price) {
        logger.info(`Executing ${side} trade for ${config.orderSize} contracts at price ${price}.`);
        const clientOrderId = `entry-${uuidv4()}`;
        const entryOrder = {
            product_id: config.productId,
            size: String(config.orderSize),
            price: String(price),
            side: side,
            order_type: 'limit_order',
            client_order_id: clientOrderId,
        };

        try {
            const resp = await this.delta.placeOrder(entryOrder);
            this.lastEntryId = resp.result.id;
            logger.info(`Entry order placed. ID: ${this.lastEntryId}, Client ID: ${clientOrderId}`);
            
            if (config.useBracketOrders) {
                await this.placeBracketOrders(side, price);
            }
        } catch (e) {
            logger.error(`Failed to place entry order: ${e.error || e.message}`);
        }
    }
    
    async placeBracketOrders(entrySide, entryPrice) {
        const exitSide = entrySide === 'buy' ? 'sell' : 'buy';
        const tpPrice = entrySide === 'buy' ? entryPrice + config.takeProfitOffset : entryPrice - config.takeProfitOffset;
        const slPrice = entrySide === 'buy' ? entryPrice - config.stopLossOffset : entryPrice + config.stopLossOffset;

        const takeProfitOrder = {
            product_id: config.productId,
            size: String(config.orderSize),
            side: exitSide,
            order_type: 'limit_order',
            price: String(tpPrice.toFixed(2)),
            reduce_only: true,
            client_order_id: `tp-${uuidv4()}`
        };

        const stopLossOrder = {
            product_id: config.productId,
            size: String(config.orderSize),
            side: exitSide,
            order_type: 'stop_order',
            stop_price: String(slPrice.toFixed(2)),
            reduce_only: true,
            client_order_id: `sl-${uuidv4()}`
        };

        logger.info(`Placing bracket orders: TP at ${tpPrice.toFixed(2)}, SL at ${slPrice.toFixed(2)}`);
        try {
            await Promise.all([
                this.delta.placeOrder(takeProfitOrder),
                this.delta.placeOrder(stopLossOrder),
            ]);
            logger.info('Bracket orders (TP & SL) submitted successfully.');
        } catch(e) {
            logger.error(`Failed to place bracket orders: ${e.error || e.message}`);
        }
    }
    
    _startCooldown() {
        this.inCooldown = true;
        logger.info(`Entering ${config.cooldownSeconds}s cooldown period.`);
        setTimeout(() => {
            logger.info('Cooldown finished. Ready for new signals.');
            this.inCooldown = false;
        }, config.cooldownSeconds * 1000);
    }
}

// ============================  START BOT  ===============================
(async () => {
    try {
        const trader = new Trader();
        await trader.initialize();
    } catch (e) {
        logger.error(`A fatal error occurred during bot startup: ${e.message}`);
        process.exit(1);
    }
})();
