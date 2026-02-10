const https = require('https');
const crypto = require('crypto');
const dns = require('dns');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #agent;
    #logger;
    #heartbeatTimer;

    constructor(apiKey, apiSecret, baseURL, logger) {
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;
        
        // Use Standard Domain
        this.HOSTNAME = 'api.india.delta.exchange';

        // 1. OPTIMIZED AGENT
        this.#agent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 64,
            scheduling: 'lifo',
            timeout: 10000,
            lookup: (hostname, opts, cb) => {
                opts.family = 4; // Force IPv4
                dns.lookup(hostname, opts, cb);
            }
        });

        // 2. START HEARTBEAT (Keep-Alive Enforcer)
        // Pings the server every 3 seconds to prevent TCP Idle Timeout
        this.#startHeartbeat();
    }

    #startHeartbeat() {
        if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = setInterval(() => {
            // Silently fetch balance to keep socket hot
            this.getWalletBalance().catch(() => {}); 
        }, 3000); 
    }

    async #request(method, endpoint, payload = null, qs = {}) {
        return new Promise((resolve, reject) => {
            // High Precision Timing
            const startNs = process.hrtime.bigint();
            let uploadNs = 0n, ttfbNs = 0n;

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
                hostname: this.HOSTNAME,
                port: 443,
                path: pathWithSlash + queryStr,
                method: method,
                headers: {
                    // 3. SPOOF REAL BROWSER (Bypass WAF/Firewall Throttling)
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'api-key': this.#apiKey,
                    'timestamp': timestamp,
                    'signature': signature,
                    'Content-Length': Buffer.byteLength(bodyStr)
                },
                agent: this.#agent,
                timeout: 5000
            };

            const req = https.request(options, (res) => {
                ttfbNs = process.hrtime.bigint(); // First byte received

                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    const endNs = process.hrtime.bigint();
                    const totalMs = Number(endNs - startNs) / 1e6;
                    
                    // Log Latency if it's a Trade Order (POST) or Slow
                    const isTrade = method === 'POST';
                    if (isTrade || totalMs > 100) {
                        const waitMs = Number(ttfbNs - (uploadNs || startNs)) / 1e6;
                        this.#logger.warn(
                            `[REQ] ${method} ${endpoint} | Total:${totalMs.toFixed(1)}ms | Wait(Server):${waitMs.toFixed(1)}ms`
                        );
                    }

                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                });
            });

            req.on('socket', (socket) => {
                socket.setNoDelay(true); // Disable Nagle
                socket.setKeepAlive(true, 1000);
            });
            
            req.on('finish', () => { uploadNs = process.hrtime.bigint(); });

            req.on('error', (err) => {
                this.#logger.error(`[NetError] ${err.message}`);
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
                        
