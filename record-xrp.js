/**
 * record-xrp.js
 * Records XRP market data from Delta Exchange (trades) and Binance (bookTicker)
 * for 120 seconds, saving to CSV files.
 *
 * Usage: node record-xrp.js
 */

const WebSocket = require('ws');
const fs = require('fs');

// --- Configuration ---
const DELTA_WS = 'wss://public-socket.india.delta.exchange';
const BINANCE_WS = 'wss://fstream.binance.com/stream?streams=xrpusdt@bookTicker';
const DURATION_MS = 180_000;

const DELTA_CSV = 'delta_xrp_trades.csv';
const BINANCE_CSV = 'binance_xrp_bookticker.csv';

let deltaCount = 0;
let binanceCount = 0;

// ==========================================
// CSV Helpers
// ==========================================

function initCsv(filepath, header) {
    fs.writeFileSync(filepath, header + '\n');
}

function appendCsv(filepath, row) {
    fs.appendFileSync(filepath, row + '\n');
}

// ==========================================
// Delta Exchange - Trades
// ==========================================

function connectDelta() {
    const ws = new WebSocket(DELTA_WS);

    ws.on('open', () => {
        const subscribe = {
            type: 'subscribe',
            payload: {
                channels: [{ name: 'trades', symbols: ['XRPUSD'] }]
            }
        };
        ws.send(JSON.stringify(subscribe));
        console.log('[Delta] ✅ Connected. Subscribed to XRPUSD trades.');
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            // Delta sends trades as direct messages (not wrapped in data array)
            // Format: {type:"trades", p:"price", r:"m"/"t", s:size, sy:symbol, t:timestamp_us, ts:server_ts}
            if (msg.type === 'trades' && msg.sy) {
                const ts = Math.floor((msg.t || Date.now() * 1000) / 1000); // Convert microseconds to ms
                const symbol = msg.sy || 'XRPUSD';
                const price = parseFloat(msg.p) || 0;
                const size = parseFloat(msg.s) || 0;
                const buyerRole = msg.r === 't' ? 'taker' : 'maker'; // r="t" means taker (buyer), r="m" means maker

                const row = `${ts},${symbol},${price},${size},${buyerRole}`;
                appendCsv(DELTA_CSV, row);
                deltaCount++;
            }
        } catch (e) {
            // silently ignore parse errors
        }
    });

    ws.on('error', (err) => {
        console.error('[Delta] ⚠️ WS error:', err.message);
    });

    ws.on('close', (code, reason) => {
        console.log(`[Delta] 🔌 Disconnected (code=${code})`);
    });

    return ws;
}

// ==========================================
// Binance - bookTicker
// ==========================================

function connectBinance() {
    const ws = new WebSocket(BINANCE_WS);

    ws.on('open', () => {
        console.log('[Binance] ✅ Connected. Subscribed to xrpusdt@bookTicker.');
    });

    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            const ticker = parsed.data || parsed;
            if (ticker.s && ticker.b && ticker.a) {
                const ts = Date.now();
                const symbol = ticker.s || 'XRPUSDT';
                const bid = ticker.b || 0;
                const ask = ticker.a || 0;
                const bidQty = ticker.B || 0;
                const askQty = ticker.A || 0;

                const row = `${ts},${symbol},${bid},${ask},${bidQty},${askQty}`;
                appendCsv(BINANCE_CSV, row);
                binanceCount++;
            }
        } catch (e) {
            // silently ignore parse errors
        }
    });

    ws.on('error', (err) => {
        console.error('[Binance] ⚠️ WS error:', err.message);
    });

    ws.on('close', (code, reason) => {
        console.log(`[Binance] 🔌 Disconnected (code=${code})`);
    });

    return ws;
}

// ==========================================
// Main
// ==========================================

function main() {
    // Initialize CSV files with headers
    initCsv(DELTA_CSV, 'timestamp,symbol,price,size,buyer_role');
    initCsv(BINANCE_CSV, 'timestamp,symbol,bid,ask,bid_qty,ask_qty');

    console.log('🚀 Starting XRP data recording for 120 seconds...');
    console.log(`   Delta CSV  : ${DELTA_CSV}`);
    console.log(`   Binance CSV: ${BINANCE_CSV}`);
    console.log('');

    // Connect both WebSockets
    const deltaWs = connectDelta();
    const binanceWs = connectBinance();

    // Progress timer every 5 seconds
    const startTime = Date.now();
    const progressInterval = setInterval(() => {
        console.log(`[Progress] ${Math.round((Date.now() - startTime) / 1000)}s | Delta trades: ${deltaCount} | Binance bookTicker: ${binanceCount}`);
    }, 5000);

    // Stop after DURATION_MS
    setTimeout(() => {
        clearInterval(progressInterval);

        // Close WebSocket connections
        if (deltaWs.readyState === WebSocket.OPEN) deltaWs.close();
        if (binanceWs.readyState === WebSocket.OPEN) binanceWs.close();

        console.log('');
        console.log('✅ Recording complete.');
        console.log(`   Delta trades captured     : ${deltaCount}`);
        console.log(`   Binance bookTicker captured: ${binanceCount}`);
        console.log(`   Files saved: ${DELTA_CSV}, ${BINANCE_CSV}`);
        process.exit(0);
    }, DURATION_MS);
}

main();
