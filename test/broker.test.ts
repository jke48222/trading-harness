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

test('fmtLimit keeps every digit a coin needs and rounds buy limits up (the BONK and $1-coin bugs)', () => {
  assert.equal(orders.fmtLimit(0.0000034, true), '0.0000034', 'old toFixed(6) gave 0.000003, 12% below the market');
  assert.equal(orders.fmtLimit(0.00000339123, true), '0.000003392', 'rounded UP to the 1e-9 increment');
  assert.equal(orders.fmtLimit(0.4636, true), '0.4636');
  // A $1.08 coin with a 30 bps cap: cents would give 1.08, under the 1.0801 ask.
  const limit = 1.0801 * 1.003;
  assert.ok(Number(orders.fmtLimit(limit, true)) >= limit, 'never below the intended limit');
  assert.equal(orders.fmtLimit(1.0801 * 1.003, true), '1.0833403');
  assert.equal(orders.fmtLimit(83030.134, true), '83030.134');
  assert.equal(orders.fmtLimit(0.5, false), '0.5000', 'stocks under $1 get 4 decimals');
  assert.equal(orders.fmtLimit(12.341, false), '12.35', 'stock cents, rounded up');
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

test('cancelStaleBotOrders cancels only old bot orders, and waits for each cancel to land', async () => {
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
    if (url.includes('/v2/orders/old')) return { body: { ...open[0], status: deleted.includes('old') ? 'canceled' : 'new' } };
    return { body: open };
  });
  try {
    const swept = await orders.cancelStaleBotOrders(2 * 60_000);
    assert.deepEqual(swept.map((o) => o.id), ['old']);
    assert.equal(swept[0].status, 'canceled', 'the final state, not the stale one');
    assert.deepEqual(deleted, ['old']);
  } finally {
    m.restore();
  }
});

test('settleOrder: a failed status check never skips the cancel (the 429 that left an order resting)', async () => {
  let gets = 0;
  let deleted = false;
  const m = mockFetch((_url, init) => {
    if (init?.method === 'DELETE') {
      deleted = true;
      return { status: 204, body: null };
    }
    gets++;
    if (gets === 2) return { status: 429, body: { message: 'too many requests' } };
    return { body: order({ id: 'z', status: deleted ? 'canceled' : 'new', filled_qty: '0' }) };
  });
  try {
    const final = await orders.settleOrder('z', 30, 5);
    assert.equal(deleted, true, 'the cancel was still sent');
    assert.equal(final.status, 'canceled');
  } finally {
    m.restore();
  }
});

test('settleOrder: when the broker never answers, the result is unknown, not a throw', async () => {
  const m = mockFetch((_url, init) => (init?.method === 'DELETE' ? { status: 500, body: {} } : { status: 503, body: {} }));
  try {
    const final = await orders.settleOrder('q', 10, 2);
    assert.equal(orders.classifyEntry(final).state, 'unknown');
  } finally {
    m.restore();
  }
});

