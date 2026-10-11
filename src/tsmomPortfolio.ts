/**
 * The TSMOM-28 portfolio construction shared by Trial 07, Trial 08 and the
 * monthly regime monitor: per-symbol daily strategy returns, calendar-month
 * compounding, the constant-exposure timing benchmark, the equal-weight
 * portfolio, the bootstrap test and the trials-ledger config count.
 *
 * Everything here is a pure function of candles or arrays, so the
 * construction can be tested without the network. The arithmetic follows
 * scripts/trial07_portfolio.ts operation for operation, so Trial 07's printed
 * numbers come out identical through this module.
 */
import { completeMonths, ymOf } from './months';
import type { Candle } from './types';

/** Deterministic PRNG, so the bootstrap is reproducible (the registered seed is 42). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation (n - 1). */
export const sd = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
};

/**
 * One-sided percentile-bootstrap p for H0: mean <= 0. The share of resampled
 * means at or below zero, floored at 1/resamples. Pass a fresh
 * mulberry32(42) per test to reproduce the registered numbers.
 */
export function bootstrapP(xs: number[], resamples: number, rand: () => number): number {
  let atOrBelow = 0;
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rand() * xs.length)];
    if (s / xs.length <= 0) atOrBelow++;
  }
  return Math.max(atOrBelow / resamples, 1 / resamples);
}

/** Annualized Sharpe of a monthly series. */
export function annSharpe(xs: number[]): number {
  return (mean(xs) / sd(xs)) * Math.sqrt(12);
}

/**
 * Where a position change fills.
 * - 'close': at the signal close. Crypto: the book enters within two hours of
 *   the daily close. This is Trial 07's model.
 * - 'next-open': at the next session's open. US stocks: the book trades at the
 *   open. Long-only.
 */
export type Execution = 'close' | 'next-open';

export interface SeriesOptions {
  /** Momentum lookback in candles (trading sessions for stocks). */
  lookback: number;
  /** Cost charged per unit of position change, as a fraction (0.003 = 30 bps). */
  costPerUnit: number;
  execution: Execution;
  /** Trial 07's both-sides descriptive: exposure -1 when momentum < 0. Close execution only. */
  bothSides?: boolean;
  /**
   * The candle time that names a return day's calendar month: closeTime for
   * Binance crypto (Trial 07), openTime for Alpaca stock bars, whose openTime
   * falls at 04:00 or 05:00 UTC on the session date.
   */
  monthBy: 'closeTime' | 'openTime';
  /** completeMonths gap allowance: 0 for crypto, 4 for US sessions. */
  maxGapDays: number;
  /** "Now" for completeMonths: a month that is not over by then is never complete. */
  nowMs: number;
}

/**
 * Daily-sign exposure decided at each close: s_t = 1 if close_t / close_{t-L} - 1 > 0,
 * else 0 (both-sides: -1 when it is < 0). Zero while the lookback warms up.
 */
export function signals(closes: number[], lookback: number, bothSides = false): number[] {
  const pos: number[] = new Array(closes.length).fill(0);
  for (let i = lookback; i < closes.length; i++) {
    const mom = closes[i] / closes[i - lookback] - 1;
    pos[i] = bothSides ? (mom > 0 ? 1 : mom < 0 ? -1 : 0) : mom > 0 ? 1 : 0;
  }
  return pos;
}

/** Close execution (Trial 07): r_{t+1} = s_t * (close_{t+1}/close_t - 1) - c * |s_t - s_{t-1}|. */
export function closeExecutionReturn(sPrev: number, sCur: number, closePrev: number, close: number, cost: number): number {
  const rAsset = close / closePrev - 1;
  return sCur * rAsset - cost * Math.abs(sCur - sPrev);
}

