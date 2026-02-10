
const got = require('got');
const crypto = require('crypto');
const https = require('https');
const dns = require('dns');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #client;
    #logger;
    #dnsTimer;

    constructor(apiKey, apiSecret, baseURL, logger) {
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;

        // --- 1. OS CACHE WARMING ---
        try {
            const hostname = new URL(baseURL).hostname;
            this.#warmDNS(hostname);
            this.#dnsTimer = setInterval(() => this.#warmDNS(hostname), 30000);
        } catch (e) {
            this.#logger.warn(`[DeltaClient] DNS Warming setup failed: ${e.message}`);
        }

        // --- 2. OPTIMIZED AGENT (IPv4 FORCED) ---
        const httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 64,
            maxFreeSockets: 16,
            scheduling: 'lifo',
            timeout: 15000,
            // 🔥 IPv4 Force to fix 800ms latency
            lookup: (hostname, options, callback) => {
                options.family = 4;
                dns.lookup(hostname, options, callback);
            }
        });

        this.#client = got.extend({
            prefixUrl: baseURL,
            http2: false,
            agent: { https: httpsAgent },
            timeout: { request: 10000, connect: 2000 },
            retry: { limit: 0 },
            headers: {
                'User-Agent': 'nodejs-delta-hft-v1',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });
    }

    #warmDNS(hostname) {
        dns.lookup(hostname, { family: 4 }, (err, address) => {
            if (!err && this.#logger) {
                // Silently refresh OS DNS cache
            }
        });
    }

    async #request(method, endpoint, payload = null, qs = {}) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const bodyStr = payload ? JSON.stringify(payload) : '';
        
        // Note: We must add the leading slash BACK for the signature calculation
        // because Delta expects it in the signature string (e.g., POST.../v2/orders...)
        const signatureEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;

        let signatureData = method + timestamp + signatureEndpoint;
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
            // Send request WITHOUT the leading slash (required by 'got' prefixUrl)
            const response = await this.#client(endpoint, options);
            
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

    // ✅ FIXED: Removed leading slashes from these calls
    placeOrder(payload) { return this.#request('POST', 'v2/orders', payload); }
    getPositions() { return this.#request('GET', 'v2/positions/margined'); }
    getLiveOrders(productId, opts = {}) { return this.#request('GET', 'v2/orders', null, {}); }
    getWalletBalance() { return this.#request('GET', 'v2/wallet/balances'); }
}

module.exports = DeltaClient;
                   
