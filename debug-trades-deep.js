/**
 * debug-trades-deep.js
 * Deep analysis of why trades are losing
 */

const fs = require('fs');

// Read CSVs
const binanceCSV = fs.readFileSync('binance_xrp_bookticker.csv', 'utf-8');
const deltaCSV = fs.readFileSync('delta_xrp_trades.csv', 'utf-8');

const binanceLines = binanceCSV.trim().split('\n').slice(1);
const deltaLines = deltaCSV.trim().split('\n').slice(1);

const binanceData = binanceLines.map(line => {
    const [ts, symbol, bid, ask] = line.split(',');
    return { ts: parseInt(ts), bid: parseFloat(bid), ask: parseFloat(ask), mid: (parseFloat(bid) + parseFloat(ask)) / 2 };
});

const deltaData = deltaLines.map(line => {
    const [ts, symbol, price, size, buyerRole] = line.split(',');
    return { ts: parseInt(ts), price: parseFloat(price), size: parseFloat(size) };
});

console.log('=== DEEP TRADE ANALYSIS ===\n');

// Strategy parameters
const FEE = 0.0003; // 0.03% edge threshold
const EMA_ALPHA = 0.02;
const TRAILING_STOP_PCT = 0.0002; // 0.02% trailing stop
const TRADING_FEE = 0.0005; // 0.05% actual fee
const COOLDOWN_MS = 30000; // 30 seconds

function findNearestBinance(deltaTs) {
    let nearest = null;
    for (const b of binanceData) {
        if (b.ts <= deltaTs) nearest = b;
        else break;
    }
    return nearest;
}

// Simulate with detailed logging
let emaBaseline = null;
let inPosition = false;
let entryPrice = 0;
let side = '';
let peakPrice = 0;
let lastSignalTime = 0;
let tradeCount = 0;

console.log('--- Step-by-Step Simulation ---\n');

for (const delta of deltaData) {
    const binance = findNearestBinance(delta.ts);
    if (!binance) continue;
    
    const pBinance = binance.mid;
    const pDelta = delta.price;
    const spread = pBinance - pDelta;
    
    if (emaBaseline === null) {
        emaBaseline = spread;
        console.log(`[INIT] EMA baseline set to: ${spread.toFixed(6)}`);
        continue;
    }
    
    emaBaseline = EMA_ALPHA * spread + (1 - EMA_ALPHA) * emaBaseline;
    const adjustedEdge = spread - emaBaseline;
    const edgePct = (adjustedEdge / pBinance) * 100;
    
    // Check exit first
    if (inPosition) {
        if (side === 'buy') {
            if (pDelta > peakPrice) peakPrice = pDelta;
            const drawdown = (peakPrice - pDelta) / peakPrice;
            
            if (drawdown >= TRAILING_STOP_PCT) {
                tradeCount++;
                const grossPnl = (pDelta - entryPrice) / entryPrice;
                const netPnl = grossPnl - TRADING_FEE;
                
                console.log(`\n[TRADE ${tradeCount} EXIT] BUY`);
                console.log(`  Entry price: ${entryPrice.toFixed(4)}`);
                console.log(`  Exit price: ${pDelta.toFixed(4)}`);
                console.log(`  Peak price: ${peakPrice.toFixed(4)}`);
                console.log(`  Gross PnL: ${(grossPnl * 100).toFixed(4)}%`);
                console.log(`  Trading fee: ${(TRADING_FEE * 100).toFixed(4)}%`);
                console.log(`  Net PnL: ${(netPnl * 100).toFixed(4)}%`);
                console.log(`  Result: ${netPnl > 0 ? 'WIN' : 'LOSS'}`);
                
                // Analyze why loss
                console.log(`\n  [ANALYSIS]`);
                if (grossPnl > 0 && netPnl < 0) {
                    console.log(`  ⚠️  GROSS PROFIT but NET LOSS — fee ate the profit`);
                    console.log(`  ⚠️  Need gross PnL > ${(TRADING_FEE * 100).toFixed(2)}% to break even`);
                    console.log(`  ⚠️  Actual gross: ${(grossPnl * 100).toFixed(4)}% — ${(grossPnl * 100 < TRADING_FEE * 100 ? 'TOO SMALL' : 'SUFFICIENT')}`);
                } else if (grossPnl < 0) {
                    console.log(`  ❌ GROSS LOSS — price moved against position`);
                    console.log(`  ❌ Trailing stop triggered at drawdown: ${(drawdown * 100).toFixed(4)}%`);
                }
                
                inPosition = false;
                lastSignalTime = delta.ts;
            }
        } else {
            if (pDelta < peakPrice) peakPrice = pDelta;
            const drawdown = (pDelta - peakPrice) / peakPrice;
            
            if (drawdown >= TRAILING_STOP_PCT) {
                tradeCount++;
                const grossPnl = (entryPrice - pDelta) / entryPrice;
                const netPnl = grossPnl - TRADING_FEE;
                
                console.log(`\n[TRADE ${tradeCount} EXIT] SELL`);
                console.log(`  Entry price: ${entryPrice.toFixed(4)}`);
                console.log(`  Exit price: ${pDelta.toFixed(4)}`);
                console.log(`  Peak price: ${peakPrice.toFixed(4)}`);
                console.log(`  Gross PnL: ${(grossPnl * 100).toFixed(4)}%`);
                console.log(`  Trading fee: ${(TRADING_FEE * 100).toFixed(4)}%`);
                console.log(`  Net PnL: ${(netPnl * 100).toFixed(4)}%`);
                console.log(`  Result: ${netPnl > 0 ? 'WIN' : 'LOSS'}`);
                
                // Analyze why loss
                console.log(`\n  [ANALYSIS]`);
                if (grossPnl > 0 && netPnl < 0) {
                    console.log(`  ⚠️  GROSS PROFIT but NET LOSS — fee ate the profit`);
                    console.log(`  ⚠️  Need gross PnL > ${(TRADING_FEE * 100).toFixed(2)}% to break even`);
                    console.log(`  ⚠️  Actual gross: ${(grossPnl * 100).toFixed(4)}% — ${(grossPnl * 100 < TRADING_FEE * 100 ? 'TOO SMALL' : 'SUFFICIENT')}`);
                } else if (grossPnl < 0) {
                    console.log(`  ❌ GROSS LOSS — price moved against position`);
                    console.log(`  ❌ Trailing stop triggered at drawdown: ${(drawdown * 100).toFixed(4)}%`);
                }
                
                inPosition = false;
                lastSignalTime = delta.ts;
            }
        }
    }
    
    // Check entry
    if (!inPosition) {
        const cooldownActive = delta.ts - lastSignalTime < COOLDOWN_MS;
        
        if (!cooldownActive) {
            let entrySide = null;
            if (edgePct > FEE * 100) entrySide = 'buy';
            else if (edgePct < -(FEE * 100)) entrySide = 'sell';
            
            if (entrySide) {
                inPosition = true;
                entryPrice = pDelta;
                side = entrySide;
                peakPrice = pDelta;
                
                console.log(`\n[ENTRY] ${side.toUpperCase()}`);
                console.log(`  Delta price: ${pDelta.toFixed(4)}`);
                console.log(`  Binance mid: ${pBinance.toFixed(4)}`);
                console.log(`  Spread: ${spread.toFixed(6)}`);
                console.log(`  EMA baseline: ${emaBaseline.toFixed(6)}`);
                console.log(`  Adjusted edge: ${adjustedEdge.toFixed(6)}`);
                console.log(`  Edge %: ${edgePct.toFixed(4)}%`);
                console.log(`  Required move to break even: ${(TRADING_FEE * 100).toFixed(2)}% (just to cover fee)`);
            }
        }
    }
}

