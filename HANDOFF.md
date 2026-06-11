# Handoff Document: Momentum Strategy Backtesting
## Date: June 11, 2026

---

## 1. Original Goal

Test if simple momentum strategy works on XRP (Delta Exchange) before deploying real money.

**User's request:** "we are having losses. we need to backtest. csv delta trades we record and binance bookticker and we to check simple momentum strategy works or no."

---

## 2. What We Discovered

### 2.1 The Real Strategy: MomentumSimpleStrategy (NOT MomentumRider)

**Location:** `/home/arshhtripathi/Bot/strategies/MomentumSimpleStrategy.js`

**Strategy Type:** Lead-Lag Arbitrage
- **Binance = LEAD** (faster, more liquid)
- **Delta = LAG** (slower, less liquid)
- **Logic:** When Binance moves → assume Delta will follow → trade on Delta

**How it works:**
```
1. Binance price moves
2. Edge = (Binance - Delta) / Binance
3. Adjusted Edge = Edge - EMA baseline
4. If adjustedEdge > FEE (0.03%) → BUY on Delta
5. If adjustedEdge < -FEE → SELL on Delta
6. Exit via trailing stop (absolute amount)
```

### 2.2 Key Parameters (from .env.example)

| Parameter | Value | Purpose |
|-----------|-------|---------|
| MONUMENT_FEE | 0.0018 (0.18%) | Signal threshold (edge must exceed) |
| TRADING_FEE | 0.0005 (0.05%) | Actual fee (scalper offer) |
| TRAILING_STOP_PCT | 0.0002 (0.02%) | Trailing stop percentage |
| EMA_ALPHA | 0.02 | EMA smoothing factor |
| COOLDOWN_MS | 30000 | 30 seconds between trades |

**Note:** MONUMENT_FEE=0.18% is too high for XRP. We tested with FEE=0.03% which gave 2 trades.

### 2.3 Fee Structure (Delta Exchange Scalper Offer)

- **Opening fee:** 0.05% (paid on entry)
- **Closing fee:** 0% (scalper offer)
- **Total round-trip:** 0.05%

**Critical insight:** The fee (0.05%) eats small profits. Need >0.05% favorable move to break even.

### 2.4 Trailing Stop Logic (Delta Exchange)

**From Delta docs:**
- Trail amount is **ABSOLUTE price** (not percentage)
- Delta tracks peak/trough **server-side**
- Sign convention: **Negative for buy, positive for sell**
- Must conform to product's **tick_size**

**Strategy implementation:**
```javascript
const trailAbs = price * TRAILING_STOP_PCT;
const tickSize = spec.tickSize || 0.0001;
const trailTicks = Math.max(1, Math.round(trailAbs / tickSize));
const trailAmount = trailTicks * tickSize;
const signedTrail = side === 'buy' ? -trailAmount : trailAmount;
```

---

## 3. What We Built

### 3.1 Data Recording Scripts

**File:** `/home/arshhtripathi/Bot/record-xrp.js`
- Records XRP data from Delta Exchange (trades) and Binance (bookTicker)
- Duration: Configurable (currently 180 seconds)
- Output: `delta_xrp_trades.csv` and `binance_xrp_bookticker.csv`

**Run:** `node record-xrp.js`

### 3.2 Test Scripts

| File | Purpose | Status |
|------|---------|--------|
| `test-momentum.js` | Old test (WRONG - different strategy) | ❌ Don't use |
| `test-momentum-rider.js` | Tests MomentumRiderStrategy | ⚠️ Different strategy |
| `test-momentum-simple.js` | Basic MomentumSimpleStrategy test | ⚠️ Approximate |
| `test-momentum-simple-trades.js` | Full trade simulation (percentage trail) | ⚠️ Not aligned |
| `test-momentum-simple-aligned.js` | **ALIGNED** - uses absolute trail amount | ✅ Use this |
| `debug-trades-deep.js` | Deep analysis of why trades lose | ✅ Diagnostic |

### 3.3 Data Files

| File | Records | Content |
|------|---------|---------|
| `binance_xrp_bookticker.csv` | 10,200 | Binance bookTicker (bid, ask, bid_qty, ask_qty) |
| `delta_xrp_trades.csv` | 22 | Delta trades (price, size, buyer_role) |

**Time period:** ~3 minutes (too short for statistical validation)

---

## 4. Test Results

### 4.1 Aligned Test (FEE=0.03%, Trail=0.02%)

| Metric | Value |
|--------|-------|
| Total trades | 2 |
| Wins | 1 |
| Losses | 1 |
| Win rate | 50% |
| Total net PnL | -0.082% |

**Trade details:**
1. SELL at 1.1173 → Exit at 1.1167 → **WIN (+0.004%)**
2. SELL at 1.1174 → Exit at 1.1178 → **LOSS (-0.086%)**

### 4.2 Fee Threshold Comparison

| Fee Threshold | Trades | Win Rate | Total PnL |
|---------------|--------|----------|-----------|
| 0.01% | 3 | 33% | -0.132% |
| 0.02% | 3 | 33% | -0.132% |
| 0.03% | 2 | 50% | -0.082% |
| 0.04% | 0 | — | 0% |
| 0.05% | 0 | — | 0% |

### 4.3 Trail Amount Comparison

