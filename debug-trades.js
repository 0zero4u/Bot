/**
 * debug-trades.js
 * Debug script to see what's happening with momentum trades
 */

const fs = require('fs');

const csv = fs.readFileSync('binance_xrp_bookticker.csv', 'utf-8');
const lines = csv.trim().split('\n').slice(1);
const prices = lines.map(line => parseFloat(line.split(',')[2])); // bid price

console.log(`Loaded ${prices.length} price points`);
const minPrice = Math.min(...prices);
const maxPrice = Math.max(...prices);
console.log(`Price range: ${minPrice} - ${maxPrice}`);
console.log('');

// Debug N=96 trades
const N = 96;
const holdingPeriod = 6;
let tradeCount = 0;

console.log(`=== DEBUG N=${N} TRADES ===\n`);

for (let i = N; i < prices.length - holdingPeriod && tradeCount < 10; i++) {
    const momentum = (prices[i] - prices[i - N]) / prices[i - N];
    
    if (Math.abs(momentum) < 0.00015) continue;

    const entryPrice = prices[i];
    const exitPrice = prices[i + holdingPeriod];
    const side = momentum > 0 ? 1 : -1;
    const returnPct = side * (exitPrice - entryPrice) / entryPrice;
    
    tradeCount++;
    console.log(`Trade ${tradeCount}:`);
    console.log(`  Entry price: ${entryPrice}`);
    console.log(`  Exit price: ${exitPrice}`);
    console.log(`  Momentum: ${(momentum * 100).toFixed(4)}%`);
    console.log(`  Side: ${side > 0 ? 'LONG' : 'SHORT'}`);
    console.log(`  Return: ${(returnPct * 100).toFixed(4)}%`);
    console.log(`  Result: ${returnPct > 0 ? 'WIN' : 'LOSS'}`);
    console.log('');
}
