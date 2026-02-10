const https = require('https');
const crypto = require('crypto');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #agent;
    #logger;

    constructor(apiKey, apiSecret, baseURL, logger) {
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;

        // ⚡ 1. DIRECT IP (Your Fast 1ms IP)
        this.DIRECT_IP = '13.227.249.121'; 
        this.REAL_HOSTNAME = 'api.india.delta.exchange';

        // ⚡ 2. NATIVE AGENT WITH TCP OPTIMIZATIONS
        this.#agent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 64,
            scheduling: 'lifo',
            timeout: 5000
        });
    }

    async #request(method, endpoint, payload = null, qs = {}) {
        return new Promise((resolve, reject) => {
            const tStart = Date.now();
            let tSocket = 0, tFirstByte = 0;

            const timestamp = Math.floor(Date.now() / 1000).toString();
            const bodyStr = payload ? JSON.stringify(payload) : '';

            // Signature Logic
            const pathWithSlash = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
            let queryStr = '';
            if (Object.keys(qs).length > 0) {
                queryStr = '?' + new URLSearchParams(qs).toString();
            }

            const signatureData = method + timestamp + pathWithSlash + queryStr + bodyStr;
            const signature = crypto
                .createHmac('sha256', this.#apiSecret)
                .update(signatureData)
                .digest('hex');

            const options = {
                hostname: this.DIRECT_IP,
                port: 443,
                path: pathWithSlash + queryStr,
                method: method,
                headers: {
                    'Host': this.REAL_HOSTNAME,
                    'User-Agent': 'nodejs-native-hft',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'api-key': this.#apiKey,
                    'timestamp': timestamp,
                    'signature': signature,
                    'Content-Length': Buffer.byteLength(bodyStr),
                    'Connection': 'keep-alive' // Explicitly request keep-alive
                },
                agent: this.#agent,
                servername: this.REAL_HOSTNAME,
                rejectUnauthorized: false
            };

            const req = https.request(options, (res) => {
                // TTFB: Time To First Byte (How long the server took to reply)
                tFirstByte = Date.now();

                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    const tEnd = Date.now();
                    const totalTime = tEnd - tStart;
                    const serverWait = tFirstByte - tStart; // How long we waited for the server

                    // Detailed Lag Analysis
                    if (totalTime > 100) {
                        this.#logger.warn(`[SLOW REQ] Total:${totalTime}ms | Wait(TTFB):${serverWait}ms | Payload:${Buffer.byteLength(bodyStr)}b`);
                    }

                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (e) {
                        resolve(data);
                    }
                });
            });

            // ⚡ 3. FORCE TCP NO-DELAY (DISABLE NAGLE)
            req.on('socket', (socket) => {
                tSocket = Date.now();
                socket.setNoDelay(true); // <--- CRITICAL: Send immediately, don't buffer!
                socket.setKeepAlive(true, 1000);
            });

            req.on('error', (err) => {
                this.#logger.error(`[NativeReq] Error: ${err.message}`);
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request Timeout'));
            });

            // ⚡ 4. FLUSH DATA IMMEDIATELY
            if (payload) {
                req.write(bodyStr);
            }
            req.end();
        });
    }

    placeOrder(payload) { return this.#request('POST', '/v2/orders', payload); }
    getPositions() { return this.#request('GET', '/v2/positions/margined'); }
    getLiveOrders() { return this.#request('GET', '/v2/orders'); }
    getWalletBalance() { return this.#request('GET', '/v2/wallet/balances'); }
}

module.exports = DeltaClient;
                    