test('ordersToFills keeps a partial fill that has no filled_at', () => {
  const partial = order({ id: 'p', client_order_id: 'bot-DOTUSDT-1', status: 'canceled', filled_qty: '5', filled_avg_price: '1.1', filled_at: null, updated_at: '2026-10-01T00:00:30Z', submitted_at: '2026-10-01T00:00:00Z' });
  const [f] = fills.ordersToFills([partial]);
  assert.equal(f.qty, 5);
  assert.equal(f.filledAt, '2026-10-01T00:00:30Z');
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

test('repairFromBroker adopts a late fill and records an exit that has no row, once', async () => {
  const { repairFromBroker } = await import('../src/reconcileRun.ts');
  memory.resetMemory();
  const T = Date.parse('2026-09-01T00:30:00Z');
  const brokerOrders = [
    fill('buy', 100, 1.0, T, 'bot-DOTUSDT-1788220800000'), // its scan timed out; no row
    fill('buy', 50, 2.0, T + DAY, 'bot-ADAUSDT-1788307200000'),
    fill('sell', 49.9, 2.2, T + 3 * DAY, 'uuid-x'), // closed, but the exit row was lost
  ].map((o, i) => (i === 0 ? o : { ...o, symbol: 'ADA/USD' }));
  memory.appendLedgerRow(row({ timestamp: iso(T + DAY), symbol: 'ADAUSDT', price: '1.98', reason: '[tsmom28-1d-state-long] up || broker fill 2 qty 50, order bot-ADAUSDT-1788307200000' }));
  const positions = [{ symbol: 'DOTUSD', qty: '100', avg_entry_price: '1', market_value: '110', unrealized_pl: '10', current_price: '1.1' }];
  const klines = Array.from({ length: 12 }, (_, i) => {
    const open = Date.parse('2026-08-25T00:00:00Z') + i * DAY;
    return [open, '0.97', '0.97', '0.97', '0.97', '1', open + DAY - 1];
  });
  const m = mockFetch((url) => {
    if (url.includes('/v2/orders?')) return { body: brokerOrders };
    if (url.endsWith('/v2/positions')) return { body: positions };
    if (url.includes('klines')) return { body: klines };
    return { status: 404, body: {} };
  });
  try {
    const first = await repairFromBroker(() => {}, new Set(['DOTUSDT', 'ADAUSDT']));
    assert.equal(first.adopted, 1);
    assert.equal(first.exitsAdded, 1);
    const second = await repairFromBroker(() => {}, new Set(['DOTUSDT', 'ADAUSDT']));
    assert.deepEqual([second.adopted, second.exitsAdded], [0, 0], 'nothing twice');
  } finally {
    m.restore();
  }
  const rows = memory.loadLedger();
  const dot = rows.find((r) => r.symbol === 'DOTUSDT');
  assert.equal(dot?.price, '0.970000', 'adopted at the signal close');
  const adaExit = rows.find((r) => r.symbol === 'ADAUSDT' && r.mode === 'alpaca-paper-exit');
  assert.equal(adaExit?.pnl, '10.0000');
});

test('stock round trips are measured in cash, so a split does not read as a crash', async () => {
  const { tripReturnPct } = await import('../src/exitPricing.ts');
  const splitOrders = [
    { ...fill('buy', 10, 200, t0, 'bot-NVDAX-1'), symbol: 'NVDAX' },
    { ...fill('sell', 100, 21, t0 + 30 * DAY, 'uuid-s'), symbol: 'NVDAX' }, // after a 10-for-1 split
  ];
  const { trips } = fills.buildRoundTrips(fills.ordersToFills(splitOrders));
  assert.equal(trips[0].grossPct?.toFixed(2), '5.00', '2,000 in, 2,100 out');
  assert.equal(tripReturnPct(false, 200, { exitPrice: 21, exitQty: 100, buyCost: 2000 }).toFixed(2), '5.00');
  assert.equal(tripReturnPct(false, 200, { exitPrice: 210, exitQty: 10, buyCost: 0 }).toFixed(2), '5.00', 'no buy history: per share');
  assert.equal(tripReturnPct(true, 2, { exitPrice: 2.1, exitQty: 99.75, buyCost: 200 }).toFixed(2), '5.00', 'crypto stays per unit');
});

test('without order history, a split stock is priced from the broker\'s cost basis, not the pre-split entry price', async () => {
  const { tripCashSince, tripReturnPct } = await import('../src/exitPricing.ts');
  const close = order({ id: 'c1', symbol: 'NVDAX', side: 'sell', status: 'filled', filled_qty: '100', filled_avg_price: '21' });
  const down = mockFetch(() => ({ status: 503, body: { message: 'unavailable' } }));
  try {
    const cash = await tripCashSince('NVDAX', iso(t0), close, 2000); // 10 shares at 200 became 100 at 20
    assert.deepEqual(cash, { exitPrice: 21, exitQty: 100, buyCost: 2000 });
    assert.equal(tripReturnPct(false, 200, cash).toFixed(2), '5.00', 'the per-share fallback read -89.5%');
  } finally {
    down.restore();
  }
  // History that shows the sell but not the buy (bought before the window): the cost basis stands in only for a single closing sell.
  const sellOnly = mockFetch(() => ({ body: [{ ...fill('sell', 100, 21, t0 + DAY, 'uuid-s'), symbol: 'NVDAX' }] }));
  try {
    assert.equal((await tripCashSince('NVDAX', iso(t0), close, 2000)).buyCost, 2000);
  } finally {
    sellOnly.restore();
  }
});

test('reconcile and the scan repair both leave a still-held remainder to the exit manager', async () => {
  const { exitStillHeld } = await import('../src/reconcileRun.ts');
  const held = new Set(['DOTUSDT']);
  assert.equal(exitStillHeld({ kind: 'missing-exit-row', botSymbol: 'DOTUSDT' } as never, held), true);
  assert.equal(exitStillHeld({ kind: 'missing-exit-row', botSymbol: 'ADAUSDT' } as never, held), false, 'sold out: the exit row is due');
  assert.equal(exitStillHeld({ kind: 'missing-entry-row', botSymbol: 'DOTUSDT' } as never, held), false);
});

test('repairFromBroker leaves a still-held leftover to the exit manager (no exit row, no orphan)', async () => {
  const { repairFromBroker } = await import('../src/reconcileRun.ts');
  memory.resetMemory();
  const T = Date.parse('2026-09-01T00:30:00Z');
  const brokerOrders = [
    { ...fill('buy', 1000, 1.0, T, 'bot-DOTUSDT-1788220800000'), symbol: 'DOT/USD' },
    { ...fill('sell', 995, 1.1, T + 2 * DAY, 'uuid-p'), symbol: 'DOT/USD' }, // 99.5% filled, the rest canceled
  ];
  memory.appendLedgerRow(row({ timestamp: iso(T), symbol: 'DOTUSDT', price: '0.99', reason: '[tsmom28-1d-state-long] up || broker fill 1 qty 1000, order bot-DOTUSDT-1788220800000' }));
  const positions = [{ symbol: 'DOTUSD', qty: '5', avg_entry_price: '1', market_value: '5.5', unrealized_pl: '0.5', current_price: '1.1' }];
  const m = mockFetch((url) => {
    if (url.includes('/v2/orders?')) return { body: brokerOrders };
    if (url.endsWith('/v2/positions')) return { body: positions };
    return { status: 404, body: {} };
  });
  try {
    const r = await repairFromBroker(() => {}, new Set(['DOTUSDT']));
    assert.equal(r.exitsAdded, 0);
  } finally {
    m.restore();
  }
  assert.equal(memory.openEntryFor(memory.loadLedger(), 'DOTUSDT')?.symbol, 'DOTUSDT', 'the entry stays open for the exit manager');
});
