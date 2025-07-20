// DeltaClient.js
const axios = require('axios');
const crypto = require('crypto');

/**
 * A dedicated client for handling all communication with the Delta Exchange API.
 */
class DeltaClient {
    #apiKey;
    #apiSecret;
    #axiosInstance;
    #logger;

    constructor(apiKey, apiSecret, baseURL, logger) {
        if (!apiKey || !apiSecret || !baseURL || !logger) {
            throw new Error("DeltaClient requires apiKey, apiSecret, baseURL, and a logger.");
        }
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;
        this.#axiosInstance = axios.create({
            baseURL: baseURL,
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    /**
     * Generates the required signature for an authenticated API request.
     * @private
     */
    #signRequest(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        let signatureData = method.toUpperCase() + timestamp + path;
        if (query) {
            signatureData += '?' + new URLSearchParams(query).toString();
        }
        if (data) {
            signatureData += JSON.stringify(data);
        }
        const signature = crypto.createHmac('sha256', this.#apiSecret).update(signatureData).digest('hex');
        return { timestamp, signature };
    }

    /**
     * The core private method for making a signed API request.
     * @private
     */
    async #request(method, path, data = null, query = null) {
        const { timestamp, signature } = this.#signRequest(method, path, data, query);
        try {
            const response = await this.#axiosInstance({
                method,
                url: path,
                headers: {
                    'api-key': this.#apiKey,
                    'timestamp': timestamp,
                    'signature': signature,
                },
                params: query,
                data: data
            });
            return response.data;
        } catch (error) {
            this.#logger.error(`[DeltaClient] API request failed: ${method} ${path}`, {
                status: error.response?.status,
                data: error.response?.data
            });
            throw error; // Re-throw for the caller to handle
        }
    }

    /**
     * Places a new order.
     * @param {object} orderData - The order payload.
     * @returns {Promise<object>} The API response from the exchange.
     */
    async placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData);
    }

    /**
     * Cancels a batch of open orders for a given product.
     * @param {number} productId - The product ID for the orders being cancelled.
     * @param {Array<string|number>} orderIds - An array of order IDs to cancel.
     * @returns {Promise<object>} The API response from the exchange.
     */
    async batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            this.#logger.info("[DeltaClient] batchCancelOrders called with no IDs. Skipping.");
            return Promise.resolve();
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        this.#logger.info(`[DeltaClient] Batch cancelling orders:`, orderIds);
        return this.#request('DELETE', '/v2/orders/batch', payload);
    }
}

module.exports = DeltaClient;