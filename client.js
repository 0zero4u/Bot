// client.js – v8.1.1 (FIXED: 403-safe REST adapter)
const axios = require('axios');
const crypto = require('crypto');

class DeltaClient {
  #apiKey; #apiSecret; #axios; #logger;
  constructor(apiKey, apiSecret, baseURL, logger) {
    if (!apiKey || !apiSecret || !baseURL || !logger) {
      throw new Error('DeltaClient requires apiKey, apiSecret, baseURL and logger');
    }
    this.#apiKey = apiKey;
    this.#apiSecret = apiSecret;
    this.#logger = logger;
    this.#axios = axios.create({ baseURL, timeout: 15000 });
  }

  /* ---------- PRIVATE CORE ---------- */
  async #request(method, path, data = null, query = null, attempt = 1) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const qs = query ? new URLSearchParams(query).toString() : '';
    const body = data ? JSON.stringify(data) : '';
    
    // --- FIX ---
    // The signature string must have the timestamp at the END. The previous order
    // (timestamp at the beginning) caused a 403 Forbidden error from the CloudFront WAF.
    // Correct format: METHOD + path + body + timestamp
    const sigStr = method.toUpperCase() + path + (qs ? `?${qs}` : '') + body + timestamp;
    const signature = crypto.createHmac('sha256', this.#apiSecret).update(sigStr).digest('hex');

    const headers = {
      'api-key': this.#apiKey,
      timestamp,
      signature,
      Accept: 'application/json'
    };
    // Only attach Content-Type if we are really sending a body
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
      this.#logger.error(`[DeltaClient] ${method} ${path} attempt ${attempt} failed with status ${status}.`, { responseData });
      
      // Retry on 5xx server errors or 406 (Not Acceptable), which might be a transient firewall issue.
      if ((status >= 500 || status === 406) && attempt < 3) {
        this.#logger.warn(`[DeltaClient] Retrying in ${250 * attempt}ms...`);
        await new Promise(r => setTimeout(r, 250 * attempt));  // exponential back-off
        return this.#request(method, path, data, query, attempt + 1);
      }
      throw err; // Re-throw the error if it's not retryable or retries are exhausted.
    }
  }

  /* ---------- PUBLIC WRAPPERS ---------- */
  placeOrder(payload) { return this.#request('POST', '/v2/orders', payload); }

  getLiveOrders(productId) {
    return this.#request('GET', '/v2/orders', null, { product_id: productId });
  }

  async batchCancelOrders(productId, ids) {
    if (!ids?.length) {
        this.#logger.info('[DeltaClient] batchCancelOrders called with no IDs.');
        return { success: true, result: 'nothing-to-do' };
    }
    // Delta API might have a limit on the number of orders in a single batch request.
    // Chunking the requests is a safe way to handle large numbers of cancellations.
    const chunks = [];
    for (let i = 0; i < ids.length; i += 20) { // Using a conservative chunk size of 20
        chunks.push(ids.slice(i, i + 20));
    }

    const results = [];
    for (const slice of chunks) {
      this.#logger.info(`[DeltaClient] Batch cancelling ${slice.length} orders...`);
      const payload = {
            product_id: productId,
            orders: slice.map(id => ({ id }))
      };
      // The DELETE method for batch cancellation sends the product_id in the body, not query.
      const res = await this.#request('DELETE', '/v2/orders/batch', payload, null);
      results.push(res);
    }
    return results;
  }

  async cancelAllOrders(productId) {
    try {
        const live = await this.getLiveOrders(productId);
        const ids = live.result?.map(o => o.id) || [];
        if (!ids.length) {
          this.#logger.info('[DeltaClient] No live orders found to cancel.');
          return;
        }
        this.#logger.info(`[DeltaClient] Found ${ids.length} orders to cancel. Proceeding with batch cancellation.`);
        return this.batchCancelOrders(productId, ids);
    } catch (error) {
        this.#logger.error(`[DeltaClient] Failed to get live orders for cancellation.`, { message: error.message });
        throw error;
    }
  }
}

module.exports = DeltaClient;
