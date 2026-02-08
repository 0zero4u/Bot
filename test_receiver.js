
const WebSocket = require('ws');
require('dotenv').config();

const PORT = process.env.INTERNAL_WS_PORT || 8082;
const wss = new WebSocket.Server({ port: PORT });

console.log(`\n📊 SMART RECEIVER listening on port ${PORT}...`);
console.log('aggregating data... (updates every 3 seconds)\n');

// Store latest prices here
let priceCache = {};
let messageCount = 0;
let lastTime = Date.now();

wss.on('connection', (ws) => {
    console.log('✅ market_listener connected! Gathering data...');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            // Increment counter
            messageCount++;

            // Update cache: priceCache['ETH']['BINANCE'] = 2299.65
            if (!priceCache[data.s]) priceCache[data.s] = {};
            priceCache[data.s][data.x] = data.p;

        } catch (e) {
            console.error('Parse error');
        }
    });
});

// Print Summary every 3 Seconds
setInterval(() => {
    // Clear console to keep it clean (optional)
    console.clear();
    
    const now = Date.now();
    const duration = (now - lastTime) / 1000;
    const mps = (messageCount / duration).toFixed(0);

    console.log(`\n--- 📉 MARKET PULSE (Last ${duration.toFixed(1)}s) ---`);
    console.log(`⚡ Traffic Speed: ${mps} messages/second`);
    console.log(`-------------------------------------------`);

    // Print table of assets
    Object.keys(priceCache).sort().forEach(asset => {
        const sources = priceCache[asset];
        const sourceList = Object.keys(sources).map(src => {
            return `${src}: $${sources[src]}`;
        }).join(' | ');
        
        console.log(`💰 ${asset.padEnd(5)} : ${sourceList}`);
    });

    console.log(`-------------------------------------------`);
    
    // Reset counters
    messageCount = 0;
    lastTime = now;
}, 3000); // 3000ms = 3 seconds
                                    
