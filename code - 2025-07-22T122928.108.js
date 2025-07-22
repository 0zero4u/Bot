// client.js – v8.1.4 (with “open,pending” cancellation fix)

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
    const qs = query ? new URLSearchParams(query).toString() : '';
    const body = data ? JSON.stringify(data) : '';

    // Signature string per Delta docs: METHOD + timestamp + path + query + body
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

      // Retry on transient errors (5xx / 406) with exponential back-off
      if ((status >= 500 || status === 406) && attempt < 3) {
        const delay = 500 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        return this.#request(method, path, data, query, attempt + 1);
      }

      // Bubble up after retries exhausted or non-retryable error
      throw err;
    }
  }

  /* ---------- PUBLIC WRAPPERS ---------- */

  placeOrder(payload) {
    return this.#request('POST', '/v2/orders', payload);
  }
  
  // ADDED: Method to get all margined positions
  getPositions() {
    return this.#request('GET', '/v2/positions/margined');
  }

  /**
   * Fetch live orders for a product.
   * @param {number} productId
   * @param {{ states?: string }} [opts]  // NEW: allow specifying states
   */
  getLiveOrders(productId, opts = {}) {
    // By default, fetch both open and pending orders
    const query = {
      product_id: productId,
      states: opts.states || 'open,pending'
    };
    return this.#request('GET', '/v2/orders', null, query);
  }

  /**
   * Batch-cancel up to 20 orders at a time.
   * @param {number} productId
   * @param {number[]} ids
   */
  async batchCancelOrders(productId, ids) {
    if (!ids?.length) {
      this.#logger.info('[DeltaClient] batchCancelOrders called with no IDs.');
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
      const res = await this.#request('DELETE', '/v2/orders/batch', payload);
      results.push(res);
    }
    return results;
  }

  /**
   * Cancel all live orders (open or pending) for a product.
   * Retries and ignores any "open_order_not_found" errors.
   * @param {number} productId
   */
  async cancelAllOrders(productId) {
    try {
      // Fetch both open and pending orders
      const live = await this.getLiveOrders(productId, { states: 'open,pending' });
      const ids = live.result?.map((o) => o.id) || [];

      if (!ids.length) {
        this.#logger.info('[DeltaClient] No live orders found to cancel.');
        return;
      }

      this.logger.info(
        `[DeltaClient] Found ${ids.length} orders to cancel. Proceeding with batch cancellation.`
      );

      try {
        return await this.batchCancelOrders(productId, ids);
      } catch (err) {
        // Ignore "open_order_not_found" race errors
        if (err.response?.data?.error?.code === 'open_order_not_found') {
          this.logger.warn(
            '[DeltaClient] Some orders not found (likely already filled/closed); ignoring.'
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