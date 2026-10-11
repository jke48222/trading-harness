/**
 * Trial 09 (pre-registered in docs/trial_09_crypto_momentum_v2.md, committed in
 * 794fa9b before this script existed): does a four-lookback rule with a band
 * (v2) beat the book's 28-day rule (v1) on its 32 coins, 2021-01 to 2026-09,
 * at 30 bps per unit of position change?
 *
 *   H1  BOOK-32, v2's mean monthly excess, decision window
 *   H2  BOOK-32, mean monthly (v2 excess - v1 excess), decision window
 * Holm across H1-H2 at alpha 0.05. The switch rule: v2 replaces v1 if the mean
 * paired difference is positive both in the decision window and over every
 * month both rules cover. D1-D5 decide nothing.
 *
 * Choices the registration leaves open, fixed before any statistic was computed:
 * - w̄ is the mean s over every return day from candle 58, each rule its own.
 * - "Every month both rules cover" runs from the portfolio's first complete
 *   month to 2026-09. Because both rules start on candle 58, each symbol has
 *   the same months under both, and the script checks that.
 * - D3's break-even is v2's, in the decision window, by bisection on c in
 *   [0, 0.05] until the bracket is narrower than 1e-9.
 * - D5 weights a symbol by 1 / sd of its last 60 daily returns before the month
 *   starts; a symbol with fewer than 20 such returns sits that month out.
 * - The Bonferroni context multiplies p by the configurations disclosed in
 *   data/trials.csv by earlier trials plus this trial's four.
 *
 * Usage (Binance public data; GET only):
 *   npx tsx scripts/trial09_crypto_momentum_v2.ts            # print the report
 *   npx tsx scripts/trial09_crypto_momentum_v2.ts --append   # also append the four rows to data/trials.csv
 */
import * as fs from 'node:fs';
import { appendTrialRow, trialsPath, type TrialRow } from '../src/trials';
import { AS_OF_MS, LAST_MONTH, V1, V2, cryptoOptions, loadCrypto, voteSleeve, type Loaded, type Sleeve, type VoteRule } from '../src/trialData';
import {
  bootstrapP,
  breakEvenCost,
  configKey,
  configKeys,
  holm,
  inverseVolExcess,
  mean,
  mulberry32,
  parseCsvLine,
  sd,
  type BreakEven,
} from '../src/tsmomPortfolio';
import type { Candle } from '../src/types';
import { BOOK_CRYPTO, TRIAL07_CRYPTO } from '../src/universe';

