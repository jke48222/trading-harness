import * as fs from 'node:fs';

// Minimal .env loader (no dependency): real environment variables win over .env values.
(function loadDotEnv(): void {
  try {
    const text = fs.readFileSync('.env', 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      if (process.env[key] === undefined) {
        process.env[key] = raw.replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // No .env file — defaults apply.
  }
})();

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name}='${v}' is not a number.`);
  }
  return n;
}

const primarySymbol = process.env.SYMBOL ?? 'BTCUSDT';

export const CONFIG = {
  symbol: primarySymbol,
  /**
   * Scan universe: comma-separated SYMBOLS (e.g. "BTCUSDT,ETHUSDT,SPY").
   * Symbols ending in USDT use Binance public data; anything else is treated
   * as a US stock via the Alpaca PAPER data API (read-only, IEX feed).
   */
  symbolsList: (process.env.SYMBOLS ?? primarySymbol)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  interval: process.env.INTERVAL ?? '5m',
  fastPeriod: num('FAST_MA', 9),
  slowPeriod: num('SLOW_MA', 21),

  /** Higher-timeframe regime filter (Trial 02): gate entries by 1h trend. */
  regimeFilter: (process.env.REGIME_FILTER ?? 'off').toLowerCase() === 'on',
  htfInterval: process.env.HTF_INTERVAL ?? '1h',
  htfMa: num('HTF_MA', 50),

  /** Strategy selector: 'sma-cross' (default), 'donchian-breakout' (Trial 03), or 'tsmom' (Trial 04). */
  strategyName: process.env.STRATEGY ?? 'sma-cross',
  /** Trial 04: time-series momentum lookback in candles (locked default 28 days). */
  tsmomLookback: num('TSMOM_LOOKBACK', 28),
  /**
   * TSMOM state mode (the exact Trial 07 construction): long whenever the
   * trailing momentum is positive, exit when it flips non-positive. Requires
   * EXECUTION=alpaca-paper and LONG_ONLY=on (position state lives at the
   * broker; simulation has no position to key off).
   */
  tsmomState: (process.env.TSMOM_STATE ?? 'off').toLowerCase() === 'on',
  /** Donchian channel length (Trial 03, locked default 20). */
  donchianLen: num('DONCHIAN_LEN', 20),
  /** Trial 03 v2: gate breakouts by same-timeframe SMA trend. */
  trendAlign: (process.env.TREND_ALIGN ?? 'off').toLowerCase() === 'on',
  trendMa: num('TREND_MA', 200),
  /** Trial 03 v3: suppress short setups. */
  longOnly: (process.env.LONG_ONLY ?? 'off').toLowerCase() === 'on',

  /** Optional replay window bounds (ISO dates) for IS/OOS splits; empty = whole span. */
  replayWindowStart: process.env.REPLAY_WINDOW_START ?? '',
  replayWindowEnd: process.env.REPLAY_WINDOW_END ?? '',

  /**
   * Execution mode: 'sim' (default — local simulation, exactly as before) or
   * 'alpaca-paper' (real orders on the hardcoded Alpaca PAPER account).
   * Approved by the user 2026-07-15 per §5 of trading_bot_instructions.md.
   */
  executionMode: process.env.EXECUTION ?? 'sim',
  /** Max total notional deployed at once (user 2026-07-15: full $100k paper for breadth discovery). */
  budgetUsd: num('BUDGET', 100000),
  /** Notional per entry in USD (before volatility scaling). */
  perTradeUsd: num('PER_TRADE_USD', 2000),

  // ---- Risk controls (the brakes) ----
  /** Halt all NEW entries if the account is down more than this % on the UTC day. Exits still run. */
  maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 8),
  /** Volatility target for position sizing: size = perTrade × clamp(target / realizedVol, floor, 1). */
  volTargetPct: num('VOL_TARGET_PCT', 4),
  /** Floor on the vol-scaling fraction, so high-vol names still get a (small) position. */
  volSizeFloor: num('VOL_SIZE_FLOOR', 0.25),
  /** Correlation cap: crypto moves together (~0.6–0.9), so cap the crypto cluster at this % of budget. */
  cryptoClusterCapPct: num('CRYPTO_CLUSTER_CAP_PCT', 70),
  /** Catastrophe stop: force-exit a position down more than this % (0 = off). Wide, so it never fights the strategy. */
  maxPositionLossPct: num('MAX_POSITION_LOSS_PCT', 30),
  /** Optional bounded marketable-limit: cap how far a fill may move from the decision price, in bps (0 = plain market). */
  limitSlippageBps: num('LIMIT_SLIPPAGE_BPS', 0),

  // ---- Cost & timing levers (attack the ~30 bps that starts every trade underwater) ----
  /** 'taker' (market, default) or 'maker' (passive limit below the mark → lower fee; may not fill → retry next scan). */
  orderMode: (process.env.ORDER_MODE ?? 'taker').toLowerCase(),
  /** Maker limit is placed this many bps BELOW the decision mark, so it rests instead of crossing. */
  makerOffsetBps: num('MAKER_OFFSET_BPS', 5),
  /** Seconds to wait for a maker fill before cancelling and retrying next scan. */
  makerWaitSec: num('MAKER_WAIT_SEC', 25),
  /**
   * If > 0, NEW crypto entries only fire within this many minutes after the last
   * daily close (00:00 UTC) — so fills land near the price the signal was
   * computed on. TZ-independent. Exits are never windowed. 0 = enter anytime.
   */
  entryWindowMin: num('ENTRY_WINDOW_MIN', 0),
  /** Max simultaneous broker positions. */
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 50),

  /** Paper order size in base units (BTC for BTCUSDT). */
  quantity: num('QUANTITY', 0.001),
  /** Max paper position in base units. Orders that would exceed it are SKIPped. */
  maxPosition: num('MAX_POSITION', 0.003),
  /** Paper order size for stock symbols, in shares. */
  stockQuantity: num('STOCK_QUANTITY', 1),
  /** Max paper stock position, in shares. */
  stockMaxPosition: num('STOCK_MAX_POSITION', 3),

  /** Historical candles pulled for replay commands (max 1000 per request). */
  replayCandles: num('REPLAY_CANDLES', 500),
  /** Candles held when scoring a replay setup (12 x 5m = 1 hour). */
  evalHorizon: num('EVAL_HORIZON', 12),
  /** Round-trip fee + slippage assumption, in basis points (10 = 0.10%). */
  feeBps: num('FEE_BPS', 10),
  /** Candles pulled for a single scan. */
  scanCandles: num('SCAN_CANDLES', 120),

  /** Real prior losses on a setup before memory may block it. */
  memoryMinLosses: num('MEMORY_MIN_LOSSES', 2),

  /**
   * When 'false', replay runs do NOT write to ledger.csv/learnings.md —
   * research experiments stay out of forward trade memory. Trials are still
   * disclosed in trials.csv either way.
   */
  replayWriteMemory: (process.env.REPLAY_WRITE_MEMORY ?? 'true').toLowerCase() !== 'false',

  dataDir: process.env.DATA_DIR ?? 'data',
} as const;

/**
 * Validate config at startup. Throws on values that would corrupt results or
 * risk logic; warns on suspicious-but-legal ones. Called by the CLI entrypoint.
 */
export function validateConfig(): void {
  const die = (m: string): never => {
    throw new Error(`Config error: ${m}`);
  };
  if (CONFIG.perTradeUsd <= 0) die('PER_TRADE_USD must be positive.');
  if (CONFIG.budgetUsd < CONFIG.perTradeUsd) die('BUDGET must be at least PER_TRADE_USD.');
  if (CONFIG.maxOpenPositions < 1) die('MAX_OPEN_POSITIONS must be at least 1.');
  if (CONFIG.feeBps < 0) die('FEE_BPS cannot be negative.');
  if (CONFIG.tsmomLookback < 2) die('TSMOM_LOOKBACK must be at least 2.');
  if (CONFIG.volSizeFloor <= 0 || CONFIG.volSizeFloor > 1) die('VOL_SIZE_FLOOR must be in (0,1].');
  if (CONFIG.cryptoClusterCapPct <= 0 || CONFIG.cryptoClusterCapPct > 100) die('CRYPTO_CLUSTER_CAP_PCT must be in (0,100].');
  if (CONFIG.executionMode !== 'sim' && CONFIG.executionMode !== 'alpaca-paper') {
    die(`EXECUTION must be 'sim' or 'alpaca-paper' (got '${CONFIG.executionMode}') — there is no live execution mode.`);
  }
  const warn: string[] = [];
  if (CONFIG.executionMode === 'alpaca-paper' && CONFIG.feeBps < 25) warn.push(`FEE_BPS=${CONFIG.feeBps} understates real ~30–58 bps costs for live scoring.`);
  if (CONFIG.maxDailyLossPct <= 0 || CONFIG.maxDailyLossPct > 50) warn.push(`MAX_DAILY_LOSS_PCT=${CONFIG.maxDailyLossPct} is unusual (kill switch effectively ${CONFIG.maxDailyLossPct <= 0 ? 'always on' : 'very loose'}).`);
  for (const w of warn) console.error(`[config warn] ${w}`);
}

/**
 * Guardrail, stated as code: this project has no live-trading capability beyond
 * the hardcoded Alpaca PAPER host. There is no live-API endpoint anywhere in
 * src/ — flipping this flag changes nothing except tripping the safety throw in
 * execution.ts.
 */
export const LIVE_TRADING_ENABLED = false as const;