| Trail % | Trades | Win Rate | Total PnL |
|---------|--------|----------|-----------|
| 0.01% | 2 | 50% | -0.082% |
| 0.02% | 2 | 50% | -0.082% |
| 0.05% | 2 | 0% | -0.100% |
| 0.10% | 1 | 0% | -0.095% |
| 0.20% | 1 | 0% | -0.131% |

---

## 5. Root Cause Analysis

### Why Trades Lose

1. **Fee eats profits** (0.05% per trade)
   - Trade 1: Gross +0.054%, Fee -0.05%, Net +0.004%
   - Need >0.05% favorable move just to break even

2. **Low volatility** (only 0.14% total movement in 3 minutes)
   - Only 22 Delta trades in 3 minutes
   - Only 2 signals generated at FEE=0.03%

3. **Price moved wrong direction** (Trade 2)
   - Delta didn't follow Binance
   - Trailing stop triggered at loss

4. **Insufficient data** (3 minutes is too short)
   - Need hours/days for statistical validation
   - Need 50+ trades to evaluate performance

---

## 6. What We Validated

### ✅ Strategy Logic is Correct

- EMA baseline correctly normalizes persistent spread
- Edge calculation matches Delta docs
- Trailing stop uses absolute amount (confirmed by Delta docs)
- Sign convention is correct (negative for buy, positive for sell)
- Tick size rounding is correct

### ✅ Test is Now Aligned

- Uses absolute trail amount (not percentage)
- Matches MomentumSimpleStrategy logic exactly
- Uses correct fee structure (0.05% opening, 0% closing)

### ⚠️ Data is Insufficient

- Only 3 minutes of data
- Only 22 Delta trades
- Only 2 signals at FEE=0.03%
- Need longer data for validation

---

## 7. Next Steps

### 7.1 Immediate (Before Real Trading)

1. **Record longer data** (1+ hours, ideally 24 hours)
   - Run `node record-xrp.js` with `DURATION_MS = 3600000` (1 hour)
   - Or better: run continuously and save daily files

2. **Test with more data**
   - Run `node test-momentum-simple-aligned.js`
   - Need 50+ trades for statistical significance

3. **Validate lead-lag relationship**
   - Check if Binance actually leads Delta
   - Run cointegration/Granger causality tests
   - Need hours of aligned data

### 7.2 Parameter Tuning

| Parameter | Current | Test Range | Notes |
|-----------|---------|------------|-------|
| FEE | 0.03% | 0.01% - 0.05% | Lower = more trades, lower quality |
| TRAILING_STOP_PCT | 0.02% | 0.01% - 0.10% | Wider = capture more move |
| EMA_ALPHA | 0.02 | 0.01 - 0.05 | Slower = more stable baseline |
| COOLDOWN_MS | 30000 | 10000 - 60000 | Shorter = more trades |

### 7.3 Before Real Money

1. **Paper trading** — test on live data without real money
2. **Statistical validation** — prove lead-lag relationship exists
3. **Backtesting** — test on historical data (days/weeks)
4. **Risk management** — position sizing, max loss limits

---

## 8. Key Files Reference

### Strategy Code
- `/home/arshhtripathi/Bot/strategies/MomentumSimpleStrategy.js` — Main strategy
- `/home/arshhtripathi/Bot/strategies/MomentumRiderStrategy.js` — Different strategy (not used)

### Configuration
- `/home/arshhtripathi/Bot/.env.example` — Environment variables
- `/home/arshhtripathi/Bot/trader.js` — Bot main file

### Test Scripts
- `/home/arshhtripathi/Bot/test-momentum-simple-aligned.js` — **USE THIS** (aligned test)
- `/home/arshhtripathi/Bot/debug-trades-deep.js` — Deep trade analysis
- `/home/arshhtripathi/Bot/record-xrp.js` — Data recording

### Data
- `/home/arshhtripathi/Bot/binance_xrp_bookticker.csv` — Binance bookTicker
- `/home/arshhtripathi/Bot/delta_xrp_trades.csv` — Delta trades

---

## 9. Critical Findings Summary

1. **Strategy logic is correct** — aligned with Delta Exchange docs
2. **Fee (0.05%) is the main problem** — eats small profits
3. **Low volatility** — need more price movement
4. **Insufficient data** — 3 minutes is too short
5. **Win rate is 50%** — but still losing due to fee
6. **Need longer data** — 1+ hours for validation

---

## 10. Commands to Continue

```bash
# Record longer data (1 hour)
cd /home/arshhtripathi/Bot
node record-xrp.js  # Edit DURATION_MS = 3600000 first

# Run aligned test
node test-momentum-simple-aligned.js

# Deep analysis
node debug-trades-deep.js

# Check strategy code
cat strategies/MomentumSimpleStrategy.js
```

---

## 11. Questions to Answer Next

1. **Does Binance actually lead Delta?** (need cointegration test)
2. **What FEE threshold works?** (test 0.01% - 0.05%)
3. **What trail amount works?** (test 0.01% - 0.10%)
4. **Is 50% win rate enough?** (need more trades to know)
5. **Can we profit after fees?** (need larger moves or lower fees)

---

## 12. Risk Warnings

⚠️ **Do NOT deploy real money until:**
- Lead-lag relationship is statistically validated
- Strategy is profitable on 1+ hours of data
- Paper trading shows consistent profits
- Risk management is in place

⚠️ **Current status:** Strategy logic is correct, but insufficient data to prove profitability.

---

*Last updated: June 11, 2026*
*Next action: Record 1+ hour of data and re-run tests*
