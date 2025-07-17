// bybit_listener.js
// ROLE: Connects to Bybit's public WebSocket, listens for small price ticks,
// and forwards them to the delta_trader.js script running on the same machine.

const WebSocket = require('ws');

// --- Global Error Handlers ---
process.on('uncaughtException', (err, origin) => {
    console.error(`[Listener] PID: ${process.pid} --- FATAL: UNCAUGHT EXCEPTION`);
    console.error(err.stack || err);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`[Listener] PID: ${process.pid} --- FATAL: UNHANDLED PROMISE REJECTION`);
    console.error('[Listener] Reason:', reason instanceof Error ? reason.stack : reason);
    process.exit(1);
});

// --- Listener Configuration ---
const SYMBOL = 'BTCUSDT'; // Bybit uses uppercase symbols
const RECONNECT_INTERVAL_MS = 5000;
const MINIMUM_TICK_SIZE = 0.1; // Sends a signal for every $0.10 price change

// --- Connection URLs ---
// ** MODIFIED: This now points to the trader script on the SAME machine (localhost) **
const internalReceiverUrl = 'ws://localhost:8082';
const BYBIT_STREAM_URL = 'wss://stream.bybit.com/v5/public/spot';

// --- State Variables ---
let internalWsClient, bybitWsClient;
let last_sent_spot_bid_price = null; // Tracks the last price that triggered a signal

// --- Internal Receiver Connection (to delta_trader.js) ---
function connectToInternalReceiver() {
    if (internalWsClient && (internalWsClient.readyState === WebSocket.OPEN || internalWsClient.readyState === WebSocket.CONNECTING)) return;
    internalWsClient = new WebSocket(internalReceiverUrl);
    internalWsClient.on('error', (err) => console.error(`[Internal] WebSocket error: ${err.message}`));
    internalWsClient.on('close', () => {
        console.error('[Internal] Connection to trader script closed. Reconnecting...');
        internalWsClient = null;
        setTimeout(connectToInternalReceiver, RECONNECT_INTERVAL_MS);
    });
    internalWsClient.on('open', () => console.log('[Internal] Connection to trader script established.'));
}

// --- Data Forwarding ---
function sendToInternalClient(payload) {
    if (internalWsClient && internalWsClient.readyState === WebSocket.OPEN) {
        try {
            internalWsClient.send(JSON.stringify(payload));
        } catch (e) { console.error(`[Internal] Failed to send message to trader: ${e.message}`); }
    }
}

// --- Bybit Exchange Connection ---
function connectToBybit() {
    bybitWsClient = new WebSocket(BYBIT_STREAM_URL);
    
    bybitWsClient.on('open', () => {
        console.log('[Bybit] Connection established.');
        last_sent_spot_bid_price = null; // Reset on new connection
        const subscriptionMessage = { op: "subscribe", args: [`orderbook.1.${SYMBOL}`] };
        bybitWsClient.send(JSON.stringify(subscriptionMessage));
        console.log(`[Bybit] Sent subscription for: ${subscriptionMessage.args[0]}`);
    });
    
    bybitWsClient.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.op === 'ping') {
                bybitWsClient.send(JSON.stringify({ op: 'pong', req_id: message.req_id }));
                return;
            }
            if (message.topic && message.topic.startsWith('orderbook.1') && message.data) {
                const topBid = message.data.b && message.data.b[0];
                if (!topBid) return;
                const current_spot_bid_price = parseFloat(topBid[0]);
                if (!current_spot_bid_price) return;
                if (last_sent_spot_bid_price === null) {
                    last_sent_spot_bid_price = current_spot_bid_price;
                    return;
                }
                const price_difference = current_spot_bid_price - last_sent_spot_bid_price;
                if (Math.abs(price_difference) >= MINIMUM_TICK_SIZE) {
                    const payload = { type: 'S', p: current_spot_bid_price };
                    sendToInternalClient(payload);
                    last_sent_spot_bid_price = current_spot_bid_price;
                }
            }
        } catch (e) { console.error(`[Bybit] Error processing message: ${e.message}`); }
    });

    bybitWsClient.on('error', (err) => console.error('[Bybit] Connection error:', err.message));
    
    bybitWsClient.on('close', () => {
        console.error('[Bybit] Connection closed. Reconnecting...');
        bybitWsClient = null;
        setTimeout(connectToBybit, RECONNECT_INTERVAL_MS);
    });
}

// --- Start all connections ---
console.log(`[Listener] Starting... PID: ${process.pid}`);
connectToInternalReceiver();
connectToBybit();