/**
 * Next-open execution (Trial 08 stocks), the registered table. sPrev = s_{t-1},
 * sCur = s_t, closePrev = close_t, open and close are day t+1's.
 *   1 -> 1: close_{t+1}/close_t - 1
 *   0 -> 1: close_{t+1}/open_{t+1} - 1 - c   (buy at the open)
 *   1 -> 0: open_{t+1}/close_t - 1 - c       (sell at the open)
 *   0 -> 0: 0
 */
export function nextOpenReturn(sPrev: number, sCur: number, closePrev: number, open: number, close: number, cost: number): number {
  if (sPrev === 1 && sCur === 1) return close / closePrev - 1;
  if (sPrev === 0 && sCur === 1) return close / open - 1 - cost;
  if (sPrev === 1 && sCur === 0) return open / closePrev - 1 - cost;
  if (sPrev === 0 && sCur === 0) return 0;
  throw new Error(`next-open execution is long-only: got s_{t-1}=${sPrev}, s_t=${sCur}`);
}

/** One entry per return day t+1 (candle index lookback+2 onward), in candle order. */
export interface DailyPath {
  /** Candle index of the return day. */
  index: number[];
  /** The time that names the return day's month (see SeriesOptions.monthBy). */
  time: number[];
  /** close_{t+1}/close_t - 1. */
  rAsset: number[];
  /** Strategy return net of cost, per the execution model. */
  rStrat: number[];
  /** s_t, the exposure decided at the previous close. */
  exposure: number[];
  /** |s_t - s_{t-1}|, the units of position change charged that day. */
  change: number[];
}

/**
 * Daily strategy returns. The first return day is candle lookback+2, so both
 * s_t and s_{t-1} are real signals rather than warmup zeros (as in Trial 07).
 */
export function dailyPath(candles: Candle[], o: SeriesOptions): DailyPath {
  if (o.execution === 'next-open' && o.bothSides) throw new Error('next-open execution is long-only; bothSides is not defined for it.');
  const c = candles.map((x) => x.close);
  const t = candles.map((x) => (o.monthBy === 'openTime' ? x.openTime : x.closeTime));
  const pos = signals(c, o.lookback, o.bothSides ?? false);
  const out: DailyPath = { index: [], time: [], rAsset: [], rStrat: [], exposure: [], change: [] };
  for (let i = o.lookback + 2; i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    const rStrat =
      o.execution === 'close'
        ? closeExecutionReturn(pos[i - 2], pos[i - 1], c[i - 1], c[i], o.costPerUnit)
        : nextOpenReturn(pos[i - 2], pos[i - 1], c[i - 1], candles[i].open, c[i], o.costPerUnit);
    out.index.push(i);
    out.time.push(t[i]);
    out.rAsset.push(rAsset);
    out.rStrat.push(rStrat);
    out.exposure.push(pos[i - 1]);
    out.change.push(Math.abs(pos[i - 1] - pos[i - 2]));
  }
  return out;
}

export interface SymbolSeries {
  symbol: string;
  /** Sorted month keys (YYYY-MM) the return series fully covers. */
  months: string[];
  /** Compounded monthly strategy return, net of cost. */
  stratM: Map<string, number>;
  /** Compounded monthly benchmark: wbar * close-to-close, costless. */
  benchM: Map<string, number>;
  /** Compounded monthly buy-and-hold. */
  bhM: Map<string, number>;
  /** Mean exposure s over every return day in the series (partial months included, as in Trial 07). */
  wbar: number;
  /** Units of position change per calendar year. */
  turnoverPerYear: number;
  /** Return days in the series. */
  nDays: number;
}

