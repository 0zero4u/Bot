// client.js
// Version 1.2.0 - Added getPositions method for startup synchronization

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
            timeout: 10000, // Apply a timeout to all requests
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
            // Ensure query parameters are correctly encoded for the signature
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
            // The API wraps successful responses in a 'result' object
            return response.data.result;
        } catch (error) {
            this.#logger.error(`[DeltaClient] API request failed: ${method} ${path}`, {
                status: error.response?.status,
                data: error.response?.data
            });
            throw error; // Re-throw for the caller to handle
        }
    }
    
    // --- NEWLY ADDED FUNCTION ---
    /**
     * Fetches open positions for a specific product.
     * @param {number} productId - The product ID to fetch positions for.
     * @returns {Promise<Array>} A promise that resolves to an array of position objects.
     */
    async getPositions(productId) {
        return this.#request('GET', '/v2/positions', null, { product_id: productId });
    }
    
    /**
     * Places a new order.
     */
    async placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData);
    }

    /**
     * Cancels a batch of open orders for a given product.
     */
    async batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            return Promise.resolve();
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        return this.#request('DELETE', '/v2/orders/batch', payload);
    }
}

module.exports = DeltaClient;
