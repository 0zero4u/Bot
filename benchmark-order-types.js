/**
 * benchmark-order-types.js
 * Tests latency for all Delta Exchange order types
 * Sends 1 order per type, measures API response time, then cancels
 */

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');

// Load native client
let DeltaNativeClient;
try {
    const fastClient = require('fast-client');
    DeltaNativeClient = fastClient.DeltaNativeClient;
} catch (e) {
    console.error('Failed to load fast-client:', e.message);
    process.exit(1);
}

const client = new DeltaNativeClient(
    process.env.DELTA_API_KEY,
    process.env.DELTA_API_SECRET,
    process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange'
);

// Config
const PRODUCT_ID = '14969'; // XRPUSD
const PRODUCT_SYMBOL = 'XRPUSD';
const SIZE = '1';

// Results storage
const results = [];

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function measureLatency(label, orderPayload) {
    const start = process.hrtime.bigint();
    
    try {
        const result = await client.placeOrder(orderPayload);
        const end = process.hrtime.bigint();
        const latencyMs = Number(end - start) / 1e6;
        
        const success = result && (result.success || result.result);
        const orderId = result?.result?.id;
        
        // Debug: show full response for failures
        if (!success) {
            console.log(`    ↳ Response: ${JSON.stringify(result).substring(0, 200)}`);
        }
        
        results.push({
            type: label,
            latencyMs: latencyMs.toFixed(2),
            success: success ? 'YES' : 'NO',
            orderId: orderId || 'N/A',
            error: result?.error || null
        });
        
        console.log(`  ${success ? '✅' : '❌'} ${label}: ${latencyMs.toFixed(2)}ms ${orderId ? `(OID: ${orderId})` : ''} ${result?.error ? `ERR: ${JSON.stringify(result.error)}` : ''}`);
        
        // Cancel if order was placed successfully (limit/stop orders)
        if (orderId && orderPayload.order_type !== 'market_order') {
            try {
                await client.cancelOrder({ product_id: PRODUCT_ID, order_id: orderId.toString() });
                console.log(`    ↳ Cancelled order ${orderId}`);
            } catch (e) {
                // Ignore cancel errors
            }
        }
        
        return orderId;
    } catch (error) {
        const end = process.hrtime.bigint();
        const latencyMs = Number(end - start) / 1e6;
        
        results.push({
            type: label,
            latencyMs: latencyMs.toFixed(2),
            success: 'ERROR',
            orderId: 'N/A',
            error: error.message
        });
        
        console.log(`  ❌ ${label}: ${latencyMs.toFixed(2)}ms (ERROR: ${error.message || JSON.stringify(error)})`);
        return null;
    }
}