/** Per-symbol monthly strategy, benchmark and buy-and-hold returns over complete months. */
export function buildSymbolSeries(symbol: string, candles: Candle[], o: SeriesOptions): SymbolSeries {
  const d = dailyPath(candles, o);
  const n = d.rStrat.length;
  if (n === 0) {
    return { symbol, months: [], stratM: new Map(), benchM: new Map(), bhM: new Map(), wbar: NaN, turnoverPerYear: NaN, nDays: 0 };
  }
  const stratAcc = new Map<string, number>();
  const bhAcc = new Map<string, number>();
  let turnover = 0;
  for (let k = 0; k < n; k++) {
    turnover += d.change[k];
    const key = ymOf(d.time[k]);
    stratAcc.set(key, (stratAcc.get(key) ?? 1) * (1 + d.rStrat[k]));
    bhAcc.set(key, (bhAcc.get(key) ?? 1) * (1 + d.rAsset[k]));
  }
  // The benchmark needs wbar, which is only known once every exposure is in.
  const wbar = mean(d.exposure);
  const benchAcc = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    const key = ymOf(d.time[k]);
    benchAcc.set(key, (benchAcc.get(key) ?? 1) * (1 + wbar * d.rAsset[k]));
  }
  // Partial first and last calendar months are dropped (completeMonths).
  const complete = new Set(completeMonths(d.time, o.nowMs, o.maxGapDays));
  const months = [...stratAcc.keys()].sort().filter((k) => complete.has(k));
  const stratM = new Map<string, number>();
  const benchM = new Map<string, number>();
  const bhM = new Map<string, number>();
  for (const k of months) {
    stratM.set(k, (stratAcc.get(k) as number) - 1);
    benchM.set(k, (benchAcc.get(k) as number) - 1);
    bhM.set(k, (bhAcc.get(k) as number) - 1);
  }
  const years = (d.time[n - 1] - d.time[0]) / (365.25 * 86_400_000);
  return { symbol, months, stratM, benchM, bhM, wbar, turnoverPerYear: turnover / years, nDays: n };
}

/** Monthly timing excess of one symbol (strategy month - benchmark month), over its complete months. */
export function symbolExcess(s: SymbolSeries): number[] {
  return s.months.map((m) => (s.stratM.get(m) as number) - (s.benchM.get(m) as number));
}

export interface Portfolio {
  months: string[];
  /** Equal-weight mean of per-symbol excess across the symbols live that month. */
  excess: number[];
  /** Equal-weight mean strategy return. */
  raw: number[];
  /** Equal-weight mean buy-and-hold return. */
  bh: number[];
  /** Number of symbols live that month. */
  live: number[];
}

/** Equal-weight portfolio across the symbols live each month (a symbol is live in its complete months only). */
export function portfolioExcess(series: SymbolSeries[]): Portfolio {
  const all = new Set<string>();
  for (const s of series) for (const m of s.months) all.add(m);
  const out: Portfolio = { months: [], excess: [], raw: [], bh: [], live: [] };
  for (const m of [...all].sort()) {
    const have = series.filter((s) => s.stratM.has(m));
    if (have.length === 0) continue;
    out.months.push(m);
    out.excess.push(mean(have.map((s) => (s.stratM.get(m) as number) - (s.benchM.get(m) as number))));
    out.raw.push(mean(have.map((s) => s.stratM.get(m) as number)));
    out.bh.push(mean(have.map((s) => s.bhM.get(m) as number)));
    out.live.push(have.length);
  }
  return out;
}

/** The trials-ledger CSV line parser Trial 07 used (understands double-quoted fields). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(f);
      f = '';
    } else f += ch;
  }
  out.push(f);
  return out;
}

/**
 * Identity of a disclosed configuration: strategy | symbol | params, with the
 * params' window dropped, so re-runs of one configuration on another window
 * count once (Trial 07's rule).
 */
export function configKey(strategy: string, symbol: string, params: string): string {
  let p = params;
  try {
    const obj = JSON.parse(p);
    delete obj.window;
    p = JSON.stringify(obj);
  } catch {
    /* keep raw */
  }
  return `${strategy}|${symbol.replace('BINANCE:', '')}|${p}`;
}

