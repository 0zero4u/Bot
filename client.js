// client.js
// Version 15.0.0 - [X-RAY] Granular Latency Logging

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

        // --- 2. OPTIMIZED AGENT ---
        const httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 64,
            maxFreeSockets: 16,
            scheduling: 'lifo',
            timeout: 15000
        });

        this.#client = got.extend({
            prefixUrl: baseURL,
            http2: false,
            agent: { https: httpsAgent },
            timeout: { request: 10000, connect: 2000 },
            retry: { limit: 0 },
            headers: {
                'User-Agent': 'nodejs-delta-xray',
                'Accept': 'application/json',
                'Connection': 'keep-alive' 
            }
        });
    }

    #warmDNS(hostname) {
        dns.lookup(hostname, { family: 4 }, (err, address) => { });
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

            // [X-RAY] Extract precise timings from the response
            const timings = response.timings;
            
            // Attach timings to the body so Strategy can log them
            // We use a non-enumerable property to avoid breaking normal usage
            if (response.body && typeof response.body === 'object') {
                Object.defineProperty(response.body, '_metrics', {
                    value: {
                        dns: timings.phases.dns,      // Should be ~0ms
                        tcp: timings.phases.tcp,      // Should be ~0ms
                        tls: timings.phases.tls,      // Should be ~0ms
                        server: timings.phases.total  // Total Request time
                    },
                    enumerable: false
                });
            }

            return response.body;
        } catch (err) {
            const status = err.response?.statusCode;
            const responseData = err.response?.body;
            if (status !== 400 && status !== 404) {
                this.#logger.error(`[DeltaClient] Request Failed: ${err.message}`);
            }
            throw err; 
        }
    }

    placeOrder(payload) { return this.#request('POST', '/v2/orders', payload); }
    getPositions() { return this.#request('GET', '/v2/positions/margined'); }
    getLiveOrders(productId, opts = {}) { return this.#request('GET', '/v2/orders', null, {}); }
    getWalletBalance() { return this.#request('GET', '/v2/wallet/balances'); }
}

module.exports = DeltaClient;
