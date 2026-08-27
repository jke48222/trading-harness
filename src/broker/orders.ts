import { CONFIG } from '../config';

/**
 * Alpaca PAPER order adapter — the execution layer §5 reserved for explicit
 * user approval (granted 2026-07-15: "$100k in paper money on alpaca to do a
 * lot of testing and trials").
 *
 * Guardrails:
 * - The host is hardcoded to paper-api.alpaca.markets. There is no live host
 *   anywhere in this file or this project; the paper host only serves paper
 *   accounts, so no key or flag can make this code touch real money.
 * - Order placement additionally requires EXECUTION=alpaca-paper in config —
 *   default is local simulation, exactly as before.
 * - Every fill is recorded with its slippage vs the signal price, so paper
 *   trading doubles as the instrumented execution-cost experiment the research
 *   said we owe ourselves.
 */
const PAPER_TRADING_HOST = 'https://paper-api.alpaca.markets';

function authHeaders(): Record<string, string> {
  const key = process.env.ALPACA_PAPER_KEY_ID;
  const secret = process.env.ALPACA_PAPER_SECRET;
  if (!key || !secret) {
    throw new Error('Missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET in .env — paper execution needs the paper keys.');
  }
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'content-type': 'application/json' };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(PAPER_TRADING_HOST + path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface BrokerOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  status: string;
  side: string;
  notional: string | null;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
}

export interface BrokerPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
  current_price: string;
}