async function runBenchmark() {
    console.log('\n🚀 Delta Exchange Order Type Latency Benchmark');
    console.log('━'.repeat(60));
    console.log(`Asset: ${PRODUCT_SYMBOL} (ID: ${PRODUCT_ID})`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log('━'.repeat(60) + '\n');

    // Get current price for limit orders
    let currentPrice = 2.0; // Default fallback for XRP
    try {
        const wallet = await client.getWalletBalance();
        console.log('✅ API Connection verified\n');
    } catch (e) {
        console.log('⚠️  API warmup failed, continuing...\n');
    }

    console.log('📊 Getting current market price...');
    try {
        const warmup = await client.placeOrder({
            product_id: PRODUCT_ID,
            size: SIZE,
            side: 'buy',
            order_type: 'market_order',
            client_order_id: `warmup_${Date.now()}`
        });
        if (warmup?.result?.average_fill_price) {
            currentPrice = parseFloat(warmup.result.average_fill_price);
            console.log(`  Current price: ${currentPrice}`);
        }
    } catch (e) {
        console.log('  Using default price for limit orders');
    }
    await sleep(300);

    console.log('📊 Closing warmup position...');
    try {
        await client.placeOrder({
            product_id: PRODUCT_ID,
            size: SIZE,
            side: 'sell',
            order_type: 'market_order',
            reduce_only: true,
            client_order_id: `closewarmup_${Date.now()}`
        });
    } catch (e) {}
    await sleep(500);

    console.log('\n⏱️  Testing Order Types:\n');

    // 0. Get BBO for aggressive limit
    let bestAsk = currentPrice * 1.001;
    let bestBid = currentPrice * 0.999;
    try {
        const ob = await client.getOrderbook({ product_id: PRODUCT_ID });
        if (ob?.result) {
            bestAsk = parseFloat(ob.result.best_ask || currentPrice * 1.001);
            bestBid = parseFloat(ob.result.best_bid || currentPrice * 0.999);
            console.log(`  BBO: Bid=${bestBid} Ask=${bestAsk}`);
        }
    } catch (e) {}

    // 1. Market Order
    await measureLatency('market_order', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'sell',
        order_type: 'market_order',
        client_order_id: `bench_market_${Date.now()}`
    });
    await sleep(300);

    // 2. Limit Order (aggressive, likely fills immediately)
    const limitPrice = (currentPrice * 0.99).toFixed(4); // 1% below
    await measureLatency('limit_order', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'buy',
        order_type: 'limit_order',
        limit_price: limitPrice,
        time_in_force: 'gtc',
        client_order_id: `bench_limit_${Date.now()}`
    });
    await sleep(300);

    // 3. Limit Order with IOC
    await measureLatency('limit_order_ioc', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'buy',
        order_type: 'limit_order',
        limit_price: (currentPrice * 0.95).toFixed(4),
        time_in_force: 'ioc',
        client_order_id: `bench_limit_ioc_${Date.now()}`
    });
    await sleep(300);

    // 4. Limit Order Post-Only
    await measureLatency('limit_post_only', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'buy',
        order_type: 'limit_order',
        limit_price: (currentPrice * 0.90).toFixed(4),
        time_in_force: 'gtc',
        post_only: true,
        client_order_id: `bench_postonly_${Date.now()}`
    });
    await sleep(300);

    // 5. Stop Market Order
    await measureLatency('stop_market', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'sell',
        order_type: 'market_order',
        stop_order_type: 'stop_loss_order',
        stop_price: (currentPrice * 0.95).toFixed(4),
        stop_trigger_method: 'last_traded_price',
        client_order_id: `bench_stopmarket_${Date.now()}`
    });
    await sleep(300);

    // 6. Stop Limit Order
    await measureLatency('stop_limit', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'sell',
        order_type: 'limit_order',
        stop_order_type: 'stop_loss_order',
        stop_price: (currentPrice * 0.95).toFixed(4),
        limit_price: (currentPrice * 0.94).toFixed(4),
        stop_trigger_method: 'last_traded_price',
        client_order_id: `bench_stoplimit_${Date.now()}`
    });
    await sleep(300);

    // 7. Trailing Stop Order (sell = negative trail_amount)
    const trailAmt = (currentPrice * 0.01).toFixed(4);
    await measureLatency('trailing_stop', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'sell',
        order_type: 'market_order',
        stop_order_type: 'stop_loss_order',
        trail_amount: `-${trailAmt}`,
        stop_trigger_method: 'last_traded_price',
        client_order_id: `bench_trailstop_${Date.now()}`
    });
    await sleep(300);

    console.log('  Closing positions & orders for bracket tests...');
    try {
        const orders = await client.getLiveOrders();
        if (orders?.result) {
            for (const order of orders.result) {
                if (order.product_id?.toString() === PRODUCT_ID) {
                    await client.cancelOrder({ product_id: PRODUCT_ID, order_id: order.id.toString() });
                }
            }
        }
    } catch (e) {}
    try {
        await client.placeOrder({
            product_id: PRODUCT_ID,
            size: SIZE,
            side: 'sell',
            order_type: 'market_order',
            reduce_only: true,
            client_order_id: `close_bracket_${Date.now()}`
        });
    } catch (e) {}
    await sleep(800);

    await measureLatency('bracket_stoploss', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'buy',
        order_type: 'market_order',
        bracket_stop_loss_price: (currentPrice * 0.98).toFixed(4),
        bracket_stop_trigger_method: 'last_traded_price',
        client_order_id: `bench_bracket_${Date.now()}`
    });
    await sleep(300);

    console.log('  Closing positions & orders for bracket TP/SL test...');
    try {
        const orders2 = await client.getLiveOrders();
        if (orders2?.result) {
            for (const order of orders2.result) {
                if (order.product_id?.toString() === PRODUCT_ID) {
                    await client.cancelOrder({ product_id: PRODUCT_ID, order_id: order.id.toString() });
                }
            }
        }
    } catch (e) {}
    try {
        await client.placeOrder({
            product_id: PRODUCT_ID,
            size: SIZE,
            side: 'sell',
            order_type: 'market_order',
            reduce_only: true,
            client_order_id: `close_brackettpsl_${Date.now()}`
        });
    } catch (e) {}
    await sleep(800);

    await measureLatency('bracket_tpsl', {
        product_id: PRODUCT_ID,
        size: SIZE,
        side: 'buy',
        order_type: 'market_order',
        bracket_take_profit_price: (currentPrice * 1.02).toFixed(4),
        bracket_stop_loss_price: (currentPrice * 0.98).toFixed(4),
        bracket_stop_trigger_method: 'last_traded_price',
        client_order_id: `bench_brackettpsl_${Date.now()}`
    });

    // Print summary
    console.log('\n' + '━'.repeat(60));
    console.log('📊 RESULTS SUMMARY');
    console.log('━'.repeat(60));
    console.log('Order Type'.padEnd(25) + 'Latency'.padEnd(12) + 'Status'.padEnd(10) + 'Order ID');
    console.log('─'.repeat(60));
    
    // Sort by latency
    const sorted = [...results].sort((a, b) => parseFloat(a.latencyMs) - parseFloat(b.latencyMs));
    
    sorted.forEach((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
        console.log(`${medal} ${r.type.padEnd(22)}${r.latencyMs.padEnd(10)}ms ${r.success.padEnd(10)}${r.orderId}`);
    });
    
    console.log('━'.repeat(60));
    
    if (sorted.length > 0) {
        console.log(`\n🏆 Fastest: ${sorted[0].type} @ ${sorted[0].latencyMs}ms`);
        console.log(`🐢 Slowest: ${sorted[sorted.length-1].type} @ ${sorted[sorted.length-1].latencyMs}ms`);
        
        const avg = results.reduce((sum, r) => sum + parseFloat(r.latencyMs), 0) / results.length;
        console.log(`📈 Average: ${avg.toFixed(2)}ms`);
    }
    
    console.log('\n✅ Benchmark complete!\n');
}

// Run
runBenchmark().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
