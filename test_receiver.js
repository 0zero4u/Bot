const WebSocket = require('ws');
require('dotenv').config();

const PORT = process.env.INTERNAL_WS_PORT || 8082;

const wss = new WebSocket.Server({ port: PORT });

console.log(`🧪 TEST RECEIVER listening on port ${PORT}...`);
console.log('Waiting for market_listener to connect...');

wss.on('connection', (ws) => {
    console.log('✅ market_listener connected!');

    ws.on('message', (message) => {
        const data = JSON.parse(message.toString());
        // Print the data nicely
        console.log(`[${new Date().toLocaleTimeString()}] RECEIVED:`, data);
    });

    ws.on('close', () => {
        console.log('❌ market_listener disconnected');
    });
});
