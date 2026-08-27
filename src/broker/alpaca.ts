import { CONFIG } from '../config';
import { closedCandles, fetchCandles } from '../market';
import { latestSignal } from '../strategy';

/**
 * Read-only Alpaca PAPER adapter.
 *
 * Guardrails:
 * - The trading host is hardcoded to paper-api.alpaca.markets — no code path
 *   to the live API host exists in this project.
 * - This module performs GET requests only. It cannot submit, modify, or
 *   cancel orders; `broker:preview` builds an order payload locally and
 *   never sends it anywhere.
 * - Keys come from .env (ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET) and are
 *   never printed or logged.
 */
const PAPER_TRADING_HOST = 'https://paper-api.alpaca.markets';
const DATA_HOST = 'https://data.alpaca.markets';

function authHeaders(): Record<string, string> {
  const key = process.env.ALPACA_PAPER_KEY_ID;
  const secret = process.env.ALPACA_PAPER_SECRET;
  if (!key || !secret) {
    throw new Error(
      'Missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET in .env — add your Alpaca PAPER keys there (never commit .env, never paste keys into chat).'
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

interface AlpacaAccount {
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  portfolio_value: string;
  buying_power: string;
  pattern_day_trader?: boolean;
  daytrade_count?: number;
  trading_blocked?: boolean;
  account_blocked?: boolean;
  crypto_status?: string;
  options_approved_level?: number;
}

interface AlpacaClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

/** Read-only smoke test against the PAPER account: account, positions, orders, clock, market data. */
export async function brokerCheck(): Promise<void> {
  console.log(`Broker check (read-only) against ${PAPER_TRADING_HOST} — PAPER host, hardcoded.`);

  const account = await get<AlpacaAccount>(PAPER_TRADING_HOST, '/v2/account');
  console.log(`Account: ${account.account_number} · status ${account.status} · ${account.currency}`);
  console.log(`  cash ${account.cash} · portfolio value ${account.portfolio_value} · buying power ${account.buying_power}`);
  console.log(
    `  pattern_day_trader ${account.pattern_day_trader ?? false} · daytrade_count ${account.daytrade_count ?? 0} · trading_blocked ${account.trading_blocked ?? false} · account_blocked ${account.account_blocked ?? false}`
  );
  console.log(`  crypto_status ${account.crypto_status ?? 'n/a'} · options level ${account.options_approved_level ?? 'n/a'}`);

  const positions = await get<unknown[]>(PAPER_TRADING_HOST, '/v2/positions');
  console.log(`Open positions: ${positions.length}`);

  const orders = await get<unknown[]>(PAPER_TRADING_HOST, '/v2/orders?status=open');
  console.log(`Open orders: ${orders.length}`);

  const clock = await get<AlpacaClock>(PAPER_TRADING_HOST, '/v2/clock');
  console.log(`Market clock: open=${clock.is_open} · next open ${clock.next_open} · next close ${clock.next_close}`);

  try {
    const crypto = await get<{ trades: Record<string, { p: number; t: string }> }>(
      DATA_HOST,
      '/v1beta3/crypto/us/latest/trades?symbols=BTC/USD'
    );
    const t = crypto.trades['BTC/USD'];
    console.log(`Market data (crypto): BTC/USD last trade ${t.p} at ${t.t}`);
  } catch (err) {
    console.log(`Market data (crypto): unavailable -> ${(err as Error).message}`);
  }

  console.log('Broker check complete: GET requests only — no order was submitted, previewed, or canceled.');
}

/** BTCUSDT -> BTC/USD; equity tickers pass through unchanged. */
export function toAlpacaSymbol(symbol: string): string {
  if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}/USD`;
  if (symbol.endsWith('USD') && !symbol.includes('/')) return `${symbol.slice(0, -3)}/USD`;
  return symbol;
}

/**
 * DRY RUN: shows the order payload the bot WOULD send for the current signal.
 * Pure local construction — this function makes no trading API call at all.
 */
export async function brokerPreview(): Promise<void> {
  const { symbol, interval, scanCandles, quantity } = CONFIG;
  console.log(`Broker preview (DRY RUN) for ${symbol} on ${interval} — nothing will be sent.`);

  const candles = closedCandles(await fetchCandles(symbol, interval, scanCandles));
  const sig = latestSignal(candles);
  console.log(`Signal: ${sig.action} — ${sig.reason}`);

  if (sig.action === 'HOLD') {
    console.log('No order would be placed on this signal. DRY RUN over — nothing was sent.');
    return;
  }

  const payload = {
    symbol: toAlpacaSymbol(symbol),
    qty: String(quantity),
    side: sig.action.toLowerCase(),
    type: 'market',
    time_in_force: 'gtc',
  };
  console.log('Order payload the bot WOULD submit to the PAPER API:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('DRY RUN — NOT SENT. This project contains no code that submits orders.');
}
