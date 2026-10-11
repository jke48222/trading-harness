import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dotOrders, fill, mockFetch, order, row, t0, iso } from './helpers.ts';
import type { LedgerRow } from '../src/types.ts';

// Order lifecycle and broker truth: settling, sweeping, round trips, reconciliation and attribution.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-broker-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const orders = await import('../src/broker/orders.ts');
const fills = await import('../src/broker/fills.ts');
const memory = await import('../src/memory.ts');
const { attributeTrips } = await import('../src/report.ts');
const DAY = 86_400_000;

test('fmtLimit keeps every digit a sub-cent coin needs (the BONK/SHIB bug)', () => {
  assert.equal(orders.fmtLimit(0.0000034, true), '0.0000034', 'old toFixed(6) gave 0.000003, 12% below the market');
  assert.equal(orders.fmtLimit(0.00000339123, true), '0.000003391', 'rounded to the 1e-9 price increment');
  assert.equal(orders.fmtLimit(0.4636, true), '0.4636');
  assert.equal(orders.fmtLimit(83030.134, true), '83030.13');
  assert.equal(orders.fmtLimit(0.5, false), '0.5000', 'stocks under $1 get 4 decimals');
  assert.equal(orders.fmtLimit(12.345, false), '12.35');
});

test('classifyEntry: a canceled order with a fill is a real (partial) position', () => {
  assert.equal(orders.classifyEntry(order({ status: 'filled', filled_qty: '2', filled_avg_price: '1' })).state, 'filled');
  assert.equal(orders.classifyEntry(order({ status: 'canceled', filled_qty: '0' })).state, 'unfilled');
  const partial = orders.classifyEntry(order({ status: 'canceled', filled_qty: '0.5', filled_avg_price: '3' }));
  assert.equal(partial.state, 'partial');
  assert.equal(partial.filledQty, 0.5);
  assert.equal(orders.classifyEntry(order({ status: 'new' })).state, 'unknown');
});

test('settleOrder cancels an order that has not filled by the deadline (never leaves it resting)', async () => {
  let canceled = false;
  const m = mockFetch((url, init) => {
    if (init?.method === 'DELETE') {
      canceled = true;
      return { status: 204, body: null };
    }
    return { body: order({ id: 'x', status: canceled ? 'canceled' : 'new', filled_qty: '0' }) };
  });
  try {
    const final = await orders.settleOrder('x', 30, 5);
    assert.equal(canceled, true, 'a DELETE was sent');
    assert.equal(final.status, 'canceled');
    assert.ok(m.calls.some((c) => c.startsWith('DELETE') && c.endsWith('/v2/orders/x')));
  } finally {
    m.restore();
  }
});

test('settleOrder returns a fill that lands while the cancel is in flight', async () => {
  let deletes = 0;
  const m = mockFetch((_url, init) => {
    if (init?.method === 'DELETE') {
      deletes++;
      return { status: 422, body: { message: 'order is already filled' } };
    }
    return { body: order({ id: 'y', status: deletes > 0 ? 'filled' : 'new', filled_qty: deletes > 0 ? '10' : '0', filled_avg_price: '2' }) };
  });
  try {
    const res = orders.classifyEntry(await orders.settleOrder('y', 20, 5));
    assert.equal(res.state, 'filled');
    assert.equal(res.filledQty, 10);
  } finally {
    m.restore();
  }
});

test('cancelStaleBotOrders cancels only old bot orders', async () => {
  const now = Date.now();
  const open = [
    order({ id: 'old', client_order_id: 'bot-LDOUSDT-1', status: 'new', submitted_at: new Date(now - 3_600_000).toISOString() }),
    order({ id: 'young', client_order_id: 'bot-ONDOUSDT-1', status: 'new', submitted_at: new Date(now - 10_000).toISOString() }),
    order({ id: 'human', client_order_id: 'abc', status: 'new', submitted_at: new Date(now - 3_600_000).toISOString() }),
  ];
  const deleted: string[] = [];
  const m = mockFetch((url, init) => {
    if (init?.method === 'DELETE') {
      deleted.push(url.split('/').pop() as string);
      return { status: 204, body: null };
    }
    return { body: open };
  });
  try {
    const swept = await orders.cancelStaleBotOrders(2 * 60_000);
    assert.deepEqual(swept.map((o) => o.id), ['old']);
    assert.deepEqual(deleted, ['old']);
  } finally {
    m.restore();
  }
});

test('botSymbolOf and toOrderSymbol round-trip both broker spellings', () => {
  assert.equal(orders.botSymbolOf('DOT/USD'), 'DOTUSDT');
  assert.equal(orders.botSymbolOf('BONKUSD'), 'BONKUSDT');
  assert.equal(orders.botSymbolOf('AAPL'), 'AAPL');
  assert.equal(orders.toOrderSymbol('BONKUSDT'), 'BONK/USD');
  assert.equal(orders.makeQuote(10, 10.1, 't')?.spreadBps.toFixed(1), '99.5');
  assert.equal(orders.makeQuote(0, 1, 't'), null, 'a one-sided book is not a quote');
});

test('buildRoundTrips: fee-in-coin dust still closes a trip; each trip keeps its own entry', () => {
  const { trips, unmatchedSells } = fills.buildRoundTrips(fills.ordersToFills(dotOrders));
  assert.equal(unmatchedSells.length, 0);
  assert.equal(trips.length, 3);
  assert.ok(trips.every((t) => !t.open));
  assert.equal(trips[2].entryVwap, 1.14);
  assert.equal(trips[2].grossPct?.toFixed(2), '4.85', 'the third trip made +4.85%, not the +37.88% the ledger recorded');
});

