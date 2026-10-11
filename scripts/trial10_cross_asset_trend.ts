/**
 * Trial 10 (pre-registered in docs/trial_10_cross_asset_trend.md, committed in
 * 794fa9b before this script existed): does long-or-flat trend timing across
 * 11 asset-class ETFs (XA-11) beat its own average exposure, with fills at the
 * next open and 5 bps per unit of position change?
 *
 *   H1  XA-11, mean monthly excess > 0 over every complete month to 2026-09 (one test, alpha 0.05)
 * D1-D6 decide nothing.
 *
 * Choices the registration leaves open, fixed before any statistic was computed:
 * - w̄ is the mean s over every return day from session 254; for the long/short
 *   descriptive it is the mean of s in {-1, +1}.
 * - Faber's rule (D3) starts two sessions after the 10th month end, the first
 *   session where its signal is defined; all 11 funds share one session
 *   calendar, which the script checks.
 * - D4 pairs XA-11's monthly strategy return with the BOOK-32 crypto book's
 *   under v1 at 30 bps, from candle 58 as in Trial 09, over common months.
 * - D5 measures DBMF and KMLM as held: monthly returns of the adjusted price,
 *   over their complete months to 2026-09.
 * - D6 weights a fund by 1 / sd of its last 60 daily returns before the month
 *   starts; a fund with fewer than 20 sits that month out.
 * - The Bonferroni context multiplies p by the configurations disclosed in
 *   data/trials.csv by other trials plus this trial's four.
 *
 * Usage. Stock bars need the Alpaca paper data keys in the environment; GET only.
 *   set -a; source <.env with the paper keys>; set +a
 *   npx tsx scripts/trial10_cross_asset_trend.ts            # print the report
 *   npx tsx scripts/trial10_cross_asset_trend.ts --append   # also append the four rows to data/trials.csv
 */
import * as fs from 'node:fs';
import { ymOf } from '../src/months';
import { appendTrialRow, trialsPath, type TrialRow } from '../src/trials';
import {
  AS_OF_MS,
  CRYPTO_FIRST_INDEX,
  LAST_MONTH,
  TREND,
  TREND_FIRST_INDEX,
  V1,
  XA_11,
  cryptoOptions,
  loadCrypto,
  loadStock,
  sleeveFromPositions,
  stockOptions,
  voteSleeve,
  type Loaded,
  type Sleeve,
} from '../src/trialData';
import {
  bootstrapP,
  configKey,
  configKeys,
  correlation,
  inverseVolExcess,
  mean,
  monthEndSmaSignals,
  mulberry32,
  parseCsvLine,
  pathFromPositions,
  sd,
  seriesFromPath,
  symbolExcess,
  voteSignalsLongShort,
} from '../src/tsmomPortfolio';
import type { Candle } from '../src/types';
import { BOOK_CRYPTO } from '../src/universe';

const ALPHA = 0.05;
const RESAMPLES = 10_000;
const SEED = 42;
const COST = 0.0005;
const CRYPTO_COST = 0.003;
const FABER_MONTHS = 10;
const COMMAND = 'trial10-cross-asset-trend';
const DOC = 'docs/trial_10_cross_asset_trend.md';
const YARDSTICKS = ['DBMF', 'KMLM'];

