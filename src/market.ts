import type { Candle } from './types';
import { fetchStockCandles } from './stockdata';

/** '5m' → 300000, '1h' → 3600000, etc. */
export function intervalToMs(interval: string): number {
  const m = interval.match(/^(\d+)([smhdw])$/);
  if (!m) throw new Error(`Unsupported interval '${interval}'.`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 's' | 'm' | 'h' | 'd' | 'w'];
  return Number(m[1]) * unit;
}

/** Venue routing: USDT pairs are Binance crypto; anything else is a US stock via Alpaca paper data. */
export function isCryptoSymbol(symbol: string): boolean {
  return symbol.endsWith('USDT');
}

/** Venue-agnostic candle fetch: most recent `limit` candles. */
export async function fetchSeries(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  return isCryptoSymbol(symbol) ? fetchCandles(symbol, interval, limit) : fetchStockCandles(symbol, interval, limit);
}

/** Venue-agnostic candle fetch: everything from `startTime` (ms epoch) to now. */
export async function fetchSeriesSince(symbol: string, interval: string, startTime: number): Promise<Candle[]> {
  return isCryptoSymbol(symbol)
    ? fetchCandlesSince(symbol, interval, startTime)
    : fetchStockCandles(symbol, interval, 10000, startTime);
}

/**
 * Public market-data endpoints — no API key, read-only.
 * data-api.binance.vision is Binance's official market-data-only host and is
 * reachable from regions where api.binance.com is blocked (e.g. the US).
 */
const ENDPOINTS = [
  'https://data-api.binance.vision/api/v3/klines',
  'https://api.binance.com/api/v3/klines',
];

export async function fetchCandles(symbol: string, interval: string, limit: number, startTime?: number): Promise<Candle[]> {
  const attempts: string[] = [];
  for (const base of ENDPOINTS) {
    const startParam = startTime !== undefined ? `&startTime=${startTime}` : '';
    const url = `${base}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}${startParam}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        attempts.push(`${base} -> HTTP ${res.status}`);
        continue;
      }
      const raw = (await res.json()) as unknown[];
      if (!Array.isArray(raw) || raw.length === 0) {
        attempts.push(`${base} -> empty response`);
        continue;
      }
      return raw.map(parseKline);
    } catch (err) {
      attempts.push(`${base} -> ${(err as Error).message}`);
    }
  }
  throw new Error(
    `Could not fetch real market data for ${symbol} ${interval}. ` +
      `This bot never invents candles, so it stops here instead of faking data.\nAttempts:\n  ${attempts.join('\n  ')}`
  );
}

function parseKline(k: unknown): Candle {
  const a = k as (string | number)[];
  return {
    openTime: Number(a[0]),
    open: Number(a[1]),
    high: Number(a[2]),
    low: Number(a[3]),
    close: Number(a[4]),
    volume: Number(a[5]),
    closeTime: Number(a[6]),
  };
}

/**
 * All candles from `startTime` (ms epoch) to now, paging forward in
 * 1000-candle chunks. Used by scoring, where an open trade may be older than
 * a single request's worth of candles.
 */
export async function fetchCandlesSince(symbol: string, interval: string, startTime: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startTime;
  for (let page = 0; page < 10; page++) {
    const batch = await fetchCandles(symbol, interval, 1000, cursor);
    out.push(...batch);
    const last = batch[batch.length - 1];
    if (batch.length < 1000 || last.closeTime > Date.now()) break;
    cursor = last.closeTime + 1;
  }
  return out;
}

/** Binance returns the still-forming candle last; drop it so signals never repaint. */
export function closedCandles(candles: Candle[]): Candle[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  return last.closeTime > Date.now() ? candles.slice(0, -1) : candles;
}
