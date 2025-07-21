// client.js
// Version 5.0.0 - FINAL & CORRECTED: Implements the exact signature logic from official documentation.

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
            timeout: 15000,
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'trading-bot-v10.5' // Required by API firewall
            }
        });
    }

    async #request(method, path, data = null, query = null, auth = true) {
        const requestConfig = {
            method,
            url: path, // Only the path, e.g., /v2/orders
            params: query,
            data: data,
            headers: {}
        };

        if (auth) {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            
            // <<< THE DEFINITIVE FIX >>>
            // Create the query and body strings exactly as per documentation.
            const queryString = query ? '?' + new URLSearchParams(query).toString() : '';
            const bodyString = data ? JSON.stringify(data) : '';

            // The signature path is composed of the distinct components.
            const signatureData = method.toUpperCase() + timestamp + path + queryString + bodyString;
            
            this.#logger.debug(`[DeltaClient] Signing string: "${signatureData}"`);

            const signature = crypto.createHmac('sha256', this.#apiSecret).update(signatureData).digest('hex');

            // Add authentication headers to the request config.
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
            this.#logger.error(`[DeltaClient] API Request Failed: ${method} ${path}`, {
                status: error.response?.status,
                data: error.response?.data
            });
            throw error;
        }
    }
    
    // --- Authenticated Methods ---
    placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData, null, true);
    }

    getLiveOrders(productId) {
        if (!productId) throw new Error("productId is required for getLiveOrders.");
        return this.#request('GET', '/v2/orders', null, { product_id: productId }, true);
    }

    batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            return Promise.resolve({ success: true, result: 'No orders to cancel.' });
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        return this.#request('DELETE', '/v2/orders/batch', payload, null, true);
    }
    
    async cancelAllOrders(productId) {
        this.#logger.info(`[DeltaClient] Requesting to cancel all orders for product ${productId}...`);
        
        try {
            const liveOrdersResponse = await this.getLiveOrders(productId);
            if (liveOrdersResponse && liveOrdersResponse.result && liveOrdersResponse.result.length > 0) {
                const orderIdsToCancel = liveOrdersResponse.result.map(o => o.id);
                this.#logger.info(`[DeltaClient] Found open orders to cancel: ${orderIdsToCancel.join(', ')}`);
                return this.batchCancelOrders(productId, orderIdsToCancel);
            } else {
                this.#logger.info(`[DeltaClient] No live orders found for product ${productId}.`);
                return Promise.resolve({ success: true, result: 'No live orders found.' });
            }
        } catch (error) {
            this.#logger.error(`[DeltaClient] Failed to execute cancelAllOrders due to an API error.`);
            // Return a consistent failure object
            return Promise.resolve({ success: false, error: 'API error during getLiveOrders prevented cancellation.' });
        }
    }
}

module.exports = DeltaClient;
