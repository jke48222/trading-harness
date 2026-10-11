/**
 * Data loading and sleeve definitions shared by Trials 09, 10 and 11 (registered
 * in docs/trial_09_crypto_momentum_v2.md, docs/trial_10_cross_asset_trend.md
 * and docs/trial_11_combination.md). The loaders repeat Trial 08's checks
 * exactly; Trial 08's script keeps its own copy so its record stays as run.
 */
import { closedCandles, fetchCandlesSince, intervalToMs } from './market';
import { ymOf } from './months';
import { fetchStockCandles } from './stockdata';
import {
  type DailyPath,
  type Portfolio,
  type PositionPathOptions,
  type SymbolSeries,
  pathFromPositions,
  portfolioExcess,
  seriesFromPath,
  voteSignals,
} from './tsmomPortfolio';
import type { Candle } from './types';

const DAY = 86_400_000;

/** The evaluation instant shared with Trial 08: candles closed before it, sessions dated 2026-09-30 or earlier. */
export const AS_OF_MS = Date.parse('2026-10-01T00:00:00Z');
export const LAST_MONTH = '2026-09';
export const STOCK_START_MS = Date.parse('2016-01-04T00:00:00Z');

/** A vote rule: lookbacks, and the vote counts that open and close a position. */
export interface VoteRule {
  name: string;
  lookbacks: number[];
  enter: number;
  exit: number;
}

/** Trial 07's rule, the book today. */
export const V1: VoteRule = { name: 'v1', lookbacks: [28], enter: 1, exit: 0 };
/** Trial 09's candidate. */
export const V2: VoteRule = { name: 'v2', lookbacks: [7, 14, 28, 56], enter: 3, exit: 1 };
/** Trial 10's cross-asset rule: a majority of three lookbacks, long or flat. */
export const TREND: VoteRule = { name: 'trend', lookbacks: [21, 63, 252], enter: 2, exit: 1 };

/** Trial 09: both crypto rules start on candle 58 (56 + 2), so each symbol covers the same months under each. */
export const CRYPTO_FIRST_INDEX = 58;
/** Trial 10: the first return day is session 254 (252 + 2). */
export const TREND_FIRST_INDEX = 254;

/** Trial 10's universe, one fund per asset class. */
export const XA_11 = ['SPY', 'EFA', 'EEM', 'VNQ', 'TLT', 'IEF', 'TIP', 'LQD', 'GLD', 'DBC', 'UUP'];

