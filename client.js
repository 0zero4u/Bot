const https = require('https');
const crypto = require('crypto');
const dns = require('dns');

class DeltaClient {
    #apiKey;
    #apiSecret;
    #agent;
    #logger;
    #pinnedIP;
    #heartbeatTimer;

    constructor(apiKey, apiSecret, baseURL, logger) {
        this.#apiKey = apiKey;
        this.#apiSecret = apiSecret;
        this.#logger = logger;
        this.HOSTNAME = 'api.india.delta.exchange';
        this.#pinnedIP = null; // We will fill this via DNS Resolve

        // 1. HIGH-PERFORMANCE AGENT
        this.#agent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 1000,
            maxSockets: 256, // Increased to ensure free sockets are available
            maxFreeSockets: 64,
            scheduling: 'lifo',
            timeout: 5000
        });

        // 2. RESOLVE & PIN IP IMMEDIATELY
        this.#refreshDNS();
        
        // 3. START HEARTBEAT
        this.#startHeartbeat();
    }

    // 🔥 BYPASS OS RESOLVER: Resolve IPv4 directly via Network DNS
    #refreshDNS() {
        dns.resolve4(this.HOSTNAME, (err, addresses) => {
            if (!err && addresses && addresses.length > 0) {
                this.#pinnedIP = addresses[0];
                this.#logger.info(`[DNS] 🎯 Pinned API to IP: ${this.#pinnedIP}`);
            } else {
                this.#logger.warn(`[DNS] Resolution failed, defaulting to hostname. ${err?.message}`);
            }
        });
    }

    #startHeartbeat() {
        if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = setInterval(() => {
            // Refresh IP every 60s just in case
            if (Date.now() % 60000 < 3000) this.#refreshDNS();
            // Keep socket hot
            this.getWalletBalance().catch(() => {}); 
        }, 20000); // Faster heartbeat (2s) to prevent any socket idle
    }

    async #request(method, endpoint, payload = null, qs = {}) {
        return new Promise((resolve, reject) => {
            const startNs = process.hrtime.bigint();
            let ttfbNs = 0n;

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

            // 🔥 TARGET: Use Pinned IP if available, otherwise Hostname
            // This removes the 1000ms DNS penalty on new connections.
            const targetHost = this.#pinnedIP || this.HOSTNAME;

            const options = {
                hostname: targetHost,
                port: 443,
                path: pathWithSlash + queryStr,
                method: method,
                headers: {
                    'Host': this.HOSTNAME, // Spoof Host Header
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'api-key': this.#apiKey,
                    'timestamp': timestamp,
                    'signature': signature,
                    'Content-Length': Buffer.byteLength(bodyStr)
                },
                agent: this.#agent,
                servername: this.HOSTNAME, // SNI Spoofing
                timeout: 5000
            };

            const req = https.request(options, (res) => {
                ttfbNs = process.hrtime.bigint();
                let data = '';
                
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    const endNs = process.hrtime.bigint();
                    const totalMs = Number(endNs - startNs) / 1e6;

                    // Log Logic: Warn if Trade is slow
                    if (method === 'POST' || totalMs > 200) {
                        const waitMs = ttfbNs > 0n ? Number(ttfbNs - startNs) / 1e6 : 0;
                        // Subtract Connect Time estimation
                        const connectTime = waitMs > 20 ? (waitMs - 20) : 0; 
                        
                        this.#logger.warn(
                            `[REQ] ${method} ${endpoint} | Total:${totalMs.toFixed(1)}ms`
                        );
                    }

                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(data);
                    }
                });
            });

            // 🔥 FORCE TCP OPTIMIZATIONS
            req.on('socket', (socket) => {
                socket.setNoDelay(true);
                socket.setKeepAlive(true, 1000);
                if (socket.connecting) {
                    // If we are connecting, it means we are opening a new socket.
                    // If we used PinnedIP, this should take ~30ms.
                    // If we used Hostname, this might take ~1000ms.
                }
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
            
