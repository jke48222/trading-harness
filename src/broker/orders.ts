import { CONFIG } from '../config';

/**
 * Alpaca PAPER order adapter: the execution layer reserved for explicit user
 * approval (granted 2026-07-15: "$100k in paper money on alpaca to do a lot of
 * testing and trials").
 *
 * Guardrails:
 * - Orders go to paper-api.alpaca.markets, hardcoded. That host only serves
 *   paper accounts, so no key or flag can make this code touch real money.
 * - Order placement also requires EXECUTION=alpaca-paper in config; the
 *   default is local simulation.
 * - No order is ever left resting. Every submit settles: it waits for a final
 *   state and cancels on timeout. A resting buy reserves cash and can fill
 *   hours later with no ledger row; from July to October 2026, 35 of them
 *   locked up ~$64k and blocked every crypto entry (see docs/incidents.md).
 */
const PAPER_TRADING_HOST = 'https://paper-api.alpaca.markets';
const DATA_HOST = 'https://data.alpaca.markets';

function authHeaders(): Record<string, string> {
  const key = process.env.ALPACA_PAPER_KEY_ID;
  const secret = process.env.ALPACA_PAPER_SECRET;
  if (!key || !secret) {
    throw new Error('Missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET in .env — paper execution needs the paper keys.');
  }
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'content-type': 'application/json' };
}

/** An HTTP error from the broker, kept structured so callers can tell a rejection from an outage. */
export class BrokerHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`${method} ${path} -> HTTP ${status}: ${body}`);
    this.name = 'BrokerHttpError';
  }
}

async function request<T>(method: string, path: string, body?: unknown, host = PAPER_TRADING_HOST): Promise<T> {
  const res = await fetch(host + path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new BrokerHttpError(method, path, res.status, (await res.text()).slice(0, 300));
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface BrokerOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  status: string;
  side: string;
  type?: string;
  time_in_force?: string;
  notional: string | null;
  qty: string | null;
  limit_price?: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  submitted_at?: string;
  filled_at?: string | null;
  created_at?: string;
}

export interface BrokerPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
  current_price: string;
}

export interface BrokerAccount {
  account_number: string;
  status: string;
  cash: string;
  equity: string;
  portfolio_value: string;
  buying_power: string;
  non_marginable_buying_power?: string;
}

/** BTCUSDT -> BTC/USD for orders; equities pass through. */
export function toOrderSymbol(symbol: string): string {
  if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}/USD`;
  if (symbol.endsWith('USD') && !symbol.includes('/')) return `${symbol.slice(0, -3)}/USD`;
  return symbol;
}

/** Broker symbol (BTC/USD, BTCUSD, AAPL) -> the bot's symbol (BTCUSDT, AAPL). */
export function botSymbolOf(brokerSymbol: string): string {
  if (brokerSymbol.endsWith('/USD')) return `${brokerSymbol.slice(0, -4)}USDT`;
  if (brokerSymbol.endsWith('USD') && brokerSymbol.length > 4) return `${brokerSymbol.slice(0, -3)}USDT`;
  return brokerSymbol;
}

/** Positions API reports crypto without the slash (BTCUSD); normalize both ways. */
export function positionMatches(positionSymbol: string, symbol: string): boolean {
  return positionSymbol.replace('/', '') === toOrderSymbol(symbol).replace('/', '');
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

export async function getOpenOrders(): Promise<BrokerOrder[]> {
  return request<BrokerOrder[]>('GET', '/v2/orders?status=open&limit=500');
}

export async function cancelOrder(id: string): Promise<void> {
  try {
    await request<unknown>('DELETE', `/v2/orders/${id}`);
  } catch {
    /* already gone or filled; settleOrder reads the final state either way */
  }
}

/** Every order submitted after `afterIso`, newest first, paging past the 500-row page limit. */
export async function fetchOrdersSince(afterIso: string): Promise<BrokerOrder[]> {
  const seen = new Map<string, BrokerOrder>();
  let until = new Date(Date.now() + 60_000).toISOString();
  for (let page = 0; page < 40; page++) {
    const batch = await request<BrokerOrder[]>(
      'GET',
      `/v2/orders?status=all&limit=500&direction=desc&after=${encodeURIComponent(afterIso)}&until=${encodeURIComponent(until)}`
    );
    for (const o of batch) seen.set(o.id, o);
    if (batch.length < 500) break;
    until = batch[batch.length - 1].submitted_at ?? until;
  }
  return [...seen.values()];
}

export interface BrokerActivity {
  id: string;
  activity_type: string;
  date?: string;
  created_at?: string;
  transaction_time?: string;
  net_amount?: string;
  symbol?: string;
  qty?: string;
  price?: string;
  side?: string;
  description?: string;
}

/** Account activities of one type (CFEE, FILL, ...) since `afterIso`, paging by token. */
export async function fetchActivities(type: string, afterIso: string): Promise<BrokerActivity[]> {
  const out: BrokerActivity[] = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const batch = await request<BrokerActivity[]>(
      'GET',
      `/v2/account/activities/${type}?after=${encodeURIComponent(afterIso)}&direction=desc&page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ''}`
    );
    out.push(...batch);
    if (batch.length < 100) break;
    token = batch[batch.length - 1].id;
  }
  return out;
}

export interface Quote {
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  at: string;
}

/** Spread and mid from a bid/ask pair, or null when the pair is not a usable two-sided quote. */
export function makeQuote(bid: number, ask: number, at: string): Quote | null {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return { bid, ask, mid, spreadBps: ((ask - bid) / mid) * 10_000, at };
}

/**
 * Latest top-of-book quote on the venue the order will hit: Alpaca's crypto
 * book for crypto, the IEX book for stocks. Null when there is no usable
 * two-sided quote (callers fall back to the last trade price).
 */
export async function getLatestQuote(symbol: string): Promise<Quote | null> {
  try {
    if (symbol.endsWith('USDT')) {
      const sym = toOrderSymbol(symbol);
      const res = await request<{ quotes: Record<string, { bp: number; ap: number; t: string }> }>(
        'GET',
        `/v1beta3/crypto/us/latest/quotes?symbols=${encodeURIComponent(sym)}`,
        undefined,
        DATA_HOST
      );
      const q = res.quotes?.[sym];
      return q ? makeQuote(q.bp, q.ap, q.t) : null;
    }
    const res = await request<{ quote: { bp: number; ap: number; t: string } }>(
      'GET',
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`,
      undefined,
      DATA_HOST
    );
    return res.quote ? makeQuote(res.quote.bp, res.quote.ap, res.quote.t) : null;
  } catch {
    return null;
  }
}

