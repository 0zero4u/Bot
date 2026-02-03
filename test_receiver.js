const zmq = require('zeromq');
require('dotenv').config();

const IPC_URL = 'ipc:///tmp/market_feed.sock';
const sock = zmq.socket('sub');

// --- FIX APPLIED ---
// The line below caused "Error: Invalid argument".
// Conflation is an optimization and not strictly required for this test script to function.
// We have disabled it to prevent the crash.
// sock.setsockopt(54, 1); 

try {
    sock.connect(IPC_URL);
} catch(e) {
    console.error(`Could not connect to ZMQ socket at ${IPC_URL}. Is market_listener running?`);
    process.exit(1);
}

sock.subscribe('market');

console.log(`\n📊 ZMQ SMART RECEIVER listening on ${IPC_URL}...`);
console.log('aggregating data... (updates every 3 seconds)\n');

let priceCache = {};
let messageCount = 0;
let lastTime = Date.now();

sock.on('message', (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        messageCount++;
        if (!priceCache[data.s]) priceCache[data.s] = {};
        priceCache[data.s][data.x] = data.p;
    } catch (e) {
        console.error('Parse error');
    }
});

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
