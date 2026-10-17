import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAY, dotOrders, fill, iso, order, row, t0 } from './helpers.ts';
import type { ScanStats } from '../src/bot.ts';
import type { Finding } from '../src/broker/fills.ts';

// The dashboard: its request guard, and the pure shapers behind /api/health,
// /api/report, /api/perf, gate 2 and the server's broker caches.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-dashboard-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const P = await import('../src/dashboard/payloads.ts');
const { ordersToFills, buildRoundTrips } = await import('../src/broker/fills.ts');
const { attributeTrips } = await import('../src/report.ts');
const { evaluateHealth } = await import('../src/health.ts');

test('dashboard guard: only its own page, on its own host, may POST', async () => {
  const { requestAllowed } = await import('../src/dashboard/guard.ts');
  const own = { host: '127.0.0.1:8787' };
  const post = { ...own, origin: 'http://127.0.0.1:8787', 'content-type': 'application/json', 'x-dashboard': '1' };
  assert.equal(requestAllowed('GET', own, 8787), true, 'the page itself');
  assert.equal(requestAllowed('GET', own, 8787, '/api/summary'), false, 'an API read without the header (an <img> on another site)');
  assert.equal(requestAllowed('GET', { ...own, 'x-dashboard': '1' }, 8787, '/api/summary'), true);
  assert.equal(requestAllowed('GET', { host: 'evil.example:8787' }, 8787), false, 'DNS rebinding: foreign Host');
  assert.equal(requestAllowed('POST', post, 8787), true);
  assert.equal(requestAllowed('POST', { ...post, origin: 'https://evil.example' }, 8787), false, 'cross-site origin');
  assert.equal(requestAllowed('POST', { ...post, 'content-type': 'text/plain' }, 8787), false, 'preflight-free body');
  const { ['x-dashboard']: _drop, ...noHeader } = post;
  assert.equal(requestAllowed('POST', noHeader, 8787), false, 'missing custom header');
});

// ---- /api/health ----

const EXPECTED = {
  book: { maxAgeMin: 130, critical: true, what: 'hourly book agent (real paper orders)' },
  'watch-flip': { maxAgeMin: 130, critical: false, what: 'flip-entry watch tests (simulation)' },
  'watch-sol': { maxAgeMin: 130, critical: false, what: 'SOL both-sides watch test (simulation)' },
};
const NOW = Date.parse('2026-10-11T04:00:00Z');

function hb(p: Partial<ScanStats>): ScanStats {
  const at = p.at ?? iso(NOW);
  return { label: 'book', at, startedAt: at, interval: '1d', execution: 'alpaca-paper', symbols: 56, failures: [], entries: [], partials: [], unfilled: [], unknown: [], rejects: [], spreadSkips: [], exits: [], exitFailures: [], orphans: [], swept: 0, adopted: 0, exitsAdded: 0, needsReview: [], stepFailures: [], exitsRan: true, entriesBlocked: null, attempts: {}, entryMisses: {}, lastCryptoWindowScan: new Date().toISOString(), offline: false, offlineStreak: 0, universe: [], rule: '', ...p };
}

