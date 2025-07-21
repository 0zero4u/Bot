// client.js
// Version 8.0.0 - FINAL: A direct and correct implementation based on official documentation.

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
                'User-Agent': 'trading-bot-v10.8' // Required by API firewall
            }
        });
    }

    async #request(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        
        // --- THE DEFINITIVE FIX ---
        // 1. Generate the query string. It's an empty string if `query` is null.
        const queryString = query ? new URLSearchParams(query).toString() : '';
        
        // 2. Generate the body string. It's an empty string if `data` is null.
        const bodyString = data ? JSON.stringify(data) : '';

        // 3. For the signature, the query string MUST be prefixed with '?' if it exists.
        const queryStringForSig = queryString ? '?' + queryString : '';

        // 4. Build the final signature string from the distinct components, exactly as per the official examples.
        const signatureData = method.toUpperCase() + timestamp + path + queryStringForSig + bodyString;
        
        this.#logger.debug(`[DeltaClient] Signing string: "${signatureData}"`);

        const signature = crypto.createHmac('sha256', this.#apiSecret).update(signatureData).digest('hex');

        try {
            // 5. Make the request using the original path and query object. `axios` will handle the final URL construction.
            const response = await this.#axiosInstance({
                method,
                url: path,
                params: query,
                data: data,
                headers: {
                    'api-key': this.#apiKey,
                    'timestamp': timestamp,
                    'signature': signature,
                }
            });
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
        return this.#request('POST', '/v2/orders', orderData, null);
    }

    getLiveOrders(productId) {
        if (!productId) throw new Error("productId is required for getLiveOrders.");
        // This is a direct implementation of the `get_live_orders` Python function.
        return this.#request('GET', '/v2/orders', null, { product_id: productId });
    }

    batchCancelOrders(productId, orderIds) {
        if (!orderIds || orderIds.length === 0) {
            return Promise.resolve({ success: true, result: 'No orders to cancel.' });
        }
        const payload = {
            product_id: productId,
            orders: orderIds.map(id => ({ id }))
        };
        // This is a direct implementation of the `batch_cancel` Python function.
        return this.#request('DELETE', '/v2/orders/batch', payload, null);
    }
    
    async cancelAllOrders(productId) {
        this.#logger.info(`[DeltaClient] Requesting to cancel all orders for product ${productId}...`);
        
        try {
            // This now correctly calls the fixed `getLiveOrders`.
            const liveOrdersResponse = await this.getLiveOrders(productId);

            if (liveOrdersResponse && liveOrdersResponse.result && liveOrdersResponse.result.length > 0) {
                const orderIdsToCancel = liveOrdersResponse.result.map(o => o.id);
                this.#logger.info(`[DeltaClient] Found open orders to cancel: ${orderIdsToCancel.join(', ')}`);
                // This now correctly calls the fixed `batchCancelOrders`.
                return this.batchCancelOrders(productId, orderIdsToCancel);
            } else {
                this.#logger.info(`[DeltaClient] No live orders found for product ${productId}.`);
                return Promise.resolve({ success: true, result: 'No live orders found.' });
            }
        } catch (error) {
            this.#logger.error(`[DeltaClient] Failed to execute cancelAllOrders due to an API error.`);
            return Promise.resolve({ success: false, error: 'API error during getLiveOrders prevented cancellation.' });
        }
    }
}

module.exports = DeltaClient;
