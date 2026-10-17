import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrokerActivity, PortfolioHistory } from '../src/broker/orders.ts';

// Cash from outside the book: which flows count, the cash rebuild from the
// activity log, and returns net of flows. Pure functions; src/cashflows.ts
// reads no CONFIG, so no env is needed.
const cf = await import('../src/cashflows.ts');

const DAY = 86_400_000;
const at = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const NOW = Date.parse('2026-10-17T21:00:00Z');
const near = (actual: number | null | undefined, expected: number, eps = 1e-6): void => {
  assert.ok(actual != null && Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
};

/** The account's daily history around the journal, as Alpaca returns it with cashflow_types=ALL (2026-10-17). */
function history(rows: [string, number | null, Record<string, number>?][]): PortfolioHistory {
  const types = [...new Set(rows.flatMap(([, , f]) => Object.keys(f ?? {})))];
  return {
    timestamp: rows.map(([d]) => at(d) / 1000),
    equity: rows.map(([, e]) => e),
    profit_loss_pct: rows.map(() => 0),
    cashflow: Object.fromEntries(types.map((t) => [t, rows.map(([, , f]) => f?.[t] ?? 0)])),
  };
}
const REAL = history([
  ['2026-07-14', 100000],
  ['2026-07-15', 100000, { JNLC: 100000 }],
  ['2026-07-16', 99949.79, { CFEE: -0.03 }],
  ['2026-10-13', 103601.89, { CFEE: -9.77, FEE: -0.05 }],
  ['2026-10-14', 38742.05, { JNLC: -66905.32, CFEE: -12.53 }],
  ['2026-10-15', 36180.12],
  ['2026-10-16', 37955.56, { FEE: -0.15 }],
  ['2026-10-17', 36969.47],
]);

test('external flows: journals, deposits and transfers are external; fills, fees, dividends, interest and corporate actions are the book', () => {
  for (const t of ['JNLC', 'JNLS', 'JNL', 'CSD', 'CSW', 'TRANS', 'ACATC', 'ACATS', 'FOPT', 'OCT', 'SOMETHINGNEW']) assert.equal(cf.isExternalFlowType(t), true, t);
  for (const t of ['FILL', 'CFEE', 'FEE', 'DIV', 'DIVNRA', 'DIVTXEX', 'INT', 'INTTW', 'CGD', 'MA', 'SPLIT', 'SPIN', 'PTC', 'PTR', 'WH']) assert.equal(cf.isExternalFlowType(t), false, t);
});

test('externalFlows reads the history: the funding and the journal, never the fees', () => {
  const flows = cf.externalFlows(REAL);
  assert.deepEqual(
    flows.map((f) => [f.date, f.type, f.amount]),
    [['2026-07-15', 'JNLC', 100000], ['2026-10-14', 'JNLC', -66905.32]]
  );
  assert.equal(flows[1].t, at('2026-10-14'));
  assert.equal(cf.flowKey(flows[1]), 'JNLC:2026-10-14:-66905.32');
  assert.deepEqual(cf.externalFlows({ timestamp: [1], equity: [1], profit_loss_pct: [0] }), [], 'a history fetched without cashflow_types has no flows');
  assert.equal(cf.usd(-66905.32), '-$66,905.32');
  assert.equal(cf.usd(66905.32, true), '+$66,905.32');
  assert.equal(cf.usd(0, true), '$0.00');
});

test('netOfFlows: the journal is neither a gain nor a loss, and a reversal is handled the same way', () => {
  const pts = [
    { t: at('2026-10-13'), date: '2026-10-13', equity: 103601.89 },
    { t: at('2026-10-14'), date: '2026-10-14', equity: 38742.05 },
    { t: at('2026-10-15'), date: '2026-10-15', equity: 36180.12 },
  ];
  const v = cf.netOfFlows(pts, [{ t: at('2026-10-14'), amount: -66905.32 }]);
  // The day of the journal: the book's own $2,045.48 over the equity at the start less half the journal (mid-day). The raw move was -62.61%.
  near(v[1].ret, 2045.48 / (103601.89 - 66905.32 / 2), 1e-9);
  near(v[1].ret as number, 0.029159, 1e-6);
  near(cf.periodReturn(103601.89, 103000, 0), 103000 / 103601.89 - 1, 1e-15); // with no flow it is the plain return
  near(v[2].ret, 36180.12 / 38742.05 - 1, 1e-12);
  assert.equal(v[1].flow, -66905.32);
  near(v[2].value, 99572.07, 0.005);

  // Alpaca reverses it two days later: +$66,905.32 lands, equity jumps, and the return is only the book's own $361.80 that day.
  const back = [...pts, { t: at('2026-10-16'), date: '2026-10-16', equity: 36180.12 * 1.01 + 66905.32 }];
  const r = cf.netOfFlows(back, [{ t: at('2026-10-14'), amount: -66905.32 }, { t: at('2026-10-16'), amount: 66905.32 }]);
  near(r[3].ret, (36180.12 * 0.01) / (36180.12 + 66905.32 / 2), 1e-12);
  assert.ok((r[3].ret as number) > 0 && (r[3].ret as number) < 0.01, 'neither the reversal nor the journal is a gain or a loss'); 

  // Flows at or before the first point are its capital: the funding never enters a return.
  const funded = cf.netOfFlows([{ t: at('2026-07-15'), date: '2026-07-15', equity: 100000 }, { t: at('2026-07-16'), date: '2026-07-16', equity: 99949.79 }], [{ t: at('2026-07-15'), amount: 100000 }]);
  near(funded[1].ret, 99949.79 / 100000 - 1, 1e-12);
  // A flow booked on a point that was left out counts at the next point kept.
  const skipped = cf.netOfFlows([pts[0], pts[2]], [{ t: at('2026-10-14'), amount: -66905.32 }]);
  near(skipped[1].ret, (36180.12 - 103601.89 + 66905.32) / (103601.89 - 66905.32 / 2), 1e-12);
});

test('netOfFlows refuses a flow the equity does not show (a flow booked a day off)', () => {
  const pts = [
    { t: at('2026-10-13'), date: '2026-10-13', equity: 103601.89 },
    { t: at('2026-10-14'), date: '2026-10-14', equity: 50000 },
  ];
  assert.throws(() => cf.netOfFlows(pts, [{ t: at('2026-10-14'), amount: 66905.32 * 2 }]), /disagree at 2026-10-14/);
});

test('alignFlows moves a large flow to the neighbouring point its equity step is in, and leaves the rest alone', () => {
  const p = (date: string, equity: number) => ({ t: at(date), date, equity });
  const pts = [p('2026-10-12', 105305.58), p('2026-10-13', 103601.89), p('2026-10-14', 38742.05), p('2026-10-15', 36180.12)];
  const flow = (date: string, amount: number) => ({ t: at(date), date, type: 'JNLC', amount });
  // Booked where the equity steps: stays.
  assert.equal(cf.alignFlows(pts, [flow('2026-10-14', -66905.32)])[0].at, at('2026-10-14'));
  // Booked a point early (the equity steps a point later): moved to the step.
  assert.equal(cf.alignFlows(pts, [flow('2026-10-13', -66905.32)])[0].at, at('2026-10-14'));
  // Booked a point late: moved back.
  assert.equal(cf.alignFlows(pts, [flow('2026-10-15', -66905.32)])[0].at, at('2026-10-14'));
  // Under 20% of equity a flow is never moved: a $5,000 deposit on a -5% day before a +5% day would fit the next day as well.
  const swing = [p('2026-10-12', 100000), p('2026-10-13', 100000), p('2026-10-14', 105000)];
  assert.equal(cf.alignFlows(swing, [flow('2026-10-13', 5000)])[0].at, at('2026-10-13'));
  // A -$60,000 journal on a $30,000 print can't be valued where it is booked, so it goes to the neighbour that fits best, here the bad print;
  // perf then finds that print as an outlier net of the journal and counts the journal at 2026-10-14 after all (test/perf.test.ts).
  const bad = [p('2026-10-12', 100000), p('2026-10-13', 30000), p('2026-10-14', 40000), p('2026-10-15', 40000)];
  assert.equal(cf.alignFlows(bad, [flow('2026-10-14', -60000)])[0].at, at('2026-10-13'));
  // A large flow no point moves with stays where it is booked (perf flags it).
  const flat = [p('2026-10-12', 100000), p('2026-10-13', 100100), p('2026-10-14', 99900), p('2026-10-15', 100050)];
  assert.equal(cf.alignFlows(flat, [flow('2026-10-14', -50000)])[0].at, at('2026-10-14'));
  // At or before the first point it is capital: it never moves.
  assert.equal(cf.alignFlows(pts, [flow('2026-10-12', -66905.32)])[0].at, at('2026-10-12'));
  // Booked in a day still in progress (after the last point) while the last point already stepped: it counts at the last point.
  const stepped = [p('2026-10-12', 36969.47), p('2026-10-13', 36969.47 * 1.01 + 66905.32)];
  assert.equal(cf.alignFlows(stepped, [flow('2026-10-14', 66905.32)])[0].at, at('2026-10-13'));
  assert.equal(cf.alignFlows(pts, [flow('2026-10-16', -66905.32)])[0].at, at('2026-10-16'), 'no step to match: it waits for its day');
  // An inflow bigger than its point's equity, booked a day before the equity steps: moved to the step, whatever the market did.
  const before = [p('2026-10-12', 36969.47), p('2026-10-13', 36969.47), p('2026-10-14', (36969.47 + 66905.32) * 0.88)];
  assert.equal(cf.alignFlows(before, [flow('2026-10-13', 66905.32)])[0].at, at('2026-10-14'));
  // A deposit no point moves with, but that its point can still value: it stays, and perf flags it.
  const small = [p('2026-10-12', 36969.47), p('2026-10-13', 36000), p('2026-10-14', 35000)];
  assert.equal(cf.alignFlows(small, [flow('2026-10-13', 66905.32)])[0].at, at('2026-10-13'));
  // Nowhere the equity could have held it: left uncounted rather than a return below -100%.
  const none = [p('2026-10-12', 36969.47), p('2026-10-13', 30000), p('2026-10-14', 29000)];
  assert.equal(cf.alignFlows(none, [flow('2026-10-13', 100000)])[0].at, null);
});

// ---- the activity log ----

const act = (p: Partial<BrokerActivity>): BrokerActivity => ({ id: 'x', activity_type: 'JNLC', status: 'executed', ...p });
const fillAct = (side: string, symbol: string, qty: number, price: number, time: string): BrokerActivity =>
  act({ activity_type: 'FILL', side, symbol, qty: String(qty), price: String(price), transaction_time: time, status: undefined });

/** A small log in the account's shapes: the funding, fills both ways, USD and in-coin crypto fees, a CAT fee, a canceled entry. */
const LOG: BrokerActivity[] = [
  act({ activity_type: 'JNLC', date: '2026-07-14', created_at: '2026-07-14T08:29:25.234851Z', net_amount: '100000' }),
  fillAct('buy', 'BTC/USD', 0.01, 65000, '2026-07-15T21:11:48.484349Z'),
  act({ activity_type: 'CFEE', date: '2026-07-15', created_at: '2026-07-15T23:55:20Z', net_amount: '0', qty: '-0.000025', price: '65000', symbol: 'BTCUSD' }),
  fillAct('buy', 'AAPL', 10, 200, '2026-08-01T14:00:00Z'),
  fillAct('sell', 'AAPL', 10, 210, '2026-09-01T14:00:00Z'),
  act({ activity_type: 'FEE', date: '2026-09-01', created_at: '2026-09-02T00:06:49Z', net_amount: '-0.01' }),
  act({ activity_type: 'JNLC', date: '2026-09-15', created_at: '2026-09-15T10:00:00Z', net_amount: '-500', status: 'canceled' }),
  act({ activity_type: 'JNLS', date: '2026-09-20', created_at: '2026-09-20T10:00:00Z', net_amount: '0' }),
  fillAct('sell', 'BTC/USD', 0.004, 70000, '2026-10-16T00:10:15Z'),
  act({ activity_type: 'CFEE', date: '2026-10-16', created_at: '2026-10-17T04:21:35Z', net_amount: '-0.7', symbol: 'BTCUSD' }),
  fillAct('sell', 'SOL/USD', 10, 186.255, '2026-10-17T00:10:15Z'),
];
const LOG_CASH = 100000 - 650 - 2000 + 2100 - 0.01 + 280 - 0.7 + 1862.55;

test('foldCash rebuilds cash to the cent: fills move price times quantity, coin fees nothing, a canceled entry nothing', () => {
  const { rebuild, ledger } = cf.foldCash(null, LOG, NOW);
  near(rebuild.cash, LOG_CASH, 1e-6);
  assert.equal(rebuild.activities, LOG.length);
  assert.deepEqual(rebuild.external, [{ id: 'x', type: 'JNLC', date: '2026-07-14', amount: 100000 }], 'neither the canceled journal nor a $0 stock journal is a cash flow');
  near(rebuild.recentCryptoSalesUsd, 280 + 1862.55, 1e-6);
  // The ledger keeps everything older than three days; the last three are read again next run.
  assert.equal(ledger.through, new Date(NOW - cf.SETTLE_MS).toISOString());
  near(ledger.cash, 100000 - 650 - 2000 + 2100 - 0.01, 1e-6);
  assert.equal(ledger.count, 8);
  assert.equal(ledger.fullAt, new Date(NOW).toISOString());
});

test('foldCash on a ledger reads only what is newer and lands on the same cash as a full read', () => {
  const first = cf.foldCash(null, LOG.slice(0, 8), Date.parse('2026-10-01T00:00:00Z')).ledger;
  // The next read overlaps the ledger: the rows it already holds are skipped, not counted twice.
  const overlap = LOG.filter((a) => cf.activityTime(a) > Date.parse(first.through) - 30 * DAY);
  assert.ok(overlap.some((a) => cf.activityTime(a) <= Date.parse(first.through)), 'the overlap holds rows the ledger has');
  const again = cf.foldCash(first, overlap, NOW);
  near(again.rebuild.cash, LOG_CASH, 1e-6);
  assert.equal(again.rebuild.activities, LOG.length);
  assert.equal(again.ledger.fullAt, first.fullAt, 'an incremental read keeps the date of the last full one');
  near(again.ledger.cash, cf.foldCash(null, LOG, NOW).ledger.cash, 1e-6);
});

test('foldCash stops on an activity it cannot read instead of guessing at cash', () => {
  assert.throws(() => cf.foldCash(null, [fillAct('buy', 'BTC/USD', Number.NaN, 65000, '2026-07-15T21:11:48Z')], NOW), /FILL activity has no readable amount/);
  assert.throws(() => cf.foldCash(null, [act({ net_amount: '5', date: undefined, created_at: undefined })], NOW), /no readable time/);
});

test('matchFlows: the journal is in the history only; a flow the log lists first is in the log only, never against the history', () => {
  const flows = cf.externalFlows(REAL);
  const funding = { id: 'a-funding', type: 'JNLC', date: '2026-07-14', amount: 100000 };
  const m = cf.matchFlows(flows, [funding]);
  assert.deepEqual(m.historyOnly.map((h) => [cf.flowKey(h.flow), h.amount]), [['JNLC:2026-10-14:-66905.32', -66905.32]]);
  assert.deepEqual(m.pairs.map((p) => p.acts), [[funding], []], 'the funding activity of 07-14 pairs with the 07-15 point');
  assert.deepEqual(m.logOnly, []);
  // Once the log lists it (Alpaca backfills it, dated a day earlier), nothing is left over.
  const backfilled = cf.matchFlows(flows, [funding, { id: 'a-journal', type: 'JNLC', date: '2026-10-13', amount: -66905.32 }]);
  assert.deepEqual([backfilled.historyOnly, backfilled.logOnly], [[], []]);
  // A reversal the log lists before the daily history books it: in the log only, and the journal still in the history only.
  const reversal = { id: 'a-reversal', type: 'JNLC', date: '2026-10-20', amount: 66905.32 };
  const early = cf.matchFlows(flows, [funding, reversal]);
  assert.deepEqual(early.logOnly, [reversal]);
  assert.deepEqual(early.historyOnly.map((h) => h.amount), [-66905.32]);
  // A point holds the sum of its window: two deposits the same day match the one flow they add up to.
  const two = cf.externalFlows(history([['2026-10-13', 1], ['2026-10-14', 1, { CSD: 300 }]]));
  const summed = cf.matchFlows(two, [{ id: 'a1', type: 'CSD', date: '2026-10-13', amount: 100 }, { id: 'a2', type: 'CSD', date: '2026-10-13', amount: 200 }, { id: 'a3', type: 'CSD', date: '2026-10-25', amount: 7 }]);
  assert.deepEqual([summed.historyOnly, summed.logOnly.map((a) => a.id)], [[], ['a3']]);
  // A history that starts after the funding point leaves the funding activity in the log only, not a flow against the history.
  const late = cf.matchFlows(flows.slice(1), [funding]);
  assert.deepEqual([late.logOnly, late.historyOnly.length], [[funding], 1]);
});

test('matchFlows pairs across a holiday weekend and an early close, and carries what a mixed point leaves over', () => {
  // A Saturday journal before Presidents\' Day books in the Tuesday session\'s point, stamped 01:00 UTC on Wednesday 2027-02-17.
  const presidents = [{ t: Date.parse('2027-02-17T01:00:00Z'), date: '2027-02-17', type: 'JNLC', amount: 66905.32 }];
  assert.deepEqual(cf.matchFlows(presidents, [{ id: 'a1', type: 'JNLC', date: '2027-02-13', amount: 66905.32 }]).historyOnly, []);
  // After the 2026-12-24 early close, the next point is the 2026-12-29 one.
  const christmas = [{ t: Date.parse('2026-12-29T01:00:00Z'), date: '2026-12-29', type: 'CSD', amount: 500 }];
  assert.deepEqual(cf.matchFlows(christmas, [{ id: 'a1', type: 'CSD', date: '2026-12-24', amount: 500 }]).historyOnly, []);
  // A week apart is two different flows.
  assert.equal(cf.matchFlows(christmas, [{ id: 'a1', type: 'CSD', date: '2026-12-21', amount: 500 }]).historyOnly.length, 1);
  // One point booking a logged $10,000 and an unlogged $66,905.32: the log covers $10,000 of it, the rest is unlisted.
  const mixed = cf.matchFlows([{ t: at('2026-10-20'), date: '2026-10-20', type: 'JNLC', amount: 76905.32 }], [{ id: 'a1', type: 'JNLC', date: '2026-10-19', amount: 10000 }]);
  assert.deepEqual([mixed.historyOnly.map((h) => h.amount), mixed.logOnly], [[66905.32], []]);
  // A journal never swallows its own reversal: the log lists the reversal (dated a day either side) before the history books it.
  const journal = cf.externalFlows(REAL)[1];
  for (const date of ['2026-10-13', '2026-10-15']) {
    const r = cf.matchFlows([journal], [{ id: 'a-rev', type: 'JNLC', date, amount: 66905.32 }]);
    assert.deepEqual([r.historyOnly.map((h) => h.amount), r.logOnly.map((a) => a.id)], [[-66905.32], ['a-rev']], date);
  }
  // The log lists part of a point: the entry dated the day before counts toward it, the one dated on its own day waits for the next point.
  const part = cf.matchFlows([{ t: at('2026-10-20'), date: '2026-10-20', type: 'CSD', amount: 100 }], [{ id: 'b1', type: 'CSD', date: '2026-10-19', amount: 70 }, { id: 'b2', type: 'CSD', date: '2026-10-20', amount: 80 }]);
  assert.deepEqual([part.historyOnly.map((h) => h.amount), part.logOnly.map((a) => a.id)], [[30], ['b2']]);
  // Same-sign entries that add up to more than the point belong to other flows too, so none of them is taken.
  const over = cf.matchFlows([{ t: at('2026-10-20'), date: '2026-10-20', type: 'CSD', amount: 100 }], [{ id: 'b1', type: 'CSD', date: '2026-10-18', amount: 70 }, { id: 'b2', type: 'CSD', date: '2026-10-19', amount: 80 }]);
  assert.deepEqual([over.historyOnly.map((h) => h.amount), over.logOnly.length], [[100], 2]);
});
