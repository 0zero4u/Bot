
/**
 * Trader Bot for Delta Exchange – Fixed Implementation
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

  /* ----  PRIVATE SIGNING HELPER  ---- */
  _sign(method, path, params = {}, body = '') {
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const query = qs.stringify(params);
    const preHash = `${timestamp}${method}${path}${query ? '?' + query : ''}${body}`;
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(preHash)
      .digest('hex');
    return { timestamp, signature };
  }

  /* ----  GENERIC REQUEST WRAPPER  ---- */
  async _request(method, path, query = {}, body = undefined) {
    const { timestamp, signature } = this._sign(method, path, query, body ? JSON.stringify(body) : '');

    const headers = {
      'api-key': this.key,
      'timestamp': timestamp,
      'signature': signature,
    };

    const opts = {
      method,
      url: path,
      headers,
      params: query,
      data: body,
    };
    const { data } = await this.instance.request(opts);
    return data;
  }

  /* ----  REST ENDPOINTS  ---- */
  placeOrder(order) {
    return this._request('POST', '/v2/orders', {}, order);
  }

  getOpenOrders(productId) {
    return this._request('GET', '/v2/orders', { state: 'open', product_id: productId });
  }

  cancelOrder(orderId) {
    return this._request('DELETE', `/v2/orders/${orderId}`);
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
    const openOrders = await this.delta.getOpenOrders(config.productId);
    
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
        // Assuming the API returns orders sorted by creation time (oldest to newest),
        // the last order in the list is the newest one. We want to keep it.
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
        await this.delta.cancelOrder(id);
        console.log(`Cancelled duplicate stop/tp ${id}`);
      } catch (err) {
        console.error('Cancel error', id, err.response?.data || err.message);
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
  }

  _onOrderUpdate({ data }) {
    for (const ord of data) {
      this.orderManager.upsert(ord);
      if (ord.id === this.lastEntryId && ord.state === 'filled') {
        this.positionOpen = true;
        console.log('Entry filled – position open');
      }
    }
  }

  _onPositionUpdate({ data }) {
    for (const pos of data) {
      if (pos.net_qty === 0) {
        this.positionOpen = false;
        this.lastEntryId = null;
      }
    }
  }

  /* ----  TRADING LOGIC DEMO  ---- */
  async enterLong(price) {
    if (this.positionOpen) return console.log('Position exists – skip');
    await this.orderManager.cleanupDuplicateStops(); // Pre-clean duplicates

    const entry = {
      product_id: config.productId,
      size: config.size,
      price: price,
      side: 'buy',
      order_type: 'limit',
      time_in_force: 'gtc',
      text: 'Entry',
    };

    const resp = await this.delta.placeOrder(entry);
    this.lastEntryId = resp.result.id;

    // create bracket children (stop & take)
    const stopPrice = price - config.stopPips;
    const takePrice = price + config.takePips;

    const stopOrder = {
      product_id: config.productId,
      size: config.size,
      side: 'sell',
      order_type: 'stop_loss_order',
      stop_price: stopPrice,
      reduce_only: true,
      post_only: false,
      text: 'SL',
      tags: [config.ocoTag],
    };

    const takeOrder = {
      product_id: config.productId,
      size: config.size,
      side: 'sell',
      order_type: 'take_profit_order',
      stop_price: takePrice,
      reduce_only: true,
      post_only: false,
      text: 'TP',
      tags: [config.ocoTag],
    };

    await Promise.all([
      this.delta.placeOrder(stopOrder),
      this.delta.placeOrder(takeOrder),
    ]);

    console.log('Bracket orders submitted');
  }
}

/* ============================  START BOT  =============================== */
(async () => {
  try {
    const trader = new Trader();

    // Example usage: enter long at current market price
    // You should plug real price feed here.
    trader.enterLong(30000);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
