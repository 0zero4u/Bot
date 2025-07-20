// client.js
// Version 1.4.0 - FINAL PRODUCTION VERSION

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
            throw error;
        }
    }
    
    async placeOrder(orderData) {
        return this.#request('POST', '/v2/orders', orderData);
    }

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