/** Distinct configuration keys in a trials.csv text (header skipped, rows with fewer than 19 fields ignored). */
export function configKeys(csvText: string): Set<string> {
  const lines = csvText.split('\n').filter((l) => l.trim());
  const keys = new Set<string>();
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (c.length < 19) continue;
    keys.add(configKey(c[5], c[3], c[6]));
  }
  return keys;
}

/** Count of distinct disclosed configurations in a trials.csv text. */
export function countConfigs(csvText: string): number {
  return configKeys(csvText).size;
}

export interface HolmResult {
  /** Holm-adjusted p per input, in input order. */
  adjusted: number[];
  /** Whether each H0 is rejected at alpha, in input order. */
  reject: boolean[];
  /** Input indices sorted by p, ascending (the step-down order). */
  order: number[];
}

/**
 * Holm-Bonferroni step-down: sort p ascending; reject the k-th smallest
 * (k = 0-based) while p <= alpha / (m - k); stop at the first that fails.
 * Adjusted p_(k) = max over j <= k of min(1, (m - j) * p_(j)).
 */
export function holm(pvals: number[], alpha: number): HolmResult {
  const m = pvals.length;
  const order = pvals.map((_, i) => i).sort((a, b) => pvals[a] - pvals[b] || a - b);
  const adjusted: number[] = new Array(m).fill(1);
  const reject: boolean[] = new Array(m).fill(false);
  let running = 0;
  let stillRejecting = true;
  order.forEach((idx, k) => {
    running = Math.max(running, Math.min(1, (m - k) * pvals[idx]));
    adjusted[idx] = running;
    if (stillRejecting && pvals[idx] <= alpha / (m - k)) reject[idx] = true;
    else stillRejecting = false;
  });
  return { adjusted, reject, order };
}

export type BreakEven = { status: 'root'; cost: number } | { status: 'not-positive-at-low' } | { status: 'positive-at-high' };

/**
 * The cost per unit change at which a decreasing function of cost (mean
 * excess) crosses zero, by bisection on [lo, hi] until the bracket is
 * narrower than tol. Reports when there is no crossing inside the range.
 */
export function breakEvenCost(meanExcessAt: (cost: number) => number, lo: number, hi: number, tol = 1e-9): BreakEven {
  if (!(meanExcessAt(lo) > 0)) return { status: 'not-positive-at-low' };
  if (meanExcessAt(hi) > 0) return { status: 'positive-at-high' };
  let a = lo;
  let b = hi;
  while (b - a > tol) {
    const mid = (a + b) / 2;
    if (meanExcessAt(mid) > 0) a = mid;
    else b = mid;
  }
  return { status: 'root', cost: (a + b) / 2 };
}

// ---------------------------------------------------------------- rules beyond one lookback (Trials 09 to 11)
//
// New code paths, so the functions above (and the Trial 07, Trial 08 and
// monitor numbers they produce) stay exactly as they were. A test ties the two
// together: a one-lookback vote through this path equals buildSymbolSeries.

/** How many of the lookbacks have close_i / close_{i-L} - 1 > 0. */
export function countVotes(closes: number[], i: number, lookbacks: number[]): number {
  let votes = 0;
  for (const L of lookbacks) if (closes[i] / closes[i - L] - 1 > 0) votes++;
  return votes;
}

/**
 * A vote across lookbacks with a band between entry and exit (Trials 09, 10):
 * from flat, go long when votes >= enter; from long, go flat when votes <= exit;
 * otherwise keep the previous position. Flat until the longest lookback exists.
 * One lookback with enter 1 and exit 0 is Trial 07's rule.
 */
export function voteSignals(closes: number[], lookbacks: number[], enter: number, exit: number): number[] {
  const maxL = Math.max(...lookbacks);
  const pos: number[] = new Array(closes.length).fill(0);
  for (let i = maxL; i < closes.length; i++) {
    const votes = countVotes(closes, i, lookbacks);
    pos[i] = pos[i - 1] === 0 ? (votes >= enter ? 1 : 0) : votes <= exit ? 0 : 1;
  }
  return pos;
}

