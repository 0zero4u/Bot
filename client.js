// client.js
// Version 13.2.0 - [FIXED] HTTP/1.1 Fallback (Stability)

const got = require('got');
const crypto = require('crypto');
const http2 = require('http2-wrapper');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #client;
    #logger;

    constructor(apiKey, apiSecret, baseURL, logger) {
        if (!apiKey || !apiSecret || !baseURL || !logger) {
            throw new Error('DeltaClient requires apiKey, apiSecret, baseURL and logger');
        }
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;

        // --- HTTP Agent ---
        // Using standard agent for HTTP/1.1 reliability
        const agent = {
            http2: new http2.Agent({
                keepAlive: true,
                keepAliveMsecs: 1000,
                maxSockets: 32,
                timeout: 5000
            })
        };

        this.#client = got.extend({
            prefixUrl: baseURL,
            // [FIXED] Set to false to prevent HTTP/2 handshake timeouts
            http2: false, 
            agent: agent,
            timeout: { 
                request: 10000, // Increased timeout for stability
                connect: 5000 
            },
            retry: { limit: 2 },
            headers: {
                'User-Agent': 'nodejs-delta',
                'Accept': 'application/json'
            }
        });
    }

    async #request(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const params = new URLSearchParams(query);
        const qs = params.toString().replace(/%2C/g, ','); 
        const body = data ? JSON.stringify(data) : '';
        
        const sigStr = method.toUpperCase() + timestamp + path + (qs ? `?${qs}` : '') + body;
        const signature = crypto.createHmac('sha256', this.#apiSecret).update(sigStr).digest('hex');

        const headers = {
            'api-key': this.#apiKey,
            'timestamp': timestamp,
            'signature': signature,
            'Content-Type': body ? 'application/json' : undefined
        };

        try {
            const response = await this.#client(path.startsWith('/') ? path.substring(1) : path, {
                method: method,
                searchParams: qs || undefined,
                body: body || undefined,
                headers: headers,
                responseType: 'json'
            });
            return response.body;
        } catch (err) {
            const status = err.response?.statusCode;
            const responseData = err.response?.body;
            if (status !== 400 && status !== 404) {
                this.#logger.error(
                    `[DeltaClient] ${method} ${path} FAILED (Status: ${status}).`, 
                    { error: responseData || err.message }
                );
            }
            throw err; 
        }
    }

    // --- ORDER MANAGEMENT ---

    placeOrder(payload) {
        return this.#request('POST', '/v2/orders', payload);
    }
    
    getPositions() {
        return this.#request('GET', '/v2/positions/margined');
    }

    getLiveOrders(productId, opts = {}) {
        const query = { product_id: productId, states: opts.states || 'open,pending' };
        return this.#request('GET', '/v2/orders', null, query);
    }

    getWalletBalance() {
        return this.#request('GET', '/v2/wallet/balances');
    }
}

module.exports = DeltaClient;
            
