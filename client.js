// client.js
// Version 2.0.0 - FINAL: Comprehensive client with User-Agent and full method support.

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
                'User-Agent': 'trading-bot-v10.3' // Fixes CloudFront 403 errors
            }
        });
    }

    #signRequest(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const queryString = query ? '?' + new URLSearchParams(query).toString() : '';
        const bodyString = data ? JSON.stringify(data) : '';
        const signatureData = method.toUpperCase() + timestamp + path + queryString + bodyString;
        const signature = crypto.createHmac('sha256', this.#apiSecret).update(signatureData).digest('hex');
        return { timestamp, signature };
    }

    async #request(method, path, data = null, query = null, auth = false) {
        const requestConfig = {
            method,
            url: path,
            params: query,
            data: data,
            headers: {}
        };

        if (auth) {
            const { timestamp, signature } = this.#signRequest(method, path, data, query);
            requestConfig.headers = {
                'api-key': this.#apiKey,
                'timestamp': timestamp,
                'signature': signature,
            };
        }

        try {
            const response = await this.#axiosInstance(requestConfig);
            return response.data;
        } catch (error) {
            this.#logger.error(`[DeltaClient] API request failed: ${method} ${path}`, {
                status: error.response?.status,
                data: error.response?.data
            });
            throw error;
        }
    }
    
    // --- Public, Non-Authenticated Methods ---
    getAssets() {
        return this.#request('GET', '/v2/assets');
    }

    getProduct(productId) {
        if (!productId) throw new Error("productId is required for getProduct.");
        return this.#request('GET', `/v2/products/${productId}`);
    }

    // --- Private, Authenticated Methods ---
    placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData, null, true);
    }

    batchCreateOrders(productId, orders) {
        const payload = { product_id: productId, orders: orders };
        return this.#request('POST', '/v2/orders/batch', payload, null, true);
    }

    batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            return Promise.resolve({ success: true, result: 'No orders to cancel.'});
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        return this.#request('DELETE', '/v2/orders/batch', payload, null, true);
    }
    
    getLiveOrders(productId) {
        if (!productId) throw new Error("productId is required for getLiveOrders.");
        return this.#request('GET', '/v2/orders', null, { product_id: productId }, true);
    }

    async cancelAllOrders(productId) {
        this.#logger.info(`[DeltaClient] Requesting to cancel all orders for product ${productId}...`);
        
        const liveOrdersResponse = await this.getLiveOrders(productId);
        
        if (liveOrdersResponse && liveOrdersResponse.result && liveOrdersResponse.result.length > 0) {
            const orderIdsToCancel = liveOrdersResponse.result.map(o => o.id);
            this.#logger.info(`[DeltaClient] Found open orders to cancel: ${orderIdsToCancel.join(', ')}`);
            return this.batchCancelOrders(productId, orderIdsToCancel);
        } else {
            this.#logger.info(`[DeltaClient] No live orders found for product ${productId} to cancel.`);
            return Promise.resolve({ success: true, result: 'No live orders found.' });
        }
    }
}

module.exports = DeltaClient;
