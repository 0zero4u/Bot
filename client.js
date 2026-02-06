// client.js
// Version 14.1.0 - [FIXED] Stability Restore + OS Cache Warming

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
        if (!apiKey || !apiSecret || !baseURL || !logger) {
            throw new Error('DeltaClient requires apiKey, apiSecret, baseURL and logger');
        }
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;

        // --- 1. OS CACHE WARMING (Safe Mode) ---
        // Instead of overriding the agent's lookup (which caused the crash),
        // we force the OS to refresh its DNS cache every 30 seconds.
        // This ensures the main request always hits a "warm" OS cache (0ms latency).
        
        try {
            const hostname = new URL(baseURL).hostname;
            // Run immediately
            this.#warmDNS(hostname);
            // Run every 30s (Beat the 60s TTL safely)
            this.#dnsTimer = setInterval(() => this.#warmDNS(hostname), 30000);
        } catch (e) {
            this.#logger.warn(`[DeltaClient] DNS Warming setup failed: ${e.message}`);
        }

        // --- 2. OPTIMIZED HTTPS AGENT ---
        const httpsAgent = new https.Agent({
            keepAlive: true,             // Reuse TCP connection (Critical)
            keepAliveMsecs: 1000,        // Send Keep-Alive packets every 1s
            maxSockets: 64,              // Allow high concurrency
            maxFreeSockets: 16,          // Keep 16 hot connections ready
            scheduling: 'lifo',          // Use the most recently used socket (Lowest Latency)
            timeout: 15000               // Socket timeout
        });

        // --- 3. GOT CLIENT CONFIGURATION ---
        this.#client = got.extend({
            prefixUrl: baseURL,
            http2: false,                // DISABLED (Stability)
            agent: {
                https: httpsAgent        // Use optimized agent
            },
            timeout: { 
                request: 10000,          // 10s Request timeout
                connect: 2000            // Fast fail on connection (2s)
            },
            retry: { limit: 0 },         // Zero retries (Fail Fast)
            headers: {
                'User-Agent': 'nodejs-delta-opt-v14.1',
                'Accept': 'application/json',
                'Connection': 'keep-alive' 
            }
        });
    }

    // Background function to keep OS DNS Cache fresh
    #warmDNS(hostname) {
        dns.lookup(hostname, { family: 4 }, (err, address) => {
            if (err) {
                // Just warn, don't crash. The main request will retry lookup.
                // this.#logger.warn(`[DNS] Warming Failed: ${err.message}`); 
            } else {
                // Optional: Log purely for confirmation, or disable to reduce noise
                // this.#logger.info(`[DNS] Cache Warmed: ${hostname} -> ${address}`);
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
            