test('health payload: expected agents first, each fresh, stale, missing or unscheduled', () => {
  const book = hb({ at: iso(NOW - 12 * 60_000), startedAt: iso(NOW - 12 * 60_000 - 20_000), exits: ['PAXGUSDT +0.61%'], rejects: ['XRPUSDT: HTTP 403'] });
  const flip = hb({ label: 'watch-flip', execution: 'sim', symbols: 4, at: iso(NOW - 200 * 60_000) });
  const manual = hb({ label: 'tsmom-state-1d-alpaca-paper-56sym', at: iso(NOW - 5 * 60_000) });
  // An older heartbeat written before `unknown` and `orphans` existed.
  const { unknown: _u, orphans: _o, ...legacy } = hb({ label: 'zz-legacy', execution: 'sim' });
  const h = P.shapeHealth({
    nowMs: NOW,
    expected: EXPECTED,
    heartbeats: [manual, flip, book, legacy as unknown as ScanStats],
    report: { problems: [], warnings: ['a warning'], info: ['a note'], notices: [], newFlows: [], seenFlows: [], cashGap: null },
    monitor: { month: '2026-09', status: 'ok', trailing12: '1.185' },
    broker: { positions: 28, openOrders: 0, equity: 105305.58 },
    brokerChecked: true,
    brokerError: null,
  });
  assert.deepEqual(h.agents.map((a) => a.label), ['book', 'watch-flip', 'watch-sol', 'tsmom-state-1d-alpaca-paper-56sym', 'zz-legacy']);
  assert.deepEqual(h.agents.map((a) => a.state), ['fresh', 'stale', 'missing', 'unscheduled', 'unscheduled']);
  const [b, f, sol, m, old] = h.agents;
  assert.equal(Math.round(b.ageMin as number), 12);
  assert.equal(b.durationSec, 20);
  assert.equal(b.critical, true);
  assert.deepEqual(b.last?.exits, ['PAXGUSDT +0.61%']);
  assert.deepEqual(b.last?.rejects, ['XRPUSDT: HTTP 403']);
  assert.equal(Math.round(f.ageMin as number), 200);
  assert.equal(sol.last, null);
  assert.equal(sol.at, null);
  assert.equal(sol.what, 'SOL both-sides watch test (simulation)');
  assert.equal(m.critical, true, 'an unscheduled run that placed paper orders counts as critical');
  assert.equal(m.maxAgeMin, null);
  assert.deepEqual(old.last?.unknown, [], 'missing lists read as empty');
  assert.equal(h.status, 'warning');
  assert.equal(h.asOf, iso(NOW));
});

test('health payload: status follows evaluateHealth (a stale book is a problem)', () => {
  const heartbeats = [hb({ at: iso(NOW - 3 * 3_600_000) }), hb({ label: 'watch-flip', execution: 'sim' }), hb({ label: 'watch-sol', execution: 'sim' })];
  const monitor = { month: '2026-09', status: 'ok', trailing12: '1.185' };
  const healthRunTimes = [5, 4, 3, 2, 1].map((i) => NOW - i * 30 * 60_000);
  const report = evaluateHealth({ nowMs: NOW, heartbeats, rows: [], monitor, healthRunTimes });
  const h = P.shapeHealth({ nowMs: NOW, expected: EXPECTED, heartbeats, report, monitor, broker: null, brokerChecked: false, brokerError: null });
  assert.equal(h.status, 'problem');
  assert.match(h.problems.join(' | '), /\[book\] has not run while health ran 5 times/);
  assert.equal(h.agents[0].state, 'stale');
  assert.equal(h.broker, null);
});

// ---- /api/report ----

const AAPL_BUY = 'bot-AAPL-1785110400000';

