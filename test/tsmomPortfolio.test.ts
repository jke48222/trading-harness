import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAY } from './helpers.ts';
import type { Candle } from '../src/types.ts';
import type { SymbolSeries } from '../src/tsmomPortfolio.ts';

// The TSMOM portfolio construction shared by Trial 07, Trial 08 and the monitor.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-tsmom-portfolio-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const tp = await import('../src/tsmomPortfolio.ts');
const { completeMonths } = await import('../src/months.ts');

const close = (x: number, y: number): boolean => Math.abs(x - y) < 1e-12;

/** Binance-style daily candles: openTime 00:00 UTC, closeTime 23:59:59.999. */
function cryptoCandles(startIso: string, closes: number[], opens: number[] = closes): Candle[] {
  const t0 = Date.parse(startIso);
  return closes.map((c, i) => ({ openTime: t0 + i * DAY, open: opens[i], high: c, low: c, close: c, volume: 1, closeTime: t0 + (i + 1) * DAY - 1 }));
}

/** Alpaca-style stock bar: openTime 05:00 UTC on the session date, closeTime one interval later minus 1 ms. */
function stockBar(sessionDate: string, open: number, closePx: number): Candle {
  const openTime = Date.parse(`${sessionDate}T05:00:00Z`);
  return { openTime, open, high: Math.max(open, closePx), low: Math.min(open, closePx), close: closePx, volume: 1, closeTime: openTime + DAY - 1 };
}

const crypto = (cost: number, lookback: number, nowMs: number) =>
  ({ lookback, costPerUnit: cost, execution: 'close', monthBy: 'closeTime', maxGapDays: 0, nowMs }) as const;
const stocks = (cost: number, lookback: number, nowMs: number) =>
  ({ lookback, costPerUnit: cost, execution: 'next-open', monthBy: 'openTime', maxGapDays: 4, nowMs }) as const;

test('next-open execution: the registered table, all four s_{t-1}/s_t cases', () => {
  // close_t = 100, open_{t+1} = 102, close_{t+1} = 105, c = 5 bps.
  assert.ok(close(tp.nextOpenReturn(1, 1, 100, 102, 105, 0.0005), 0.05), '1 -> 1: close to close, no cost');
  assert.ok(close(tp.nextOpenReturn(0, 1, 100, 102, 105, 0.0005), 0.0289117647058824), '0 -> 1: buy the open, 105/102 - 1 - 0.0005');
  assert.ok(close(tp.nextOpenReturn(1, 0, 100, 102, 105, 0.0005), 0.0195), '1 -> 0: sell the open, 102/100 - 1 - 0.0005');
  assert.equal(tp.nextOpenReturn(0, 0, 100, 102, 105, 0.0005), 0, '0 -> 0: flat');
  assert.throws(() => tp.nextOpenReturn(-1, 1, 100, 102, 105, 0.0005), /long-only/);
});

test('next-open execution through dailyPath: signals at the close, fills at the next open', () => {
  // Lookback 2: s = [0,0,1,1,0,0,1,1]. Return days are candles 4..7 with (s_{t-1}, s_t) = (1,1), (1,0), (0,0), (0,1).
  const closes = [10, 10, 11, 12, 11, 10, 12, 13];
  const opens = [10, 10, 10.5, 11.5, 11.8, 10.6, 11, 12.4];
  const days = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11'];
  const bars = days.map((d, i) => stockBar(d, opens[i], closes[i]));
  assert.deepEqual(tp.signals(closes, 2), [0, 0, 1, 1, 0, 0, 1, 1]);
  const d = tp.dailyPath(bars, stocks(0.0005, 2, Date.parse('2024-06-01T00:00:00Z')));
  assert.deepEqual(d.index, [4, 5, 6, 7]);
  assert.deepEqual(d.exposure, [1, 0, 0, 1]);
  assert.deepEqual(d.change, [0, 1, 0, 1]);
  const expected = [
    -0.0833333333333333, // 1 -> 1: 11/12 - 1
    -0.0368636363636364, // 1 -> 0: 10.6/11 - 1 - 0.0005 (out at the open)
    0, //                   0 -> 0
    0.0478870967741935, //  0 -> 1: 13/12.4 - 1 - 0.0005 (in at the open)
  ];
  d.rStrat.forEach((r, k) => assert.ok(close(r, expected[k]), `day ${d.index[k]}: ${r} vs ${expected[k]}`));
  assert.deepEqual(d.time, days.slice(4).map((x) => Date.parse(`${x}T05:00:00Z`)), 'stock months key off the session date');
  assert.throws(() => tp.dailyPath(bars, { ...stocks(0.0005, 2, 0), bothSides: true }), /long-only/);
});