/** Long or short (Trial 10, D1): +1 when votes >= longAt, else -1; 0 until the longest lookback exists. */
export function voteSignalsLongShort(closes: number[], lookbacks: number[], longAt: number): number[] {
  const maxL = Math.max(...lookbacks);
  const pos: number[] = new Array(closes.length).fill(0);
  for (let i = maxL; i < closes.length; i++) pos[i] = countVotes(closes, i, lookbacks) >= longAt ? 1 : -1;
  return pos;
}

/**
 * Faber's monthly rule (Trial 10, D3): at each month's last session, s = 1 if
 * the close is above the mean of the last `months` month-end closes (this one
 * included), else 0, held until the next month's last session. The final
 * candle counts as a month end. Returns the positions and the first index where
 * the rule is defined (0 before it).
 */
export function monthEndSmaSignals(candles: Candle[], months: number, monthOf: (c: Candle) => string): { pos: number[]; firstDefined: number } {
  const pos: number[] = new Array(candles.length).fill(0);
  const ends: number[] = [];
  let firstDefined = -1;
  let current = 0;
  for (let i = 0; i < candles.length; i++) {
    const isEnd = i === candles.length - 1 || monthOf(candles[i + 1]) !== monthOf(candles[i]);
    if (isEnd) {
      ends.push(candles[i].close);
      if (ends.length >= months) {
        const window = ends.slice(-months);
        current = candles[i].close > mean(window) ? 1 : 0;
        if (firstDefined < 0) firstDefined = i;
      }
    }
    pos[i] = firstDefined >= 0 ? current : 0;
  }
  return { pos, firstDefined };
}

/**
 * Next-open fill for any position, long or short: the old position carries the
 * overnight move, the new one the session, compounded. For 0 and 1 it equals
 * the registered table in nextOpenReturn (up to float rounding).
 */
export function nextOpenReturnAny(sPrev: number, sCur: number, closePrev: number, open: number, close: number, cost: number): number {
  return (1 + sPrev * (open / closePrev - 1)) * (1 + sCur * (close / open - 1)) - 1 - cost * Math.abs(sCur - sPrev);
}

export interface PositionPathOptions {
  /** Candle index of the first return day: two after the first defined signal, so s_t and s_{t-1} are both real. */
  firstIndex: number;
  costPerUnit: number;
  /** 'next-open' uses the registered long-only table; 'next-open-any' allows shorts. */
  execution: Execution | 'next-open-any';
  monthBy: 'closeTime' | 'openTime';
  maxGapDays: number;
  nowMs: number;
}

/** Daily returns for a given position path, s_t decided at close t (as dailyPath, for any rule). */
export function pathFromPositions(candles: Candle[], pos: number[], o: PositionPathOptions): DailyPath {
  const c = candles.map((x) => x.close);
  const t = candles.map((x) => (o.monthBy === 'openTime' ? x.openTime : x.closeTime));
  const out: DailyPath = { index: [], time: [], rAsset: [], rStrat: [], exposure: [], change: [] };
  for (let i = Math.max(o.firstIndex, 2); i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    let rStrat: number;
    if (o.execution === 'close') rStrat = closeExecutionReturn(pos[i - 2], pos[i - 1], c[i - 1], c[i], o.costPerUnit);
    else if (o.execution === 'next-open') rStrat = nextOpenReturn(pos[i - 2], pos[i - 1], c[i - 1], candles[i].open, c[i], o.costPerUnit);
    else rStrat = nextOpenReturnAny(pos[i - 2], pos[i - 1], c[i - 1], candles[i].open, c[i], o.costPerUnit);
    out.index.push(i);
    out.time.push(t[i]);
    out.rAsset.push(rAsset);
    out.rStrat.push(rStrat);
    out.exposure.push(pos[i - 1]);
    out.change.push(Math.abs(pos[i - 1] - pos[i - 2]));
  }
  return out;
}