function bookFixture(): { attributions: ReturnType<typeof attributeTrips>; trips: ReturnType<typeof buildRoundTrips>['trips'] } {
  const orders = [
    ...dotOrders,
    // A closed stock trip: +5% gross, +$100 cash.
    order({ id: 'a1', client_order_id: AAPL_BUY, symbol: 'AAPL', side: 'buy', filled_qty: '10', filled_avg_price: '200', filled_at: iso(t0 + 2 * DAY), submitted_at: iso(t0 + 2 * DAY) }),
    order({ id: 'a2', client_order_id: 'uuid-a', symbol: 'AAPL', side: 'sell', filled_qty: '10', filled_avg_price: '210', filled_at: iso(t0 + 9 * DAY), submitted_at: iso(t0 + 9 * DAY) }),
    // A manual probe trip (non-bot buy): reported, excluded from every statistic.
    order({ id: 's1', client_order_id: 'smoke-test-1', symbol: 'SPY', side: 'buy', filled_qty: '1', filled_avg_price: '500', filled_at: iso(t0 + DAY), submitted_at: iso(t0 + DAY) }),
    order({ id: 's2', client_order_id: 'uuid-s', symbol: 'SPY', side: 'sell', filled_qty: '1', filled_avg_price: '490', filled_at: iso(t0 + 1.5 * DAY), submitted_at: iso(t0 + 1.5 * DAY) }),
    // An open crypto trip.
    fill('buy', 0.5, 4000, t0 + 70 * DAY, 'bot-ETHUSDT-1791158400000'),
  ].map((o) => (o.client_order_id === 'bot-ETHUSDT-1791158400000' ? { ...o, symbol: 'ETH/USD' } : o));
  const { trips } = buildRoundTrips(ordersToFills(orders));
  const rows = [
    // DOT trip 1: model scored (pnl is net of the 30 bps fee), exit priced at 0.75.
    row({ timestamp: iso(t0), symbol: 'DOTUSDT', price: '0.82', outcome: 'loss', pnl: '-9.3000', reason: '[tsmom28-1d-state-long] entry || broker fill 0.82663, order bot-DOTUSDT-1785110400000 || model: state exit 2026-07-28 at 0.75' }),
    // DOT trip 2: model scored, no model exit price.
    row({ timestamp: iso(t0 + 9 * DAY), symbol: 'DOTUSDT', price: '0.866892', outcome: 'loss', pnl: '-6.0000', reason: '[tsmom28-1d-state-long] entry || order bot-DOTUSDT-1785888000000' }),
    // DOT trip 3: never scored (still open in the ledger's eyes).
    row({ timestamp: iso(t0 + 54 * DAY), symbol: 'DOTUSDT', price: '1.14', outcome: 'open', pnl: '', reason: '[tsmom28-1d-state-long] entry || order bot-DOTUSDT-1789776000000' }),
    row({ timestamp: iso(t0 + 2 * DAY), symbol: 'AAPL', price: '200', outcome: 'win', pnl: '4.7000', reason: `[tsmom28-1d-state-long] entry || order ${AAPL_BUY}` }),
  ];
  return { attributions: attributeTrips(trips, rows, 30), trips };
}