const ALPHA = 0.05;
const RESAMPLES = 10_000;
const SEED = 42;
const DECISION_FROM = '2021-01';
const COST = 0.003;
const D3_COSTS = [0, 0.0005, 0.0015, 0.003, 0.005];
const BREAK_EVEN_RANGE: [number, number] = [0, 0.05];
const COMMAND = 'trial09-crypto-momentum-v2';
const DOC = 'docs/trial_09_crypto_momentum_v2.md';

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
const pct = (x: number, digits = 3): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}`;
const bps = (c: number, digits = 0): string => (c * 10_000).toFixed(digits);

function stats(months: string[], xs: number[]): Stats {
  const m = mean(xs);
  const s = sd(xs);
  return { n: xs.length, first: months[0], last: months[months.length - 1], mean: m, sd: s, t: (m / s) * Math.sqrt(xs.length), p: bootstrapP(xs, RESAMPLES, mulberry32(SEED)) };
}

/** The months from `from` on, with their values. */
function windowOf(months: string[], xs: number[], from: string | null): { months: string[]; xs: number[] } {
  const idx = months.map((m, i) => (from === null || m >= from ? i : -1)).filter((i) => i >= 0);
  return { months: idx.map((i) => months[i]), xs: idx.map((i) => xs[i]) };
}

function fmt(s: Stats): string {
  return `${s.first}..${s.last} (${s.n} mo) · mean ${pct(s.mean)}%/mo · sd ${(s.sd * 100).toFixed(2)}% · t=${s.t.toFixed(2)} · p=${s.p.toFixed(4)}`;
}

function fmtBreakEven(be: BreakEven): string {
  if (be.status === 'root') return `${bps(be.cost, 1)} bps per unit change`;
  if (be.status === 'not-positive-at-low') return 'none: mean excess is not positive even at 0 bps';
  return `above ${bps(BREAK_EVEN_RANGE[1])} bps per unit change (no crossing in the range)`;
}

(async () => {
  if (BOOK_CRYPTO.length !== 32 || new Set(BOOK_CRYPTO).size !== 32) throw new Error('BOOK-32 must hold 32 distinct symbols.');
  if (TRIAL07_CRYPTO.join() !== 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT') throw new Error('T07-8 differs from the registered list.');
  if (V2.lookbacks.join() !== '7,14,28,56' || V2.enter !== 3 || V2.exit !== 1) throw new Error('v2 differs from the registered rule.');
  const append = process.argv.includes('--append');
  const runAt = iso(Date.now());

  // Every series is fetched and checked before any statistic is computed, so a data failure reveals nothing.
  const data = new Map<string, Loaded>();
  for (const s of [...new Set([...BOOK_CRYPTO, ...TRIAL07_CRYPTO])]) data.set(s, await loadCrypto(s));
  const candlesOf = (s: string): Candle[] => (data.get(s) as Loaded).candles;

  const sleeve = (symbols: string[], rule: VoteRule, cost: number): Sleeve => voteSleeve(symbols, candlesOf, rule, cryptoOptions(cost));
  const paired = (a: Sleeve, b: Sleeve): void => {
    const same = a.port.months.join() === b.port.months.join() && a.series.every((s, i) => s.months.join() === b.series[i].months.join());
    if (!same) throw new Error('v1 and v2 cover different months; the registration requires the same months under both.');
    if (a.port.months[a.port.months.length - 1] !== LAST_MONTH) throw new Error(`The portfolio ends ${a.port.months[a.port.months.length - 1]}, not ${LAST_MONTH}.`);
  };

  const book1 = sleeve(BOOK_CRYPTO, V1, COST);
  const book2 = sleeve(BOOK_CRYPTO, V2, COST);
  paired(book1, book2);
  const months = book1.port.months;
  const diff = months.map((_, i) => book2.port.excess[i] - book1.port.excess[i]);

  const dec = (xs: number[]): { months: string[]; xs: number[] } => windowOf(months, xs, DECISION_FROM);
  const h1 = stats(dec(book2.port.excess).months, dec(book2.port.excess).xs);
  const h2 = stats(dec(diff).months, dec(diff).xs);
  const holmResult = holm([h1.p, h2.p], ALPHA);
  const fullDiff = stats(months, diff);
  const switchToV2 = h2.mean > 0 && fullDiff.mean > 0;

  // Descriptives.
  const t1 = sleeve(TRIAL07_CRYPTO, V1, COST);
  const t2 = sleeve(TRIAL07_CRYPTO, V2, COST);
  paired(t1, t2);
  const tDiff = t1.port.months.map((_, i) => t2.port.excess[i] - t1.port.excess[i]);
  const tWin = (xs: number[], from: string | null): Stats => {
    const w = windowOf(t1.port.months, xs, from);
    return stats(w.months, w.xs);
  };
  const d1 = {
    v1Dec: tWin(t1.port.excess, DECISION_FROM),
    v2Dec: tWin(t2.port.excess, DECISION_FROM),
    diffDec: tWin(tDiff, DECISION_FROM),
    v1Full: tWin(t1.port.excess, null),
    v2Full: tWin(t2.port.excess, null),
    diffFull: tWin(tDiff, null),
  };
  const d2 = { v1: stats(months, book1.port.excess), v2: stats(months, book2.port.excess) };
  const d3 = D3_COSTS.map((c) => {
    const a = c === COST ? book1 : sleeve(BOOK_CRYPTO, V1, c);
    const b = c === COST ? book2 : sleeve(BOOK_CRYPTO, V2, c);
    return { cost: c, v1: mean(dec(a.port.excess).xs), v2: mean(dec(b.port.excess).xs) };
  });
  const d3BreakEven = breakEvenCost((c) => mean(dec(sleeve(BOOK_CRYPTO, V2, c).port.excess).xs), BREAK_EVEN_RANGE[0], BREAK_EVEN_RANGE[1]);
  const live = (sl: Sleeve) => sl.series.filter((s) => s.months.length > 0);
  const d4 = {
    v1Turnover: mean(live(book1).map((s) => s.turnoverPerYear)),
    v2Turnover: mean(live(book2).map((s) => s.turnoverPerYear)),
    v1Wbar: mean(live(book1).map((s) => s.wbar)),
    v2Wbar: mean(live(book2).map((s) => s.wbar)),
  };
  const iv = inverseVolExcess(book2.series.map((series, i) => ({ series, path: book2.paths[i] })));
  const d5Dec = windowOf(iv.months, iv.excess, DECISION_FROM);
  const d5 = { dec: stats(d5Dec.months, d5Dec.xs), full: stats(iv.months, iv.excess) };

  // Ledger rows; their params fix the configuration keys, so the count is known before the notes.
  const base = { execution: 'signal close', cost: `${bps(COST)}bps per unit position change`, benchmark: 'constant mean-exposure', bootstrap: '10k seed42', data: 'Binance USDT daily from listing', start: 'candle 58' };
  const v2Rule = 'votes over 7/14/28/56d: enter at >=3, exit at <=1';
  const specs = [
    { id: 'H1', universe: 'BOOK-32', params: { test: 'H1', universe: 'BOOK-32', rule: v2Rule, weights: 'equal', ...base }, s: h1 },
    { id: 'H2', universe: 'BOOK-32', params: { test: 'H2', universe: 'BOOK-32', rule: `${v2Rule} minus 28d sign`, weights: 'equal', ...base }, s: h2 },
    { id: 'D1', universe: 'T07-8', params: { test: 'D1 descriptive', universe: 'T07-8', rule: v2Rule, weights: 'equal', ...base }, s: d1.v2Dec },
    { id: 'D5', universe: 'BOOK-32', params: { test: 'D5 descriptive', universe: 'BOOK-32', rule: v2Rule, weights: 'inverse 60d volatility', ...base }, s: d5.dec },
  ];
  const ledgerText = fs.readFileSync(trialsPath(), 'utf8');
  const alreadyAppended = ledgerText.split('\n').some((l) => parseCsvLine(l)[2] === COMMAND);
  const own = new Set(specs.map((x) => configKey('tsmom-portfolio', x.universe, JSON.stringify(x.params))));
  const keys = configKeys(ledgerText);
  const configsBefore = [...keys].filter((k) => !own.has(k)).length;
  for (const k of own) keys.add(k);
  const nConfigs = keys.size;
  const bonferroni = (p: number): number => Math.min(1, p * nConfigs);

  const say = (line = ''): void => console.log(line);
  say('Trial 09: crypto momentum v2, several lookbacks and a band');
  say(`Pre-registered in ${DOC} (commit 794fa9b, before this script). Run ${runAt}.`);
  say(`Evaluated as of ${iso(AS_OF_MS)}; last month used ${LAST_MONTH}. Decision window ${DECISION_FROM}..${LAST_MONTH}.`);
  say(`v1: s = 1 if the 28-day return > 0. v2: votes over 7/14/28/56 days, enter at 3 or more, exit at 1 or fewer, else hold. Both from candle 58.`);
  say(`Fills at the signal close, ${bps(COST)} bps per unit of position change. Benchmark: each rule's own mean exposure x close-to-close, costless.`);
  say(`Tests: one-sided percentile bootstrap of the mean, ${RESAMPLES.toLocaleString('en-US')} resamples, a fresh mulberry32(${SEED}) each.`);
  say('');
  say(`=== HYPOTHESES (Holm across H1-H2, alpha ${ALPHA}) ===`);
  say(`H1  BOOK-32 v2 excess          ${fmt(h1)}`);
  say(`H2  BOOK-32 v2 minus v1        ${fmt(h2)}`);
  [h1, h2].forEach((s, i) => say(`    H${i + 1}: Holm-adjusted p = ${holmResult.adjusted[i].toFixed(4)} -> ${holmResult.reject[i] ? 'H0 rejected: PASS' : 'H0 not rejected: FAIL'}; Bonferroni context p x ${nConfigs} = ${bonferroni(s.p).toFixed(3)}`));
  say(`    Symbols live per month: ${Math.min(...book2.port.live)} to ${Math.max(...book2.port.live)} (${book2.port.live[book2.port.live.length - 1]} in ${LAST_MONTH}).`);
  say(`Bonferroni-vs-ledger context (not the rule): ${configsBefore} configurations from earlier trials + ${own.size} from this trial = ${nConfigs}.`);
  say('');
  say('=== THE SWITCH RULE (locked) ===');
  say(`  Mean v2 - v1, decision window: ${pct(h2.mean)}%/mo. Over every month both rules cover (${fullDiff.first}..${fullDiff.last}, ${fullDiff.n} mo): ${pct(fullDiff.mean)}%/mo (p=${fullDiff.p.toFixed(4)}).`);
  say(`  DECISION: ${switchToV2 ? 'SWITCH the book to v2 (both differences are positive).' : 'STAY on v1 (the difference is not positive in both windows).'}`);
  say('');
  say('=== DESCRIPTIVES (decide nothing) ===');
  say('D1  T07-8:');
  say(`      v1 decision window   ${fmt(d1.v1Dec)}`);
  say(`      v2 decision window   ${fmt(d1.v2Dec)}`);
  say(`      v2 - v1 decision     ${fmt(d1.diffDec)}`);
  say(`      v1 every month       ${fmt(d1.v1Full)}`);
  say(`      v2 every month       ${fmt(d1.v2Full)}`);
  say(`      v2 - v1 every month  ${fmt(d1.diffFull)}`);
  say('D2  BOOK-32 over every month both rules cover:');
  say(`      v1  ${fmt(d2.v1)}`);
  say(`      v2  ${fmt(d2.v2)}`);
  say('D3  BOOK-32 cost sensitivity, decision window (mean excess %/mo):');
  for (const r of d3) say(`      ${(bps(r.cost) + ' bps').padEnd(7)} v1 ${pct(r.v1)}  v2 ${pct(r.v2)}  v2 - v1 ${pct(r.v2 - r.v1)}`);
  say(`      v2 break-even cost, decision window: ${fmtBreakEven(d3BreakEven)}`);
  say(`D4  BOOK-32 averages per symbol: position changes per year v1 ${d4.v1Turnover.toFixed(1)}, v2 ${d4.v2Turnover.toFixed(1)}; mean exposure v1 ${d4.v1Wbar.toFixed(2)}, v2 ${d4.v2Wbar.toFixed(2)}.`);
  say('D5  BOOK-32 v2 with inverse 60-day volatility weights:');
  say(`      decision window  ${fmt(d5.dec)}`);
  say(`      every month      ${fmt(d5.full)}`);
  const shortNotes = [...data].filter(([, l]) => l.shortCandles.length > 0).map(([sym, l]) => `${sym} ${l.shortCandles.join(', ')}`);
  const missing = [...data].filter(([, l]) => l.missingDays > 0).map(([sym, l]) => `${sym} ${l.missingDays}`);
  say(`    Data notes: short candles kept as ordinary days: ${shortNotes.length ? shortNotes.join('; ') : 'none'}. Missing days: ${missing.length ? missing.join(', ') : 'none'}.`);

  const noteOf = (id: string, s: Stats): string => {
    const head = `${s.n} mo ${s.first}..${s.last}; mean ${pct(s.mean)}%/mo (sd ${(s.sd * 100).toFixed(2)}%; t=${s.t.toFixed(2)}); bootstrap p=${s.p.toFixed(4)}`;
    if (id === 'H1' || id === 'H2') {
      const i = id === 'H1' ? 0 : 1;
      return `TRIAL 09 ${id} ${holmResult.reject[i] ? 'PASS' : 'FAIL'}: ${head}; Holm-adjusted p=${holmResult.adjusted[i].toFixed(4)}; Bonferroni context p x ${nConfigs} = ${bonferroni(s.p).toFixed(3)} (not the rule). Switch rule: ${switchToV2 ? 'SWITCH to v2' : 'STAY on v1'} (v2 - v1 every month ${pct(fullDiff.mean)}%/mo). ${DOC}`;
    }
    return `TRIAL 09 ${id} DESCRIPTIVE (not a decision): ${head}. ${DOC}`;
  };
  const rows: TrialRow[] = specs.map((x) => ({
    runAt,
    source: 'local-analysis',
    command: COMMAND,
    symbol: x.universe,
    interval: '1d',
    strategy: 'tsmom-portfolio',
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
  say('=== data/trials.csv (H1, H2, D1, D5) ===');
  if (!append) {
    for (const r of rows) say(`  ${r.symbol}: ${r.windowStart}..${r.windowEnd}, ${r.setups} months, total_pnl_pct ${r.totalPnlPct} | ${r.notes}`);
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
