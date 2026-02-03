const zmq = require('zeromq');
require('dotenv').config();

// MUST match the ipcUrl in your new market_listener.js
const IPC_URL = 'ipc:///tmp/market_feed.sock';

// 1. Create a ZMQ Subscriber Socket
const sock = zmq.socket('sub');

// 2. SAFETY VALVE: Use CONFLATE
// This prevents the test tool from falling behind if you pause it.
// It ensures you always see the freshest data, just like the trader.
sock.setsockopt(zmq.ZMQ_CONFLATE, 1);

// 3. Connect to the IPC endpoint
try {
    sock.connect(IPC_URL);
} catch(e) {
    console.error(`Could not connect to ZMQ socket at ${IPC_URL}. Is market_listener running?`);
    process.exit(1);
}

// 4. Subscribe to the 'market' topic
sock.subscribe('market');

console.log(`\n📊 ZMQ SMART RECEIVER listening on ${IPC_URL}...`);
console.log('aggregating data... (updates every 3 seconds)\n');

// Store latest prices here
let priceCache = {};
let messageCount = 0;
let lastTime = Date.now();

// 5. Handle incoming messages from ZMQ
sock.on('message', (topic, message) => {
    try {
        // Message is a buffer, convert to string then parse
        const data = JSON.parse(message.toString());
        
        messageCount++;

        // Update cache
        if (!priceCache[data.s]) priceCache[data.s] = {};
        priceCache[data.s][data.x] = data.p;

    } catch (e) {
        console.error('Parse error');
    }
});

// The rest of the display logic is identical
setInterval(() => {
    console.clear();
    
    const now = Date.now();
    const duration = (now - lastTime) / 1000;
    const mps = (messageCount / duration).toFixed(0);

    console.log(`\n--- 📉 ZMQ MARKET PULSE (Last ${duration.toFixed(1)}s) ---`);
    console.log(`⚡ Traffic Speed: ${mps} messages/second`);
    console.log(`-------------------------------------------`);

    Object.keys(priceCache).sort().forEach(asset => {
        const sources = priceCache[asset];
        const sourceList = Object.keys(sources).map(src => {
            return `${src}: $${sources[src]}`;
        }).join(' | ');
        
        console.log(`💰 ${asset.padEnd(5)} : ${sourceList}`);
    });

    console.log(`-------------------------------------------`);
    
    messageCount = 0;
    lastTime = now;
}, 3000);
