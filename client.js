// client.js
// Version 13.0.0 - SNIPER MODE: HTTP/2, TCP NoDelay, Got, Fail-Fast

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

        // --- HTTP/2 & TCP OPTIMIZATION ---
        // We create a custom agent to enforce TCP NoDelay (disable Nagle's algorithm)
        const agent = {
            http2: new http2.Agent({
                keepAlive: true,
                keepAliveMsecs: 1000,
                maxSockets: 32, // High concurrency
                timeout: 5000,
                // Hook into the session creation to enforce socket options
                createConnection: (authority, options) => {
                    const socket = http2.auto.createConnection(authority, options);
                    socket.on('connect', () => {
                        if (socket.setNoDelay) {
                            socket.setNoDelay(true); // Disable Nagle's Algorithm
                        }
                    });
                    return socket;
                }
            })
        };

        // Initialize the persistent Got client
        this.#client = got.extend({
            prefixUrl: baseURL,
            http2: true, // Native HTTP/2 support
            agent: agent,
            timeout: {
                request: 5000 // Aggressive global timeout (Fail-Fast)
            },
            retry: {
                limit: 0 // FAIL-FAST: No retries. If it fails, we move on.
            },
            headers: {
                'User-Agent': 'nodejs-delta',
                'Accept': 'application/json'
            }
        });
    }

    /**
     * Core Request Method - Optimized for Low Latency
     */
    async #request(method, path, data = null, query = null) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        
        // 1. Prepare Query String (Manual construction to match signature requirements exactly)
        const params = new URLSearchParams(query);
        const qs = params.toString().replace(/%2C/g, ','); 
        
        // 2. Prepare Body
        const body = data ? JSON.stringify(data) : '';
        
        // 3. Generate Signature
        const sigStr = method.toUpperCase() + timestamp + path + (qs ? `?${qs}` : '') + body;
        const signature = crypto.createHmac('sha256', this.#apiSecret).update(sigStr).digest('hex');

        // 4. Headers
        const headers = {
            'api-key': this.#apiKey,
            'timestamp': timestamp,
            'signature': signature,
            'Content-Type': body ? 'application/json' : undefined
        };

        try {
            // 5. Execute Request
            const response = await this.#client(path.startsWith('/') ? path.substring(1) : path, {
                method: method,
                searchParams: qs || undefined, // use string to avoid double encoding issues
                body: body || undefined,
                headers: headers,
                responseType: 'json'
            });

            return response.body;

        } catch (err) {
            // FAIL-FAST: Log and rethrow immediately.
            const status = err.response?.statusCode;
            const responseData = err.response?.body;
            
            // Only log if it's a genuine error, not just a cancel-fail (which is common)
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
        // Fire and forget logic is handled by caller, but we return the promise for confirmation
        return this.#request('POST', '/v2/orders', payload);
    }

    cancelSingleOrder(productId, orderId) {
        const payload = { product_id: productId, id: orderId };
        return this.#request('DELETE', '/v2/orders', payload);
    }
    
    getPositions() {
        return this.#request('GET', '/v2/positions/margined');
    }

    /**
     * [NEW] Used for Keep-Alive Loop
     */
    getWalletBalance() {
        return this.#request('GET', '/v2/wallet/balances');
    }

    getLiveOrders(productId, opts = {}) {
        const query = { product_id: productId, states: opts.states || 'open,pending' };
        return this.#request('GET', '/v2/orders', null, query);
    }

    async batchCancelOrders(productId, ids) {
        if (!ids?.length) return { success: true, result: 'nothing-to-do' };
        
        const payload = { product_id: productId, orders: ids.map((id) => ({ id })) };
        return await this.#request('DELETE', '/v2/orders/batch', payload);
    }

    /**
     * [SNIPER OPTIMIZED] Safely cancels orders.
     * Prioritizes speed. If we suspect orders exist, we nuke them.
     */
    async cancelAllOrders(productId) {
        try {
            // 1. Fetch live orders
            const response = await this.getLiveOrders(productId);

            if (!response || !response.success || !Array.isArray(response.result)) {
                return;
            }

            const ids = response.result.map((o) => o.id);

            // 2. Decision Logic
            if (ids.length === 0) return;

            if (ids.length === 1) {
                // Fastest path for single order
                return await this.cancelSingleOrder(productId, ids[0]);
            } 
            
            // Batch cancel for multiple
            return await this.batchCancelOrders(productId, ids);

        } catch (error) {
            // Swallow errors in cancelAll to prevent strategy crash during cleanup
            this.#logger.warn(`[DeltaClient] Cleanup warning: ${error.message}`);
        }
    }
}

module.exports = DeltaClient;
