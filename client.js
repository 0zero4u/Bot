// client.js
// Version 1.5.0 - Based on working v1.4.0. Added User-Agent and cancelAllOrders.

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
        
        // <<< THE FIX: Added User-Agent to satisfy the API firewall >>>
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
        const queryString = query ? '?' + new URLSearchParams(query).toString() : '';
        const bodyString = data ? JSON.stringify(data) : '';
        const signatureData = method.toUpperCase() + timestamp + path + queryString + bodyString;
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
            throw error; // This correctly propagates the error to the strategy.
        }
    }
    
    async placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData, null);
    }

    async batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            return Promise.resolve({ success: true, result: 'No orders to cancel.'});
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        return this.#request('DELETE', '/v2/orders/batch', payload, null);
    }
    
    // --- ADDED: Method to get all live orders for a product ---
    async getLiveOrders(productId) {
        if (!productId) {
            throw new Error("productId is required for getLiveOrders.");
        }
        return this.#request('GET', '/v2/orders', null, { product_id: productId });
    }

    // --- ADDED: High-level utility to cancel all open orders for a product ---
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