test('report payload: broker-truth sleeves, model-vs-actual gap, fees and per-symbol rows', () => {
  const { attributions, trips } = bookFixture();
  const findings: Finding[] = [
    { kind: 'manual-trip', botSymbol: 'SPY', detail: 'trip includes a non-bot buy' },
    { kind: 'missing-exit-row', botSymbol: 'AAPL', detail: 'closed with no exit row' },
  ];
  const r = P.shapeReport({
    asOfMs: NOW,
    bookStart: '2026-07-14',
    feeBps: 30,
    attributions,
    positions: [{ symbol: 'ETHUSD', qty: '0.5', avg_entry_price: '4000', market_value: '2100', unrealized_pl: '100', current_price: '4200' }],
    unmatchedSells: 2,
    fees: { usd: 12.5, inCoin: 3 },
    findings,
  });
  const closedDot = trips.filter((t) => t.botSymbol === 'DOTUSDT' && !t.open);
  assert.equal(closedDot.length, 3);

  assert.equal(r.sleeves.all.trips, 4, '3 DOT + 1 AAPL; the manual SPY trip and the open ETH trip are out');
  assert.equal(r.sleeves.crypto.trips, 3);
  assert.equal(r.sleeves.stocks.trips, 1);
  assert.equal(r.sleeves.stocks.wins, 1);
  assert.equal(r.sleeves.stocks.winRatePct, 100);
  assert.ok(Math.abs((r.sleeves.stocks.meanGrossPct as number) - 5) < 1e-9);
  assert.ok(Math.abs(r.sleeves.stocks.cashPnlUsd - 100) < 1e-9);
  assert.equal(r.sleeves.crypto.wins, 1, 'only DOT trip 3 made money');
  const dotCash = closedDot.reduce((s, t) => s + (t.cashPnlUsd as number), 0);
  assert.ok(Math.abs(r.sleeves.crypto.cashPnlUsd - dotCash) < 1e-9);
  assert.ok(Math.abs(r.sleeves.all.cashPnlUsd - (dotCash + 100)) < 1e-9);

  // Gap: actual minus model (model gross = ledger pnl + 0.30), on the 3 trips with a score.
  assert.equal(r.gap.tripsWithModel, 3);
  const scored = attributions.filter((a) => !a.trip.open && !a.trip.manual && a.modelGrossPct != null);
  const gaps = scored.map((a) => (a.trip.grossPct as number) - (a.modelGrossPct as number));
  assert.ok(Math.abs((r.gap.gapMeanPct as number) - gaps.reduce((a, b) => a + b, 0) / gaps.length) < 1e-9);
  assert.equal(r.gap.entrySlip.trips, 4, 'every closed trip with an entry row has an entry slippage');
  assert.equal(r.gap.exitSlip.trips, 1, 'only DOT trip 1 recorded the model exit close');
  assert.ok(Math.abs((r.gap.exitSlip.meanBps as number) - (0.754711 / 0.75 - 1) * 10_000) < 1e-6);

  assert.deepEqual(r.fees, { usd: 12.5, inCoinCount: 3 });
  assert.equal(r.feesError, null);
  assert.deepEqual(r.open, { positions: 1, deployedUsd: 2100, openTrips: 1 });
  assert.deepEqual(r.excluded, { manualTrips: 1, unmatchedSells: 2 });
  assert.equal(r.reconcile?.attention, 1, 'manual trips are reported, not counted as needing attention');
  assert.deepEqual(r.reconcile?.byKind, { 'manual-trip': 1, 'missing-exit-row': 1 });
  assert.match(r.reconcile?.details[0] ?? '', /^missing-exit-row AAPL: /);

  assert.deepEqual(r.symbols.map((s) => s.symbol), ['DOTUSDT', 'AAPL'], 'sorted by trip count');
  const dot = r.symbols[0];
  assert.equal(dot.sleeve, 'crypto');
  assert.equal(dot.trips, 3);
  assert.equal(dot.wins, 1);
  assert.equal(dot.modelScored, 2);
  assert.equal(dot.lastClosedAt, iso(t0 + 72 * DAY));
  assert.equal(r.symbols[1].sleeve, 'stocks');
  assert.equal(r.asOf, iso(NOW));
});

test('report payload: an empty book has nulls where a statistic does not exist', () => {
  const r = P.shapeReport({ asOfMs: NOW, bookStart: '2026-07-14', feeBps: 30, attributions: [], positions: [], unmatchedSells: 0, fees: null, feesError: 'HTTP 500' });
  assert.equal(r.sleeves.all.trips, 0);
  assert.equal(r.sleeves.all.winRatePct, null);
  assert.equal(r.sleeves.all.meanGrossPct, null);
  assert.equal(r.gap.gapMeanPct, null);
  assert.equal(r.fees, null);
  assert.equal(r.feesError, 'HTTP 500');
  assert.equal(r.reconcile, null);
  assert.deepEqual(r.symbols, []);
  assert.equal(JSON.stringify(r).includes('NaN'), false);
});

// ---- gate 2 ----

