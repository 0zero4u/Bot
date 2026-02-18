/**
 *  */

class HybridStrategy {
  constructor(bot) {
    this.bot = bot;
    this.logger = bot.logger;

    // --- GLOBAL CONFIG ---

    // Vol regime / Z-gating (from TickStrategy, slightly cleaned)
    this.FAST_TAU_MS = 10000;   // fast vol timescale
    this.SLOW_TAU_MS = 180000;  // slow vol timescale
    this.WARMUP_MS   = 180000;  // 3 min warmup

    this.Z_BASE_ENTRY   = 1.8;
    this.MIN_OBI        = 0.20;
    this.VOL_REGIME_MIN = 1.0;   // enforce true vol expansion, not 0.85

    this.COOLDOWN_MS = 10000;    // shorter cooldown for HFT microstructure

    // Micro velocity + microprice (MicroStrategy)
    this.SPIKE_WINDOW_MS   = 15;
    this.SPIKE_PERCENT     = 0.0002; // 2 bps
    this.MICRO_THRESHOLD   = 0.60;   // microprice vs mid, in half-spread units

    // Hard SL + Trail TP (Micro/Advance style)
    this.TRAILING_PERCENT = parseFloat(process.env.TRAILING_PERCENT || "0.035");

    // Asset configuration (Kalman Q/R taken from TickStrategy)
    const envSize = process.env.ORDER_SIZE ? parseFloat(process.env.ORDER_SIZE) : null;

    this.assets = {};
    const now = Date.now();

    const MASTER_CONFIG = {
      XRP: {
        deltaId: 14969,
        precision: 4,
        tickSize: 0.0001,
        minLiquidity: 5000,
        kalmanQ: 1e-8,
        kalmanR: 1e-6,
        baseSize: envSize || 10
      },
      BTC: {
        deltaId: 27,
        precision: 1,
        tickSize: 0.1,
        minLiquidity: 0.5,
        kalmanQ: 1e-2,
        kalmanR: 1e-0,
        baseSize: envSize || 0.001
      },
      ETH: {
        deltaId: 299,
        precision: 2,
        tickSize: 0.01,
        minLiquidity: 5.0,
        kalmanQ: 1e-4,
        kalmanR: 1e-2,
        baseSize: envSize || 0.01
      },
      SOL: {
        deltaId: 417,
        precision: 3,
        tickSize: 0.1,
        minLiquidity: 50.0,
        kalmanQ: 1e-2,
        kalmanR: 1e-0,
        baseSize: envSize || 0.1
      }
    };

    Object.entries(MASTER_CONFIG).forEach(([symbol, cfg]) => {
      this.assets[symbol] = {
        symbol,
        ...cfg,

        // Tick/vol state
        isInitialized: false,
        lastTickMs: now,
        startTimeMs: now,
        lastLogMs: now,
        cooldownUntil: 0,

        muFast: 0,
        muSlow: 0,
        varFast: 0,
        varSlow: 0,

        kalmanX: 0,
        kalmanP: 1,

        emaObi: 0,

        // Microstructure state
        priceHistory: [],    // [{ price, time }]
        prevHalfSpread: null
      };
    });

    this.logger.info(
      `[HybridMicroLeadTick] Loaded | W=${this.SPIKE_WINDOW_MS}ms | ` +
      `Trail=${this.TRAILING_PERCENT}%`
    );
  }

  getName() {
    return "HybridMicroLeadTickStrategy";
  }

  async start() {
    this.logger.info("[HybridMicroLeadTick] 🟢 Engine Started.");
    return true;
  }

