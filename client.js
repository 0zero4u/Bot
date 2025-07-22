// client.js – v10.0.0 (STABLE & OPTIMIZED)
// Implements a defensive, efficient cancellation logic for single-order scenarios.

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

  /* ---------- PRIVATE CORE ---------- */

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

  /* ---------- PUBLIC WRAPPERS ---------- */

  placeOrder(payload) {
    return this.#request('POST', '/v2/orders', payload);
  }

  /**
   * Helper function to cancel a single order. (Weight: 5)
   * @param {number} productId 
   * @param {number} orderId 
   */
  cancelSingleOrder(productId, orderId) {
    const payload = { 
        product_id: productId,
        id: orderId 
    };
    return this.#request('DELETE', '/v2/orders', payload);
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
   * [OPTIMIZED & SAFE] Cancels all live orders for a product.
   * Uses a lightweight call for the common single-order case, with a robust fallback.
   * @param {number} productId
   */
  async cancelAllOrders(productId) {
    try {
      const live = await this.getLiveOrders(productId, { states: 'open,pending' });

      // --- Defensive Check 1: Ensure the response from the exchange is valid ---
      if (!live || !Array.isArray(live.result)) {
        this.logger.warn('[DeltaClient] getLiveOrders returned an invalid response. Falling back to robust batch cancel.', { response: live });
        // As a fallback, try to cancel all, even without knowing the IDs. This endpoint handles it.
        return await this.#request('DELETE', '/v2/orders/all', { product_id: productId });
      }
      
      const ids = live.result.map((o) => o.id);

      // --- Defensive Check 2: Handle the order count ---
      if (ids.length === 1) {
        // HAPPY PATH: Exactly one order found. Use the efficient method.
        this.logger.info(`[DeltaClient] Found 1 order. Using efficient single order cancellation (Weight: 5).`);
        return await this.cancelSingleOrder(productId, ids[0]);
      }
      
      if (ids.length === 0) {
        // No orders found, nothing to do.
        this.logger.info('[DeltaClient] No live orders found to cancel.');
        return;
      }
      
      // SAFE PATH: 0 or >1 orders found. Use the robust batch method just in case.
      this.logger.warn(`[DeltaClient] Found ${ids.length} orders. Using robust batch cancellation as a safeguard (Weight: 25).`);
      return await this.batchCancelOrders(productId, ids);

    } catch (error) {
        // This catch block handles errors from the API calls themselves (e.g., network issues)
        this.logger.error('[DeltaClient] CRITICAL: An error occurred during the cancellation process.', { message: error.message });
        // Re-throw so the robust handler in trader.js can log it without crashing the bot.
        throw error;
    }
  }
}

module.exports = DeltaClient;