// Close any open position
if (inPosition) {
    const lastDelta = deltaData[deltaData.length - 1];
    const exitPrice = lastDelta.price;
    
    const grossPnl = side === 'buy' 
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;
    const netPnl = grossPnl - TRADING_FEE;
    
    tradeCount++;
    console.log(`\n[TRADE ${tradeCount} EXIT] ${side.toUpperCase()} (end of data)`);
    console.log(`  Entry: ${entryPrice.toFixed(4)} | Exit: ${exitPrice.toFixed(4)}`);
    console.log(`  Gross PnL: ${(grossPnl * 100).toFixed(4)}% | Net PnL: ${(netPnl * 100).toFixed(4)}%`);
}

// ==========================================
// ROOT CAUSE ANALYSIS
// ==========================================

console.log('\n=== ROOT CAUSE ANALYSIS ===\n');

console.log('Key metrics:');
console.log(`  Trading fee: 0.05% per trade`);
console.log(`  Trailing stop: 0.02% from peak`);
console.log(`  Break-even move: 0.05% (to cover fee alone)`);
console.log(`  Trailing stop exit: 0.02% drawdown from peak`);
console.log('');

console.log('The problem:');
console.log('  1. Trailing stop is 0.02% — exits when price drops 0.02% from peak');
console.log('  2. But fee is 0.05% — need 0.05% favorable move just to break even');
console.log('  3. If price moves 0.04% favorably then drops 0.02% → exit at +0.02% gross');
console.log('  4. Net = 0.02% - 0.05% = -0.03% (LOSS even though price moved favorably!)');
console.log('');

console.log('Example from Trade 1:');
console.log('  Entry (SELL): 1.1173');
console.log('  Peak: 1.1163 (price dropped 0.09% — good!)');
console.log('  Exit: 1.1168 (price rose 0.05% from peak — trailing stop)');
console.log('  Gross PnL: (1.1173 - 1.1168) / 1.1173 = +0.0447%');
console.log('  Fee: 0.05%');
console.log('  Net: 0.0447% - 0.05% = -0.0053% (LOSS!)');
console.log('');

console.log('The trailing stop is NOT the problem — the FEE is the problem!');
console.log('  - Price moved 0.09% favorably before trailing stop triggered');
console.log('  - But we only captured 0.0447% of that move');
console.log('  - And the fee ate 0.05%');
console.log('');

console.log('Solutions:');
console.log('  1. Use scalper offer (0% closing fee) → break-even at 0% instead of 0.05%');
console.log('  2. Widen trailing stop to capture more of the move (0.05-0.10%)');
console.log('  3. Wait for more volatile conditions (larger moves)');
console.log('  4. Combine: lower fee + wider stop = profit');
