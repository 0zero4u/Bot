// client.js
// Version: 14.0.0 (Switched to Standard HTTPS Keep-Alive)

const got = require('got');
const crypto = require('crypto');
const https = require('https'); // Use standard HTTPS

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

        // --- STANDARD HTTPS AGENT (Proven Low Latency) ---
        const agent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 256, // Allow more parallel connections
            maxFreeSockets: 256,
            scheduling: 'lifo',
            timeout: 15000 
        });

        this.#client = got.extend({
            prefixUrl: baseURL,
            http2: false, // <--- DISABLED HTTP/2
            agent: { https: agent },
            timeout: { request: 5000 },
            retry: { limit: 0 },
            headers: {
                'User-Agent': 'nodejs-delta-v1',
                'Accept': 'application/json',
                'Connection': 'keep-alive' // Explicitly request persistence
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
            // Only log actual errors, not "Cancelled" orders which are normal for IOC
            if (status !== 400 && status !== 404) {
                 this.#logger.error(`[DeltaClient] Request Failed: ${err.message}`);
            }
            throw err; 
        }
    }

    // ... (Keep existing methods: placeOrder, getPositions, etc.) ...
    placeOrder(payload) { return this.#request('POST', '/v2/orders', payload); }
    getPositions() { return this.#request('GET', '/v2/positions/margined'); }
    getLiveOrders(productId, opts = {}) {
        const query = { product_id: productId, states: opts.states || 'open,pending' };
        return this.#request('GET', '/v2/orders', null, query);
    }
    getWalletBalance() { return this.#request('GET', '/v2/wallet/balances'); }
}

module.exports = DeltaClient;
            