test('stock months are assigned by session date: the last January session stays in January', () => {
  // Weekday sessions 2024-01-02 .. 2024-03-01 with a rising-then-choppy close path.
  const bars: Candle[] = [];
  let px = 100;
  for (let ms = Date.parse('2024-01-02T00:00:00Z'); ms <= Date.parse('2024-03-01T00:00:00Z'); ms += DAY) {
    const dow = new Date(ms).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const i = bars.length;
    const open = px * (1 + (i % 3 === 0 ? 0.004 : -0.002));
    px = px * (1 + (i % 4 === 0 ? -0.03 : 0.012));
    bars.push(stockBar(new Date(ms).toISOString().slice(0, 10), open, px));
  }
  const jan31 = bars.find((b) => new Date(b.openTime).toISOString().startsWith('2024-01-31')) as Candle;
  assert.equal(new Date(jan31.closeTime).toISOString().slice(0, 7), '2024-02', 'closeTime of the last January bar is in February');
  const opts = stocks(0.0005, 2, Date.parse('2024-06-01T00:00:00Z'));
  const s = tp.buildSymbolSeries('X', bars, opts);
  assert.deepEqual(s.months, ['2024-02'], 'January starts late (first return day Jan 8) and March is cut off after the 1st');
  // February's compounded return, rebuilt from the table over February sessions only.
  const pos = tp.signals(bars.map((b) => b.close), 2);
  let feb = 1;
  for (let i = 4; i < bars.length; i++) {
    if (!new Date(bars[i].openTime).toISOString().startsWith('2024-02')) continue;
    feb *= 1 + tp.nextOpenReturn(pos[i - 2], pos[i - 1], bars[i - 1].close, bars[i].open, bars[i].close, 0.0005);
  }
  assert.ok(close(s.stratM.get('2024-02') as number, feb - 1));
});

/** Trial 07's per-symbol loop exactly as scripts/trial07_portfolio.ts ran it on 2026-07-15, minus the fetch. */
function trial07Reference(symbol: string, candles: Candle[], bothSides: boolean, nowMs: number): SymbolSeries {
  const L = 28;
  const COST_PER_UNIT = 0.0015;
  const c = candles.map((x) => x.close);
  const t = candles.map((x) => x.closeTime);
  const pos: number[] = new Array(c.length).fill(0);
  for (let i = L; i < c.length; i++) {
    const mom = c[i] / c[i - L] - 1;
    pos[i] = bothSides ? (mom > 0 ? 1 : mom < 0 ? -1 : 0) : mom > 0 ? 1 : 0;
  }
  const ym = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
  const stratAcc = new Map<string, number>();
  const benchAcc = new Map<string, number>();
  const bhAcc = new Map<string, number>();
  const wUsed: number[] = [];
  let turnover = 0;
  const start = L + 2;
  for (let i = start; i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    wUsed.push(pos[i - 1]);
    turnover += Math.abs(pos[i - 1] - pos[i - 2]);
    const rStrat = pos[i - 1] * rAsset - COST_PER_UNIT * Math.abs(pos[i - 1] - pos[i - 2]);
    const key = ym(t[i]);
    stratAcc.set(key, (stratAcc.get(key) ?? 1) * (1 + rStrat));
    bhAcc.set(key, (bhAcc.get(key) ?? 1) * (1 + rAsset));
  }
  const wbar = tp.mean(wUsed);
  const benchKeys = new Map<string, number>();
  for (let i = start; i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    const key = ym(t[i]);
    benchKeys.set(key, (benchKeys.get(key) ?? 1) * (1 + wbar * rAsset));
  }
  for (const [k, v] of benchKeys) benchAcc.set(k, v);
  const keys = [...stratAcc.keys()].sort();
  const complete = new Set(completeMonths(t.slice(start), nowMs, 0));
  const full = keys.filter((k) => complete.has(k));
  const stratM = new Map<string, number>();
  const benchM = new Map<string, number>();
  const bhM = new Map<string, number>();
  for (const k of full) {
    stratM.set(k, (stratAcc.get(k) as number) - 1);
    benchM.set(k, (benchAcc.get(k) as number) - 1);
    bhM.set(k, (bhAcc.get(k) as number) - 1);
  }
  const years = (t[c.length - 1] - t[start]) / (365.25 * 86_400_000);
  return { symbol, months: full, stratM, benchM, bhM, wbar, turnoverPerYear: turnover / years, nDays: c.length - start };
}