/**
 * Limit price text the broker accepts. Alpaca's crypto price increment is
 * 1e-9, so sub-dollar coins get up to 9 decimals (BONK at 0.0000034 keeps its
 * digits; the old toFixed(6) turned it into 0.000003, 12% below the market).
 * Stocks: cents at $1 and above, 4 decimals below.
 */
export function fmtLimit(price: number, crypto: boolean): string {
  if (price >= 1) return price.toFixed(2);
  if (!crypto) return price.toFixed(4);
  const s = price.toFixed(9).replace(/0+$/, '');
  return s.endsWith('.') ? s + '0' : s;
}

const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'done_for_day', 'replaced']);

/**
 * Wait for an order to reach a final state. If it has not by the deadline,
 * CANCEL it and wait for the cancel to land, so nothing is left resting at the
 * broker. Returns the last state seen; a non-terminal result means the broker
 * never confirmed and the caller must treat the order as unknown.
 */
export async function settleOrder(orderId: string, timeoutMs = 30_000, pollMs = 500): Promise<BrokerOrder> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const start = Date.now();
  let o = await getOrder(orderId);
  while (!TERMINAL.has(o.status) && Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    o = await getOrder(orderId);
  }
  if (TERMINAL.has(o.status)) return o;
  await cancelOrder(orderId);
  const cancelDeadline = Date.now() + 15_000;
  do {
    await sleep(pollMs);
    o = await getOrder(orderId);
  } while (!TERMINAL.has(o.status) && Date.now() < cancelDeadline);
  return o;
}

export type EntryState = 'filled' | 'partial' | 'unfilled' | 'unknown';

export interface EntryResult {
  state: EntryState;
  order: BrokerOrder;
  filledQty: number;
  fillPrice: number | null;
}

/** Classify a settled order. A partial fill that was then canceled is still a real position. */
export function classifyEntry(order: BrokerOrder): EntryResult {
  const filledQty = Number(order.filled_qty) || 0;
  const fillPrice = order.filled_avg_price != null && Number(order.filled_avg_price) > 0 ? Number(order.filled_avg_price) : null;
  let state: EntryState;
  if (order.status === 'filled') state = 'filled';
  else if (!TERMINAL.has(order.status)) state = 'unknown';
  else state = filledQty > 0 ? 'partial' : 'unfilled';
  return { state, order, filledQty, fillPrice };
}

/**
 * Notional market BUY. `clientOrderId` is deterministic per signal candle, so
 * Alpaca rejects a duplicate: a second guard behind the per-candle dedup.
 */
