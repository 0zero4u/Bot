# Bot — Delta Exchange Arbitrage Trading Bot

High-frequency arbitrage bot trading on **Delta Exchange (India)** using **Binance** price signals. Built with a **Rust native client** (NAPI-RS) for low-latency REST, and **Node.js** for WebSocket orchestration + strategy logic.

---

## Architecture

```
Binance WS ──► Rust BinanceListener ──► JS Strategy ──► Rust DeltaNativeClient ──► Delta Exchange
                      │                        │                 │
                  SIMD JSON                  O(1) Map       HTTP/2 + TCP_NODELAY
                  scratch buffer            lookups         pre-allocated sign()
                  reuse                                    static default headers
```

### Components

| Layer | Technology | Role |
|-------|-----------|------|
| **Binance Listener** | Rust (`fast_websocket_client` + `simd-json`) | WebSocket trade/depth feeds, parsed with scratch-buffer reuse |
| **Strategy Engine** | Node.js | Divergence detection, Z-score baseline, signal generation |
| **Delta Client** | Rust (reqwest HTTP/2, napi-rs) | Authenticated REST orders, HMAC-SHA256 signing |
| **Delta WS** | Node.js (`ws`) | Public trades + private orders/positions on single endpoint `wss://socket.india.delta.exchange` |

---

## Key Optimizations

### 1. WS-Race Order Acknowledgement (~140ms saved)

`trader.js:placeOrder()` races the REST response against the WebSocket `orders` channel `create` event. Delta broadcasts the WS event ~100-160ms **before** the REST response returns (WS fires immediately after matching, before DB sync + REST gateway).

```
REST:  ──► send order ──► Delta matches ──► DB sync ──► REST response  (~750ms)
WS:    ──► send order ──► Delta matches ──► WS broadcast              (~620ms)
                                    WS wins by ~130ms 🚀
```

- If WS wins: order acknowledged ~130ms faster, REST result discarded
- If WS times out (2s): REST response used as fallback
- If WS unavailable: REST works normally — zero regression

**All strategies automatically benefit** — they call `this.bot.placeOrder()` which implements the race.

### 2. Native WebSocket Ping/Pong

Heartbeat uses `ws.ping()` (WebSocket control frame, opcode 0x9) instead of `JSON.stringify({type:'ping'})`:
- Zero JSON serialization/parse overhead
- Handled at TCP layer
- No GC pressure from heartbeat allocations

### 3. O(1) Symbol Lookups

All position/trade/order handlers use pre-built `Map` lookups instead of `Array.find()` / `Object.keys().find()`:

| Before | After |
|--------|-------|
| `targetAssets.find(a => symbol.startsWith(a))` — O(n) | `symbolLookup.get(symbol) \|\| .find()` — O(1) |
| `Object.keys(assets).find(k => symbol.includes(k))` — O(n) | `symbolIndex.get(symbol) \|\| .find()` — O(1) |

Pre-maps all common suffix formats: `XRP`, `XRPUSD`, `XRPUSDT`, `XRP-USD`, `XRP-PERP`.

### 4. Pre-Computed WS Subscribe Messages

Subscribe payloads are serialized once at construction, not on every (re)connection. Saves ~5-10μs + GC per reconnect.

### 5. Rust Native Client Optimizations

| Optimization | Before | After |
|-------------|--------|-------|
| **sign() buffer** | `format!()` — allocates + copies all inputs | `String::with_capacity()` + `push_str()` — exact single alloc |
| **Headers** | `api-key`, `Content-Type` set per-request | Set once at `reqwest::Client::builder()` level |
| **User-Agent** | `Mozilla/5.0 (compatible; DeltaBot/Native)` — 46B | `DeltaBot` — 7B |
| **Timeout** | 2.5s total | 2s connect + 4s total (room within 5s signature window) |
| **HTTP** | HTTP/1.1 | **HTTP/2** multiplexing via `reqwest + rustls-tls` |
| **Raw JSON orders** | Via `Value` intermediary (can reorder keys) | `place_order_raw()` accepts pre-serialized `String` |

### 6. Dead Code Removal

`client.js` — the old JavaScript `DeltaClient` (161 lines with DNS pinning, LIFO scheduling, SNI spoofing) was **never imported** anywhere. All code uses the Rust `DeltaNativeClient`. Deleted.

---

## Latency Profile

Measured on warm connection to `api.india.delta.exchange`:

```
Network RTT (warm):            ~15ms
Rust sign() + headers:          ~2μs
getPositions (auth'd GET):     ~23ms
placeOrder REST:               ~750ms
placeOrder WS-race ack:        ~620ms  ← ~130ms faster
```

**Bottleneck**: Delta Exchange's internal order processing + DB sync (~730ms). No client-side optimization reduces this — it's the exchange's matching engine.

---

## Setup