  /**
   * DepthUpdate from Rust:
   * { s: "BTC", bb: f64, bq: f64, ba: f64, aq: f64 }
   */
  async onDepthUpdate(depth) {
    if (!depth || !depth.s) return;

    const symbol = depth.s;
    const asset = this.assets[symbol];
    if (!asset) return;

    const now = Date.now();

    // Basic gating: open orders / positions
    if (this.bot.isOrderInProgress) return;
    if (this.bot.hasOpenPosition && this.bot.hasOpenPosition(symbol)) return;

    // Map & validate
    const bestBid = Number(depth.bb);
    const bestAsk = Number(depth.ba);
    const bidSize = Number(depth.bq || 0);
    const askSize = Number(depth.aq || 0);

    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return;

    const totalLiquidity = bidSize + askSize;
    if (totalLiquidity < asset.minLiquidity) return;

    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const halfSpread = spread / 2;
    if (halfSpread <= 1e-9) return;

    // --- INIT ON FIRST TICK ---
    if (!asset.isInitialized) {
      asset.lastTickMs = now;
      asset.startTimeMs = now;
      asset.muFast = mid;
      asset.muSlow = mid;
      asset.varFast = 0;
      asset.varSlow = 0;
      asset.emaObi = 0;
      asset.kalmanX = mid;
      asset.lastLogMs = now;
      asset.isInitialized = true;
      this.logger.info(`[HybridMicroLeadTick] First tick for ${symbol}. Engine primed.`);
      return;
    }

    // --- TIME DECAY COEFFICIENTS ---
    const dtMs = Math.max(1, now - asset.lastTickMs);
    asset.lastTickMs = now;

    const alphaFast  = 1 - Math.exp(-dtMs / this.FAST_TAU_MS);
    const alphaSlow  = 1 - Math.exp(-dtMs / this.SLOW_TAU_MS);
    const alphaMicro = 1 - Math.exp(-dtMs / 100); // 100ms time constant for OBI EMA

    // --- VWMP-STYLE MICROPRICE (Lead/Micro) ---
    const wmid = ((bestBid * askSize) + (bestAsk * bidSize)) / totalLiquidity;
    const microPrice = wmid;

    // --- KALMAN FILTER ON MID ---
    const pPred = asset.kalmanP + asset.kalmanQ;
    const kalmanGain = pPred / (pPred + asset.kalmanR);
    asset.kalmanX = asset.kalmanX + kalmanGain * (mid - asset.kalmanX);
    asset.kalmanP = (1 - kalmanGain) * pPred;
    const truePrice = asset.kalmanX;

    // --- FAST/SLOW VOL ON TRUE PRICE ---
    const deltaFast = truePrice - asset.muFast;
    asset.muFast += alphaFast * deltaFast;
    asset.varFast = (1 - alphaFast) * (asset.varFast + alphaFast * deltaFast * deltaFast);

    const deltaSlow = truePrice - asset.muSlow;
    asset.muSlow += alphaSlow * deltaSlow;
    asset.varSlow = (1 - alphaSlow) * (asset.varSlow + alphaSlow * deltaSlow * deltaSlow);

    const fastVol = Math.sqrt(Math.max(asset.varFast, 0));
    const slowVol = Math.sqrt(Math.max(asset.varSlow, 0));

    let zScore = 0;
    if (slowVol > 1e-9) {
      zScore = (truePrice - asset.muSlow) / slowVol;
    }

    const regimeRatio = slowVol > 1e-9 ? fastVol / slowVol : 1.0;
    const activeRegime = Math.max(1.0, regimeRatio);

    const dynamicZ   = Math.max(1.5, this.Z_BASE_ENTRY / Math.sqrt(activeRegime));
    const dynamicObi = Math.max(0.10, this.MIN_OBI / activeRegime);

    // --- OBI MICRO EMA ---
    const rawObi = (bidSize - askSize) / totalLiquidity;
    asset.emaObi += alphaMicro * (rawObi - asset.emaObi);

    // --- MICROSTRUCTURE VELOCITY (MicroStrategy) ---
    asset.priceHistory.push({ price: mid, time: now });
    const historyLimitMs = this.SPIKE_WINDOW_MS * 10;
    while (asset.priceHistory.length > 0 &&
           (now - asset.priceHistory[0].time) > historyLimitMs) {
      asset.priceHistory.shift();
    }

    let baseline = null;
    for (let i = 0; i < asset.priceHistory.length; i++) {
      if (now - asset.priceHistory[i].time <= this.SPIKE_WINDOW_MS) {
        baseline = asset.priceHistory[i];
        break;
      }
    }
    if (!baseline && asset.priceHistory.length > 0) {
      baseline = asset.priceHistory[0];
    }
    if (!baseline) return;

    const signedChange = (mid - baseline.price) / baseline.price;
    const absChange = Math.abs(signedChange);

    const signalStrength = (microPrice - mid) / halfSpread;

    const isVelUp   = signedChange > 0;
    const isVelDown = signedChange < 0;

    // --- LOGGING GLASS BOX (every 5s) ---
    if (now - asset.lastLogMs > 5000) {
      asset.lastLogMs = now;
      const warmPct = Math.min(100, (now - asset.startTimeMs) / this.WARMUP_MS * 100);

      let state = "[🟢 ACTIVE]";
      const isWarm = (now - asset.startTimeMs) >= this.WARMUP_MS;
      const isOnCooldown = asset.cooldownUntil && now < asset.cooldownUntil;
      const hasPosition =
        this.bot.hasOpenPosition && this.bot.hasOpenPosition(symbol);

      if (!isWarm) {
        state = `[🟡 WARMING UP: ${warmPct.toFixed(0)}%]`;
      } else if (hasPosition) {
        state = "[🔴 IN POSITION]";
      } else if (isOnCooldown) {
        const cdSecs = Math.max(0, (asset.cooldownUntil - now) / 1000).toFixed(0);
        state = `[🔵 COOLDOWN: ${cdSecs}s]`;
      }

      this.logger.info(
        `[HGLASS] ${symbol} ${state} | ` +
        `Mid:${mid.toFixed(asset.precision)} | WMid:${microPrice.toFixed(asset.precision)} | ` +
        `Z:${zScore.toFixed(2)} (req: ±${dynamicZ.toFixed(2)}) | ` +
        `OBI(EMA): ${(asset.emaObi * 100).toFixed(1)}% (req: ±${(dynamicObi*100).toFixed(1)}%) | ` +
        `ΔP:${(signedChange*100).toFixed(3)}% | Sig:${signalStrength.toFixed(2)} | ` +
        `Spread:${spread.toFixed(asset.precision)} | VolRegime:${regimeRatio.toFixed(2)}x | ` +
        `K:${kalmanGain.toFixed(4)}`
      );
    }

    // --- STRICT GATES ---

    const elapsedWarmup = now - asset.startTimeMs;
    const isWarm = elapsedWarmup >= this.WARMUP_MS;
    const isOnCooldown = asset.cooldownUntil && now < asset.cooldownUntil;
    const hasPosition =
      this.bot.hasOpenPosition && this.bot.hasOpenPosition(symbol);

    if (!isWarm || isOnCooldown || hasPosition) return;

    // Require vol expansion and reasonable spread vs vol
    const isVolExpanding = regimeRatio >= this.VOL_REGIME_MIN;
    const maxSpread = Math.max(asset.tickSize * 1.5, slowVol * 0.5);
    const isSpreadTight = spread <= maxSpread;

    if (!isVolExpanding || !isSpreadTight) return;

    // Require actual short-term move
    if (absChange < this.SPIKE_PERCENT) return;

    const bidRatio = bidSize / totalLiquidity;

    let side = null;

    // LONG hypothesis
    if (
      zScore >= dynamicZ &&
      asset.emaObi >= dynamicObi &&
      isVelUp &&
      signalStrength >= this.MICRO_THRESHOLD &&
      bidRatio >= 0.55
    ) {
      side = "buy";
      this.logger.info(
        `[TRIGGER] 📈 LONG ${symbol} | Z:${zScore.toFixed(2)} / ${dynamicZ.toFixed(2)} | ` +
        `OBI:${(asset.emaObi*100).toFixed(1)}% / ${(dynamicObi*100).toFixed(1)}% | ` +
        `ΔP:${(signedChange*100).toFixed(3)}% | Sig:${signalStrength.toFixed(2)} | ` +
        `BidRatio:${bidRatio.toFixed(2)}`
      );
    }

    // SHORT hypothesis
    if (!side &&
      zScore <= -dynamicZ &&
      asset.emaObi <= -dynamicObi &&
      isVelDown &&
      signalStrength <= -this.MICRO_THRESHOLD &&
      bidRatio <= 0.45
    ) {
      side = "sell";
      this.logger.info(
        `[TRIGGER] 📉 SHORT ${symbol} | Z:${zScore.toFixed(2)} / -${dynamicZ.toFixed(2)} | ` +
        `OBI:${(asset.emaObi*100).toFixed(1)}% / -${(dynamicObi*100).toFixed(1)}% | ` +
        `ΔP:${(signedChange*100).toFixed(3)}% | Sig:${signalStrength.toFixed(2)} | ` +
        `BidRatio:${bidRatio.toFixed(2)}`
      );
    }

    if (!side) return;

    asset.cooldownUntil = now + this.COOLDOWN_MS;

    const quotePrice = side === "buy" ? bestAsk : bestBid;
    await this.executeTrade(asset, side, quotePrice);
  }

