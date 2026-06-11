/**
 * test-momentum-rider.js
 * Tests MomentumRiderStrategy logic on XRP Binance bookTicker data
 * 
 * REAL STRATEGY LOGIC:
 * - Entry: ANY price change triggers trade (currentPrice > lastTradePrice → buy, else sell)
 * - Exit: Trailing stop at momentumReversalThreshold drawdown from peak
 * - Fees: 0.05% opening (scalper offer: 0% closing)
 * - Order: IOC limit at aggressive price (ask+epsilon for buy, bid-epsilon for sell)
 */

const fs = require('fs');

// Read CSV
const csv = fs.readFileSync('binance_xrp_bookticker.csv', 'utf-8');
const lines = csv.trim().split('\n').slice(1); // skip header

// Extract bid and ask prices
const data = lines.map(line => {
    const [ts, symbol, bid, ask] = line.split(',');
    return { ts: parseInt(ts), bid: parseFloat(bid), ask: parseFloat(ask) };
});

console.log(`Loaded ${data.length} price points\n`);

// Strategy parameters
const FEE_RATE = 0.0005; // 0.05% opening fee (scalper offer)
const AGGRESSION_EPSILON = 0.00001; // 1 pip for aggressive pricing

// Test different trailing stop thresholds
const thresholds = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005]; // 0.01% to 0.5%

// Results storage
const results = [];

for (const threshold of thresholds) {
    let wins = 0;
    let losses = 0;
    let totalGrossPnl = 0;
    let totalFees = 0;
    let totalNetPnl = 0;
    let tradeCount = 0;
    let peakEquity = 0;
    let maxDrawdown = 0;
    let equity = 0;
    
    // Position state
    let inTrade = false;
    let entryPrice = 0;
    let side = 0; // 1 = long, -1 = short
    let peakPrice = 0;
    let lastTradePrice = data[0].bid;
    
    // Simulate trades
    for (let i = 1; i < data.length; i++) {
        const currentBid = data[i].bid;
        const currentAsk = data[i].ask;
        
        // Check if price changed
        if (currentBid === lastTradePrice) continue;
        
        if (!inTrade) {
            // ENTRY: Any price change triggers trade
            // Direction: currentPrice > lastTradePrice → buy, else sell
            side = currentBid > lastTradePrice ? 1 : -1;
            
            // Aggressive IOC pricing
            entryPrice = side === 1 
                ? currentAsk + AGGRESSION_EPSILON  // Buy at ask + epsilon
                : currentBid - AGGRESSION_EPSILON; // Sell at bid - epsilon
            
            // Pay opening fee
            const fee = entryPrice * FEE_RATE;
            totalFees += fee;
            
            // Set position state
            inTrade = true;
            peakPrice = entryPrice;
            lastTradePrice = currentBid;
            
        } else {
            // MANAGE POSITION: Track peak and check trailing stop
            if (side === 1) {
                // Long position
                if (currentBid > peakPrice) {
                    peakPrice = currentBid;
                }
                const drawdown = (peakPrice - currentBid) / peakPrice;
                
                if (drawdown >= threshold) {
                    // EXIT: Trailing stop triggered
                    const exitPrice = currentBid; // Exit at bid
                    const grossPnl = side * (exitPrice - entryPrice) / entryPrice;
                    const fee = entryPrice * FEE_RATE; // Already paid on entry
                    const netPnl = grossPnl - (fee / entryPrice);
                    
                    totalGrossPnl += grossPnl;
                    totalNetPnl += netPnl;
                    tradeCount++;
                    
                    if (netPnl > 0) wins++;
                    else losses++;
                    
                    // Track equity
                    equity += netPnl;
                    if (equity > peakEquity) peakEquity = equity;
                    const dd = peakEquity - equity;
                    if (dd > maxDrawdown) maxDrawdown = dd;
                    
                    // Reset position
                    inTrade = false;
                    lastTradePrice = currentBid;
                }
            } else {
                // Short position
                if (currentBid < peakPrice) {
                    peakPrice = currentBid;
                }
                const drawdown = (currentBid - peakPrice) / peakPrice;
                
                if (drawdown >= threshold) {
                    // EXIT: Trailing stop triggered
                    const exitPrice = currentAsk; // Exit at ask for short
                    const grossPnl = side * (exitPrice - entryPrice) / entryPrice;
                    const fee = entryPrice * FEE_RATE; // Already paid on entry
                    const netPnl = grossPnl - (fee / entryPrice);
                    
                    totalGrossPnl += grossPnl;
                    totalNetPnl += netPnl;
                    tradeCount++;
                    
                    if (netPnl > 0) wins++;
                    else losses++;
                    
                    // Track equity
                    equity += netPnl;
                    if (equity > peakEquity) peakEquity = equity;
                    const dd = peakEquity - equity;
                    if (dd > maxDrawdown) maxDrawdown = dd;
                    
                    // Reset position
                    inTrade = false;
                    lastTradePrice = currentBid;
                }
            }
        }
    }
    
    // Close any open position at end
    if (inTrade) {
        const exitPrice = side === 1 ? data[data.length - 1].bid : data[data.length - 1].ask;
        const grossPnl = side * (exitPrice - entryPrice) / entryPrice;
        const fee = entryPrice * FEE_RATE;
        const netPnl = grossPnl - (fee / entryPrice);
        
        totalGrossPnl += grossPnl;
        totalNetPnl += netPnl;
        tradeCount++;
        
        if (netPnl > 0) wins++;
        else losses++;
    }
    
    const winRate = tradeCount > 0 ? (wins / tradeCount * 100).toFixed(1) : 0;
    const avgGrossPnl = tradeCount > 0 ? (totalGrossPnl / tradeCount * 100).toFixed(4) : 0;
    const avgFee = tradeCount > 0 ? (totalFees / tradeCount / entryPrice * 100).toFixed(4) : 0;
    const avgNetPnl = tradeCount > 0 ? (totalNetPnl / tradeCount * 100).toFixed(4) : 0;
    const returnToMaxDD = maxDrawdown > 0 ? (totalNetPnl / maxDrawdown).toFixed(2) : 'N/A';
    
    results.push({
        threshold: (threshold * 100).toFixed(2) + '%',
        trades: tradeCount,
        winRate: parseFloat(winRate),
        avgGrossPnl: parseFloat(avgGrossPnl),
        avgFee: parseFloat(avgFee),
        avgNetPnl: parseFloat(avgNetPnl),
        totalNetPnl: (totalNetPnl * 100).toFixed(4),
        maxDrawdown: (maxDrawdown * 100).toFixed(4),
        returnToMaxDD
    });
}

