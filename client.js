const https = require('https');
const crypto = require('crypto');
const dns = require('dns');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #agent;
    #logger;

    constructor(apiKey, apiSecret, baseURL, logger) {
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;
        
        // Use the standard domain to avoid WAF blocks during diagnosis
        this.HOSTNAME = 'api.india.delta.exchange';

        // Standard Agent with Keep-Alive
        this.#agent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 64,
            scheduling: 'lifo',
            timeout: 10000,
            // Force IPv4 to rule out IPv6 timeouts
            lookup: (hostname, opts, cb) => {
                opts.family = 4;
                dns.lookup(hostname, opts, cb);
            }
        });
    }

    async #request(method, endpoint, payload = null, qs = {}) {
        return new Promise((resolve, reject) => {
            // --- ⏱️ HIGH PRECISION TIMING START ---
            const startNs = process.hrtime.bigint();
            let dnsNs = 0n, tcpNs = 0n, tlsNs = 0n, uploadNs = 0n, ttfbNs = 0n;

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
                hostname: this.HOSTNAME,
                port: 443,
                path: pathWithSlash + queryStr,
                method: method,
                headers: {
                    'User-Agent': 'nodejs-diag-v1',
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
                // ⏱️ TTFB Captured (Time To First Byte)
                ttfbNs = process.hrtime.bigint();

                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    const endNs = process.hrtime.bigint();
                    
                    // --- CALCULATION (Nanoseconds to Milliseconds) ---
                    const totalMs = Number(endNs - startNs) / 1e6;
                    const dnsMs = dnsNs > 0n ? Number(dnsNs - startNs) / 1e6 : 0;
                    const tcpMs = tcpNs > 0n ? Number(tcpNs - (dnsNs || startNs)) / 1e6 : 0;
                    const tlsMs = tlsNs > 0n ? Number(tlsNs - (tcpNs || startNs)) / 1e6 : 0;
                    const waitMs = Number(ttfbNs - (uploadNs || tlsNs || startNs)) / 1e6; // Server Think Time

                    // LOG THE WATERFALL
                    if (totalMs > 50) { // Log anything slower than 50ms
                        this.#logger.warn(
                            `[PROFILE] Total:${totalMs.toFixed(1)}ms | ` +
                            `DNS:${dnsMs.toFixed(1)} | ` +
                            `TCP:${tcpMs.toFixed(1)} | ` +
                            `TLS:${tlsMs.toFixed(1)} | ` +
                            `Wait(Server):${waitMs.toFixed(1)}`
                        );
                    }

                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                });
            });

            // --- ⏱️ EVENT LISTENERS FOR TIMING ---
            req.on('socket', (socket) => {
                socket.on('lookup', () => { dnsNs = process.hrtime.bigint(); });
                socket.on('connect', () => { tcpNs = process.hrtime.bigint(); });
                socket.on('secureConnect', () => { tlsNs = process.hrtime.bigint(); });
                
                // Force optimizations
                socket.setNoDelay(true); 
                socket.setKeepAlive(true, 1000);
            });

            req.on('finish', () => {
                // Request flushed to OS kernel
                uploadNs = process.hrtime.bigint();
            });

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
                    