test('close execution charges c per unit of position change, as in Trial 07', () => {
  assert.ok(close(tp.closeExecutionReturn(0, 1, 100, 103, 0.0015), 0.03 - 0.0015), 'entry day: return minus one unit of cost');
  assert.ok(close(tp.closeExecutionReturn(1, 0, 100, 103, 0.0015), -0.0015), 'exit day: flat, minus one unit');
  assert.ok(close(tp.closeExecutionReturn(1, 1, 100, 103, 0.0015), 0.03), 'held: no cost');
  assert.ok(close(tp.closeExecutionReturn(1, -1, 100, 103, 0.0015), -0.03 - 0.003), 'both-sides reversal: two units');
  // Lookback 2 on a hand path: s = [0,0,1,1,0,0,1,1]; days 4..7 have (s_{t-1}, s_t) = (1,1), (1,0), (0,0), (0,1).
  const d = tp.dailyPath(cryptoCandles('2024-01-01T00:00:00Z', [10, 10, 11, 12, 11, 10, 12, 13]), crypto(0.0015, 2, 0));
  const expected = [11 / 12 - 1, -0.0015, 0, 13 / 12 - 1 - 0.0015];
  d.rStrat.forEach((r, k) => assert.ok(close(r, expected[k]), `day ${d.index[k]}`));
});

test('close execution reproduces Trial 07 exactly on a random walk (long-only and both-sides)', () => {
  const rand = tp.mulberry32(7);
  const closes: number[] = [];
  let px = 100;
  for (let i = 0; i < 900; i++) {
    px *= 1 + (rand() - 0.48) * 0.12;
    closes.push(px);
  }
  const candles = cryptoCandles('2019-03-14T00:00:00Z', closes); // starts mid-month, ends 2021-08-29
  const nowMs = Date.parse('2026-10-11T04:00:00Z');
  for (const bothSides of [false, true]) {
    const ref = trial07Reference('RW', candles, bothSides, nowMs);
    const got = tp.buildSymbolSeries('RW', candles, { ...crypto(0.0015, 28, nowMs), bothSides });
    assert.deepStrictEqual(got, ref, `bothSides=${bothSides}`);
    assert.equal(ref.months[0], '2019-05', 'partial first month dropped');
    assert.equal(ref.months[ref.months.length - 1], '2021-07', 'partial last month dropped');
  }
});

