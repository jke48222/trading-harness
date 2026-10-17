import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RoundTrip } from '../src/broker/fills.ts';
import type { BrokerPosition, PortfolioHistory } from '../src/broker/orders.ts';
import type { TripAttribution } from '../src/report.ts';
import type { Candle } from '../src/types.ts';

// Account performance: the glitch filter, drawdown, risk, benchmarks and sleeves. Pure helpers, no network.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-perf-'));
process.env.EXECUTION = 'sim';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const perf = await import('../src/perf.ts');
const DAY = 86_400_000;
const at = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const pt = (date: string, equity: number) => ({ t: at(date), date, equity });
/** A day's return net of a flow taken at mid-day (src/cashflows.ts periodReturn). */
const dietz = (start: number, end: number, flow: number): number => (end - start - flow) / (start + flow / 2);
const near = (actual: number | null, expected: number, eps = 1e-9): void => {
  assert.ok(actual != null && Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
};

/** The account's real daily history around its known features, as Alpaca returns it (seconds, nulls allowed). */
function history(rows: [string, number | null][]): PortfolioHistory {
  return { timestamp: rows.map(([d]) => at(d) / 1000), equity: rows.map(([, e]) => e), profit_loss_pct: rows.map(() => 0) };
}
const REAL: [string, number | null][] = [
  ['2026-07-10', 0], // before funding
  ['2026-07-14', 100000],
  ['2026-07-15', 100000],
  ['2026-07-22', 100336.07],
  ['2026-08-01', null],
  ['2026-08-19', 96344.68],
  ['2026-08-22', 100102.43],
  ['2026-09-04', 100720.48],
  ['2026-09-05', 99750.9],
  ['2026-09-09', 75118.07], // the bogus point
  ['2026-09-10', 99918.66],
  ['2026-10-10', 105305.58],
  ['2026-10-13', 105000], // stamped after "now": a day still in progress
];
const NOW = Date.parse('2026-10-11T12:00:00Z');

test('findGlitches drops the 2026-09-09 point and keeps a real two-day drop', () => {
  const sept = [pt('2026-09-04', 100720.48), pt('2026-09-05', 99750.9), pt('2026-09-09', 75118.07), pt('2026-09-10', 99918.66), pt('2026-09-11', 98861.87)];
  const { kept, glitches } = perf.findGlitches(sept);
  assert.deepEqual(glitches.map((g) => g.date), ['2026-09-09']);
  assert.equal(glitches[0].equity, 75118.07);
  assert.match(glitches[0].reason, /-24\.69% vs 2026-09-05 and -24\.82% vs 2026-09-10, which agree within 0\.17%/);
  assert.deepEqual(kept.map((p) => p.date), ['2026-09-04', '2026-09-05', '2026-09-10', '2026-09-11']);

  const twoDay = [pt('2026-01-05', 100000), pt('2026-01-06', 88000), pt('2026-01-07', 87500), pt('2026-01-08', 99000)];
  assert.equal(perf.findGlitches(twoDay).glitches.length, 0, 'a fall that lasts two days is a move, even when it recovers');
  const crash = [pt('2026-01-05', 100000), pt('2026-01-06', 75000), pt('2026-01-07', 60000)];
  assert.equal(perf.findGlitches(crash).glitches.length, 0, 'neighbors 40% apart: the middle point is on the way down');
  const small = [pt('2026-01-05', 100000), pt('2026-01-06', 91000), pt('2026-01-07', 100500)];
  assert.equal(perf.findGlitches(small).glitches.length, 0, '9% from both neighbors is under the 10% bar');
  const ends = [pt('2026-01-05', 50000), pt('2026-01-06', 100000), pt('2026-01-07', 100000), pt('2026-01-08', 50000)];
  assert.equal(perf.findGlitches(ends).glitches.length, 0, 'the first and last points have one neighbor and are never judged');
});

test('maxDrawdown measures from the running peak and names the peak and trough', () => {
  const dd = perf.maxDrawdown([
    pt('2026-07-15', 100000),
    pt('2026-07-22', 110000),
    pt('2026-07-28', 99000),
    pt('2026-08-19', 88000),
    pt('2026-09-04', 105000),
    pt('2026-09-23', 120000),
    pt('2026-10-09', 102000), // -15% from the later, higher peak: smaller
  ]);
  near(dd.pct, -20);
  assert.equal(dd.peak, '2026-07-22');
  assert.equal(dd.trough, '2026-08-19');
  assert.deepEqual(perf.maxDrawdown([pt('2026-07-15', 1), pt('2026-07-16', 2)]), { pct: 0, peak: '2026-07-15', trough: '2026-07-15' });
});

test('analyzeEquity on the real history: the glitch, the null and the open day are excluded and listed', () => {
  assert.equal(perf.coversStart(history(REAL)), true);
  assert.equal(perf.coversStart(history(REAL.slice(3))), false, 'a history that starts after 2026-07-15 must be widened');
  const s = perf.analyzeEquity(perf.historyPoints(history(REAL)), perf.PERF_START_DATE, NOW);
  assert.equal(s.bookStart, '2026-07-15');
  assert.equal(s.start.equity, 100000);
  assert.equal(s.end.date, '2026-10-10');
  near(s.returnPct, 5.30558);
  assert.deepEqual(
    s.excluded.map((x) => [x.date, x.equity]),
    [['2026-08-01', 0], ['2026-09-09', 75118.07], ['2026-10-13', 105000]]
  );
  assert.match(s.excluded[0].reason, /no equity value/);
  assert.match(s.excluded[1].reason, /one-day outlier/);
  assert.match(s.excluded[2].reason, /still in progress/);
  assert.ok(!s.curve.some((p) => p.date === '2026-07-14' || p.date === '2026-09-09'), 'curve = the window, glitch removed');
  // The real worst drawdown runs from the 2026-07-22 high, not from the 100,000 start.
  near(s.drawdown.pct, -3.9780210646081837);
  assert.equal(s.drawdown.peak, '2026-07-22');
  assert.equal(s.drawdown.trough, '2026-08-19');
  near(s.unfilteredDrawdownPct, -25.4192692489154, 1e-9);
  assert.equal(s.best.date, '2026-10-10');
  assert.equal(s.worst.date, '2026-08-19');
  near(s.best.pct, (105305.58 / 99918.66 - 1) * 100, 1e-12);
  assert.equal(s.returns, s.curve.length - 1);
  // The return across the excluded point spans it: 09-05 to 09-10, +0.17%.
  assert.ok(perf.dailyMoves(s.curve).some((m) => m.date === '2026-09-10' && Math.abs(m.pct - 0.168178933723917) < 1e-9));
});

test('riskStats: sample sd of daily returns, rf 0, scaled by sqrt(252)', () => {
  assert.equal(perf.POINTS_PER_YEAR, 252, 'one history point per US trading day');
  // Returns +1%, -1%, +2%, 0: mean 0.5%, sample variance 0.0005/3.
  const curve = [pt('2026-01-05', 100), pt('2026-01-06', 101), pt('2026-01-07', 99.99), pt('2026-01-08', 101.9898), pt('2026-01-09', 101.9898)];
  const r = perf.riskStats(perf.dailyMoves(curve).map((m) => m.pct / 100));
  near(r.annVolPct, Math.sqrt(0.042) * 100, 1e-9); // sqrt(var x 252) = sqrt(0.042)
  near(r.sharpe, Math.sqrt(37.8), 1e-9); // mean/sd = sqrt(0.15); x sqrt(252) = sqrt(37.8) = 6.148
  near(perf.riskStats([0.01, -0.01, 0.02, 0], 365).sharpe, Math.sqrt(0.15 * 365), 1e-9);
  assert.equal(perf.riskStats([0, 0, 0]).sharpe, null, 'no variation: Sharpe undefined');
  assert.equal(perf.riskStats([0.01]).sharpe, null, 'one return: Sharpe undefined');
});

const binance = (date: string, close: number): Candle => ({ openTime: at(date), open: close, high: close, low: close, close, volume: 1, closeTime: at(date) + DAY - 1 });
const alpaca = (date: string, close: number): Candle => {
  const open = Date.parse(`${date}T04:00:00Z`); // 00:00 New York in summer
  return { openTime: open, open: close, high: close, low: close, close, volume: 1, closeTime: open + DAY - 1 };
};

test('closeAsOf prices a stamp at that moment: the candle ending at 00:00 UTC, the session before it', () => {
  const t0 = at('2026-07-15');
  const btc = [binance('2026-07-13', 64000), binance('2026-07-14', 65043.98), binance('2026-07-15', 66000)];
  assert.equal(perf.closeAsOf(btc, t0, true)?.close, 65043.98, 'the 07-14 candle closes at 2026-07-15 00:00 UTC; the 07-15 candle has not');
  const spy = [alpaca('2026-07-13', 745), alpaca('2026-07-14', 749.97), alpaca('2026-07-15', 752)];
  assert.equal(perf.closeAsOf(spy, t0, false)?.close, 749.97, 'the 07-14 session closed at 20:00 UTC, before the stamp');
  assert.equal(perf.closeAsOf([binance('2026-07-12', 63000)], t0, true), null, 'a crypto close two days old is stale');
  // Winter stamps fall at 01:00 UTC, and an early-close day's at 22:00 UTC: both take that day's 00:00 close.
  assert.equal(perf.closeAsOf(btc, Date.parse('2026-07-15T01:00:00Z'), true)?.close, 65043.98);
  assert.equal(perf.closeAsOf(btc, Date.parse('2026-07-15T22:00:00Z'), true)?.close, 65043.98, 'an early-close stamp still has a benchmark price');
  assert.equal(perf.closeAsOf([binance('2026-07-20', 1)], t0, true), null, 'listed after the stamp: no price');
  const friday = Date.parse('2026-07-18T00:00:00Z'); // the stamp after Friday 07-17
  const tuesday = Date.parse('2026-07-21T00:00:00Z'); // the stamp after Monday 07-20
  const week = [alpaca('2026-07-17', 10), alpaca('2026-07-20', 11)];
  assert.equal(perf.closeAsOf(week, friday, false)?.close, 10);
  assert.equal(perf.closeAsOf(week, tuesday, false)?.close, 11);
});

test('equalWeight: equal dollars at the start, mean of symbol returns; a symbol with no start price is listed, not used', () => {
  const t0 = at('2026-07-15');
  const t1 = at('2026-10-10');
  const legs = [
    perf.legFromCandles('AAAUSDT', [binance('2026-07-14', 100), binance('2026-10-09', 130)], t0, t1), // +30%
    perf.legFromCandles('BBB', [alpaca('2026-07-14', 50), alpaca('2026-10-09', 45)], t0, t1), // -10%
    perf.legFromCandles('NEWUSDT', [binance('2026-07-20', 1), binance('2026-10-09', 2)], t0, t1), // listed after the start
    { symbol: 'GONE', start: null, end: null, error: 'No real 1d bars returned for stock GONE (SIP feed).' },
  ];
  const ew = perf.equalWeight(legs, '2026-07-15', '2026-10-10');
  near(ew.returnPct, 10);
  assert.equal(ew.used, 2);
  assert.deepEqual(ew.excluded, [
    { symbol: 'NEWUSDT', reason: 'no price at the start (2026-07-15)' },
    { symbol: 'GONE', reason: 'no data (No real 1d bars returned for stock GONE (SIP feed).)' },
  ]);
  near(perf.legReturnPct(legs[0]), 30);
  assert.equal(perf.legReturnPct(legs[2]), null);
});

const trip = (p: Partial<RoundTrip>): RoundTrip => ({
  botSymbol: 'BTCUSDT',
  brokerSymbol: 'BTC/USD',
  entries: [],
  exits: [],
  open: false,
  entryQty: 1,
  entryVwap: 100,
  exitQty: 1,
  exitVwap: 101,
  openedAt: '2026-07-15T00:10:00Z',
  closedAt: '2026-07-20T00:10:00Z',
  grossPct: 1,
  cashPnlUsd: 20,
  manual: false,
  ...p,
});

test('sleeveStats splits closed bot trips into crypto and stocks; open and manual trips stay out', () => {
  const s = perf.sleeveStats([
    trip({ botSymbol: 'BTCUSDT', grossPct: 4, cashPnlUsd: 80 }),
    trip({ botSymbol: 'ETHUSDT', grossPct: -2, cashPnlUsd: -40 }),
    trip({ botSymbol: 'SOLUSDT', grossPct: -1, cashPnlUsd: -20 }),
    trip({ botSymbol: 'AAPL', brokerSymbol: 'AAPL', grossPct: 3, cashPnlUsd: 60 }),
    trip({ botSymbol: 'MSFT', brokerSymbol: 'MSFT', open: true, closedAt: null, exitVwap: null, grossPct: null, cashPnlUsd: null }),
    trip({ botSymbol: 'LTCUSDT', manual: true, grossPct: 50, cashPnlUsd: 1000 }),
  ]);
  assert.equal(s.all.trips, 4);
  near(s.all.winRatePct, 50);
  near(s.all.meanGrossPct, 1);
  near(s.all.cashPnlUsd, 80);
  assert.equal(s.crypto.trips, 3);
  near(s.crypto.winRatePct, 100 / 3);
  near(s.crypto.meanGrossPct, 1 / 3);
  near(s.crypto.cashPnlUsd, 20);
  assert.equal(s.stocks.trips, 1);
  near(s.stocks.winRatePct, 100);
  near(s.stocks.meanGrossPct, 3);
  near(s.stocks.cashPnlUsd, 60);

  const pos = (symbol: string, upl: string, assetClass?: string): BrokerPosition =>
    ({ symbol, qty: '1', avg_entry_price: '1', market_value: '1', unrealized_pl: upl, current_price: '1', ...(assetClass ? { asset_class: assetClass } : {}) }) as BrokerPosition;
  const u = perf.unrealizedSplit([pos('BTCUSD', '120.5', 'crypto'), pos('AAPL', '-20.25', 'us_equity'), pos('DOGEUSD', '-0.25')]);
  near(u.crypto, 120.25);
  near(u.stocks, -20.25);
  near(u.all, 100);

  // Bought 1 BTC at 100; the 0.25% fee was taken in coin, so the broker holds 0.9975 and its cost basis is 0.9975 x 100.
  const held = { ...pos('BTCUSD', '0', 'crypto'), qty: '0.9975' };
  const openBtc = trip({ open: true, entryQty: 1, entryVwap: 100, exitQty: 0, exitVwap: null, closedAt: null, grossPct: null, cashPnlUsd: null });
  near(perf.openCoinFeesUsd([held, { ...pos('AAPL', '0', 'us_equity'), qty: '3' }], [openBtc]), 0.25);
});

test('executionStats uses the same cut as npm run report: closed bot trips only', () => {
  const a = (t: Partial<RoundTrip>, model: number | null, entry: number | null, exit: number | null): TripAttribution => ({
    trip: trip(t),
    entryRow: null,
    modelGrossPct: model,
    entrySlipBps: entry,
    exitSlipBps: exit,
    ruleChanged: false,
  });
  const x = perf.executionStats([
    a({ grossPct: 1 }, 2, 10, -5), // gap -1
    a({ grossPct: -3 }, -1, 20, null), // gap -2
    a({ grossPct: 0.5 }, 0, 30, -15), // gap +0.5
    a({ grossPct: 2 }, null, null, null), // no model score
    a({ open: true, grossPct: null }, 5, 500, null), // open: out
    a({ manual: true, grossPct: 9 }, 1, 900, 900), // manual: out
  ]);
  assert.equal(x.tripsWithModel, 3);
  near(x.gapMeanPct, -2.5 / 3);
  near(x.gapMedianPct, -1);
  near(x.entrySlipMeanBps, 20);
  near(x.exitSlipMeanBps, -10);
  assert.equal(x.entrySlipTrips, 3);
  assert.equal(x.exitSlipTrips, 2);
});

test('perf.json has exactly the published shape, plain numbers, and a curve without the glitch', () => {
  const equity = perf.analyzeEquity(perf.historyPoints(history(REAL)), perf.PERF_START_DATE, NOW);
  const json = perf.buildPerfJson({
    generatedAt: '2026-10-11T12:00:00.000Z',
    equity,
    benchmarks: [{ name: 'BTC buy-and-hold', returnPct: 27.0463, note: 'n' }],
    realized: perf.sleeveStats([trip({ botSymbol: 'AAPL', grossPct: 3, cashPnlUsd: 60 })]),
    unrealized: { all: 1.234, crypto: 1, stocks: 0.234 },
    fees: { usd: 12.346, inCoin: 7 },
    execution: perf.executionStats([]),
  });
  const parsed = JSON.parse(JSON.stringify(json)) as typeof json;
  assert.deepEqual(Object.keys(parsed), ['generatedAt', 'bookStart', 'equity', 'curve', 'benchmarks', 'realized', 'unrealized', 'fees', 'execution']);
  assert.deepEqual(Object.keys(parsed.equity), [
    'start', 'end', 'returnPct', 'maxDrawdownPct', 'maxDrawdownPeak', 'maxDrawdownTrough',
    'annVolPct', 'sharpe', 'bestDay', 'worstDay', 'excludedPoints', 'netFlowsUsd', 'cashFlows',
  ]);
  assert.deepEqual(Object.keys(parsed.equity.bestDay), ['date', 'pct']);
  assert.deepEqual(Object.keys(parsed.equity.excludedPoints[0]), ['date', 'equity', 'reason']);
  assert.deepEqual(Object.keys(parsed.curve[0]), ['date', 'equity', 'value']);
  assert.deepEqual([parsed.equity.netFlowsUsd, parsed.equity.cashFlows], [0, []], 'no flow in this window');
  assert.ok(parsed.curve.every((c) => c.value === c.equity), 'with no flows, the value is the equity');
  assert.deepEqual(Object.keys(parsed.benchmarks[0]), ['name', 'returnPct', 'excessPct', 'note']);
  for (const k of ['all', 'crypto', 'stocks'] as const) assert.deepEqual(Object.keys(parsed.realized[k]), ['trips', 'winRatePct', 'meanGrossPct', 'cashPnlUsd']);
  assert.deepEqual(Object.keys(parsed.unrealized), ['all', 'crypto', 'stocks']);
  assert.deepEqual(Object.keys(parsed.fees), ['usd', 'inCoinCount']);
  assert.deepEqual(Object.keys(parsed.execution), ['tripsWithModel', 'gapMeanPct', 'gapMedianPct', 'entrySlipMeanBps', 'exitSlipMeanBps']);

  // Every leaf is a number or a string; only sharpe may be null.
  const walk = (v: unknown, at: string): void => {
    if (v === null) return assert.equal(at, '.equity.sharpe', `null at ${at}`);
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (typeof v === 'object') return Object.entries(v as object).forEach(([k, x]) => walk(x, `${at}.${k}`));
    assert.ok(typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)), `${at} is ${typeof v}`);
  };
  walk(parsed, '');

  assert.equal(parsed.bookStart, '2026-07-15');
  assert.equal(parsed.equity.returnPct, 5.3056);
  assert.equal(parsed.equity.maxDrawdownPct, -3.978);
  assert.equal(parsed.benchmarks[0].excessPct, -21.7407, 'account minus benchmark, from unrounded values');
  assert.ok(!parsed.curve.some((c) => c.date === '2026-09-09'));
  assert.equal(parsed.curve.length, equity.curve.length);
  assert.deepEqual(parsed.fees, { usd: 12.35, inCoinCount: 7 });
  assert.deepEqual(parsed.realized.crypto, { trips: 0, winRatePct: 0, meanGrossPct: 0, cashPnlUsd: 0 }, 'an empty sleeve reads 0 with trips 0');

  const text = perf.renderPerf(json, { unfilteredDrawdownPct: -25.4193, entrySlipTrips: 0, exitSlipTrips: 0, openPositions: 3, openCoinFeesUsd: 49.46, outPath: 'data/perf.json' });
  const wide = text.filter((l) => l.length > 72);
  assert.deepEqual(wide, [], 'short lines');
  assert.ok(!text.join('\n').includes('\u2014'), 'no em dashes');
  assert.ok(text.some((l) => l.includes('2026-09-09') && l.includes('$75,118.07')));
  assert.ok(text.some((l) => l.includes('sqrt(252)')), 'the Sharpe convention is stated');
  assert.ok(text.some((l) => l.includes('-25.42%')), 'what the excluded point would have done is stated');
  assert.ok(text.join(' ').includes('leaves out $49.46 of buy fees taken in coin'), 'the unrealized caveat is stated');
});