export interface Loaded {
  candles: Candle[];
  /** Calendar days with no daily candle (crypto) or beyond a normal weekend/holiday break (stocks). */
  missingDays: number;
  largestGapDays: number;
  /** Crypto candles that closed early because the exchange halted (kept, as Trial 07 kept them). */
  shortCandles: string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();
const day = (ms: number): string => iso(ms).slice(0, 10);

function checkPrices(symbol: string, x: Candle): void {
  if (!(Number.isFinite(x.open) && Number.isFinite(x.close) && x.open > 0 && x.close > 0)) {
    throw new Error(`${symbol}: non-positive or missing price on ${day(x.openTime)}`);
  }
}

/** Binance USDT daily candles from listing, closed before the as-of instant (Trial 08's loader). */
export async function loadCrypto(symbol: string): Promise<Loaded> {
  const all = closedCandles(await fetchCandlesSince(symbol, '1d', Date.now() - 9600 * intervalToMs('1d')));
  const candles = all.filter((x) => x.closeTime < AS_OF_MS);
  if (candles.length === 0) throw new Error(`${symbol}: no daily candle closed before ${iso(AS_OF_MS)}`);
  let missingDays = 0;
  let largestGapDays = 0;
  const shortCandles: string[] = [];
  candles.forEach((x, i) => {
    checkPrices(symbol, x);
    if (x.openTime % DAY !== 0 || x.closeTime <= x.openTime || x.closeTime - x.openTime > DAY - 1) {
      throw new Error(`${symbol}: candle ${iso(x.openTime)} is off the UTC daily grid`);
    }
    if (x.closeTime - x.openTime < DAY - 1) shortCandles.push(`${day(x.openTime)} closed ${iso(x.closeTime).slice(11, 16)} UTC`);
    if (i === 0) return;
    const step = x.openTime - candles[i - 1].openTime;
    if (step <= 0) throw new Error(`${symbol}: candles out of order at ${iso(x.openTime)}`);
    const gap = step / DAY - 1;
    missingDays += gap;
    largestGapDays = Math.max(largestGapDays, gap);
  });
  return { candles, missingDays, largestGapDays, shortCandles };
}

/** Alpaca SIP daily bars, adjustment all, from 2016-01-04, sessions dated up to the last month used (Trial 08's loader). */
export async function loadStock(symbol: string): Promise<Loaded> {
  const all = await fetchStockCandles(symbol, '1d', 10000, STOCK_START_MS, { feed: 'sip', adjustment: 'all' });
  const candles = all.filter((x) => ymOf(x.openTime) <= LAST_MONTH);
  if (candles.length === 0) throw new Error(`${symbol}: no session dated ${LAST_MONTH} or earlier`);
  let missingDays = 0;
  let largestGapDays = 0;
  candles.forEach((x, i) => {
    checkPrices(symbol, x);
    const hour = new Date(x.openTime).getUTCHours();
    if (hour !== 4 && hour !== 5) throw new Error(`${symbol}: bar ${iso(x.openTime)} is not stamped at midnight New York time; the session date would be ambiguous`);
    if (i === 0) return;
    const step = Math.round((x.openTime - candles[i - 1].openTime) / DAY);
    if (step <= 0) throw new Error(`${symbol}: bars out of order at ${iso(x.openTime)}`);
    const gap = step - 1;
    if (gap > 3) missingDays += gap - 3;
    largestGapDays = Math.max(largestGapDays, gap);
  });
  return { candles, missingDays, largestGapDays, shortCandles: [] };
}

export interface Sleeve {
  series: SymbolSeries[];
  paths: DailyPath[];
  port: Portfolio;
}

/** Path options for crypto: fills at the signal close, months by close time, no gaps allowed. */
export function cryptoOptions(cost: number, firstIndex = CRYPTO_FIRST_INDEX): PositionPathOptions {
  return { firstIndex, costPerUnit: cost, execution: 'close', monthBy: 'closeTime', maxGapDays: 0, nowMs: AS_OF_MS };
}

/** Path options for ETFs: fills at the next open, months by session date, a four-day gap allowed. */
export function stockOptions(cost: number, firstIndex: number, execution: 'next-open' | 'next-open-any' = 'next-open'): PositionPathOptions {
  return { firstIndex, costPerUnit: cost, execution, monthBy: 'openTime', maxGapDays: 4, nowMs: AS_OF_MS };
}

/** A sleeve from per-symbol positions: the monthly series, the daily paths, and the equal-weight portfolio. */
export function sleeveFromPositions(symbols: string[], candlesOf: (s: string) => Candle[], positionsOf: (s: string, c: Candle[]) => number[], o: PositionPathOptions): Sleeve {
  const series: SymbolSeries[] = [];
  const paths: DailyPath[] = [];
  for (const s of symbols) {
    const candles = candlesOf(s);
    const path = pathFromPositions(candles, positionsOf(s, candles), o);
    paths.push(path);
    series.push(seriesFromPath(s, path, o));
  }
  return { series, paths, port: portfolioExcess(series) };
}

/** A vote-rule sleeve. */
export function voteSleeve(symbols: string[], candlesOf: (s: string) => Candle[], rule: VoteRule, o: PositionPathOptions): Sleeve {
  return sleeveFromPositions(symbols, candlesOf, (_s, c) => voteSignals(c.map((x) => x.close), rule.lookbacks, rule.enter, rule.exit), o);
}
