/**
 * test-momentum-simple-aligned.js
 * Tests MomentumSimpleStrategy with EXACT trail logic matching Delta Exchange
 * 
 * TRAIL LOGIC (from Delta docs):
 * - Trail amount is ABSOLUTE price (not percentage)
 * - Delta tracks peak/trough server-side
 * - Sign: negative for buy, positive for sell
 * - Must conform to tick_size
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

console.log(`Loaded ${binanceData.length} Binance records, ${deltaData.length} Delta trades\n`);

// Strategy parameters (EXACT match to MomentumSimpleStrategy)
const FEE = 0.0003; // 0.03% edge threshold
const EMA_ALPHA = 0.02;
const TRAILING_STOP_PCT = 0.0002; // 0.02% (used to calculate absolute trail)
const TRADING_FEE = 0.0005; // 0.05% actual fee
const COOLDOWN_MS = 30000; // 30 seconds

// XRP specs (from MomentumSimpleStrategy)
const XRP_SPEC = {
    deltaId: 14969,
    precision: 4,
    tickSize: 0.0001
};

// Find nearest Binance record for a given Delta timestamp
function findNearestBinance(deltaTs) {
    let nearest = null;
    for (const b of binanceData) {
        if (b.ts <= deltaTs) nearest = b;
        else break;
    }
    return nearest;
}

// Calculate trail amount (EXACT match to MomentumSimpleStrategy)
function calculateTrailAmount(entryPrice, side) {
    const trailAbs = entryPrice * TRAILING_STOP_PCT;
    const tickSize = XRP_SPEC.tickSize;
    const trailTicks = Math.max(1, Math.round(trailAbs / tickSize));
    const trailAmount = trailTicks * tickSize;
    
    // Sign convention: NEGATIVE for buy, POSITIVE for sell
    return side === 'buy' ? -trailAmount : trailAmount;
}

// Check if trailing stop triggered (EXACT match to Delta Exchange logic)
function checkTrailingStop(side, entryPrice, currentPrice, peakPrice, trailAmount) {
    // For SELL (short) position:
    //   - Trail amount is POSITIVE
    //   - Stop triggers when price >= peakPrice + trailAmount
    //   - peakPrice tracks the LOWEST price seen
    
    // For BUY (long) position:
    //   - Trail amount is NEGATIVE
    //   - Stop triggers when price <= peakPrice + trailAmount
    //   - peakPrice tracks the HIGHEST price seen
    
    if (side === 'buy') {
        // Long position - trail amount is negative
        // Stop triggers when price <= peakPrice + trailAmount
        const stopPrice = peakPrice + trailAmount; // trailAmount is negative
        return currentPrice <= stopPrice;
    } else {
        // Short position - trail amount is positive
        // Stop triggers when price >= peakPrice + trailAmount
        const stopPrice = peakPrice + trailAmount; // trailAmount is positive
        return currentPrice >= stopPrice;
    }
}

// ==========================================
// FULL TRADE SIMULATION (ALIGNED)
// ==========================================

console.log('=== ALIGNED TRADE SIMULATION ===\n');
console.log(`FEE threshold: ${(FEE * 100).toFixed(2)}%`);
console.log(`Trailing stop: ${(TRAILING_STOP_PCT * 100).toFixed(2)}% (absolute: ${XRP_SPEC.tickSize})`);
console.log(`Trading fee: ${(TRADING_FEE * 100).toFixed(2)}%`);
console.log(`Tick size: ${XRP_SPEC.tickSize}`);
console.log('');

let emaBaseline = null;
let inPosition = false;
let entryPrice = 0;
let side = '';
let peakPrice = 0;
let trailAmount = 0;
let lastSignalTime = 0;
let trades = [];

// Process each Delta trade
for (const delta of deltaData) {
    const binance = findNearestBinance(delta.ts);
    if (!binance) continue;
    
    const pBinance = binance.mid;
    const pDelta = delta.price;
    const spread = pBinance - pDelta;
    
    // Initialize EMA
    if (emaBaseline === null) {
        emaBaseline = spread;
        continue; // First trade can never signal
    }
    
    // Update EMA
    emaBaseline = EMA_ALPHA * spread + (1 - EMA_ALPHA) * emaBaseline;
    
    // Calculate edge
    const adjustedEdge = spread - emaBaseline;
    const edgePct = (adjustedEdge / pBinance) * 100;
    
    // Check for exit first (if in position)
    if (inPosition) {
        // Update peak price
        if (side === 'buy') {
            if (pDelta > peakPrice) peakPrice = pDelta;
        } else {
            if (pDelta < peakPrice) peakPrice = pDelta;
        }
        
        // Check trailing stop (EXACT Delta logic)
        if (checkTrailingStop(side, entryPrice, pDelta, peakPrice, trailAmount)) {
            const grossPnl = side === 'buy'
                ? (pDelta - entryPrice) / entryPrice
                : (entryPrice - pDelta) / entryPrice;
            const netPnl = grossPnl - TRADING_FEE;
            
            trades.push({
                side,
                entry: entryPrice,
                exit: pDelta,
                peak: peakPrice,
                trailAmount,
                stopPrice: peakPrice + trailAmount,
                grossPnl,
                netPnl
            });
            
            console.log(`EXIT ${side.toUpperCase()} | Entry: ${entryPrice.toFixed(4)} | Exit: ${pDelta.toFixed(4)} | Peak: ${peakPrice.toFixed(4)} | Stop: ${(peakPrice + trailAmount).toFixed(4)} | Trail: ${trailAmount.toFixed(4)} | Net: ${(netPnl * 100).toFixed(4)}%`);
            
            inPosition = false;
            lastSignalTime = delta.ts;
        }
    }
    
    // Check for entry signal (if not in position and not in cooldown)
    if (!inPosition) {
        const cooldownActive = delta.ts - lastSignalTime < COOLDOWN_MS;
        
        if (!cooldownActive) {
            let entrySide = null;
            if (edgePct > FEE * 100) {
                entrySide = 'buy';
            } else if (edgePct < -(FEE * 100)) {
                entrySide = 'sell';
            }
            
            if (entrySide) {
                inPosition = true;
                entryPrice = pDelta;
                side = entrySide;
                peakPrice = pDelta;
                trailAmount = calculateTrailAmount(entryPrice, side);
                
                console.log(`ENTRY ${side.toUpperCase()} | Price: ${pDelta.toFixed(4)} | Edge: ${edgePct.toFixed(4)} | Trail: ${trailAmount.toFixed(4)} | Stop: ${(pDelta + trailAmount).toFixed(4)}`);
            }
        }
    }
}

// Close any open position at end
if (inPosition) {
    const lastDelta = deltaData[deltaData.length - 1];
    const exitPrice = lastDelta.price;
    
    const grossPnl = side === 'buy'
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;
    const netPnl = grossPnl - TRADING_FEE;
    
    trades.push({
        side,
        entry: entryPrice,
        exit: exitPrice,
        peak: peakPrice,
        trailAmount,
        stopPrice: peakPrice + trailAmount,
        grossPnl,
        netPnl
    });
    
    console.log(`EXIT ${side.toUpperCase()} (end of data) | Entry: ${entryPrice.toFixed(4)} | Exit: ${exitPrice.toFixed(4)} | Net: ${(netPnl * 100).toFixed(4)}%`);
}

// ==========================================
// RESULTS
// ==========================================

console.log('\n=== RESULTS ===\n');

if (trades.length === 0) {
    console.log('No trades executed');
} else {
    const wins = trades.filter(t => t.netPnl > 0);
    const losses = trades.filter(t => t.netPnl <= 0);
    
    const winRate = (wins.length / trades.length * 100).toFixed(1);
    const avgWin = wins.length > 0 ? (wins.reduce((sum, t) => sum + t.netPnl, 0) / wins.length * 100).toFixed(4) : 0;
    const avgLoss = losses.length > 0 ? (losses.reduce((sum, t) => sum + t.netPnl, 0) / losses.length * 100).toFixed(4) : 0;
    const totalPnl = trades.reduce((sum, t) => sum + t.netPnl, 0);
    
    console.log(`Total trades: ${trades.length}`);
    console.log(`Wins: ${wins.length}`);
    console.log(`Losses: ${losses.length}`);
    console.log(`Win rate: ${winRate}%`);
    console.log(`Avg win: ${avgWin}%`);
    console.log(`Avg loss: ${avgLoss}%`);
    console.log(`Total net PnL: ${(totalPnl * 100).toFixed(4)}%`);
    
    console.log('\n--- Trade Details ---');
    trades.forEach((t, i) => {
        const result = t.netPnl > 0 ? 'WIN' : 'LOSS';
        console.log(`${i+1}. ${t.side.toUpperCase()} | Entry: ${t.entry.toFixed(4)} | Exit: ${t.exit.toFixed(4)} | Peak: ${t.peak.toFixed(4)} | Stop: ${t.stopPrice.toFixed(4)} | Trail: ${t.trailAmount.toFixed(4)} | PnL: ${(t.netPnl * 100).toFixed(4)}% | ${result}`);
    });
}

// ==========================================
// COMPARISON: Different FEE thresholds
// ==========================================

console.log('\n=== FEE THRESHOLD COMPARISON ===\n');

function simulateWithFee(fee) {
    let ema = null;
    let inPos = false;
    let entry = 0;
    let s = '';
    let peak = 0;
    let trail = 0;
    let lastSig = 0;
    let trds = [];
    
    for (const delta of deltaData) {
        const binance = findNearestBinance(delta.ts);
        if (!binance) continue;
        
        const pBinance = binance.mid;
        const pDelta = delta.price;
        const spread = pBinance - pDelta;
        
        if (ema === null) {
            ema = spread;
            continue;
        }
        
        ema = EMA_ALPHA * spread + (1 - EMA_ALPHA) * ema;
        const adjustedEdge = spread - ema;
        const edgePct = (adjustedEdge / pBinance) * 100;
        
        // Exit check
        if (inPos) {
            if (s === 'buy') {
                if (pDelta > peak) peak = pDelta;
            } else {
                if (pDelta < peak) peak = pDelta;
            }
            
            if (checkTrailingStop(s, entry, pDelta, peak, trail)) {
                const grossPnl = s === 'buy'
                    ? (pDelta - entry) / entry
                    : (entry - pDelta) / entry;
                const netPnl = grossPnl - TRADING_FEE;
                trds.push(netPnl);
                inPos = false;
                lastSig = delta.ts;
            }
        }
        
        // Entry check
        if (!inPos && delta.ts - lastSig >= COOLDOWN_MS) {
            let es = null;
            if (edgePct > fee * 100) es = 'buy';
            else if (edgePct < -(fee * 100)) es = 'sell';
            
            if (es) {
                inPos = true;
                entry = pDelta;
                s = es;
                peak = pDelta;
                trail = calculateTrailAmount(entry, s);
            }
        }
    }
    
    // Close open position
    if (inPos) {
        const lastP = deltaData[deltaData.length - 1].price;
        const grossPnl = s === 'buy'
            ? (lastP - entry) / entry
            : (entry - lastP) / entry;
        const netPnl = grossPnl - TRADING_FEE;
        trds.push(netPnl);
    }
    
    const wins = trds.filter(p => p > 0).length;
    const total = trds.reduce((a, b) => a + b, 0);
    
    return { trades: trds.length, wins, winRate: trds.length > 0 ? (wins / trds.length * 100).toFixed(1) : '0.0', totalPnl: (total * 100).toFixed(4) };
}

const fees = [0.0001, 0.0002, 0.0003, 0.0004, 0.0005];

console.log('Fee Threshold | Trades | Wins | Win Rate | Total PnL');
console.log('--------------|--------|------|----------|----------');

for (const fee of fees) {
    const result = simulateWithFee(fee);
    console.log(`${(fee * 100).toFixed(2).padStart(12)}% | ${String(result.trades).padStart(6)} | ${String(result.wins).padStart(4)} | ${String(result.winRate).padStart(7)}% | ${String(result.totalPnl).padStart(9)}%`);
}

// ==========================================
// TRAIL AMOUNT COMPARISON
// ==========================================

console.log('\n=== TRAIL AMOUNT COMPARISON ===\n');

function simulateWithTrail(trailPct) {
    let ema = null;
    let inPos = false;
    let entry = 0;
    let s = '';
    let peak = 0;
    let trail = 0;
    let lastSig = 0;
    let trds = [];
    
    for (const delta of deltaData) {
        const binance = findNearestBinance(delta.ts);
        if (!binance) continue;
        
        const pBinance = binance.mid;
        const pDelta = delta.price;
        const spread = pBinance - pDelta;
        
        if (ema === null) {
            ema = spread;
            continue;
        }
        
        ema = EMA_ALPHA * spread + (1 - EMA_ALPHA) * ema;
        const adjustedEdge = spread - ema;
        const edgePct = (adjustedEdge / pBinance) * 100;
        
        // Exit check
        if (inPos) {
            if (s === 'buy') {
                if (pDelta > peak) peak = pDelta;
            } else {
                if (pDelta < peak) peak = pDelta;
            }
            
            if (checkTrailingStop(s, entry, pDelta, peak, trail)) {
                const grossPnl = s === 'buy'
                    ? (pDelta - entry) / entry
                    : (entry - pDelta) / entry;
                const netPnl = grossPnl - TRADING_FEE;
                trds.push(netPnl);
                inPos = false;
                lastSig = delta.ts;
            }
        }
        
        // Entry check
        if (!inPos && delta.ts - lastSig >= COOLDOWN_MS) {
            let es = null;
            if (edgePct > FEE * 100) es = 'buy';
            else if (edgePct < -(FEE * 100)) es = 'sell';
            
            if (es) {
                inPos = true;
                entry = pDelta;
                s = es;
                peak = pDelta;
                
                // Calculate trail with custom percentage
                const trailAbs = entry * trailPct;
                const trailTicks = Math.max(1, Math.round(trailAbs / XRP_SPEC.tickSize));
                trail = trailTicks * XRP_SPEC.tickSize;
                if (s === 'buy') trail = -trail;
            }
        }
    }
    
    // Close open position
    if (inPos) {
        const lastP = deltaData[deltaData.length - 1].price;
        const grossPnl = s === 'buy'
            ? (lastP - entry) / entry
            : (entry - lastP) / entry;
        const netPnl = grossPnl - TRADING_FEE;
        trds.push(netPnl);
    }
    
    const wins = trds.filter(p => p > 0).length;
    const total = trds.reduce((a, b) => a + b, 0);
    
    return { trades: trds.length, wins, winRate: trds.length > 0 ? (wins / trds.length * 100).toFixed(1) : '0.0', totalPnl: (total * 100).toFixed(4) };
}

const trails = [0.0001, 0.0002, 0.0005, 0.001, 0.002];

console.log('Trail % | Trades | Wins | Win Rate | Total PnL');
console.log('---------|--------|------|----------|----------');

for (const trail of trails) {
    const result = simulateWithTrail(trail);
    console.log(`${(trail * 100).toFixed(2).padStart(6)}% | ${String(result.trades).padStart(6)} | ${String(result.wins).padStart(4)} | ${String(result.winRate).padStart(7)}% | ${String(result.totalPnl).padStart(9)}%`);
}
