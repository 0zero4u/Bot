# Arbitrage Bot

High-frequency cryptocurrency arbitrage trading bot for Delta Exchange (India) using Binance price signals.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Binance WS     │────▶│  Node.js Bot    │────▶│  Delta Exchange │
│  (Rust Client)  │     │  (Signal Logic) │     │  (REST API)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Strategies

### ArbBaselineCCXT (Recommended)

Cross-exchange arbitrage using CCXT library for order placement.

**Latency:** ~795ms

```bash
STRATEGY="ArbBaselineCCXT"
```

**Features:**
- Z-score statistical validation (3σ = 99.7% confidence)
- Rolling baseline divergence calculation (180s window)
- Urgency filter (≤10ms above threshold)
- Bracket trail stop-loss on entry order

### ArbBaselineGo

Cross-exchange arbitrage using Go executor service for order placement.

**Latency:** ~750ms

```bash
STRATEGY="ArbBaselineGo"
```

**Requires Go executor:**
```bash
cd go-executor
go build -o executor main.go
./executor
```

### ArbBaseline (Legacy)

Original strategy using custom Rust client.

**Latency:** ~1100ms

```bash
STRATEGY="ArbBaseline"
```

## Latency Comparison

| Client | Order Latency | Notes |
|--------|---------------|-------|
| Custom Rust | ~1100ms | Original implementation |
| CCXT Node.js | ~795ms | Recommended |
| Go HTTP/2 | ~750ms | Best possible |

**Bottleneck:** Delta Exchange API (~750ms) — not client-side code.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Delta Exchange API credentials
```

### 3. Run Bot

```bash
node trader.js
```

### 4. Run with PM2 (Production)

```bash
pm2 start ecosystem.config.js
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STRATEGY` | Strategy to use | `ArbBaselineCCXT` |
| `TARGET_ASSETS` | Comma-separated assets | `XRP` |
| `THRESHOLD` | Divergence threshold | `0.0003` |
| `Z_THRESHOLD` | Z-score threshold | `3.0` |
| `BASELINE_WINDOW` | Baseline window (ms) | `180000` |
| `COOLDOWN_MS` | Cooldown between trades | `30000` |

### Delta Exchange API

| Variable | Description |
|----------|-------------|
| `DELTA_API_KEY` | API key |
| `DELTA_API_SECRET` | API secret |
| `DELTA_BASE_URL` | API endpoint |

## Signal Logic

1. **Binance Trade Stream** — Real-time price from Binance
2. **Delta Trade Stream** — Real-time price from Delta Exchange
3. **Divergence Calculation** — `|Binance - Delta| / Binance`
4. **Z-Score Validation** — `(divergence - mean) / std`
5. **Urgency Filter** — Must be above threshold for ≤10ms
6. **Order Placement** — Market order with bracket trail stop

## Latency Optimization

### Already Implemented

- ✅ HTTP Keep-Alive / Connection Pooling
- ✅ DNS Pinning
- ✅ TCP No-Delay
- ✅ SNI Spoofing
- ✅ NTP Clock Sync

### To Improve Further

| Action | Impact |
|--------|--------|
| Move server to AWS Tokyo | -500ms → ~250ms |
| Use Binance Futures | -700ms → ~50ms |

## Files

| File | Purpose |
|------|---------|
| `trader.js` | Main bot orchestrator |
| `strategies/ArbBaselineCCXTStrategy.js` | CCXT-based strategy |
| `strategies/ArbBaselineGoStrategy.js` | Go executor strategy |
| `go-executor/` | Go order placement service |
| `bench-ccxt.js` | Latency benchmark tool |

## License

ISC
