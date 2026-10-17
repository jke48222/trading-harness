import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PortfolioHistory } from '../src/broker/orders.ts';

// Cash from outside the book: which flows count, and returns net of flows.
// Pure functions; src/cashflows.ts reads no CONFIG, so no env is needed.
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