export async function submitPaperBuy(symbol: string, notionalUsd: number, clientOrderId: string): Promise<EntryResult> {
  const isCrypto = symbol.endsWith('USDT');
  const order = await request<BrokerOrder>('POST', '/v2/orders', {
    symbol: toOrderSymbol(symbol),
    notional: notionalUsd.toFixed(2),
    side: 'buy',
    type: 'market',
    time_in_force: isCrypto ? 'gtc' : 'day',
    client_order_id: clientOrderId,
  });
  return classifyEntry(await settleOrder(order.id, CONFIG.orderTimeoutSec * 1000));
}

/**
 * Bounded marketable-limit BUY: a limit at `limitPrice` so a fill can never be
 * worse than the cap. Sized in qty from the limit (notional orders can't carry
 * a limit). Settles: an order that hasn't filled by the timeout is canceled.
 */
export async function submitPaperBuyLimit(symbol: string, notionalUsd: number, limitPrice: number, clientOrderId: string): Promise<EntryResult> {
  const isCrypto = symbol.endsWith('USDT');
  const qty = notionalUsd / limitPrice;
  const order = await request<BrokerOrder>('POST', '/v2/orders', {
    symbol: toOrderSymbol(symbol),
    qty: isCrypto ? qty.toFixed(9) : String(Math.max(1, Math.floor(qty))),
    side: 'buy',
    type: 'limit',
    limit_price: fmtLimit(limitPrice, isCrypto),
    time_in_force: isCrypto ? 'gtc' : 'day',
    client_order_id: clientOrderId,
  });
  return classifyEntry(await settleOrder(order.id, CONFIG.orderTimeoutSec * 1000));
}

/**
 * MAKER entry: a passive limit BUY below the mark, so it rests for the lower
 * fee instead of crossing the spread. Canceled if not filled within `waitSec`;
 * the caller writes no row for an unfilled result and the next scan retries.
 * Alpaca paper does not fill resting below-mark limits, so this is for real
 * accounts only (docs/paper_phase_protocol.md).
 */
export async function submitPaperBuyMaker(
  symbol: string,
  notionalUsd: number,
  limitPrice: number,
  clientOrderId: string,
  waitSec: number
): Promise<EntryResult> {
  const isCrypto = symbol.endsWith('USDT');
  const qty = notionalUsd / limitPrice;
  const order = await request<BrokerOrder>('POST', '/v2/orders', {
    symbol: toOrderSymbol(symbol),
    qty: isCrypto ? qty.toFixed(9) : String(Math.max(1, Math.floor(qty))),
    side: 'buy',
    type: 'limit',
    limit_price: fmtLimit(limitPrice, isCrypto),
    time_in_force: isCrypto ? 'gtc' : 'day',
    client_order_id: clientOrderId,
  });
  return classifyEntry(await settleOrder(order.id, waitSec * 1000));
}

/**
 * Cancel the bot's own open orders (client_order_id "bot-...") older than
 * `minAgeMs`. Entries settle synchronously now, so any survivor is left over
 * from a crash or an unconfirmed cancel. The age floor keeps a scan from
 * canceling an order another process placed seconds ago.
 */
export async function cancelStaleBotOrders(minAgeMs = 2 * 60_000): Promise<BrokerOrder[]> {
  const now = Date.now();
  const stale = (await getOpenOrders()).filter((o) => {
    if (!(o.client_order_id || '').startsWith('bot-')) return false;
    const t = Date.parse(o.submitted_at ?? o.created_at ?? '');
    return !Number.isFinite(t) || now - t >= minAgeMs;
  });
  for (const o of stale) await cancelOrder(o.id);
  return stale;
}

/**
 * Close an entire open position at market (Alpaca's close-position endpoint)
 * and settle it. Throws unless the close fully filled, so the caller records
 * an exit only for a position that is really gone; anything else is retried
 * on the next scan.
 */
export async function closePaperPosition(symbol: string): Promise<BrokerOrder> {
  const order = await request<BrokerOrder>('DELETE', `/v2/positions/${toOrderSymbol(symbol).replace('/', '')}`);
  const final = await settleOrder(order.id, CONFIG.orderTimeoutSec * 1000);
  if (final.status !== 'filled') {
    throw new Error(`Close order ${final.id} for ${symbol} ended '${final.status}' (filled ${final.filled_qty}) — exit not recorded; the next scan retries.`);
  }
  return final;
}

/** Signed slippage of a fill vs a reference price, in basis points (positive = paid more). */
export function slippageBps(fillPrice: number, referencePrice: number): number {
  return ((fillPrice - referencePrice) / referencePrice) * 10_000;
}
