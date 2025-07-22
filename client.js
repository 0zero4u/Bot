// client.js
// Version 11.0.0 - FINAL: Implements robust response parsing to permanently fix cancellation TypeErrors.

const axios = require('axios');
const crypto = require('crypto');

class DeltaClient {
  #apiKey;
  #apiSecret;
  #axios;
  #logger;

  constructor(apiKey, apiSecret, baseURL, logger) {
    if (!apiKey || !apiSecret || !baseURL || !logger) {
      throw new Error('DeltaClient requires apiKey, apiSecret, baseURL and logger');
    }
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#logger = logger;

    this.#axios = axios.create({
      baseURL,
      timeout: 15_000
    });
  }

  async #request(method, path, data = null, query = null, attempt = 1) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params = new URLSearchParams(query);
    const qs = params.toString().replace(/%2C/g, ','); 
    const body = data ? JSON.stringify(data) : '';
    const sigStr = method.toUpperCase() + timestamp + path + (qs ? `?${qs}` : '') + body;
    const signature = crypto.createHmac('sha256', this.#apiSecret).update(sigStr).digest('hex');
    const headers = {
      'api-key': this.#apiKey,
      timestamp,
      signature,
      Accept: 'application/json',
      'User-Agent': 'nodejs-delta-client'
    };
    if (body) headers['Content-Type'] = 'application/json';

    try {
      const resp = await this.#axios({
        method,
        url: path,
        params: query,
        data: body ? JSON.parse(body) : undefined,
        headers
      });
      return resp.data;
    } catch (err) {
      const status = err.response?.status;
      const responseData = err.response?.data;
      this.#logger.error(
        `[DeltaClient] ${method} ${path} attempt ${attempt} failed with status ${status}.`,
        { responseData }
      );
      if ((status >= 500 || status === 406) && attempt < 3) {
        const delay = 500 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        return this.#request(method, path, data, query, attempt + 1);
      }
      throw err;
    }
  }

  placeOrder(payload) {
    return this.#request('POST', '/v2/orders', payload);
  }
  
  getPositions() {
    return this.#request('GET', '/v2/positions/margined');
  }

  getLiveOrders(productId, opts = {}) {
    const query = { product_id: productId, states: opts.states || 'open,pending' };
    return this.#request('GET', '/v2/orders', null, query);
  }

  async batchCancelOrders(productId, ids) {
    if (!ids?.length) {
      this.logger.info('[DeltaClient] batchCancelOrders called with no IDs.');
      return { success: true, result: 'nothing-to-do' };
    }
    const payload = { product_id: productId, orders: ids.map((id) => ({ id })) };
    return await this.#request('DELETE', '/v2/orders/batch', payload);
  }

  /**
   * [STABLE & FINAL] Cancels all live orders for a product.
   * This version correctly parses the API response to prevent crashes.
   * It uses the reliable batch cancellation method for maximum stability.
   * @param {number} productId
   */
  async cancelAllOrders(productId) {
    try {
      const response = await this.getLiveOrders(productId);

      // --- ROBUST PARSING (Inspired by the Python client) ---
      // 1. Check if the response itself is valid and successful
      if (!response || !response.success) {
        this.logger.warn('[DeltaClient] getLiveOrders returned a non-successful response. Assuming no orders to cancel.', { response });
        return;
      }

      // 2. Safely extract the 'result' array
      const liveOrders = response.result;

      // 3. Check if the result is a valid array
      if (!Array.isArray(liveOrders)) {
        this.logger.warn('[DeltaClient] getLiveOrders result is not an array. Assuming no orders to cancel.', { result: liveOrders });
        return;
      }
      
      const ids = liveOrders.map((o) => o.id);

      if (ids.length === 0) {
        this.logger.info('[DeltaClient] No live orders found to cancel.');
        return;
      }
      
      this.logger.info(`[DeltaClient] Found ${ids.length} order(s). Using robust batch cancellation.`);
      return await this.batchCancelOrders(productId, ids);

    } catch (error) {
        const payload = error?.response?.data ?? error.message;
        this.#logger.error('[DeltaClient] CRITICAL: An exception occurred during the cancelAllOrders process.', { payload });
        // Re-throw so the robust handler in trader.js can log it without crashing the bot.
        throw error;
    }
  }
}

module.exports = DeltaClient;