test('gate 2 counts broker round trips that carry a model score', () => {
  const sleeves = (n: number) => ({ all: { trips: n, wins: 0, winRatePct: null, meanGrossPct: null, medianGrossPct: null, cashPnlUsd: 0 }, crypto: { trips: 0, wins: 0, winRatePct: null, meanGrossPct: null, medianGrossPct: null, cashPnlUsd: 0 }, stocks: { trips: 0, wins: 0, winRatePct: null, meanGrossPct: null, medianGrossPct: null, cashPnlUsd: 0 } });
  const gap = (n: number, mean: number | null) => ({ tripsWithModel: n, modelMeanPct: null, actualMeanPct: null, gapMeanPct: mean, gapMedianPct: mean, entrySlip: { trips: 0, meanBps: null, medianBps: null }, exitSlip: { trips: 0, meanBps: null, medianBps: null } });

  const none = P.tripsGate(null, 'HTTP 401', 109);
  assert.equal(none.done, false);
  assert.match(none.progress, /broker truth unavailable \(HTTP 401\); the ledger records 109 exits/);

  assert.equal(P.tripsGate({ sleeves: sleeves(9), gap: gap(9, -0.1) }, null, 0).done, false);
  const unscored = P.tripsGate({ sleeves: sleeves(12), gap: gap(0, null) }, null, 0);
  assert.equal(unscored.done, false, 'trips without a model score do not measure the gap');
  assert.match(unscored.progress, /gap not measured yet/);

  const met = P.tripsGate({ sleeves: sleeves(108), gap: gap(108, -0.05) }, null, 0);
  assert.equal(met.done, true);
  assert.equal(met.id, 'trips');
  assert.match(met.progress, /^108\/10 broker round trips with a model score \(108 closed\) · gap -0\.05% mean/);
});

// ---- /api/perf ----

test('perf payload: absent or malformed perf.json is a missing state, never a crash', () => {
  assert.equal(P.shapePerf(null, NOW).missing, true);
  assert.equal(P.shapePerf([1, 2], NOW).missing, true);
  assert.equal(P.shapePerf('text', NOW).missing, true);
});

test('perf payload: normalizes the published shape and derives the underwater curve', () => {
  const perf = P.shapePerf(
    {
      generatedAt: iso(NOW - 90 * 60_000),
      bookStart: '2026-07-15',
      equity: {
        start: 100000, end: 103000, returnPct: 3, maxDrawdownPct: -2.9412, maxDrawdownPeak: '2026-07-17', maxDrawdownTrough: '2026-07-20',
        annVolPct: 12.5, sharpe: null, bestDay: { date: '2026-07-21', pct: 4.04 }, worstDay: { date: '2026-07-20', pct: -2.94 },
        excludedPoints: [{ date: '2026-07-18', equity: 75118.07, reason: 'one-day outlier' }, { date: '' }],
      },
      // Out of order, with a zero point that must not reach the chart.
      curve: [
        { date: '2026-07-21', equity: 103000 },
        { date: '2026-07-15', equity: 100000 },
        { date: '2026-07-17', equity: 102000 },
        { date: '2026-07-19', equity: 0 },
        { date: '2026-07-20', equity: 99000 },
      ],
      benchmarks: [{ name: 'BTC buy-and-hold', returnPct: 4.5, excessPct: -1.5, note: 'Binance close' }, { name: '' }],
      realized: { all: { trips: 108, winRatePct: 34.26, meanGrossPct: -0.93, cashPnlUsd: -1900 }, crypto: {}, stocks: { trips: 66 } },
      unrealized: { all: 512.3, crypto: 600, stocks: -87.7 },
      fees: { usd: 198.8, inCoinCount: 131 },
    },
    NOW
  );
  assert.equal(perf.missing, false);
  if (perf.missing) return;
  assert.equal(perf.ageMin, 90);
  assert.deepEqual(perf.curve.map((c) => c.date), ['2026-07-15', '2026-07-17', '2026-07-20', '2026-07-21']);
  assert.deepEqual(perf.drawdown.map((d) => Number(d.pct.toFixed(4))), [0, 0, -2.9412, 0]);
  assert.equal(perf.equity.sharpe, null, 'an undefined Sharpe stays null, not 0');
  assert.deepEqual(perf.equity.excludedPoints, [{ date: '2026-07-18', equity: 75118.07, reason: 'one-day outlier' }]);
  assert.deepEqual(perf.benchmarks, [{ name: 'BTC buy-and-hold', returnPct: 4.5, excessPct: -1.5, note: 'Binance close' }]);
  assert.deepEqual(perf.realized.crypto, { trips: null, winRatePct: null, meanGrossPct: null, cashPnlUsd: null });
  assert.equal(perf.realized.stocks.trips, 66);
  assert.equal(perf.unrealized.stocks, -87.7);
  assert.deepEqual(perf.execution, { tripsWithModel: null, gapMeanPct: null, gapMedianPct: null, entrySlipMeanBps: null, exitSlipMeanBps: null }, 'a section the writer left out reads as nulls');
});

