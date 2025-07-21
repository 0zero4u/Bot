// client.js
// Version 1.8.0 - FINAL: Corrected signature generation to match official documentation precisely.

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
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'trading-bot-v10.3'
            }
        });
    }

    #signRequest(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();

        // <<< THE DEFINITIVE FIX >>>
        // The query string must be generated and prefixed with '?' ONLY if params exist.
        // It is a separate component from the 'path'.
        const queryString = query ? '?' + new URLSearchParams(query).toString() : '';
        const bodyString = data ? JSON.stringify(data) : '';

        // The signature is built from the distinct components, exactly as per the documentation.
        const signatureData = method.toUpperCase() + timestamp + path + queryString + bodyString;
        
        this.#logger.debug(`[DeltaClient] Signing string: "${signatureData}"`);

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
            throw error;
        }
    }
    
    async placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData, null);
    }

    async getLiveOrders(productId) {
        if (!productId) throw new Error("productId is required for getLiveOrders.");
        return this.#request('GET', '/v2/orders', null, { product_id: productId });
    }

    async batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            return Promise.resolve({ success: true, result: 'No orders to cancel.' });
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        return this.#request('DELETE', '/v2/orders/batch', payload, null);
    }
    
    async cancelAllOrders(productId) {
        this.#logger.info(`[DeltaClient] Requesting to cancel all orders for product ${productId}...`);
        
        const liveOrdersResponse = await this.getLiveOrders(productId);
        
        if (liveOrdersResponse && liveOrdersResponse.result && liveOrdersResponse.result.length > 0) {
            const orderIdsToCancel = liveOrdersResponse.result.map(o => o.id);
            this.#logger.info(`[DeltaClient] Found open orders to cancel: ${orderIdsToCancel.join(', ')}`);
            return this.batchCancelOrders(productId, orderIdsToCancel);
        } else if (liveOrdersResponse.result && liveOrdersResponse.result.length === 0) {
            this.#logger.info(`[DeltaClient] No live orders found for product ${productId}.`);
            return Promise.resolve({ success: true, result: 'No live orders found.' });
        } else {
            // This case handles when the API call itself fails.
            this.#logger.error(`[DeltaClient] Failed to get live orders. Cannot proceed with cancelAllOrders.`);
            // Create a consistent error object to be returned
            return Promise.resolve({ success: false, error: 'Failed to retrieve live orders to cancel.' });
        }
    }
}

module.exports = DeltaClient;