/** Per-symbol monthly series from a daily path (the arithmetic of buildSymbolSeries). */
export function seriesFromPath(symbol: string, d: DailyPath, o: { maxGapDays: number; nowMs: number }): SymbolSeries {
  const n = d.rStrat.length;
  if (n === 0) return { symbol, months: [], stratM: new Map(), benchM: new Map(), bhM: new Map(), wbar: NaN, turnoverPerYear: NaN, nDays: 0 };
  const stratAcc = new Map<string, number>();
  const bhAcc = new Map<string, number>();
  let turnover = 0;
  for (let k = 0; k < n; k++) {
    turnover += d.change[k];
    const key = ymOf(d.time[k]);
    stratAcc.set(key, (stratAcc.get(key) ?? 1) * (1 + d.rStrat[k]));
    bhAcc.set(key, (bhAcc.get(key) ?? 1) * (1 + d.rAsset[k]));
  }
  const wbar = mean(d.exposure);
  const benchAcc = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    const key = ymOf(d.time[k]);
    benchAcc.set(key, (benchAcc.get(key) ?? 1) * (1 + wbar * d.rAsset[k]));
  }
  const complete = new Set(completeMonths(d.time, o.nowMs, o.maxGapDays));
  const months = [...stratAcc.keys()].sort().filter((k) => complete.has(k));
  const stratM = new Map<string, number>();
  const benchM = new Map<string, number>();
  const bhM = new Map<string, number>();
  for (const k of months) {
    stratM.set(k, (stratAcc.get(k) as number) - 1);
    benchM.set(k, (benchAcc.get(k) as number) - 1);
    bhM.set(k, (bhAcc.get(k) as number) - 1);
  }
  const years = (d.time[n - 1] - d.time[0]) / (365.25 * 86_400_000);
  return { symbol, months, stratM, benchM, bhM, wbar, turnoverPerYear: turnover / years, nDays: n };
}

/** Start of a YYYY-MM month, ms UTC. */
export function monthStartMs(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}

/**
 * Portfolio excess with inverse-volatility weights (Trial 09 D5, Trial 10 D6):
 * each symbol live in a month is weighted by 1 / sd of its last `window` daily
 * asset returns before the month starts. A symbol with fewer than `minDays`
 * such returns sits that month out.
 */
export function inverseVolExcess(items: { series: SymbolSeries; path: DailyPath }[], window = 60, minDays = 20): { months: string[]; excess: number[] } {
  const all = new Set<string>();
  for (const it of items) for (const m of it.series.months) all.add(m);
  const months: string[] = [];
  const excess: number[] = [];
  for (const m of [...all].sort()) {
    const start = monthStartMs(m);
    let wSum = 0;
    let acc = 0;
    for (const it of items) {
      if (!it.series.stratM.has(m)) continue;
      const before: number[] = [];
      for (let k = 0; k < it.path.time.length && it.path.time[k] < start; k++) before.push(it.path.rAsset[k]);
      const recent = before.slice(-window);
      if (recent.length < minDays) continue;
      const vol = sd(recent);
      if (!(vol > 0)) continue;
      const w = 1 / vol;
      wSum += w;
      acc += w * ((it.series.stratM.get(m) as number) - (it.series.benchM.get(m) as number));
    }
    if (wSum > 0) {
      months.push(m);
      excess.push(acc / wSum);
    }
  }
  return { months, excess };
}

/** Pearson correlation of two equal-length series. */
export function correlation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) throw new Error('correlation needs two series of the same length, at least 2.');
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Worst peak-to-trough fall of a compounded series of monthly returns, as a negative fraction. */
export function maxDrawdownOf(monthly: number[]): number {
  let wealth = 1;
  let peak = 1;
  let worst = 0;
  for (const r of monthly) {
    wealth *= 1 + r;
    peak = Math.max(peak, wealth);
    worst = Math.min(worst, wealth / peak - 1);
  }
  return worst;
}