test('perf payload: the curve is valued net of cash flows, drawdown follows the values, and an older perf.json still reads', () => {
  const at = (d: string): number => Date.parse(`${d}T00:00:00Z`);
  const perf = P.shapePerf(
    {
      generatedAt: iso(NOW),
      bookStart: '2026-07-15',
      equity: {
        start: 100000, end: 36969.47, returnPct: 0.8136, netFlowsUsd: -66905.32,
        cashFlows: [
          { date: '2026-10-14', type: 'JNLC', amountUsd: -66905.32, bookPnlUsd: 2045.48, note: 'Equity moved -$64,859.84.' },
          { date: '2026-09-09', countedOn: '2026-09-10', type: 'CSD', amountUsd: 1000, bookPnlUsd: 167.76, note: 'Booked in the 2026-09-09 point, which is left out.' },
          { type: 'JNLC' },
        ],
      },
      curve: [
        { date: '2026-10-13', equity: 103601.89, value: 103601.89 },
        { date: '2026-10-14', equity: 38742.05, value: 105647.37 },
        { date: '2026-10-15', equity: 36180.12, value: 98661.13 },
      ],
    },
    NOW
  );
  assert.equal(perf.missing, false);
  if (perf.missing) return;
  assert.deepEqual(perf.curve.map((c) => c.value), [103601.89, 105647.37, 98661.13]);
  assert.deepEqual(perf.drawdown.map((d) => Number(d.pct.toFixed(4))), [0, 0, -6.6128], 'from the values: no -62.6% cliff');
  assert.equal(perf.equity.netFlowsUsd, -66905.32);
  assert.deepEqual(perf.equity.cashFlows, [
    { date: '2026-10-14', countedOn: '2026-10-14', type: 'JNLC', amountUsd: -66905.32, bookPnlUsd: 2045.48, note: 'Equity moved -$64,859.84.' },
    { date: '2026-09-09', countedOn: '2026-09-10', type: 'CSD', amountUsd: 1000, bookPnlUsd: 167.76, note: 'Booked in the 2026-09-09 point, which is left out.' },
  ], 'a flow with no countedOn (an older perf.json) counts on its own date');
  // A perf.json written before flows were netted has no value: the equity stands in, and no flows are listed.
  const old = P.shapePerf({ curve: [{ date: '2026-10-13', equity: 103601.89 }] }, NOW);
  assert.ok(!old.missing && old.curve[0].value === 103601.89 && old.equity.cashFlows.length === 0 && old.equity.netFlowsUsd === null);

  // The 30-day fallback chart: the broker's own history, valued the same way.
  const live = P.shapeLiveEquity({
    timestamp: ['2026-10-13', '2026-10-14', '2026-10-15'].map((d) => at(d) / 1000),
    equity: [103601.89, 38742.05, 36180.12],
    profit_loss_pct: [0, -0.626, -0.0661],
    cashflow: { JNLC: [0, -66905.32, 0], CFEE: [-9.77, -12.53, 0] },
  });
  assert.deepEqual(live.flows, [{ date: '2026-10-14', countedOn: '2026-10-14', type: 'JNLC', amountUsd: -66905.32 }]);
  // Booked a point early, it counts where the equity steps, as in perf.json.
  const early = P.shapeLiveEquity({
    timestamp: ['2026-10-13', '2026-10-14', '2026-10-15'].map((d) => at(d) / 1000),
    equity: [103601.89, 103000, 36500],
    profit_loss_pct: [0, 0, 0],
    cashflow: { JNLC: [0, -66905.32, 0] },
  });
  assert.deepEqual(early.flows.map((f) => [f.date, f.countedOn]), [['2026-10-14', '2026-10-15']]);
  assert.ok(early.points.every((p, i) => i === 0 || Math.abs(p.value / early.points[i - 1].value - 1) < 0.05), 'no false step in the values');
  assert.deepEqual(live.points.map((p) => Number(p.value.toFixed(2))), [103601.89, 106622.82, 99572.07]);
  assert.deepEqual(live.points.map((p) => p.equity), [103601.89, 38742.05, 36180.12], 'broker equity rides along for the tooltip');
  const before = P.shapeLiveEquity({ timestamp: [at('2026-10-14') / 1000, at('2026-10-15') / 1000], equity: [38742.05, 36180.12], profit_loss_pct: [0, 0], cashflow: { JNLC: [-66905.32, 0] } });
  assert.deepEqual(before.flows, [], 'a flow at the first point is its capital');
});