```bash
# Install dependencies
npm install

# Build the Rust native client
cd fast-client
npm run build    # or: cargo build --release
cd ..

# Configure environment
cp .env.example .env
# Edit .env with your Delta Exchange API keys
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DELTA_API_KEY` | — | Delta Exchange API key |
| `DELTA_API_SECRET` | — | Delta Exchange API secret |
| `DELTA_BASE_URL` | `https://api.india.delta.exchange` | REST API endpoint |
| `STRATEGY` | `Advance` | Strategy to load (see below) |
| `TARGET_ASSETS` | `BTC,ETH,XRP,SOL` | Comma-separated asset list |
| `ORDER_SIZE` | per-strategy default | Order size in contracts |
| `RECONNECT_INTERVAL` | `5000` | WS reconnect delay (ms) |
| `PING_INTERVAL_MS` | `30000` | WS ping interval (ms) |
| `HEARTBEAT_TIMEOUT_MS` | `40000` | WS heartbeat timeout (ms) |

---

## Strategies

| File | Class | Description |
|------|-------|-------------|
| `AdvanceStrategy.js` | `AdvanceStrategy` | **V83.3 Binary Sniper** — Hard SL + Trail TP, liquidity-aware sizing, binary timing window (4-20ms) |
| `ArbBaselineStrategy.js` | `ArbBaselineStrategy` | Z-score baseline arbitrage with trailing stop-loss via `onUserTrade` |
| `ArbBaselineDebugStrategy.js` | `ArbBaselineStrategy` | Simplified debug version (no Z-score, bracket orders instead of manual stop) |
| `FastStrategy.js` | — | VAMP strategy |
| `HybridStrategy.js` | — | Hybrid approach |
| `MicroStrategy.js` | — | Micro-sized entries |
| *(and more)* | | |

Set via `STRATEGY=Advance` in `.env` or environment.

---

## Pitfalls & Known Issues

### 🚨 Critical

1. **Order side defaults to `sell` if WS trade message has no `buyer_role`** — `handleWebSocketMessage` forwards `message.buyer_role` (values: `"taker"` or `"maker"`). Side is determined by `buyer_role === 'taker'` (buy) vs `seller_role === 'taker'` (sell). There is **no** `taker_side` field in Delta's protocol (verified against CCXT, cryptofeed, OpenAlgo, official SDK). Monitor `volSinceUpdateBuy` never incrementing as a symptom.

2. **WS heartbeat timeout can fire during reconnect** — If the private WS disconnects and `stopHeartbeat()` doesn't clear the old timeout before `initPrivateWebSocket()` creates a new socket, the old timeout can `.terminate()` the new connection. The fix is in place (F3), but ensure no other code path skips `stopHeartbeat()`.

### ⚠️ Medium

3. **`REST call still in flight after WS timeout** — If WS ack doesn't arrive within 2s (WS disconnected, subscribe delayed), the race resolves with `null` and the function returns `null` to the strategy. The REST request continues in background. If it later fails, the error is silently swallowed (`.catch(() => {})` is intentional to prevent crash).

4. **No exponential backoff on WS reconnect** — Both public and private WS retry at a constant interval (default 5s). If the exchange is rate-limiting, this causes a reconnection storm. Currently uses fixed `RECONNECT_INTERVAL`.

5. **Trade direction is inverted in `ArbBaselineDebugStrategy`** — Compared to the main `ArbBaselineStrategy`, the debug version's side determination is flipped (`deltaHigher ? 'buy' : 'sell'` instead of `'sell' : 'buy'`). Do NOT use the debug strategy for real trading.

### ✅ Clean (fixed)

| Issue | Status |
|-------|--------|
| `taker_side` field referenced (doesn't exist in Delta protocol) | ✅ Fixed — removed, uses `buyer_role` only |
| `wss://public-socket.india.delta.exchange` used (not a real endpoint) | ✅ Fixed — now uses `wss://socket.india.delta.exchange` (single endpoint for all channels) |
| `restCall` unhandled promise rejection | ✅ Fixed — `.catch()` attached unconditionally |
| Heartbeat interval/pong listener leak on reconnect | ✅ Fixed — `stopHeartbeat()` on close, stored handler ref |
| Missing `unhandledRejection` process handler | ✅ Fixed |
| Stop-loss `.then()` without `.catch()` | ✅ Fixed |
| Missing `-PERP` key in strategy `symbolIndex` Maps | ✅ Fixed |
| WS trade `buyer_role` not forwarded | ✅ Fixed |

---

## Running

```bash
# Start with default strategy (Advance)
node trader.js

# Start with specific strategy
STRATEGY=ArbBaseline node trader.js

# Benchmark order latencies
node benchmark-order-types.js
```

---

## Benchmarking

```bash
node benchmark-order-types.js
```

Runs a sequence of market/limit/stop/bracket orders and reports latency per type. Also serves as a quick connectivity check.

---

## Build Requirements

- **Node.js** >= 18 (tested on 20+)
- **Rust** (for `fast-client` native addon)
  - `cargo` with `rustup`
  - `napi-rs` CLI (`npm install -g @napi-rs/cli`)
- **npm** or **bun**

### Building the Rust Client

```bash
cd fast-client
npm install
npm run build
# Output: fast-client/*.node (native addon)
```