interface Stats {
  n: number;
  first: string;
  last: string;
  mean: number;
  sd: number;
  t: number;
  p: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const day = (ms: number): string => iso(ms).slice(0, 10);
const pct = (x: number, digits = 3): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}`;
const bps = (c: number, digits = 0): string => (c * 10_000).toFixed(digits);
const sessionMonth = (c: Candle): string => ymOf(c.openTime);

function stats(months: string[], xs: number[]): Stats {
  const m = mean(xs);
  const s = sd(xs);
  return { n: xs.length, first: months[0], last: months[months.length - 1], mean: m, sd: s, t: (m / s) * Math.sqrt(xs.length), p: bootstrapP(xs, RESAMPLES, mulberry32(SEED)) };
}

function fmt(s: Stats): string {
  return `${s.first}..${s.last} (${s.n} mo) · mean ${pct(s.mean)}%/mo · sd ${(s.sd * 100).toFixed(2)}% · t=${s.t.toFixed(2)} · p=${s.p.toFixed(4)}`;
}

/** Values of two month-keyed series over their common months. */
function common(aMonths: string[], a: number[], bMonths: string[], b: number[]): { months: string[]; a: number[]; b: number[] } {
  const bIndex = new Map(bMonths.map((m, i) => [m, i]));
  const out = { months: [] as string[], a: [] as number[], b: [] as number[] };
  aMonths.forEach((m, i) => {
    const j = bIndex.get(m);
    if (j === undefined) return;
    out.months.push(m);
    out.a.push(a[i]);
    out.b.push(b[j]);
  });
  return out;
}

(async () => {
  if (XA_11.join() !== 'SPY,EFA,EEM,VNQ,TLT,IEF,TIP,LQD,GLD,DBC,UUP') throw new Error('XA-11 differs from the registered list.');
  if (TREND.lookbacks.join() !== '21,63,252' || TREND.enter !== 2 || TREND.exit !== 1) throw new Error('The trend rule differs from the registration.');
  const append = process.argv.includes('--append');
  const runAt = iso(Date.now());

  // Every series is fetched and checked before any statistic is computed, so a data failure reveals nothing.
  const data = new Map<string, Loaded>();
  for (const s of [...XA_11, ...YARDSTICKS]) data.set(s, await loadStock(s));
  for (const s of BOOK_CRYPTO) data.set(s, await loadCrypto(s));
  const candlesOf = (s: string): Candle[] => (data.get(s) as Loaded).candles;
  const calendar = candlesOf('SPY').map((c) => c.openTime).join();
  for (const s of XA_11) if (candlesOf(s).map((c) => c.openTime).join() !== calendar) throw new Error(`${s} has a different session calendar from SPY.`);

  // H1.
  const trend = voteSleeve(XA_11, candlesOf, TREND, stockOptions(COST, TREND_FIRST_INDEX));
  if (trend.port.months[trend.port.months.length - 1] !== LAST_MONTH) throw new Error(`XA-11 ends ${trend.port.months[trend.port.months.length - 1]}, not ${LAST_MONTH}.`);
  const h1 = stats(trend.port.months, trend.port.excess);
  const pass = h1.p <= ALPHA;

  // D1: long/short.
  const longShort = sleeveFromPositions(XA_11, candlesOf, (_s, c) => voteSignalsLongShort(c.map((x) => x.close), TREND.lookbacks, TREND.enter), stockOptions(COST, TREND_FIRST_INDEX, 'next-open-any'));
  const d1 = stats(longShort.port.months, longShort.port.excess);
  // D3: Faber's 10-month rule.
  const faberFirst = monthEndSmaSignals(candlesOf('SPY'), FABER_MONTHS, sessionMonth).firstDefined;
  const faber = sleeveFromPositions(XA_11, candlesOf, (_s, c) => monthEndSmaSignals(c, FABER_MONTHS, sessionMonth).pos, stockOptions(COST, faberFirst + 2));
  const d3 = stats(faber.port.months, faber.port.excess);
  // D4: correlation with the crypto book (v1, 30 bps).
  const crypto: Sleeve = voteSleeve(BOOK_CRYPTO, candlesOf, V1, cryptoOptions(CRYPTO_COST, CRYPTO_FIRST_INDEX));
  const d4Pair = common(trend.port.months, trend.port.raw, crypto.port.months, crypto.port.raw);
  const d4 = { n: d4Pair.months.length, first: d4Pair.months[0], last: d4Pair.months[d4Pair.months.length - 1], rho: correlation(d4Pair.a, d4Pair.b) };
  // D5: managed-futures funds as held.
  const d5 = YARDSTICKS.map((sym) => {
    const c = candlesOf(sym);
    const path = pathFromPositions(c, new Array(c.length).fill(1), stockOptions(0, 2));
    const series = seriesFromPath(sym, path, { maxGapDays: 4, nowMs: AS_OF_MS });
    const months = series.months;
    const rets = months.map((m) => series.bhM.get(m) as number);
    const pair = common(months, rets, trend.port.months, trend.port.raw);
    return { sym, from: day(c[0].openTime), n: months.length, first: months[0], last: months[months.length - 1], mean: mean(rets), sd: sd(rets), rho: correlation(pair.a, pair.b), pairN: pair.months.length };
  });
  // D6: inverse-volatility weights.
  const iv = inverseVolExcess(trend.series.map((series, i) => ({ series, path: trend.paths[i] })));
  const d6 = stats(iv.months, iv.excess);

  // Ledger rows; their params fix the configuration keys, so the count is known before the notes.
  const base = { universe: 'XA-11', execution: 'next session open', cost: `${bps(COST)}bps per unit position change`, benchmark: 'constant mean-exposure', bootstrap: '10k seed42', data: 'Alpaca SIP daily adjustment=all from 2016-01-04' };
  const voteRule = 'votes over 21/63/252 sessions';
  const specs = [
    { id: 'H1', params: { test: 'H1', rule: `${voteRule}: long at >=2, else flat`, weights: 'equal', ...base }, s: h1 },
    { id: 'D1', params: { test: 'D1 descriptive', rule: `${voteRule}: long at >=2, else short`, weights: 'equal', ...base }, s: d1 },
    { id: 'D3', params: { test: 'D3 descriptive', rule: 'month-end close above 10 month-end mean: long, else flat', weights: 'equal', ...base }, s: d3 },
    { id: 'D6', params: { test: 'D6 descriptive', rule: `${voteRule}: long at >=2, else flat`, weights: 'inverse 60d volatility', ...base }, s: d6 },
  ];
  const ledgerText = fs.readFileSync(trialsPath(), 'utf8');
  const alreadyAppended = ledgerText.split('\n').some((l) => parseCsvLine(l)[2] === COMMAND);
  const own = new Set(specs.map((x) => configKey('trend-portfolio', 'XA-11', JSON.stringify(x.params))));
  const keys = configKeys(ledgerText);
  const configsBefore = [...keys].filter((k) => !own.has(k)).length;
  for (const k of own) keys.add(k);
  const nConfigs = keys.size;
  const bonferroni = (p: number): number => Math.min(1, p * nConfigs);

  const say = (line = ''): void => console.log(line);
  say('Trial 10: trend across asset classes, through ETFs');
  say(`Pre-registered in ${DOC} (commit 794fa9b, before this script). Run ${runAt}.`);
  say(`Evaluated as of ${iso(AS_OF_MS)}: sessions dated ${LAST_MONTH}-30 or earlier. Alpaca SIP daily bars, adjustment all, from 2016-01-04.`);
  say(`Rule: votes over 21, 63 and 252 sessions; long at 2 or 3, flat otherwise. Fills at the next open, ${bps(COST)} bps per unit change.`);
  say('Benchmark: own mean exposure x close-to-close, costless. Portfolio: equal-weight mean across the 11.');
  say('');
  say(`=== HYPOTHESIS (one test, alpha ${ALPHA}) ===`);
  say(`H1  XA-11 long/flat  ${fmt(h1)}`);
  say(`    ${pass ? 'H0 rejected: PASS' : 'H0 not rejected: FAIL'}; Bonferroni context p x ${nConfigs} = ${bonferroni(h1.p).toFixed(3)} (${configsBefore} configurations from other trials + ${own.size} from this one; not the rule).`);
  say(`    Mean monthly strategy return ${pct(mean(trend.port.raw))}% against ${pct(mean(trend.port.bh))}% for holding all 11 equally.`);
  say('');
  say('Locked consequence:');
  say(pass ? '  PASS: a trend run joins the hourly agent: XA-11 long or flat under this rule, next-open orders, $2,700 per fund (about $30,000 at full exposure).' : '  FAIL: no trend sleeve; the budget the stock sleeve held stays in cash.');
  say('');
  say('=== DESCRIPTIVES (decide nothing) ===');
  say(`D1  long/short   ${fmt(d1)}`);
  say('D2  per fund: months, mean exposure, position changes per year, mean excess %/mo');
  trend.series.forEach((s) => {
    const ex = symbolExcess(s);
    say(`      ${s.symbol.padEnd(5)} ${String(s.months.length).padStart(4)}  w̄ ${s.wbar.toFixed(2)}  changes/yr ${s.turnoverPerYear.toFixed(1).padStart(5)}  ${pct(mean(ex)).padStart(8)}`);
  });
  say(`D3  Faber 10-month rule (from session ${faberFirst + 2})  ${fmt(d3)}`);
  say(`D4  correlation of monthly strategy returns, XA-11 against the crypto book (v1, 30 bps): ${d4.rho.toFixed(3)} over ${d4.n} months (${d4.first}..${d4.last}).`);
  say('D5  managed-futures funds, as held:');
  d5.forEach((x) => say(`      ${x.sym.padEnd(5)} from ${x.from}: ${x.first}..${x.last} (${x.n} mo) mean ${pct(x.mean)}%/mo, sd ${(x.sd * 100).toFixed(2)}%; correlation with XA-11 ${x.rho.toFixed(3)} over ${x.pairN} months`));
  say(`D6  inverse 60-day volatility weights  ${fmt(d6)}`);
  const gaps = XA_11.map((s) => `${s} ${(data.get(s) as Loaded).largestGapDays}`).join(', ');
  say(`    Data notes: longest break between sessions, days: ${gaps}.`);

  const noteOf = (id: string, s: Stats): string => {
    const head = `${s.n} mo ${s.first}..${s.last}; EW monthly timing excess ${pct(s.mean)}%/mo (sd ${(s.sd * 100).toFixed(2)}%; t=${s.t.toFixed(2)}); bootstrap p=${s.p.toFixed(4)}`;
    if (id === 'H1') return `TRIAL 10 H1 ${pass ? 'PASS' : 'FAIL'}: ${head}; Bonferroni context p x ${nConfigs} = ${bonferroni(s.p).toFixed(3)} (not the rule). D4 correlation with the crypto book ${d4.rho.toFixed(2)}. ${DOC}`;
    return `TRIAL 10 ${id} DESCRIPTIVE (not a decision): ${head}. ${DOC}`;
  };
  const rows: TrialRow[] = specs.map((x) => ({
    runAt,
    source: 'local-analysis',
    command: COMMAND,
    symbol: 'XA-11',
    interval: '1d',
    strategy: 'trend-portfolio',
    params: JSON.stringify(x.params),
    windowStart: x.s.first,
    windowEnd: x.s.last,
    setups: x.s.n,
    wins: null,
    losses: null,
    winRatePct: null,
    profitFactor: null,
    totalPnlPct: Number((x.s.mean * 100).toFixed(3)),
    avgPnlPct: null,
    maxDdPct: null,
    feeBps: Number(bps(COST)),
    notes: noteOf(x.id, x.s),
  }));
  say('');
  say('=== data/trials.csv (H1, D1, D3, D6) ===');
  if (!append) {
    for (const r of rows) say(`  ${r.windowStart}..${r.windowEnd}, ${r.setups} months, total_pnl_pct ${r.totalPnlPct} | ${r.notes}`);
    say('  Not appended (run with --append to write these four rows).');
  } else if (alreadyAppended) {
    throw new Error(`data/trials.csv already holds ${COMMAND} rows; refusing to append them twice.`);
  } else {
    for (const r of rows) appendTrialRow(r);
    const count = configKeys(fs.readFileSync(trialsPath(), 'utf8')).size;
    if (count !== nConfigs) throw new Error(`After appending, data/trials.csv counts ${count} configurations, expected ${nConfigs}.`);
    say(`  Appended 4 rows to ${trialsPath()}; the ledger now counts ${count} distinct configurations.`);
  }
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