test('underwater: percent below the running peak', () => {
  const dd = P.underwater([
    { date: 'a', equity: 100 },
    { date: 'b', equity: 80 },
    { date: 'c', equity: 90 },
    { date: 'd', equity: 120 },
    { date: 'e', equity: 108 },
  ]);
  assert.deepEqual(dd.map((d) => Number(d.pct.toFixed(6))), [0, -20, -10, 0, -10]);
});

// ---- activity feed ----

test('activity feed drops the retired 5-minute scanner rows only', () => {
  assert.equal(P.tagIntervalOf('[bullish-cross-9/21-5m] Memory blocked this entry'), '5m');
  assert.equal(P.isRetiredScannerRow({ reason: '[bearish-cross-9/21-5m] Buying 0.001 would push the paper position' }), true);
  assert.equal(P.isRetiredScannerRow({ reason: '[tsmom28-1d-state-long] Entry: momentum positive' }), false);
  assert.equal(P.isRetiredScannerRow({ reason: '[actual:tsmom28-1d-state-long] Exit: momentum flipped' }), false);
  assert.equal(P.isRetiredScannerRow({ reason: 'no tag at all' }), false);
});

// ---- caches ----

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('swr cache: one load per TTL, stale served while revalidating, failures back off', async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const c = P.swrCache(
    async () => {
      calls++;
      if (fail) throw new Error('broker down\nstack line');
      return calls;
    },
    { ttlMs: 100, retryMs: 50, staleWhileRevalidate: true, now: () => now }
  );
  let r = await c.get();
  assert.deepEqual([r.value, r.at, calls], [1, 0, 1], 'a cold cache waits for the first load');
  now = 60;
  r = await c.get();
  assert.deepEqual([r.value, calls], [1, 1], 'fresh within the TTL');
  now = 150;
  r = await c.get();
  assert.deepEqual([r.value, r.refreshing, calls], [1, true, 2], 'expired: the stale value comes back at once while a reload runs');
  await tick();
  r = await c.get();
  assert.deepEqual([r.value, r.at, calls], [2, 150, 2]);

  fail = true;
  c.invalidate();
  now = 300;
  r = await c.get();
  assert.equal(r.value, 2, 'a failing refresh keeps the last good value');
  await tick();
  r = await c.get();
  assert.deepEqual([r.value, r.error, calls], [2, 'broker down', 3], 'the error keeps its first line only');
  now = 320;
  await c.get();
  assert.equal(calls, 3, 'no retry inside the back-off window');
  now = 360;
  fail = false;
  await c.get();
  await tick();
  r = await c.get();
  assert.deepEqual([r.value, r.error, calls], [4, null, 4], 'retried after the window, error cleared');
});

