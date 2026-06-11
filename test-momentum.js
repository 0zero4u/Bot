/**
 * test-momentum.js
 * Simple momentum test on XRP Binance bookTicker data
 * 
 * Logic: momentum = (price[now] - price[now-N]) / price[now-N]
 * If momentum > 0 → long (expect price to continue up)
 * If momentum < 0 → short (expect price to continue down)
 * 
 * Metrics: win rate, avg return, return/maxDD
 */

const fs = require('fs');

// Read CSV
const csv = fs.readFileSync('binance_xrp_bookticker.csv', 'utf-8');
const lines = csv.trim().split('\n').slice(1); // skip header

// Extract prices (use bid as "close" since it's more conservative)
const prices = lines.map(line => {
    const [ts, symbol, bid, ask] = line.split(',');
    return parseFloat(bid);
});

console.log(`Loaded ${prices.length} price points\n`);

// Test parameters
const lookbacks = [6, 12, 24, 48, 96];
const holdingPeriod = 6; // hold for 6 ticks after entry

// Results storage
const results = [];

for (const N of lookbacks) {
    let wins = 0;
    let losses = 0;
    let totalReturn = 0;
    let peakEquity = 0;
    let maxDrawdown = 0;
    let equity = 0;
    let tradeCount = 0;

    // Simulate trades
    for (let i = N; i < prices.length - holdingPeriod; i++) {
        const momentum = (prices[i] - prices[i - N]) / prices[i - N];
        
        // Only trade if momentum exceeds 0.015% (adjusted to match observed max momentum)
        if (Math.abs(momentum) < 0.00015) continue;

        // Entry at current price, exit after holding period
        const entryPrice = prices[i];
        const exitPrice = prices[i + holdingPeriod];
        
        // If momentum positive → long, if negative → short
        const side = momentum > 0 ? 1 : -1;
        const returnPct = side * (exitPrice - entryPrice) / entryPrice;
        
        totalReturn += returnPct;
        tradeCount++;
        
        if (returnPct > 0) wins++;
        else losses++;

        // Track equity curve for max drawdown
        equity += returnPct;
        if (equity > peakEquity) peakEquity = equity;
        const drawdown = peakEquity - equity;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const winRate = tradeCount > 0 ? (wins / tradeCount * 100).toFixed(1) : 0;
    const avgReturn = tradeCount > 0 ? (totalReturn / tradeCount * 100).toFixed(4) : 0;
    const returnToMaxDD = maxDrawdown > 0 ? (totalReturn / maxDrawdown).toFixed(2) : 'N/A';

    results.push({
        N,
        trades: tradeCount,
        winRate: parseFloat(winRate),
        avgReturn: parseFloat(avgReturn),
        totalReturn: (totalReturn * 100).toFixed(4),
        maxDrawdown: (maxDrawdown * 100).toFixed(4),
        returnToMaxDD
    });
}

// Print results table
console.log('=== MOMENTUM TEST RESULTS ===\n');
console.log('N (lookback) | Trades | Win Rate | Avg Return | Total Return | Max DD | Return/MaxDD');
console.log('-------------|--------|----------|------------|--------------|--------|-------------');

for (const r of results) {
    console.log(`${String(r.N).padStart(12)} | ${String(r.trades).padStart(6)} | ${String(r.winRate).padStart(7)}% | ${String(r.avgReturn).padStart(9)}% | ${String(r.totalReturn).padStart(11)}% | ${String(r.maxDrawdown).padStart(5)}% | ${String(r.returnToMaxDD).padStart(12)}`);
}

// Pass/Fail decision
console.log('\n=== PASS/FAIL CRITERIA ===\n');

const passed = results.filter(r => 
    r.winRate > 55 && 
    r.avgReturn > 0 && 
    r.returnToMaxDD !== 'N/A' && parseFloat(r.returnToMaxDD) > 0.5
);

console.log(`Criteria: Win Rate > 55%, Avg Return > 0, Return/MaxDD > 0.5`);
console.log(`Results: ${passed.length}/${results.length} lookback values passed\n`);

if (passed.length >= 3) {
    console.log('✅ PASS: Simple momentum shows statistical edge on XRP');
    console.log('   Recommended lookback:', passed.map(p => p.N).join(', '));
} else {
    console.log('❌ FAIL: Simple momentum does NOT show reliable edge on XRP');
    console.log('   Consider: wider stops, different timeframe, or mean-reversion strategy');
}

// Additional analysis: what stop distance would work?
console.log('\n=== STOP LOSS ANALYSIS ===\n');

// Calculate max adverse excursion for winning trades
let winningTradesKilledBy01Pct = 0;
let totalWinningTrades = 0;
let maxAdverseExcursions = [];

for (const N of lookbacks) {
    for (let i = N; i < prices.length - holdingPeriod; i++) {
        const momentum = (prices[i] - prices[i - N]) / prices[i - N];
        if (Math.abs(momentum) < 0.00015) continue;

        const entryPrice = prices[i];
        const exitPrice = prices[i + holdingPeriod];
        const side = momentum > 0 ? 1 : -1;
        const returnPct = side * (exitPrice - entryPrice) / entryPrice;
        
        if (returnPct > 0) {
            totalWinningTrades++;
            
            // Check if a 0.1% stop would have killed this winning trade
            let stoppedOut = false;
            for (let j = i + 1; j <= i + holdingPeriod; j++) {
                const adverseMove = side * (prices[j] - entryPrice) / entryPrice;
                if (adverseMove < -0.001) { // 0.1% stop
                    stoppedOut = true;
                    break;
                }
            }
            if (stoppedOut) winningTradesKilledBy01Pct++;
        }
    }
}

const pctKilled = totalWinningTrades > 0 ? (winningTradesKilledBy01Pct / totalWinningTrades * 100).toFixed(1) : 0;
console.log(`Total winning trades: ${totalWinningTrades}`);
console.log(`Winning trades killed by 0.1% stop: ${winningTradesKilledBy01Pct} (${pctKilled}%)`);

if (parseFloat(pctKilled) > 50) {
    console.log('\n⚠️  WARNING: 0.1% stop is too tight - kills >50% of winning trades');
    console.log('   Recommendation: Use volatility-adjusted stops (0.3-0.5%)');
} else {
    console.log('\n✅ 0.1% stop appears reasonable for this data');
}