test('buildRoundTrips: a probe buy marks the trip manual; probe ids are not bot ids', () => {
  assert.equal(fills.isBotClientId('bot-LTCUSDT-1784160000000'), true);
  assert.equal(fills.isBotClientId('bot-LTCUSDT-1784160000000-m29839480'), true, 'attempt suffix is still a bot id');
  assert.equal(fills.isBotClientId('bot-mklimit-1784164831146'), false);
  assert.equal(fills.isBotClientId('bot-restore-LTC-1784164886205'), false);
  assert.equal(fills.boundaryOfClientId('bot-ETHUSDT-1784160000000-m5'), 1784160000000);
  const ltc = [
    fill('buy', 43.47, 45.02, t0, 'bot-LTCUSDT-1784160000000'),
    fill('buy', 0.22, 45.0, t0 + 3_600_000, 'bot-mklimit-1784164831146'),
    fill('sell', 43.59, 44.9, t0 + 3_600_500, 'uuid'),
  ].map((o) => ({ ...o, symbol: 'LTC/USD' }));
  const { trips } = fills.buildRoundTrips(fills.ordersToFills(ltc));
  assert.equal(trips.length, 1);
  assert.equal(trips[0].manual, true);
});

test('reconcile finds the late fill, the misattributed exit and the orphan, and the fixes are exact', () => {
  const { trips } = fills.buildRoundTrips(fills.ordersToFills([...dotOrders, fill('buy', 500, 0.01, t0 + 80 * DAY, 'bot-DOTUSDT-1790000000000')]));
  const entry = (atMs: number, f: number, id: string): LedgerRow =>
    row({ timestamp: iso(atMs), symbol: 'DOTUSDT', price: '0.828000', reason: `[tsmom28-1d-state-long] up || broker fill ${f} qty 1, order ${id}` });
  const exit = (atMs: number, f: number, pnl: string): LedgerRow =>
    row({ timestamp: iso(atMs + 5_000), symbol: 'DOTUSDT', action: 'SELL', mode: 'alpaca-paper-exit', reason: `[actual:tsmom28-1d-state-long] Exit: flip; entry fill ${f}; ACTUAL`, outcome: 'loss', pnl });
  const rows = [
    entry(t0, 0.82663, 'bot-DOTUSDT-1785110400000'),
    exit(t0 + 1.1 * DAY, 0.82663, '-8.7003'),
    entry(t0 + 9 * DAY, 0.866892, 'bot-DOTUSDT-1785888000000'),
    exit(t0 + 11 * DAY, 0.866892, '-6.0332'),
    exit(t0 + 72 * DAY, 0.866892, '37.8838'), // the bug: trip 3's exit priced off trip 2's entry
  ];
  const positions = [{ symbol: 'DOTUSD', qty: '500', avg_entry_price: '0.01', market_value: '5', unrealized_pl: '0', current_price: '0.01' }];
  const ids = new Set(dotOrders.map((o) => o.client_order_id).filter((x) => x.startsWith('bot-')));
  const found = fills.reconcile({ rows, trips, positions, filledBotClientIds: ids, sinceMs: 0 });
  const kinds = found.map((f) => `${f.kind}`).sort();
  assert.deepEqual(kinds, ['misattributed-exit', 'missing-entry-row', 'missing-entry-row', 'orphan-position']);

  const mis = found.find((f) => f.kind === 'misattributed-exit');
  assert.ok(mis?.row && mis.trip);
  const fixed = fills.correctedExitRow(mis.row, mis.trip, '2026-10-11');
  assert.equal(fixed.pnl, '4.8509');
  assert.equal(fixed.outcome, 'win');
  assert.match(fixed.reason, /entry fill 1\.14;/);
  assert.match(fixed.reason, /Corrected 2026-10-11 from broker fills/);
  assert.match(fixed.reason, /had 37\.8838%/);

  const late = found.find((f) => f.kind === 'missing-entry-row' && f.fill?.price === 1.14);
  assert.ok(late?.fill);
  const adopted = fills.adoptionRow(late.fill, 'tsmom28-1d-state-long', 1.13, (p) => p.toPrecision(6), '2026-10-11');
  assert.equal(adopted.timestamp, late.fill.submittedAt, 'stamped at decision time, not fill time');
  assert.equal(adopted.price, '1.13000', 'the signal close, so scoring can verify the candle');
  assert.equal(memory.orderIdOf(adopted), 'bot-DOTUSDT-1789776000000');
  assert.equal(memory.entryFillOf(adopted), 1.14);
});

test('attributeTrips adds the fee back so model and actual are both gross', () => {
  const { trips } = fills.buildRoundTrips(fills.ordersToFills(dotOrders.slice(0, 2)));
  const rows = [
    row({ timestamp: iso(t0), symbol: 'DOTUSDT', price: '0.8280', reason: '[tsmom28-1d-state-long] up || broker fill 0.82663 qty 1, order bot-DOTUSDT-1785110400000 || model: state exit 2026-07-28 at 0.76', outcome: 'loss', pnl: '-8.5000' }),
  ];
  const [a] = attributeTrips(trips, rows, 30);
  assert.equal(a.modelGrossPct?.toFixed(2), '-8.20');
  assert.equal(a.entrySlipBps?.toFixed(0), (((0.82663 / 0.828) - 1) * 10_000).toFixed(0));
  assert.equal(a.exitSlipBps?.toFixed(0), (((0.754711 / 0.76) - 1) * 10_000).toFixed(0));
});
