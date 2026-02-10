const https = require('https');
const crypto = require('crypto');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #logger;

    constructor(apiKey, apiSecret, baseURL, logger) {
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;
        
        this.DIRECT_IP = '13.227.249.121'; 
        this.REAL_HOSTNAME = 'api.india.delta.exchange';
    }

    async #request(method, endpoint, payload = null, qs = {}) {
        return new Promise((resolve, reject) => {
            const tStart = Date.now();

            const timestamp = Math.floor(Date.now() / 1000).toString();
            const bodyStr = payload ? JSON.stringify(payload) : '';

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
                    // ⚡ SPOOF BROWSER: Look like Chrome to bypass WAF throttling
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'api-key': this.#apiKey,
                    'timestamp': timestamp,
                    'signature': signature,
                    'Content-Length': Buffer.byteLength(bodyStr),
                    // ⚡ CRITICAL FIX: FORCE CLOSE. Do not reuse dead sockets.
                    'Connection': 'close' 
                },
                // ⚡ DISABLE AGENT: Forces a fresh TCP handshake every time
                agent: false, 
                servername: this.REAL_HOSTNAME,
                rejectUnauthorized: false
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    // Log only if slow
                    const totalTime = Date.now() - tStart;
                    if (totalTime > 100) {
                        this.#logger.warn(`[REQ] Total:${totalTime}ms | Fresh Connection Used`);
                    }

                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                });
            });

            // ⚡ FORCE TCP NO DELAY (Just in case)
            req.on('socket', (socket) => {
                socket.setNoDelay(true);
            });

            req.on('error', (err) => {
                this.#logger.error(`[NativeReq] Error: ${err.message}`);
                reject(err);
            });

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