test('swr cache: concurrent cold reads share one load; a non-SWR cache waits for fresh data', async () => {
  let calls = 0;
  let release: (v: number) => void = () => {};
  const slow = P.swrCache(() => { calls++; return new Promise<number>((r) => (release = r)); }, { ttlMs: 1000, retryMs: 1000, staleWhileRevalidate: false });
  const a = slow.get();
  const b = slow.get();
  await tick();
  release(7);
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.value, rb.value, calls], [7, 7, 1]);

  let now = 0;
  let n = 0;
  const strict = P.swrCache(async () => ++n, { ttlMs: 10, retryMs: 10, staleWhileRevalidate: false, now: () => now });
  assert.equal((await strict.get()).value, 1);
  now = 20;
  assert.equal((await strict.get()).value, 2, 'expired: waits for the reload instead of serving stale data');
  const down = P.swrCache(async () => { throw new Error('no keys'); }, { ttlMs: 10, retryMs: 10, staleWhileRevalidate: false });
  const d = await down.get();
  assert.deepEqual([d.value, d.error], [null, 'no keys']);
});

test('swr cache: a load that started before invalidate() is not trusted as fresh', async () => {
  let now = 0;
  let calls = 0;
  let release: (v: number) => void = () => {};
  const c = P.swrCache(() => { calls++; return new Promise<number>((r) => (release = r)); }, { ttlMs: 1000, retryMs: 1000, staleWhileRevalidate: true, now: () => now });
  const first = c.get();
  await tick();
  c.invalidate(); // e.g. a manual close landed while broker truth was loading
  release(1);
  assert.equal((await first).value, 1);
  now = 5;
  const r = await c.get();
  assert.equal(r.value, 1, 'served while the reload runs');
  assert.equal(calls, 2, 'the pre-invalidation load did not count as fresh');
});

// ---- commands and gate 1 ----

test('scan-book runs the hourly agent\'s exact settings (fails if the plist drifts)', async () => {
  const { BOOK_ENV, COMMANDS, isCommand, plistRunEnv } = await import('../src/dashboard/commands.ts');
  const plist = fs.readFileSync(new URL('../ops/launchd/com.jalenedusei.trading.tsmom-daily.plist', import.meta.url), 'utf8');
  const agentEnv = plistRunEnv(plist, 'book');
  assert.ok(agentEnv, 'the plist has a RUN_LABEL=book run');
  assert.deepEqual({ ...BOOK_ENV }, agentEnv, 'BOOK_ENV in src/dashboard/commands.ts must match the book run in the plist');
  assert.equal(COMMANDS['scan-book'].env, BOOK_ENV);
  assert.equal(BOOK_ENV.SYMBOLS, '@book');
  assert.equal(BOOK_ENV.RUN_LABEL, 'book');
  assert.deepEqual(plistRunEnv(plist, 'watch-sol'), { RUN_LABEL: 'watch-sol', EXECUTION: 'sim', TSMOM_STATE: 'off', SYMBOLS: 'SOLUSDT', LONG_ONLY: 'off', STRATEGY: 'tsmom', INTERVAL: '1d', TSMOM_LOOKBACK: '28', EVAL_HORIZON: '28', FEE_BPS: '30' });
  assert.equal(plistRunEnv(plist, 'scan-5m'), null);
  for (const name of ['scan-book', 'score-daily', 'monitor']) assert.equal(isCommand(name), true);
  for (const name of ['constructor', '__proto__', 'toString', '', undefined, 42]) assert.equal(isCommand(name), false, String(name));
});

test('gate 1 counts days since the clock last restarted', () => {
  const start = '2026-10-11';
  assert.deepEqual(P.opsGate(Date.parse('2026-10-11T04:00:00Z'), start), { id: 'ops', label: '≥ 4 weeks clean operations', progress: '0/28 days since 2026-10-11 (the clock restarts after an incident)', done: false });
  assert.equal(P.opsGate(Date.parse('2026-11-07T23:59:00Z'), start).done, false, '27 days');
  const met = P.opsGate(Date.parse('2026-11-08T00:00:00Z'), start);
  assert.equal(met.done, true);
  assert.match(met.progress, /^28\/28 days/);
  assert.equal(P.opsGate(Date.parse('2026-10-01T00:00:00Z'), start).progress.startsWith('0/28'), true, 'never negative');
  assert.equal(P.OPS_CLOCK_START, '2026-10-11');
});
