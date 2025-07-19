/**
 * Trader Bot for Delta Exchange – Fixed Implementation
 * Aligned with official documentation and working Python client.
 * Handles bracket orders clean-up via private WebSocket feed.
 *
 * Author: Your Name – 2025-07-19
 */

/* ============================  STANDARD LIBS  ============================ */
const WebSocket = require('ws');
const axios = require('axios').default;
const crypto = require('crypto');
const qs = require('querystring');

/* ============================  CONFIGURATION  ============================ */
const config = {
  apiKey: process.env.DELTA_KEY,
  apiSecret: process.env.DELTA_SECRET,
  restBase: 'https://api.delta.exchange',
  wsBase: 'wss://socket.delta.exchange',
  productId: 24,               // BTCUSD Perpetual (example)
  productSymbol: 'BTCUSDTP',   // WebSocket symbol
  size: 1,                     // contracts per trade
  stopPips: 100,               // stop-loss distance
  takePips: 200,               // take-profit distance
  ocoTag: 'BRACKET',           // tag to identify OCO child orders
  cleanupIntervalMs: 30_000,   // periodic duplicate cleanup
};

/* =========================  DELTA REST CLIENT  ========================== */
class DeltaExchangeClient {
  constructor(key, secret) {
    this.key = key;
    this.secret = secret;
    this.instance = axios.create({
      baseURL: config.restBase,
      timeout: 10_000,
    });
  }

  /* ----  PRIVATE SIGNING HELPER (CORRECTED)  ---- */
  _sign(method, path, params = {}, body = '') {
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const query = qs.stringify(params);
    // CORRECTED SIGNATURE FORMAT: method + timestamp + path + query + body
    const preHash = `${method}${timestamp}${path}${query ? '?' + query : ''}${body}`;
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(preHash)
      .digest('hex');
    return { timestamp, signature };
  }

  /* ----  GENERIC REQUEST WRAPPER  ---- */
  async _request(method, path, query = {}, body = undefined) {
    const bodyString = body ? JSON.stringify(body) : '';
    const { timestamp, signature } = this._sign(method, path, query, bodyString);

    const headers = {
      'api-key': this.key,
      'timestamp': timestamp,
      'signature': signature,
      'Content-Type': 'application/json',
      'User-Agent': 'trader-js-v1'
    };

    const opts = {
      method,
      url: path,
      headers,
      params: query,
      data: bodyString,
    };
    
    try {
        const { data } = await this.instance.request(opts);
        return data;
    } catch (err) {
        console.error("API Request Error:", err.response?.data || err.message);
        throw err;
    }
  }

  /* ----  REST ENDPOINTS  ---- */
  placeOrder(order) {
    return this._request('POST', '/v2/orders', {}, order);
  }

  getOpenOrders(productId) {
    return this._request('GET', '/v2/orders', { state: 'open', product_id: productId });
  }

  // CORRECTED: cancelOrder requires the product_id and sends the id in the BODY.
  cancelOrder(orderId, productId) {
    const payload = {
        'id': orderId,
        'product_id': productId
    };
    // The DELETE endpoint for a single order is /v2/orders with the id in the body.
    return this._request('DELETE', `/v2/orders`, {}, payload);
  }

  cancelAll(productId) {
    return this._request('DELETE', '/v2/orders', { product_id: productId });
  }
}

/* ============================  ORDER MANAGER  =========================== */
class OrderManager {
  constructor(deltaClient) {
    this.delta = deltaClient;
    this.active = new Map(); // key: order_id, value: order
  }

  /* Track every open/accepted order */
  upsert(order) {
    if (['open', 'partially_filled', 'accepted'].includes(order.state)) {
      this.active.set(order.id, order);
    } else {
      this.active.delete(order.id);
    }
  }

  /* Remove when filled/cancelled */
  remove(orderId) {
    this.active.delete(orderId);
  }

  /* Identify duplicate stop/tp orders and cancel them */
  async cleanupDuplicateStops() {
    const response = await this.delta.getOpenOrders(config.productId);
    const openOrders = response.result || [];
    
    // Group orders by side and type to identify potential duplicates.
    const orderGroups = {}; 
    for (const ord of openOrders) {
      if (ord.tags && ord.tags.includes(config.ocoTag)) {
        const key = `${ord.side}-${ord.order_type}`;
        if (!orderGroups[key]) {
          orderGroups[key] = [];
        }
        orderGroups[key].push(ord);
      }
    }

    const duplicateIds = [];
    for (const key in orderGroups) {
      const orders = orderGroups[key];
      // If there's more than one order, all but the newest are duplicates.
      if (orders.length > 1) {
        // Sort by created_at timestamp to be certain the last one is the newest.
        orders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const newestOrder = orders[orders.length - 1];
        
        // Add all other orders from this group to the cancellation list.
        for (const ord of orders) {
          if (ord.id !== newestOrder.id) {
            duplicateIds.push(ord.id);
          }
        }
      }
    }

    for (const id of duplicateIds) {
      try {
        // CORRECTED: Pass the productId along with the orderId to be cancelled.
        await this.delta.cancelOrder(id, config.productId);
        console.log(`Cancelled duplicate stop/tp ${id}`);
      } catch (err) {
        // Error is already logged in the request wrapper, but can add more context here if needed.
        console.error(`Failed to cancel order ${id}.`);
      }
    }
  }
}

