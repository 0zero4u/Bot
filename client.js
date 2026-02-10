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

        // ⚡ 1. DIRECT IP & HOST CONFIGURATION
        // Use the fast IP you found via Ping
        this.DIRECT_IP = '13.227.249.121'; 
        this.REAL_HOSTNAME = 'api.india.delta.exchange';

        // ⚡ 2. NATIVE HTTPS AGENT
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
            // --- TIMING TRACKERS ---
            const tStart = Date.now();
            let tSocket = 0, tSecure = 0, tFirstByte = 0;

            const timestamp = Math.floor(Date.now() / 1000).toString();
            const bodyStr = payload ? JSON.stringify(payload) : '';

            // Ensure slash consistency for signature
            const pathWithSlash = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
            
            let queryStr = '';
            if (Object.keys(qs).length > 0) {
                queryStr = '?' + new URLSearchParams(qs).toString();
            }

            // Signature Generation
            const signatureData = method + timestamp + pathWithSlash + queryStr + bodyStr;
            const signature = crypto
                .createHmac('sha256', this.#apiSecret)
                .update(signatureData)
                .digest('hex');

            // ⚡ 3. RAW REQUEST OPTIONS
            const options = {
                hostname: this.DIRECT_IP, // <--- Connect to IP directly
                port: 443,
                path: pathWithSlash + queryStr,
                method: method,
                headers: {
                    'Host': this.REAL_HOSTNAME, // <--- Spoof Host Header
                    'User-Agent': 'nodejs-native-hft',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'api-key': this.#apiKey,
                    'timestamp': timestamp,
                    'signature': signature,
                    'Content-Length': Buffer.byteLength(bodyStr)
                },
                agent: this.#agent,
                servername: this.REAL_HOSTNAME, // <--- SNI Spoofing for TLS
                rejectUnauthorized: false       // <--- Trust the connection
            };

            const req = https.request(options, (res) => {
                tFirstByte = Date.now(); // TTFB Captured

                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    const tEnd = Date.now();
                    
                    // ⚡ WATERFALL LOGGING (Only if slow)
                    const totalTime = tEnd - tStart;
                    if (totalTime > 100) {
                        this.#logger.warn(`[SLOW REQ] Total:${totalTime}ms | Socket:${tSocket-tStart} | TLS:${tSecure-tSocket} | TTFB:${tFirstByte-tSecure}`);
                    }

                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (e) {
                        resolve(data); // Fallback for non-JSON
                    }
                });
            });

            // --- LOW LEVEL TIMING EVENTS ---
            req.on('socket', (socket) => {
                tSocket = Date.now();
                socket.on('secureConnect', () => { tSecure = Date.now(); });
            });

            req.on('error', (err) => {
                this.#logger.error(`[NativeReq] Error: ${err.message}`);
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request Timeout'));
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
                    