// Print results table
console.log('=== MOMENTUM RIDER STRATEGY TEST RESULTS ===\n');
console.log('Threshold | Trades | Win Rate | Avg Gross | Avg Fee | Avg Net | Total Net | Max DD | Return/MaxDD');
console.log('----------|--------|----------|-----------|---------|---------|-----------|--------|-------------');

for (const r of results) {
    console.log(`${String(r.threshold).padStart(9)} | ${String(r.trades).padStart(6)} | ${String(r.winRate).padStart(7)}% | ${String(r.avgGrossPnl).padStart(8)}% | ${String(r.avgFee).padStart(6)}% | ${String(r.avgNetPnl).padStart(6)}% | ${String(r.totalNetPnl).padStart(10)}% | ${String(r.maxDrawdown).padStart(5)}% | ${String(r.returnToMaxDD).padStart(12)}`);
}

// Pass/Fail decision
console.log('\n=== PASS/FAIL CRITERIA ===\n');

const passed = results.filter(r => 
    r.winRate > 50 && 
    r.avgNetPnl > 0 && 
    parseFloat(r.totalNetPnl) > 0
);

console.log(`Criteria: Win Rate > 50%, Avg Net PnL > 0, Total Net PnL > 0`);
console.log(`Results: ${passed.length}/${results.length} threshold values passed\n`);

if (passed.length > 0) {
    console.log('✅ PASS: MomentumRider shows edge on XRP');
    console.log('   Best threshold:', passed.reduce((a, b) => parseFloat(a.totalNetPnl) > parseFloat(b.totalNetPnl) ? a : b).threshold);
} else {
    console.log('❌ FAIL: MomentumRider does NOT show edge on XRP');
    console.log('   Strategy loses money after fees');
}

// Additional analysis
console.log('\n=== FEE IMPACT ANALYSIS ===\n');

const noThreshold = results.find(r => r.threshold === '0.20%');
if (noThreshold) {
    console.log(`With 0.2% trailing stop (current .env setting):`);
    console.log(`  Trades: ${noThreshold.trades}`);
    console.log(`  Total fees paid: ${(noThreshold.trades * FEE_RATE * 100).toFixed(2)}% of position value`);
    console.log(`  Total net PnL: ${noThreshold.totalNetPnl}%`);
    console.log(`  Verdict: ${parseFloat(noThreshold.totalNetPnl) > 0 ? 'PROFITABLE' : 'UNPROFITABLE'}`);
}

console.log('\n=== RECOMMENDATIONS ===\n');

const bestResult = results.reduce((a, b) => parseFloat(a.totalNetPnl) > parseFloat(b.totalNetPnl) ? a : b);
console.log(`Best performing threshold: ${bestResult.threshold}`);
console.log(`  Win rate: ${bestResult.winRate}%`);
console.log(`  Total net PnL: ${bestResult.totalNetPnl}%`);
console.log(`  Trades: ${bestResult.trades}`);

if (parseFloat(bestResult.totalNetPnl) <= 0) {
    console.log('\n⚠️  ALL thresholds show negative PnL after fees');
    console.log('   Options:');
    console.log('   1. Reduce trading frequency (add minimum move filter)');
    console.log('   2. Tighten trailing stop (0.01-0.05%)');
    console.log('   3. Wait for more volatile market conditions');
}
