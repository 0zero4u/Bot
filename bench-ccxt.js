const ccxt = require('ccxt');

async function main() {
    const exchange = new ccxt.delta({
        apiKey: 'qfvMkedn6I9xrprH1JqcWIPuXlLF7J',
        secret: '3LM4Kdmj9TRSkuMp5SMjRdjVoq1rqgjkyUNH43YtJceeZWaLIpHB1lczpTVV',
        urls: {
            api: {
                public: 'https://api.india.delta.exchange',
                private: 'https://api.india.delta.exchange',
            },
        },
        enableRateLimit: false,
    });

    await exchange.loadMarkets();

    const symbol = 'XRP/USD:USD';
    console.log(`Testing: ${symbol}\n`);
    const results = [];

    for (let i = 0; i < 3; i++) {
        const start = Date.now();
        try {
            const order = await exchange.createOrder(symbol, 'limit', 'buy', 1, 0.50);
            const elapsed = Date.now() - start;
            results.push(elapsed);
            console.log(`[${i + 1}] Order: ${order.id} | Latency: ${elapsed}ms`);

            await exchange.cancelOrder(order.id, symbol);
            console.log(`    Cancelled`);
        } catch (e) {
            const elapsed = Date.now() - start;
            results.push(elapsed);
            console.log(`[${i + 1}] Error: ${e.message.substring(0, 100)} | Latency: ${elapsed}ms`);
        }
    }

    const avg = results.reduce((a, b) => a + b, 0) / results.length;
    console.log(`\nAverage latency: ${avg.toFixed(0)}ms`);

    await exchange.close();
}

main().catch(console.error);
