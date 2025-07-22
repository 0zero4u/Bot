// client.js – v8.3.0 (FIXED TypeError on optimized single order cancellation)

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

    // Centralized axios instance with sane defaults
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

    const sigStr =
      method.toUpperCase() +
      timestamp +
      path +
      (qs ? `?${qs}` : '') +
      body;

    const signature = crypto
      .createHmac('sha256', this.#apiSecret)
      .update(sigStr)
      .digest('hex');

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
   * [CORRECTED] Cancels a single order by its ID. (Weight: 5)
   * @param {number} productId 
   * @param {number} orderId 
   */
  cancelOrder(productId, orderId) {
    // This is the correct payload for a single order DELETE request.
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
    const query = {
      product_id: productId,
      states: opts.states || 'open,pending'
    };
    return this.#request('GET', '/v2/orders', null, query);
  }

  async batchCancelOrders(productId, ids) {
    if (!ids?.length) {
      this.logger.info('[DeltaClient] batchCancelOrders called with no IDs.');
      return { success: true, result: 'nothing-to-do' };
    }

    const results = [];
    const chunkSize = 20;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const payload = {
        product_id: productId,
        orders: chunk.map((id) => ({ id }))
      };
      // Note: The correct endpoint for batch operations
      const res = await this.#request('DELETE', '/v2/orders/batch', payload);
      results.push(res);
    }
    return results;
  }

  /**
   * [CORRECTED & OPTIMIZED] Cancels all live orders for a product.
   * @param {number} productId
   */
  async cancelAllOrders(productId) {
    try {
      const live = await this.getLiveOrders(productId, { states: 'open,pending' });
      const ids = live.result?.map((o) => o.id) || [];

      if (!ids.length) {
        this.logger.info('[DeltaClient] No live orders found to cancel.');
        return;
      }
      
      this.logger.info(`[DeltaClient] Found ${ids.length} order(s) to cancel.`);

      try {
        // --- INTELLIGENT CANCELLATION LOGIC ---
        if (ids.length === 1) {
          // If there's only one order, use the lightweight single cancel method.
          this.logger.info(`[DeltaClient] Using efficient single order cancellation (Weight: 5).`);
          return await this.cancelOrder(productId, ids[0]); // <--- THIS IS THE FIX
        } else {
          // If there's more than one, use the robust batch method.
          this.logger.info(`[DeltaClient] Using batch cancellation for multiple orders (Weight: 25).`);
          return await this.batchCancelOrders(productId, ids);
        }
      } catch (err) {
        // This catch block now correctly handles API errors, not TypeErrors.
        if (err.response?.data?.error?.code === 'open_order_not_found') {
          this.logger.warn(
            '[DeltaClient] An order was not found (likely already closed/cancelled); ignoring.'
          );
          return;
        }
        throw err;
      }
    } catch (error) {
      this.logger.error(
        '[DeltaClient] Failed to get live orders for cancellation.',
        { message: error.message }
      );
      throw error;
    }
  }
}

module.exports = DeltaClient;
