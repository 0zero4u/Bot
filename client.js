// client.js
// v13.2.0 - [FIXED] HTTP/2 Fallback & Increased Timeout

const got = require('got');
const crypto = require('crypto');
const http2 = require('http2-wrapper');

class DeltaClient {
    #apiKey; #apiSecret; #client; #logger;

    constructor(apiKey, apiSecret, baseURL, logger) {
        if (!apiKey || !apiSecret || !baseURL || !logger) throw new Error('Missing credentials');
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;

        const agent = {
            http2: new http2.Agent({
                keepAlive: true,
                maxSockets: 32,
                createConnection: (authority, options) => {
                    const socket = http2.auto.createConnection(authority, options);
                    socket.on('connect', () => { if (socket.setNoDelay) socket.setNoDelay(true); });
                    return socket;
                }
            })
        };

        this.#client = got.extend({
            prefixUrl: baseURL,
            // [FIXED] False allows automatic fallback to HTTP/1.1 if HTTP/2 handshake times out
            http2: false, 
            agent: agent,
            // [FIXED] Increased timeout to 10s for shared CPU stability
            timeout: { request: 10000, connect: 5000 },
            retry: { limit: 2 },
            headers: { 'User-Agent': 'nodejs-delta', 'Accept': 'application/json' }
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
                method, searchParams: qs || undefined, body: body || undefined, headers, responseType: 'json'
            });
            return response.body;
        } catch (err) {
            const status = err.response?.statusCode;
            if (status !== 400 && status !== 404) {
                this.#logger.error(`[DeltaClient] ${method} ${path} FAILED (${status || 'TIMEOUT'}).`);
            }
            throw err; 
        }
    }

    placeOrder(payload) { return this.#request('POST', '/v2/orders', payload); }
    getPositions() { return this.#request('GET', '/v2/positions/margined'); }
    getWalletBalance() { return this.#request('GET', '/v2/wallet/balances'); }
}

module.exports = DeltaClient;
                                   