/** BTCUSDT -> BTC/USD for orders; equities pass through. */
export function toOrderSymbol(symbol: string): string {
  if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}/USD`;
  if (symbol.endsWith('USD') && !symbol.includes('/')) return `${symbol.slice(0, -3)}/USD`;
  return symbol;
}

/** Positions API reports crypto without the slash (BTCUSD); normalize both ways. */
export function positionMatches(positionSymbol: string, symbol: string): boolean {
  return positionSymbol.replace('/', '') === toOrderSymbol(symbol).replace('/', '');
}

export interface BrokerAccount {
  account_number: string;
  status: string;
  cash: string;
  equity: string;
  portfolio_value: string;
  buying_power: string;
}

export async function getAccount(): Promise<BrokerAccount> {
  return request<BrokerAccount>('GET', '/v2/account');
}

export async function getBrokerPositions(): Promise<BrokerPosition[]> {
  return request<BrokerPosition[]>('GET', '/v2/positions');
}

export interface PortfolioHistory {
  timestamp: number[];
  equity: (number | null)[];
  profit_loss_pct: (number | null)[];
}

/** Real equity curve from the paper account (Alpaca portfolio history). */
export async function getPortfolioHistory(period = '1M', timeframe = '1D'): Promise<PortfolioHistory> {
  return request<PortfolioHistory>('GET', `/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}&extended_hours=true`);
}

export async function getOrder(id: string): Promise<BrokerOrder> {
  return request<BrokerOrder>('GET', `/v2/orders/${id}`);
}

/**
 * Submit a notional market BUY on the paper account and wait for the fill.
 * `clientOrderId` should be deterministic per signal candle (idempotency:
 * Alpaca rejects duplicate client_order_ids, a second guard behind our
 * per-signal-candle dedup).
 */
export async function submitPaperBuy(symbol: string, notionalUsd: number, clientOrderId: string): Promise<BrokerOrder> {
  const isCrypto = symbol.endsWith('USDT');
  const order = await request<BrokerOrder>('POST', '/v2/orders', {
    symbol: toOrderSymbol(symbol),
    notional: notionalUsd.toFixed(2),
    side: 'buy',
    type: 'market',
    time_in_force: isCrypto ? 'gtc' : 'day',
    client_order_id: clientOrderId,
  });
  return waitForFill(order.id);
}

/**
 * Bounded marketable-limit BUY: a limit at `limitPrice` so a fill can never be
 * arbitrarily worse than the cap (LIMIT_SLIPPAGE_BPS above the decision mark).
 * If it doesn't fill inside the wait window it throws — the caller leaves the
 * symbol un-entered and the next scan retries. Notional orders can't carry a
 * limit price, so this sizes qty from the limit price.
 */
export async function submitPaperBuyLimit(symbol: string, notionalUsd: number, limitPrice: number, clientOrderId: string): Promise<BrokerOrder> {
  const isCrypto = symbol.endsWith('USDT');
  const qty = notionalUsd / limitPrice;
  const order = await request<BrokerOrder>('POST', '/v2/orders', {
    symbol: toOrderSymbol(symbol),
    qty: isCrypto ? qty.toFixed(9) : String(Math.max(1, Math.floor(qty))),
    side: 'buy',
    type: 'limit',
    limit_price: limitPrice.toFixed(limitPrice >= 1 ? 2 : 6),
    time_in_force: isCrypto ? 'gtc' : 'day',
    client_order_id: clientOrderId,
  });
  return waitForFill(order.id);
}

/** Format a limit price with enough precision for the asset (BTC → 2dp, SHIB → 6 sig figs). */
function fmtLimit(p: number): string {
  return p >= 1 ? p.toFixed(2) : p.toPrecision(6);
}

export async function getOpenOrders(): Promise<BrokerOrder[]> {
  return request<BrokerOrder[]>('GET', '/v2/orders?status=open&limit=200');
}

export async function cancelOrder(id: string): Promise<void> {
  try {
    await request<unknown>('DELETE', `/v2/orders/${id}`);
  } catch {
    /* already gone/filled — fine */
  }
}

/** Cancel any of the bot's still-open orders (client_order_id starts with "bot-") so none go stale between scans. */
export async function cancelStaleBotOrders(): Promise<number> {
  const open = await getOpenOrders();
  let n = 0;
  for (const o of open) {
    if ((o.client_order_id || '').startsWith('bot-')) {
      await cancelOrder(o.id);
      n++;
    }
  }
  return n;
}

/**
 * MAKER entry: a passive limit BUY placed BELOW the mark so it rests (lower fee)
 * instead of crossing the spread. Polls up to `waitSec`; if it does not fill it
 * CANCELS and returns null — the caller writes no ledger row and the next scan
 * retries. Graceful non-fill is the whole point: a missed entry costs nothing.
 */
export async function submitPaperBuyMaker(
  symbol: string,
  notionalUsd: number,
  limitPrice: number,
  clientOrderId: string,
  waitSec: number
): Promise<BrokerOrder | null> {
  const isCrypto = symbol.endsWith('USDT');
  const qty = notionalUsd / limitPrice;
  const order = await request<BrokerOrder>('POST', '/v2/orders', {
    symbol: toOrderSymbol(symbol),
    qty: isCrypto ? qty.toFixed(9) : String(Math.max(1, Math.floor(qty))),
    side: 'buy',
    type: 'limit',
    limit_price: fmtLimit(limitPrice),
    time_in_force: isCrypto ? 'gtc' : 'day',
    client_order_id: clientOrderId,
  });
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const o = await getOrder(order.id);
    if (o.status === 'filled') return o;
    if (['canceled', 'expired', 'rejected'].includes(o.status)) return null;
    if (Date.now() > deadline) {
      await cancelOrder(order.id);
      return null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Close an entire open position at market (Alpaca's close-position endpoint). */
export async function closePaperPosition(symbol: string): Promise<BrokerOrder> {
  const order = await request<BrokerOrder>('DELETE', `/v2/positions/${toOrderSymbol(symbol).replace('/', '')}`);
  return waitForFill(order.id);
}

async function waitForFill(orderId: string, timeoutMs = 20000): Promise<BrokerOrder> {
  const start = Date.now();
  for (;;) {
    const o = await getOrder(orderId);
    if (o.status === 'filled') return o;
    if (['canceled', 'expired', 'rejected'].includes(o.status)) {
      throw new Error(`Order ${orderId} ended ${o.status} without filling.`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Order ${orderId} not filled after ${timeoutMs / 1000}s (status ${o.status}) — investigate before retrying; no duplicate was sent.`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Signed slippage of a fill vs the signal price, in basis points (positive = paid more than signal close). */
export function slippageBps(fillPrice: number, signalPrice: number): number {
  return ((fillPrice - signalPrice) / signalPrice) * 10_000;
}