// ---- external cash flows (docs/incidents.md: Alpaca journaled -$66,905.32 out on 2026-10-13) ----

const funding = { t: at('2026-07-15'), date: '2026-07-15', type: 'JNLC', amount: 100000 };
const journal = { t: at('2026-10-14'), date: '2026-10-14', type: 'JNLC', amount: -66905.32 };
/** The real history through 2026-10-17, read with cashflow_types=ALL: the journal sits in the 2026-10-14 point. */
const WITH_JOURNAL: [string, number | null][] = [
  ...REAL.slice(0, -1),
  ['2026-10-13', 103601.89],
  ['2026-10-14', 38742.05],
  ['2026-10-15', 36180.12],
  ['2026-10-16', 37955.56],
  ['2026-10-17', 36969.47],
];
const NOW_17 = Date.parse('2026-10-17T21:00:00Z');

test('analyzeEquity nets the journal out: no -62.6% day, the event is listed, the 2026-09-09 outlier still goes', () => {
  const s = perf.analyzeEquity(perf.historyPoints(history(WITH_JOURNAL)), perf.PERF_START_DATE, NOW_17, [funding, journal]);
  // Raw equity fell from $100,000 to $36,969.47. Net of the journal the book is up 1.74%.
  const NET_RETURN = ((103601.89 * (1 + dietz(103601.89, 38742.05, -66905.32)) * 36969.47) / 38742.05 / 100000 - 1) * 100;
  near(s.returnPct, NET_RETURN, 1e-9);
  assert.equal(s.start.equity, 100000);
  assert.equal(s.end.equity, 36969.47);
  const day = s.curve.find((p) => p.date === '2026-10-14');
  assert.deepEqual([day?.equity, Number(day?.value.toFixed(2))], [38742.05, 106622.82]);
  near(s.worst.pct, (36180.12 / 38742.05 - 1) * 100, 1e-9);
  assert.equal(s.worst.date, '2026-10-15', 'the worst day is a market day, not the journal');
  assert.ok(!s.curve.some((p, i) => i > 0 && p.value / s.curve[i - 1].value - 1 < -0.1), 'no -10% step anywhere in the values');
  assert.deepEqual([s.drawdown.peak, s.drawdown.trough], ['2026-10-14', '2026-10-15']);
  near(s.drawdown.pct, (36180.12 / 38742.05 - 1) * 100, 1e-9);
  assert.deepEqual(s.excluded.map((x) => x.date), ['2026-08-01', '2026-09-09'], 'the one-day outlier is still left out');
  assert.equal(s.excluded[1].equity, 75118.07, 'an excluded point lists its broker equity');
  assert.equal(s.netFlowsUsd, -66905.32, 'the funding is the start, not a flow');
  assert.deepEqual(s.flows.map((f) => [f.date, f.countedOn, f.type, f.amountUsd, Number(f.bookPnlUsd.toFixed(2))]), [['2026-10-14', '2026-10-14', 'JNLC', -66905.32, 2045.48]]);
  near(s.unfilteredDrawdownPct, -25.4192692489154, 1e-9);
  assert.match(s.flows[0].note, /^Equity moved -\$64,859\.84 from 2026-10-13 to 2026-10-14; the book's own result was \+\$2,045\.48\.$/);
});

test('a journal reversed the next day is two events, never a one-day outlier', () => {
  const rows: [string, number | null][] = [['2026-07-15', 100000], ['2026-10-13', 103601.89], ['2026-10-14', 38742.05], ['2026-10-15', 105000], ['2026-10-16', 105500]];
  const reversal = { t: at('2026-10-15'), date: '2026-10-15', type: 'JNLC', amount: 66905.32 };
  const s = perf.analyzeEquity(perf.historyPoints(history(rows)), perf.PERF_START_DATE, NOW_17, [journal, reversal]);
  assert.deepEqual(s.excluded, []);
  assert.deepEqual(s.flows.map((f) => f.amountUsd), [-66905.32, 66905.32]);
  near(s.curve[3].value / s.curve[2].value - 1, dietz(38742.05, 105000, 66905.32), 1e-12);
  near(s.netFlowsUsd, 0, 1e-9);
  // Without the flows, the raw dip would pass for a bad print and vanish from the record.
  const blind = perf.analyzeEquity(perf.historyPoints(history(rows)), perf.PERF_START_DATE, NOW_17);
  assert.deepEqual(blind.excluded.map((x) => x.date), ['2026-10-14']);
});

test('a journal booked a point early, or a reversal booked a point late, counts where the equity steps', () => {
  const early = perf.analyzeEquity(perf.historyPoints(history(WITH_JOURNAL)), perf.PERF_START_DATE, NOW_17, [funding, { ...journal, t: at('2026-10-13'), date: '2026-10-13' }]);
  near(early.returnPct, ((103601.89 * (1 + dietz(103601.89, 38742.05, -66905.32)) * 36969.47) / 38742.05 / 100000 - 1) * 100, 1e-9);
  assert.deepEqual([early.flows[0].date, early.flows[0].countedOn], ['2026-10-13', '2026-10-14']);
  assert.match(early.flows[0].note, /Alpaca books it in the 2026-10-13 point, but the equity moved with it at 2026-10-14, so it counts there\./);
  // Alpaca hands the money back, and books it the day after equity shows it.
  const rows: [string, number | null][] = [...WITH_JOURNAL, ['2026-10-20', 36969.47 * 1.01 + 66905.32], ['2026-10-21', (36969.47 * 1.01 + 66905.32) * 1.002]];
  const reversal = { t: at('2026-10-21'), date: '2026-10-21', type: 'JNLC', amount: 66905.32 };
  const late = perf.analyzeEquity(perf.historyPoints(history(rows)), perf.PERF_START_DATE, Date.parse('2026-10-21T12:00:00Z'), [funding, journal, reversal]);
  assert.deepEqual(late.flows.map((f) => f.countedOn), ['2026-10-14', '2026-10-20']);
  assert.deepEqual([late.best.date, Number(late.best.pct.toFixed(2))], ['2026-10-10', 5.39], 'not a +180% day on the reversal');
  const booked = perf.analyzeEquity(perf.historyPoints(history(rows)), perf.PERF_START_DATE, Date.parse('2026-10-21T12:00:00Z'), [funding, journal, { ...reversal, t: at('2026-10-20'), date: '2026-10-20' }]);
  near(late.annVolPct, booked.annVolPct, 1e-9);
  near(late.returnPct, booked.returnPct, 1e-9);
  near(late.curve[late.curve.length - 1].value / late.curve[late.curve.length - 3].value - 1, (1 + dietz(36969.47, 36969.47 * 1.01 + 66905.32, 66905.32)) * 1.002 - 1, 1e-12);
});

test('a bad print on the day a flow counts, or next to it, is still left out as an outlier', () => {
  // The reversal books on 2026-10-20 where equity steps, but that day prints $78,000 instead of about $104,000.
  const reversal = { t: at('2026-10-20'), date: '2026-10-20', type: 'JNLC', amount: 66905.32 };
  const rows: [string, number | null][] = [...WITH_JOURNAL, ['2026-10-20', 78000], ['2026-10-21', 104200]];
  const s = perf.analyzeEquity(perf.historyPoints(history(rows)), perf.PERF_START_DATE, Date.parse('2026-10-21T12:00:00Z'), [funding, journal, reversal]);
  assert.deepEqual(s.excluded.map((x) => [x.date, x.equity]), [['2026-08-01', 0], ['2026-09-09', 75118.07], ['2026-10-20', 78000]]);
  assert.match(s.excluded[2].reason, /one-day outlier: .*, net of outside cash$/);
  assert.deepEqual(s.flows.map((f) => f.countedOn), ['2026-10-14', '2026-10-21'], 'the reversal counts at the next good point');
  near(s.curve[s.curve.length - 1].value / s.curve[s.curve.length - 2].value - 1, dietz(36969.47, 104200, 66905.32), 1e-12);
  // A $30,000 print the day before a -$60,000 journal: the print goes, and the journal stays where the equity stepped.
  const before: [string, number | null][] = [['2026-07-15', 100000], ['2026-10-12', 100000], ['2026-10-13', 30000], ['2026-10-14', 40000], ['2026-10-15', 40000]];
  const b = perf.analyzeEquity(perf.historyPoints(history(before)), perf.PERF_START_DATE, NOW_17, [{ t: at('2026-10-14'), date: '2026-10-14', type: 'JNLC', amount: -60000 }]);
  assert.deepEqual(b.excluded.map((x) => x.date), ['2026-10-13']);
  assert.deepEqual(b.flows.map((f) => f.countedOn), ['2026-10-14']);
  near(b.returnPct, 0, 1e-9);
});

test('perf never stops on a flow the equity cannot hold: it moves it to the step, counts a step from a day in progress, or leaves it uncounted and says so', async () => {
  const reversal = (date: string) => ({ t: at(date), date, type: 'JNLC', amount: 66905.32 });
  // Booked a point before the equity steps, and the restored book then fell 12%: moved to the step all the same.
  const fell: [string, number | null][] = [...WITH_JOURNAL, ['2026-10-20', 36969.47], ['2026-10-21', (36969.47 + 66905.32) * 0.88]];
  const moved = perf.analyzeEquity(perf.historyPoints(history(fell)), perf.PERF_START_DATE, Date.parse('2026-10-21T12:00:00Z'), [funding, journal, reversal('2026-10-20')]);
  assert.deepEqual(moved.flows.map((f) => f.countedOn), ['2026-10-14', '2026-10-21']);
  // Taken at mid-day, half the reversal counts as there for the day's fall: -17.70%, between -12% (there all day) and -33.72% (there at the close).
  near(moved.worst.pct, dietz(36969.47, (36969.47 + 66905.32) * 0.88, 66905.32) * 100, 1e-9);
  // Booked in a day still in progress while the last finished point already stepped: it counts at that point today, not as a +181% day.
  const stepped: [string, number | null][] = [...WITH_JOURNAL, ['2026-10-20', 36969.47 * 1.01 + 66905.32], ['2026-10-21', 104000]];
  const today = perf.analyzeEquity(perf.historyPoints(history(stepped)), perf.PERF_START_DATE, Date.parse('2026-10-20T12:00:00Z'), [funding, journal, reversal('2026-10-21')]);
  assert.deepEqual(today.flows.map((f) => f.countedOn), ['2026-10-14', '2026-10-20']);
  near(today.curve[today.curve.length - 1].value / today.curve[today.curve.length - 2].value - 1, dietz(36969.47, 36969.47 * 1.01 + 66905.32, 66905.32), 1e-12);
  // No point near it could have held it: left uncounted and flagged, and the report is still written.
  const flat: [string, number | null][] = [['2026-07-15', 100000], ['2026-10-13', 36969.47], ['2026-10-14', 30000], ['2026-10-15', 29000], ['2026-10-16', 29500]];
  const uncounted = perf.analyzeEquity(perf.historyPoints(history(flat)), perf.PERF_START_DATE, NOW_17, [{ ...reversal('2026-10-14'), amount: 100000 }]);
  assert.deepEqual([uncounted.flows[0].countedOn, uncounted.netFlowsUsd], ['', 0]);
  assert.match(uncounted.flows[0].note, /Not counted: the equity here and a point either side is too small to have held it/);
  // The 30-day fallback chart has no outlier filter; a bad print on the reversal day can't stop it either.
  const live = (await import('../src/dashboard/payloads.ts')).shapeLiveEquity;
  const bad = live({ timestamp: ['2026-10-19', '2026-10-20', '2026-10-21'].map((d) => at(d) / 1000), equity: [36969.47, 30000, 104000], profit_loss_pct: [0, 0, 0], cashflow: { JNLC: [0, 66905.32, 0] } });
  assert.equal(bad.points.length, 3);
});

test('a large flow that no point moves with stays where it is booked, and is flagged', () => {
  const rows: [string, number | null][] = [['2026-07-15', 100000], ['2026-10-13', 103601.89], ['2026-10-14', 103000], ['2026-10-15', 103500], ['2026-10-16', 103200]];
  const s = perf.analyzeEquity(perf.historyPoints(history(rows)), perf.PERF_START_DATE, NOW_17, [journal]);
  assert.equal(s.flows[0].countedOn, '2026-10-14');
  assert.match(s.flows[0].note, /Equity barely moved with this flow here or a point either side/);
});

test('a flow booked on a point left out counts at the next point kept, and only flows in the curve are counted', () => {
  const deposit = { t: at('2026-09-09'), date: '2026-09-09', type: 'CSD', amount: 1000 };
  const pending = { t: at('2026-10-13'), date: '2026-10-13', type: 'CSW', amount: -500 };
  const s = perf.analyzeEquity(perf.historyPoints(history(REAL)), perf.PERF_START_DATE, NOW, [deposit, pending]);
  assert.ok(s.excluded.some((x) => x.date === '2026-09-09'), 'the bad print is still left out');
  assert.deepEqual(s.flows.map((f) => [f.date, f.countedOn]), [['2026-09-09', '2026-09-10']]);
  assert.match(s.flows[0].note, /Booked in the 2026-09-09 point, which is left out, so it counts at 2026-09-10\./);
  assert.equal(s.netFlowsUsd, 1000, 'the withdrawal in the day still in progress waits for the next run');
  const d = perf.dailyMoves(s.curve.map((p) => ({ ...p, equity: p.value }))).find((m) => m.date === '2026-09-10');
  near(d?.pct ?? NaN, dietz(99750.9, 99918.66, 1000) * 100, 1e-9);
});

test('two flows in one period share the book\'s own result for it', () => {
  const s = perf.analyzeEquity(perf.historyPoints(history(REAL)), perf.PERF_START_DATE, NOW, [
    { t: at('2026-10-10'), date: '2026-10-10', type: 'CSD', amount: 500 },
    { t: at('2026-10-10'), date: '2026-10-10', type: 'JNLC', amount: -200 },
  ]);
  assert.deepEqual(s.flows.map((f) => Number(f.bookPnlUsd.toFixed(2))), [5086.92, 5086.92]);
  assert.equal(s.netFlowsUsd, 300);
});

test('an early close puts two points on one UTC date; a glitch on one leaves the other', () => {
  const stamps = ['2026-12-22T01:00:00Z', '2026-12-23T01:00:00Z', '2026-12-24T01:00:00Z', '2026-12-24T22:00:00Z', '2026-12-26T01:00:00Z'];
  const h: PortfolioHistory = { timestamp: stamps.map((x) => Date.parse(x) / 1000), equity: [100000, 100500, 80000, 101000, 101200], profit_loss_pct: stamps.map(() => 0) };
  const s = perf.analyzeEquity(perf.historyPoints(h), '2026-12-22', Date.parse('2026-12-27T00:00:00Z'));
  assert.deepEqual(s.excluded.map((x) => [x.date, x.equity]), [['2026-12-24', 80000]]);
  assert.deepEqual(s.curve.map((p) => p.equity), [100000, 100500, 101000, 101200], 'the early close stays in the curve');
});

test('perf.json and the report carry the flow, and the report says how returns are measured', () => {
  const equity = perf.analyzeEquity(perf.historyPoints(history(WITH_JOURNAL)), perf.PERF_START_DATE, NOW_17, [funding, journal]);
  const json = perf.buildPerfJson({
    generatedAt: '2026-10-17T21:00:00.000Z',
    equity,
    benchmarks: [{ name: 'BTC buy-and-hold', returnPct: 25.48, note: 'n' }],
    realized: perf.sleeveStats([]),
    unrealized: { all: 0, crypto: 0, stocks: 0 },
    fees: { usd: 0, inCoin: 0 },
    execution: perf.executionStats([]),
  });
  assert.deepEqual(Object.keys(json.equity.cashFlows[0]), ['date', 'countedOn', 'type', 'amountUsd', 'bookPnlUsd', 'note']);
  assert.deepEqual({ ...json.equity.cashFlows[0], note: '' }, { date: '2026-10-14', countedOn: '2026-10-14', type: 'JNLC', amountUsd: -66905.32, bookPnlUsd: 2045.48, note: '' });
  assert.equal(json.equity.netFlowsUsd, -66905.32);
  assert.equal(json.equity.returnPct, 1.7445);
  assert.deepEqual(json.curve.find((c) => c.date === '2026-10-14'), { date: '2026-10-14', equity: 38742.05, value: 106622.82 });
  const text = perf.renderPerf(json, { unfilteredDrawdownPct: -25.4193, entrySlipTrips: 0, exitSlipTrips: 0, openPositions: 28, openCoinFeesUsd: 0, outPath: 'data/perf.json' });
  assert.deepEqual(text.filter((l) => l.length > 72), [], 'short lines');
  assert.ok(!text.join('\n').includes('\u2014'), 'no em dashes');
  const all = text.join('\n');
  assert.match(all, /external flows +-\$66,905\.32 net \(1\)/);
  assert.match(all, /return +\+1\.74% time-weighted/);
  assert.match(all, /2026-10-14 {2}JNLC {2}-\$66,905\.32/);
  assert.match(text.join(' '), /a deposit, withdrawal or\s+journal is neither a gain nor a loss/);
});
