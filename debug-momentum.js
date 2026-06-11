/**
 * debug-momentum.js
 * Debug script to see actual momentum values
 */

const fs = require('fs');

const csv = fs.readFileSync('binance_xrp_bookticker.csv', 'utf-8');
const lines = csv.trim().split('\n').slice(1);
const prices = lines.map(line => parseFloat(line.split(',')[2])); // bid price

console.log(`Loaded ${prices.length} price points`);
const minPrice = Math.min(...prices);
const maxPrice = Math.max(...prices);
console.log(`Price range: ${minPrice} - ${maxPrice}`);
console.log(`Total movement: ${((maxPrice - minPrice) / minPrice * 100).toFixed(4)}%`);
console.log('');

// Check momentum for different lookbacks
const lookbacks = [6, 12, 24, 48, 96];

for (const N of lookbacks) {
    const momentums = [];
    for (let i = N; i < prices.length; i++) {
        const momentum = (prices[i] - prices[i - N]) / prices[i - N];
        momentums.push(momentum);
    }
    
    const absMomentums = momentums.map(Math.abs);
    const maxMomentum = Math.max(...absMomentums);
    const avgMomentum = absMomentums.reduce((a, b) => a + b, 0) / absMomentums.length;
    const aboveThreshold = momentums.filter(m => Math.abs(m) >= 0.00035).length;
    
    console.log(`N=${N}: max=${(maxMomentum*100).toFixed(4)}%, avg=${(avgMomentum*100).toFixed(4)}%, above 0.035% threshold: ${aboveThreshold}`);
}
