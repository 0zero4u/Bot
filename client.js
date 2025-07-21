// client.js
// Version 1.6.0 - FINAL: Corrected signature generation and error propagation.

const axios = require('axios');
const crypto = require('crypto');

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

    #signRequest(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        
        // The query string for the signature MUST start with '?' if it exists.
        const queryStringForSig = query ? '?' + new URLSearchParams(query).toString() : '';
        const bodyString = data ? JSON.stringify(data) : '';

        // The signature is always composed of METHOD, timestamp, path, query, and body.
        const signatureData = method.toUpperCase() + timestamp + path + queryStringForSig + bodyString;
        
        const signature = crypto.createHmac('sha256', this.#apiSecret).update(signatureData).digest('hex');
        return { timestamp, signature };
    }

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
            // <<< THE FIX: The error MUST be thrown to be caught by the calling function. >>>
            throw error;
        }
    }
    
    async placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData);
    }

    async getLiveOrders(productId) {
        if (!productId) throw new Error("productId is required for getLiveOrders.");
        return this.#request('GET', '/v2/orders', null, { product_id: productId });
    }

    async batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            this.#logger.info('[DeltaClient] batchCancelOrders called with no order IDs.');
            return Promise.resolve({ success: true, result: 'No orders to cancel.' });
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        return this.#request('DELETE', '/v2/orders/batch', payload);
    }
    
    async cancelAllOrders(productId) {
        this.#logger.info(`[DeltaClient] Requesting to cancel all orders for product ${productId}...`);
        
        // This function now correctly handles errors because #request will throw them.
        const liveOrdersResponse = await this.getLiveOrders(productId);
        
        if (liveOrdersResponse && liveOrdersResponse.result && liveOrdersResponse.result.length > 0) {
            const orderIdsToCancel = liveOrdersResponse.result.map(o => o.id);
            this.#logger.info(`[DeltaClient] Found open orders to cancel: ${orderIdsToCancel.join(', ')}`);
            return this.batchCancelOrders(productId, orderIdsToCancel);
        } else {
            this.#logger.info(`[DeltaClient] No live orders found for product ${productId}.`);
            return Promise.resolve({ success: true, result: 'No live orders found.' });
        }
    }
}

module.exports = DeltaClient;
