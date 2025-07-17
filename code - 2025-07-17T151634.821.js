// delta_trader.js
// ROLE: The "brain" of the trading bot. It receives price data from the listener,
// applies the $40 trading logic, and places orders on Delta Exchange.

const WebSocket = require('ws');
const DeltaRestClient = require('delta-rest-client');

// --- Main Configuration ---
const PORT = 8082; // The port this server listens on for the listener script.
const PRICE_THRESHOLD = 40.00; // The price change in USD that triggers a trade.

// --- Delta Exchange API Keys ---
// IMPORTANT: For security, set these as environment variables on your VM.
// Example: export DELTA_API_KEY="YOUR_KEY"
const DELTA_API_KEY = process.env.DELTA_API_KEY || 'PASTE_YOUR_DELTA_API_KEY_HERE';
const DELTA_API_SECRET = process.env.DELTA_API_SECRET || 'PASTE_YOUR_DELTA_API_SECRET_HERE';

if (DELTA_API_KEY.includes('PASTE_YOUR') || DELTA_API_SECRET.includes('PASTE_YOUR')) {
    console.error("[Trader] FATAL: API keys are not set. Please set them as environment variables or directly in the script.");
    process.exit(1);
}

// --- Delta Exchange Client Setup ---
const deltaClient = new DeltaRestClient({
    api_key: DELTA_API_KEY,
    api_secret: DELTA_API_SECRET,
    environment: 'production' // IMPORTANT: Use 'staging' for testnet
});

// --- Core Trading State ---
let priceAtLastTrade = null; // The price when the last trade was executed.
let isOrderInProgress = false; // A lock to prevent placing multiple orders at once.

// --- WebSocket Server (to receive data from bybit_listener.js) ---
const wss = new WebSocket.Server({ port: PORT });
console.log(`[Trader] WebSocket server started on port ${PORT}. Waiting for listener connection...`);

wss.on('connection', ws => {
    console.log('[Trader] Listener script has connected.');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message.toString());

            if (data.type === 'S' && data.p) {
                const currentPrice = parseFloat(data.p);
                // console.log(`[Trader] Tick received: ${currentPrice.toFixed(2)}`); // Uncomment for verbose logging

                if (priceAtLastTrade === null) {
                    priceAtLastTrade = currentPrice;
                    console.log(`[Trader] Initial baseline price set to: ${priceAtLastTrade.toFixed(2)}`);
                    return;
                }

                const priceDifference = Math.abs(currentPrice - priceAtLastTrade);

                if (priceDifference >= PRICE_THRESHOLD && !isOrderInProgress) {
                    isOrderInProgress = true; // Lock to prevent new orders
                    
                    console.log(`\n--- TRADE TRIGGER ---`);
                    console.log(`Price threshold of $${PRICE_THRESHOLD} met. Difference: $${priceDifference.toFixed(2)}`);
                    console.log(`Previous Baseline: ${priceAtLastTrade.toFixed(2)}, Current Price: ${currentPrice.toFixed(2)}`);
                    
                    const side = currentPrice > priceAtLastTrade ? 'buy' : 'sell';
                    
                    // --- PLACE YOUR ORDER ON DELTA EXCHANGE ---
                    await placeDeltaOrder({
                        // !!! IMPORTANT: Find the correct Product ID from Delta Exchange for the pair you want to trade !!!
                        productId: 13, // Example ID for BTCUSDT Futures, PLEASE VERIFY
                        orderSide: side,
                        orderSize: 100, // Example size: 100 contracts
                        limitPrice: currentPrice.toString()
                    });

                    // CRITICAL: Reset the baseline price to the current price for the next cycle
                    console.log(`[Trader] Resetting trade baseline to: ${currentPrice.toFixed(2)}\n`);
                    priceAtLastTrade = currentPrice;
                    
                    isOrderInProgress = false; // Release lock
                }
            }
        } catch (error) {
            console.error('[Trader] Error processing message:', error);
            isOrderInProgress = false; // Ensure lock is always released on error
        }
    });

    ws.on('close', () => console.log('[Trader] Listener script has disconnected.'));
    ws.on('error', (err) => console.error(`[Trader] Error with listener connection: ${err.message}`));
});

async function placeDeltaOrder({ productId, orderSide, orderSize, limitPrice }) {
    try {
        const order = {
            product_id: productId,
            size: orderSize,
            side: orderSide,
            limit_price: limitPrice,
            order_type: 'limit_order',
        };
        console.log('[Delta] Placing order:', order);
        const response = await deltaClient.apis.Orders.placeOrder({ order });
        console.log('[Delta] SUCCESS: Order Response:', JSON.parse(response.data.toString()));
    } catch (error) {
        const errorDetails = error.response ? error.response.data.toString() : error.message;
        console.error('[Delta] FATAL: FAILED TO PLACE ORDER. Reason:', errorDetails);
    }
}