test('bootstrapP is deterministic with seed 42', () => {
  const r = tp.mulberry32(42);
  assert.deepEqual([r(), r(), r()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  const xs = [0.03, -0.02, 0.05, -0.04, 0.01, 0.02, -0.01, 0.04, -0.03, 0.02];
  const p1 = tp.bootstrapP(xs, 10_000, tp.mulberry32(42));
  const p2 = tp.bootstrapP(xs, 10_000, tp.mulberry32(42));
  assert.equal(p1, p2);
  assert.equal(p1, 0.2243, 'pinned: a change here means the registered bootstrap changed');
  assert.equal(tp.bootstrapP([0.01, 0.02, 0.03], 10_000, tp.mulberry32(42)), 1 / 10_000, 'floored at 1/resamples');
  assert.equal(tp.bootstrapP([-0.01, -0.02], 10_000, tp.mulberry32(42)), 1);
});

test('equal-weight portfolio averages only the symbols live that month', () => {
  const mk = (symbol: string, rows: [string, number, number][]): SymbolSeries => ({
    symbol,
    months: rows.map((r) => r[0]),
    stratM: new Map(rows.map((r) => [r[0], r[1]])),
    benchM: new Map(rows.map((r) => [r[0], r[2]])),
    bhM: new Map(rows.map((r) => [r[0], r[1] * 2])),
    wbar: 0.5,
    turnoverPerYear: 0,
    nDays: rows.length * 30,
  });
  const a = mk('A', [['2020-01', 0.1, 0.02], ['2020-02', 0.05, 0.01], ['2020-03', -0.02, 0.01]]);
  const b = mk('B', [['2020-02', -0.03, 0.01], ['2020-03', 0.04, 0]]); // listed a month later
  const c = mk('C', []); // no complete month at all
  const p = tp.portfolioExcess([a, b, c]);
  assert.deepEqual(p.months, ['2020-01', '2020-02', '2020-03']);
  assert.deepEqual(p.live, [1, 2, 2]);
  assert.ok(close(p.excess[0], 0.08), 'January: A alone, not diluted by B or C');
  assert.ok(close(p.excess[1], 0), 'February: mean of +0.04 and -0.04');
  assert.ok(close(p.excess[2], (-0.03 + 0.04) / 2));
  assert.ok(close(p.raw[1], (0.05 - 0.03) / 2));
  assert.deepEqual(tp.symbolExcess(a).map((x) => Math.round(x * 1e12) / 1e12), [0.08, 0.04, -0.03]);
});

test('Holm-Bonferroni step-down: thresholds alpha/3, alpha/2, alpha and adjusted p', () => {
  const h = tp.holm([0.01, 0.04, 0.03], 0.05);
  assert.deepEqual(h.order, [0, 2, 1]);
  assert.deepEqual(h.reject, [true, false, false], '0.03 > 0.05/2 stops the procedure, so 0.04 is not tested');
  assert.ok(close(h.adjusted[0], 0.03) && close(h.adjusted[2], 0.06) && close(h.adjusted[1], 0.06));
  assert.deepEqual(tp.holm([0.001, 0.02, 0.04], 0.05).reject, [true, true, true]);
  assert.deepEqual(tp.holm([0.2, 0.0001, 0.0001], 0.05).reject, [false, true, true]);
  assert.deepEqual(tp.holm([0.02, 0.5, 0.9], 0.05).reject, [false, false, false], '0.02 > 0.05/3');
});

test('break-even cost by bisection on a decreasing mean-excess curve', () => {
  const be = tp.breakEvenCost((c) => 0.012 - 0.6 * c, 0, 0.05);
  assert.equal(be.status, 'root');
  if (be.status === 'root') assert.ok(Math.abs(be.cost - 0.02) < 1e-8);
  assert.deepEqual(tp.breakEvenCost(() => -0.001, 0, 0.05), { status: 'not-positive-at-low' });
  assert.deepEqual(tp.breakEvenCost(() => 0.001, 0, 0.05), { status: 'positive-at-high' });
});

test('countConfigs: one key per strategy|symbol|params, window ignored, short rows skipped', () => {
  const q = (s: string): string => '"' + s.replaceAll('"', '""') + '"';
  const header = 'run_at,source,command,symbol,interval,strategy,params,window_start,window_end,setups,wins,losses,win_rate_pct,profit_factor,total_pnl_pct,avg_pnl_pct,max_dd_pct,fee_bps,notes';
  const row = (symbol: string, params: string): string =>
    ['2026-07-15', 'local-replay', 'replay:raw', symbol, '1d', 'tsmom', q(params), 'a', 'b', '', '', '', '', '', '', '', '', '30', 'n'].join(',');
  const text = [
    header,
    row('BTCUSDT', '{"lookback":28,"window":"IS"}'),
    row('BINANCE:BTCUSDT', '{"lookback":28,"window":"OOS"}'), // same config: venue prefix and window ignored
    row('ETHUSDT', '{"lookback":28}'),
    'too,short,row',
    '',
  ].join('\n');
  assert.equal(tp.countConfigs(text), 2);
  assert.ok(tp.configKeys(text).has(tp.configKey('tsmom', 'ETHUSDT', '{"lookback":28}')));
});
