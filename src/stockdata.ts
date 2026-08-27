import type { Candle } from './types';

/**
 * US stock market data via the Alpaca PAPER account — READ-ONLY.
 * GET requests only; the IEX feed is what paper keys include. No order
 * endpoint exists here or anywhere else in this project.
 */
const PAPER_TRADING_HOST = 'https://paper-api.alpaca.markets';
const DATA_HOST = 'https://data.alpaca.markets';

function authHeaders(): Record<string, string> {
  const key = process.env.ALPACA_PAPER_KEY_ID;
  const secret = process.env.ALPACA_PAPER_SECRET;
  if (!key || !secret) {
    throw new Error(
      'Missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET in .env — stock symbols need the Alpaca PAPER data API.'
    );
  }
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
}

async function get<T>(host: string, path: string): Promise<T> {
  const res = await fetch(host + path, { headers: authHeaders(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

const TIMEFRAMES: Record<string, string> = {
  '1m': '1Min',
  '5m': '5Min',
  '15m': '15Min',
  '30m': '30Min',
  '1h': '1Hour',
  '1d': '1Day',
};

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars: AlpacaBar[] | null;
  next_page_token: string | null;
}

/**
 * Fetch stock candles. With `startTime`, pages forward from that time; without
 * it, returns the most recent `limit` bars. Candle shape matches the Binance
 * one (closeTime = openTime + interval − 1 ms) so the rest of the bot does not
 * care where a candle came from.
 */
export async function fetchStockCandles(
  symbol: string,
  interval: string,
  limit: number,
  startTime?: number
): Promise<Candle[]> {
  const timeframe = TIMEFRAMES[interval];
  const iMs = INTERVAL_MS[interval];
  if (!timeframe || !iMs) {
    throw new Error(`Interval '${interval}' is not supported for stock data (supported: ${Object.keys(TIMEFRAMES).join(', ')}).`);
  }

  // Alpaca defaults `start` to the current day when omitted, which would
  // return at most today's bar — so ALWAYS pass a start. In recent-bars mode
  // (no startTime), reach back far enough to cover weekends/holidays and keep
  // the most recent `limit` bars.
  const recentMode = startTime === undefined;
  const effectiveStart = startTime ?? Date.now() - Math.ceil(limit * 1.8 + 10) * iMs;
  const out: Candle[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 10; page++) {
    let path =
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}` +
      `&limit=10000&adjustment=raw&feed=iex` +
      `&start=${encodeURIComponent(new Date(effectiveStart).toISOString())}`;
    if (pageToken) path += `&page_token=${encodeURIComponent(pageToken)}`;
    const res = await get<AlpacaBarsResponse>(DATA_HOST, path);
    const bars = res.bars ?? [];
    for (const b of bars) {
      const openTime = Date.parse(b.t);
      out.push({
        openTime,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        closeTime: openTime + iMs - 1,
      });
    }
    pageToken = res.next_page_token;
    if (!pageToken) break;
  }
  if (recentMode && out.length > limit) out.splice(0, out.length - limit);

  if (out.length === 0) {
    throw new Error(
      `No real ${interval} bars returned for stock ${symbol} (IEX feed). ` +
        'The bot never invents candles — check the symbol, or the market may not have traded in the requested window.'
    );
  }
  return out;
}

export interface MarketClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

/** US equity market clock, from the PAPER trading host (read-only). */
export async function fetchMarketClock(): Promise<MarketClock> {
  return get<MarketClock>(PAPER_TRADING_HOST, '/v2/clock');
}