/* ============================  TRADER CLASS  ============================ */
class Trader {
  constructor() {
    this.delta = new DeltaExchangeClient(config.apiKey, config.apiSecret);
    this.orderManager = new OrderManager(this.delta);

    this.ws = null;
    this.positionOpen = false;
    this.lastEntryId = null;

    this._connectWS();
    setInterval(() => this.orderManager.cleanupDuplicateStops(), config.cleanupIntervalMs);
  }

  /* ----  PRIVATE WEBSOCKET  ---- */
  _connectWS() {
    this.ws = new WebSocket(`${config.wsBase}/stream`);

    this.ws.on('open', () => {
      const subMsg = {
        type: 'subscribe',
        payload: {
          channels: [
            { name: 'orders', symbols: [config.productSymbol] },
            { name: 'positions', symbols: [config.productSymbol] },
          ],
        },
      };
      // WebSocket authentication happens via REST, so just subscribe.
      this.ws.send(JSON.stringify(subMsg));
      console.log('WS connected & subscribed');
    });

    this.ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.type === 'orders') this._onOrderUpdate(msg);
      if (msg.type === 'positions') this._onPositionUpdate(msg);
    });

    this.ws.on('close', () => {
      console.warn('WS closed – reconnecting');
      setTimeout(() => this._connectWS(), 2_000);
    });
    
    this.ws.on('error', (err) => {
        console.error("WebSocket Error:", err.message);
    });
  }

  _onOrderUpdate(msg) {
    this.orderManager.upsert(msg); // The message itself is the order object
    if (msg.id === this.lastEntryId && msg.state === 'filled') {
      this.positionOpen = true;
      console.log('Entry filled – position open');
    }
  }

  _onPositionUpdate(msg) {
      if (msg.symbol === config.productSymbol && msg.net_qty === 0) {
        console.log("Position closed.");
        this.positionOpen = false;
        this.lastEntryId = null;
      }
  }

  /* ----  TRADING LOGIC DEMO  ---- */
  async enterLong(price) {
    if (this.positionOpen) return console.log('Position exists – skip');
    await this.orderManager.cleanupDuplicateStops(); // Pre-clean duplicates

    const entry = {
      product_id: config.productId,
      size: String(config.size),
      price: String(price),
      side: 'buy',
      order_type: 'limit_order',
      time_in_force: 'gtc',
    };

    const resp = await this.delta.placeOrder(entry);
    // Correctly get the ID from the response's result object
    this.lastEntryId = resp.result.id;
    console.log(`Entry order placed: ${this.lastEntryId}`);

    // create bracket children (stop & take)
    const stopPrice = price - config.stopPips;
    const takePrice = price + config.takePips;

    const stopOrder = {
      product_id: config.productId,
      size: String(config.size),
      side: 'sell',
      order_type: 'stop_order', // stop_loss_order is a type of stop_order
      stop_price: String(stopPrice),
      reduce_only: true,
      tags: [config.ocoTag],
    };

    const takeOrder = {
      product_id: config.productId,
      size: String(config.size),
      side: 'sell',
      order_type: 'limit_order', // take_profit_order is a type of limit_order
      price: String(takePrice), // Use 'price' for take profit limit orders
      reduce_only: true,
      post_only: false,
      tags: [config.ocoTag],
    };

    await Promise.all([
      this.delta.placeOrder(stopOrder),
      this.delta.placeOrder(takeOrder),
    ]);

    console.log('Bracket orders (SL & TP) submitted');
  }
}

/* ============================  START BOT  =============================== */
(async () => {
  if (!config.apiKey || !config.apiSecret) {
    console.error("API Key and Secret must be set in environment variables (DELTA_KEY, DELTA_SECRET)");
    process.exit(1);
  }
  
  try {
    const trader = new Trader();

    // Example usage: enter long at a specific price
    // In a real scenario, you would get this price from a live feed.
    console.log("Attempting to enter a long position at 30000...");
    await trader.enterLong(30000);
    
  } catch (e) {
    console.error("An error occurred during bot execution:", e.message);
    process.exit(1);
  }
})();