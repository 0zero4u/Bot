const got = require('got');
const crypto = require('crypto');
const https = require('https');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #client;
    #logger;

    constructor(apiKey, apiSecret, baseURL, logger) {
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;

        // --- ⚡ DIRECT IP CONFIGURATION ⚡ ---
        // We bypass DNS entirely to save ~800ms
        const DIRECT_IP = '13.227.249.121'; 
        const REAL_HOSTNAME = 'api.india.delta.exchange';

        // --- OPTIMIZED AGENT ---
        const httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 64,
            maxFreeSockets: 16,
            scheduling: 'lifo',
            timeout: 15000,
            // ⚡ SPOOF TLS: We tell the secure handshake we are hitting the domain
            // (Even though we are actually hitting the IP directly)
            servername: REAL_HOSTNAME 
        });

        this.#client = got.extend({
            // ⚡ CONNECT DIRECTLY TO IP
            prefixUrl: `https://${DIRECT_IP}`, 
            http2: false,
            agent: { https: httpsAgent },
            timeout: { request: 10000, connect: 2000 },
            retry: { limit: 0 },
            headers: {
                // ⚡ SPOOF ROUTING: CloudFront needs this to know where to send us
                'Host': REAL_HOSTNAME,
                'User-Agent': 'nodejs-delta-hft-v1',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            // Safety net: Accept the cert since we are spoofing
            https: { rejectUnauthorized: false }
        });
    }

    async #request(method, endpoint, payload = null, qs = {}) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = payload ? JSON.stringify(payload) : '';
        
        // --- ⚡ SLASH LOGIC FIX ⚡ ---
        // 1. Signature MUST have the slash (e.g. "/v2/orders")
        const signaturePath = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
        
        // 2. Request URL MUST NOT have the slash (because of prefixUrl)
        const requestPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;

        let signatureData = method + timestamp + signaturePath;
        if (Object.keys(qs).length > 0) {
            signatureData += '?' + new URLSearchParams(qs).toString();
        }
        if (payload) {
            signatureData += bodyStr;
        }

        const signature = crypto
            .createHmac('sha256', this.#apiSecret)
            .update(signatureData)
            .digest('hex');

        const options = {
            method: method,
            headers: {
                'api-key': this.#apiKey,
                'timestamp': timestamp,
                'signature': signature
            },
            searchParams: qs
        };

        if (payload) {
            options.body = bodyStr;
        }

        try {
            // Send to the Clean Path (No slash)
            const response = await this.#client(requestPath, options);
            
            // Attach timing metrics if available (for debugging)
            if (response.body && typeof response.body === 'object') {
                const timings = response.timings || {};
                Object.defineProperty(response.body, '_metrics', {
                    value: { total: timings.phases?.total || 0 },
                    enumerable: false
                });
            }

            return JSON.parse(response.body);
        } catch (err) {
            const status = err.response?.statusCode;
            const errorBody = err.response?.body;
            
            if (status === 400 || status === 422) {
                this.#logger.error(`[DeltaClient] ❌ REJECTED (${status}): ${errorBody}`);
            } else {
                this.#logger.error(`[DeltaClient] Net Error: ${err.message}`);
            }
            throw err; 
        }
    }

    // --- PUBLIC METHODS ---
    // Note: We pass 'v2/orders' (no slash), but #request handles the signature logic
    placeOrder(payload) { return this.#request('POST', 'v2/orders', payload); }
    getPositions() { return this.#request('GET', 'v2/positions/margined'); }
    getLiveOrders(productId, opts = {}) { return this.#request('GET', 'v2/orders', null, {}); }
    getWalletBalance() { return this.#request('GET', 'v2/wallet/balances'); }
}

module.exports = DeltaClient;
            