  async executeTrade(asset, side, quotePrice) {
    if (this.bot.isOrderInProgress) return;

    this.bot.isOrderInProgress = true;
    const symbol = asset.symbol;

    try {
      const rawSize = asset.baseSize;
      const sizeStr = rawSize.toString();

      // Hard SL + Trail TP using bracket_trail_amount (Micro/Advance style)
      let trailValue = quotePrice * (this.TRAILING_PERCENT / 100);
      const minTrail = asset.tickSize;
      if (Math.abs(trailValue) < minTrail) {
        trailValue = trailValue >= 0 ? minTrail : -minTrail;
      }

      let trailSigned = Math.abs(trailValue);
      if (side === "buy") {
        trailSigned = -trailSigned; // stop below
      } else {
        trailSigned = +trailSigned; // stop above
      }

      const trailStr = trailSigned.toFixed(asset.precision);

      const clientOid = `HYB_${symbol}_${Date.now()}`;
      const payload = {
        product_id: asset.deltaId.toString(),
        size: sizeStr,
        side: side,
        order_type: "market_order",
        bracket_trail_amount: trailStr,
        bracket_stop_trigger_method: "last_traded_price",
        client_order_id: clientOid
      };

      this.logger.info(
        `[EXEC] ⚡ ${symbol} ${side.toUpperCase()} @ ${quotePrice.toFixed(asset.precision)} | ` +
        `Size:${sizeStr} | Trail:${trailStr} | OID:${clientOid}`
      );

      const res = await this.bot.placeOrder(payload);
      if (!res || !res.success) {
        this.logger.error(
          `[EXEC FAIL] ${symbol} ${side.toUpperCase()} | ` +
          `Resp: ${JSON.stringify(res || {})}`
        );
      }
    } catch (err) {
      this.logger.error(
        `[EXEC EXCEPTION] ${asset.symbol} ${side.toUpperCase()} | ${err.message}`
      );
    } finally {
      this.bot.isOrderInProgress = false;
    }
  }
}

module.exports = HybridStrategy;
        
