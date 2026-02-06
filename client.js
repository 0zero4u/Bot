// client.js
// Version 14.0.0 - Final Low Latency (HTTP/1.1 + KeepAlive + Active DNS Cache)

const got = require('got');
const crypto = require('crypto');
const https = require('https');
const dns = require('dns');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #client;
    #logger;
    #dnsCache;
    #dnsTimer;

    constructor(apiKey, apiSecret, baseURL, logger) {
        if (!apiKey || !apiSecret || !baseURL || !logger) {
            throw new Error('DeltaClient requires apiKey, apiSecret, baseURL and logger');
        }
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;

        // --- 1. ACTIVE DNS CACHING ---
        // Prevents the 79ms lookup spike by caching the IP and refreshing it 
        // in the background *before* the 60s TTL expires.
        this.#dnsCache = { ip: null, family: 4 };
        
        // Extract hostname for DNS lookup (remove https://)
        const hostname = new URL(baseURL).hostname;
        
        // Initial Lookup & Start Refresh Loop (Every 45s to beat 60s TTL)
        this.#refreshDNS(hostname);
        this.#dnsTimer = setInterval(() => this.#refreshDNS(hostname), 45000);

        // --- 2. OPTIMIZED HTTPS AGENT ---
        // Tailored for high-frequency small-packet transmission
        const httpsAgent = new https.Agent({
            keepAlive: true,             // Reuse TCP connection (Critical)
            keepAliveMsecs: 1000,        // Send Keep-Alive packets every 1s
            maxSockets: 64,              // Allow high concurrency
            maxFreeSockets: 16,          // Keep 16 hot connections ready
            scheduling: 'lifo',          // Use the most recently used socket (Lowest Latency)
            timeout: 15000,              // Socket timeout
            
            // Custom Lookup to use our Cache
            lookup: (host, options, callback) => {
                if (host === hostname && this.#dnsCache.ip) {
                    // Instant return from cache (0ms latency)
                    return callback(null, this.#dnsCache.ip, this.#dnsCache.family);
                }
                // Fallback to OS lookup if cache empty
                dns.lookup(host, options, callback);
            }
        });

        // --- 3. GOT CLIENT CONFIGURATION ---
        this.#client = got.extend({
            prefixUrl: baseURL,
            http2: false,                // DISABLED (Stability wins over complexity)
            agent: {
                https: httpsAgent        // Explicitly use our optimized agent
            },
            timeout: { 
                request: 10000,          // 10s Request timeout
                connect: 2000            // Fast fail on connection (2s)
            },
            retry: { limit: 0 },         // Zero retries (Fail Fast strategy)
            headers: {
                'User-Agent': 'nodejs-delta-opt-v14',
                'Accept': 'application/json',
                'Connection': 'keep-alive' 
            }
        });
    }

    // Background DNS Refresher
    #refreshDNS(hostname) {
        dns.lookup(hostname, { family: 4 }, (err, address, family) => {
            if (!err && address) {
                // Only update if changed to avoid noise, but typically CloudFront IPs rotate
                if (this.#dnsCache.ip !== address) {
                    this.#dnsCache = { ip: address, family };
                    this.#logger.info(`[DNS] Active Cache Updated: ${hostname} -> ${address}`);
                }
            } else if (err) {
                this.#logger.warn(`[DNS] Background Refresh Failed: ${err.message}`);
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
            
            // Log real errors, ignore standard 400/404s to keep logs clean
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
        // [LATENCY CRITICAL] This uses the hot socket + cached DNS
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
