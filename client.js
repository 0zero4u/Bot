// client.js
// Version: 15.0.0 (Final Production - HFT Keep-Alive LIFO)

const got = require('got');
const crypto = require('crypto');
const https = require('https'); 

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

        // --- HFT INFRASTRUCTURE: DEDICATED KEEP-ALIVE AGENT ---
        // This agent manages the TCP connection pool to the exchange.
        const agent = new https.Agent({
            keepAlive: true,        // CRITICAL: Keeps the TCP connection open between trades
            keepAliveMsecs: 1000,   // Send TCP Keep-Alive packets every 1s to prevent timeouts
            maxSockets: 32,        // Allow up to 100 parallel requests (prevents blocking)
            maxFreeSockets: 50,     // Keep 50 "hot" connections ready in the pool
            scheduling: 'lifo',     // CRITICAL: Reuse the most recently used (fastest) socket first
            timeout: 60000          // Close sockets that have been dead for 60s
        });

        // Initialize 'got' HTTP client with the optimized agent
        this.#client = got.extend({
            prefixUrl: baseURL,
            http2: false,           // DISABLE HTTP/2 to avoid handshake overhead on AWS CloudFront
            agent: { https: agent },
            timeout: { request: 5000 }, // Fail fast if network hangs (5s)
            retry: { limit: 0 },    // HFT Rule: Never retry old orders. Fail and move on.
            headers: {
                'User-Agent': 'nodejs-delta-hft-v15',
                'Accept': 'application/json',
                'Connection': 'keep-alive' // Explicitly tell the server to hold the line
            }
        });
    }

    // --- PRIVATE REQUEST HANDLER ---
    async #request(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const params = new URLSearchParams(query);
        const qs = params.toString().replace(/%2C/g, ','); 
        const body = data ? JSON.stringify(data) : '';
        
        // Generate Signature
        const sigStr = method.toUpperCase() + timestamp + path + (qs ? `?${qs}` : '') + body;
        const signature = crypto.createHmac('sha256', this.#apiSecret).update(sigStr).digest('hex');

        try {
            const response = await this.#client(path.startsWith('/') ? path.substring(1) : path, {
                method: method,
                searchParams: qs || undefined,
                body: body || undefined,
                headers: { 
                    'api-key': this.#apiKey, 
                    'timestamp': timestamp, 
                    'signature': signature,
                    'Content-Type': body ? 'application/json' : undefined
                },
                responseType: 'json'
            });
            return response.body;
        } catch (err) {
            const status = err.response?.statusCode;
            const responseData = err.response?.body;
            
            // Ignore "Cancelled" errors for IOC orders (Standard HFT behavior)
            // But log critical errors (Auth failures, Rate limits)
            if (status !== 400 && status !== 404) {
                this.#logger.error(
                    `[DeltaClient] ${method} ${path} FAILED (Status: ${status}).`, 
                    { error: responseData || err.message }
                );
            }
            throw err; 
        }
    }

    // --- PUBLIC API METHODS ---

    /**
     * Places a Limit or Market order.
     * HFT Note: For IOC orders, this returns immediately after the exchange accepts/rejects.
     */
    placeOrder(payload) {
        return this.#request('POST', '/v2/orders', payload);
    }
    
    /**
     * Fetches current margined positions.
     * Used for initial sync and position checks.
     */
    getPositions() {
        return this.#request('GET', '/v2/positions/margined');
    }

    /**
     * Gets live orders.
     * Useful for tracking open limit orders (non-IOC).
     */
    getLiveOrders(productId, opts = {}) {
        const query = { product_id: productId, states: opts.states || 'open,pending' };
        return this.#request('GET', '/v2/orders', null, query);
    }

    /**
     * Fetches Wallet Balances.
     * Also used as the "Keep-Alive Heartbeat" every 25s.
     */
    getWalletBalance() {
        return this.#request('GET', '/v2/wallet/balances');
    }
}

module.exports = DeltaClient;
    
