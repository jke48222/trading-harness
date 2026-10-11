import type { BrokerOrder } from '../src/broker/orders.ts';
import type { LedgerRow } from '../src/types.ts';

/** Shared test fixtures. Nothing here reads CONFIG, so test files can import it before setting their env. */

export const DAY = 86_400_000;
export const iso = (ms: number): string => new Date(ms).toISOString();

export function row(p: Partial<LedgerRow>): LedgerRow {
  return { timestamp: '', symbol: '', action: 'BUY', price: '1', quantity: '1', reason: '', mode: 'alpaca-paper', outcome: 'open', pnl: '', ...p };
}
export function order(p: Partial<BrokerOrder>): BrokerOrder {
  return { id: 'o', client_order_id: '', symbol: 'DOT/USD', status: 'filled', side: 'buy', notional: null, qty: null, filled_qty: '0', filled_avg_price: null, ...p };
}
/** Swap global fetch for a scripted broker. Returns the call log. */
export function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const { status = 200, body } = handler(url, init);
    return new Response(body === null ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
export const t0 = Date.parse('2026-07-27T00:14:00Z');

/** A filled DOT/USD order, as the broker reports it. */
export function fill(side: 'buy' | 'sell', qty: number, price: number, atMs: number, clientOrderId: string, submittedMs = atMs): BrokerOrder {
  return order({ id: `${clientOrderId}:${atMs}`, client_order_id: clientOrderId, symbol: 'DOT/USD', side, status: 'filled', filled_qty: String(qty), filled_avg_price: String(price), filled_at: iso(atMs), submitted_at: iso(submittedMs) });
}


/** DOT's real history: two clean trips, then a late fill whose exit the old code priced off trip 2. */
export const dotOrders = [
  fill('buy', 2416.99, 0.82663, t0, 'bot-DOTUSDT-1785110400000'),
  fill('sell', 2412.57, 0.754711, t0 + 1.1 * DAY, 'uuid-1'),
  fill('buy', 2305.22, 0.866892, t0 + 9 * DAY, 'bot-DOTUSDT-1785888000000'),
  fill('sell', 2301.66, 0.814591, t0 + 11 * DAY, 'uuid-2'),
  fill('buy', 1154.79, 1.14, t0 + 54 * DAY + 28_000, 'bot-DOTUSDT-1789776000000', t0 + 54 * DAY),
  fill('sell', 1152.77, 1.1953, t0 + 72 * DAY, 'uuid-3'),
];
