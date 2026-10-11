/**
 * Trial 08 (pre-registered in docs/trial_08_cost_and_sleeves.md, committed
 * before this script existed): the one construction that passed, Trial 07's
 * daily-sign TSMOM-28 long-only, tested at the costs this account pays, on the
 * book's 32 coins, and on an unselected ETF universe traded at the next open.
 *
 * Decisions, Holm-Bonferroni across the three at alpha 0.05:
 *   H1  T07-8 crypto, 30 bps per unit of position change, fills at the signal close
 *   H2  BOOK-32 crypto, the same
 *   H3  ETF-15, 5 bps per unit of position change, fills at the next session's open
 * D1-D5 are printed and decide nothing.
 *
 * Choices the registration leaves open, fixed before any statistic was computed:
 * - The evaluation is as of 2026-10-01T00:00Z, the end of the last month used
 *   (2026-09): crypto candles that closed before it, stock sessions dated
 *   2026-09-30 or earlier, and the same instant as completeMonths' "now". So
 *   wbar and changes per year stop at 2026-09-30, and a later re-run gives the
 *   same numbers. Trial 07's script reads up to the moment it runs.
 * - wbar is the mean of s over every return day of the symbol's series, the
 *   partial first month included, as Trial 07's code computes it.
 * - The first return day is candle lookback + 2 for both execution models, as
 *   in Trial 07, so the warmup entry is never charged.
 * - A crypto candle that an exchange halt cut short (Binance closed the
 *   2018-02-08 candle at 00:28 UTC) stays in as an ordinary day, as Trial 07
 *   used it, and is listed in the data notes.
 * - Crypto months key off the candle's closeTime (Trial 07). Stock months key
 *   off the bar's openTime, which Alpaca stamps at 04:00 or 05:00 UTC on the
 *   session date; any other stamp stops the run.
 * - The Bonferroni-vs-ledger context multiplies p by the distinct
 *   configurations in data/trials.csv plus this trial's four (H1, H2, H3, D3),
 *   the way Trial 07 added its own one.
 * - D5 bisects c on [0, 0.05] until the bracket is narrower than 1e-9.
 *
 * Usage. Stock bars need the Alpaca paper data keys in the environment; the
 * run makes GET market-data calls only.
 *   set -a; source <.env with the paper keys>; set +a
 *   npx tsx scripts/trial08_cost_and_sleeves.ts            # print the report
 *   npx tsx scripts/trial08_cost_and_sleeves.ts --append   # print it, then append H1-H3 and D3 to data/trials.csv
 */
import * as fs from 'node:fs';
import { closedCandles, fetchCandlesSince, intervalToMs } from '../src/market';
import { ymOf } from '../src/months';
import { fetchStockCandles } from '../src/stockdata';
import { appendTrialRow, trialsPath, type TrialRow } from '../src/trials';
import {
  bootstrapP,
  breakEvenCost,
  buildSymbolSeries,
  configKey,
  configKeys,
  holm,
  mean,
  mulberry32,
  parseCsvLine,
  portfolioExcess,
  sd,
  symbolExcess,
  type BreakEven,
  type Portfolio,
  type SeriesOptions,
  type SymbolSeries,
} from '../src/tsmomPortfolio';
import type { Candle } from '../src/types';
import { BOOK_CRYPTO, BOOK_STOCKS, TRIAL07_CRYPTO } from '../src/universe';

const DAY = 86_400_000;
const LOOKBACK = 28;
const ALPHA = 0.05;
const RESAMPLES = 10_000;
const SEED = 42;
const LAST_MONTH = '2026-09';
const AS_OF_MS = Date.parse('2026-10-01T00:00:00Z');
const STOCK_START_MS = Date.parse('2016-01-04T00:00:00Z');
const OOS_FROM = '2023-12';
const COST_CRYPTO = 0.003; // 30 bps per unit of position change
const COST_STOCK = 0.0005; // 5 bps per unit of position change
const D1_COSTS = [0.0015, 0.005]; // Trial 07's 15 bps, and 50 bps
const BREAK_EVEN_RANGE: [number, number] = [0, 0.05];
const COMMAND = 'trial08-cost-and-sleeves';
const DOC = 'docs/trial_08_cost_and_sleeves.md';

const T07_8 = TRIAL07_CRYPTO;
const BOOK_32 = BOOK_CRYPTO;
const ETF_15 = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'];
const BOOK_24 = BOOK_STOCKS;

type Kind = 'crypto' | 'stock';

interface Spec {
  id: 'H1' | 'H2' | 'H3' | 'D3';
  universe: string;
  symbols: string[];
  kind: Kind;
  cost: number;
}

const SPECS: Spec[] = [
  { id: 'H1', universe: 'T07-8', symbols: T07_8, kind: 'crypto', cost: COST_CRYPTO },
  { id: 'H2', universe: 'BOOK-32', symbols: BOOK_32, kind: 'crypto', cost: COST_CRYPTO },
  { id: 'H3', universe: 'ETF-15', symbols: ETF_15, kind: 'stock', cost: COST_STOCK },
  { id: 'D3', universe: 'BOOK-24', symbols: BOOK_24, kind: 'stock', cost: COST_STOCK },
];

interface Loaded {
  candles: Candle[];
  /** Calendar days with no daily candle (crypto) or beyond a normal weekend/holiday break (stocks). */
  missingDays: number;
  largestGapDays: number;
  /** Crypto candles that closed early because the exchange halted (kept, as Trial 07 kept them). */
  shortCandles: string[];
}

interface Stats {
  n: number;
  first: string;
  last: string;
  mean: number;
  sd: number;
  t: number;
  p: number;
}

interface Result {
  spec: Spec;
  cost: number;
  series: SymbolSeries[];
  port: Portfolio;
  stats: Stats;
  /** Symbols with at least one complete month. */
  symbolsLive: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const day = (ms: number): string => iso(ms).slice(0, 10);
const pct = (x: number, digits = 3): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}`;
const bps = (c: number, digits = 0): string => (c * 10_000).toFixed(digits);
const exec = (k: Kind): string => (k === 'crypto' ? 'close' : 'next-open');

function seriesOptions(kind: Kind, cost: number): SeriesOptions {
  return kind === 'crypto'
    ? { lookback: LOOKBACK, costPerUnit: cost, execution: 'close', monthBy: 'closeTime', maxGapDays: 0, nowMs: AS_OF_MS }
    : { lookback: LOOKBACK, costPerUnit: cost, execution: 'next-open', monthBy: 'openTime', maxGapDays: 4, nowMs: AS_OF_MS };
}

function checkPrices(symbol: string, x: Candle): void {
  if (!(Number.isFinite(x.open) && Number.isFinite(x.close) && x.open > 0 && x.close > 0)) {
    throw new Error(`${symbol}: non-positive or missing price on ${day(x.openTime)}`);
  }
}

/** Binance USDT daily candles from listing, closed before the as-of instant. */
async function loadCrypto(symbol: string): Promise<Loaded> {
  const all = closedCandles(await fetchCandlesSince(symbol, '1d', Date.now() - 9600 * intervalToMs('1d')));
  const candles = all.filter((x) => x.closeTime < AS_OF_MS);
  if (candles.length === 0) throw new Error(`${symbol}: no daily candle closed before ${iso(AS_OF_MS)}`);
  let missingDays = 0;
  let largestGapDays = 0;
  const shortCandles: string[] = [];
  candles.forEach((x, i) => {
    checkPrices(symbol, x);
    if (x.openTime % DAY !== 0 || x.closeTime <= x.openTime || x.closeTime - x.openTime > DAY - 1) {
      throw new Error(`${symbol}: candle ${iso(x.openTime)} is off the UTC daily grid`);
    }
    // An exchange halt ends the day's candle early (Binance, 2018-02-08 00:28 UTC). It stays in, as in Trial 07.
    if (x.closeTime - x.openTime < DAY - 1) shortCandles.push(`${day(x.openTime)} closed ${iso(x.closeTime).slice(11, 16)} UTC`);
    if (i === 0) return;
    const step = x.openTime - candles[i - 1].openTime;
    if (step <= 0) throw new Error(`${symbol}: candles out of order at ${iso(x.openTime)}`);
    const gap = step / DAY - 1;
    missingDays += gap;
    largestGapDays = Math.max(largestGapDays, gap);
  });
  return { candles, missingDays, largestGapDays, shortCandles };
}

/** Alpaca SIP daily bars, adjustment all, from 2016-01-04, sessions dated up to the last month used. */
async function loadStock(symbol: string): Promise<Loaded> {
  const all = await fetchStockCandles(symbol, '1d', 10000, STOCK_START_MS, { feed: 'sip', adjustment: 'all' });
  const candles = all.filter((x) => ymOf(x.openTime) <= LAST_MONTH);
  if (candles.length === 0) throw new Error(`${symbol}: no session dated ${LAST_MONTH} or earlier`);
  let missingDays = 0;
  let largestGapDays = 0;
  candles.forEach((x, i) => {
    checkPrices(symbol, x);
    const hour = new Date(x.openTime).getUTCHours();
    if (hour !== 4 && hour !== 5) throw new Error(`${symbol}: bar ${iso(x.openTime)} is not stamped at midnight New York time; the session date would be ambiguous`);
    if (i === 0) return;
    const step = Math.round((x.openTime - candles[i - 1].openTime) / DAY);
    if (step <= 0) throw new Error(`${symbol}: bars out of order at ${iso(x.openTime)}`);
    // Friday to Tuesday over a holiday Monday is the longest normal break (3 days without a session).
    const gap = step - 1;
    if (gap > 3) missingDays += gap - 3;
    largestGapDays = Math.max(largestGapDays, gap);
  });
  return { candles, missingDays, largestGapDays, shortCandles: [] };
}

function stats(months: string[], xs: number[]): Stats {
  const m = mean(xs);
  const s = sd(xs);
  return { n: xs.length, first: months[0], last: months[months.length - 1], mean: m, sd: s, t: (m / s) * Math.sqrt(xs.length), p: bootstrapP(xs, RESAMPLES, mulberry32(SEED)) };
}

function oosStats(port: Portfolio): Stats {
  const idx = port.months.map((m, i) => (m >= OOS_FROM ? i : -1)).filter((i) => i >= 0);
  return stats(
    idx.map((i) => port.months[i]),
    idx.map((i) => port.excess[i])
  );
}

function fmtStats(s: Stats): string {
  return `${s.first}..${s.last} (${s.n} mo) · mean ${pct(s.mean)}%/mo · sd ${(s.sd * 100).toFixed(2)}% · t=${s.t.toFixed(2)} · p=${s.p.toFixed(4)}`;
}

function fmtBreakEven(be: BreakEven): string {
  if (be.status === 'root') return `${bps(be.cost, 1)} bps per unit change`;
  if (be.status === 'not-positive-at-low') return `none: mean excess is not positive even at 0 bps`;
  return `above ${bps(BREAK_EVEN_RANGE[1])} bps per unit change (no crossing in the range)`;
}

(async () => {
  if (T07_8.join() !== 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT') throw new Error('T07-8 differs from the registered list.');
  if (BOOK_32.length !== 32 || new Set(BOOK_32).size !== 32) throw new Error('BOOK-32 must hold 32 distinct symbols.');
  if (BOOK_24.length !== 24 || new Set(BOOK_24).size !== 24) throw new Error('BOOK-24 must hold 24 distinct symbols.');
  const append = process.argv.includes('--append');
  const runAt = iso(Date.now());

  // Every series is fetched and checked before any statistic is computed, so a data failure reveals nothing.
  const data = new Map<string, Loaded>();
  for (const s of [...new Set([...T07_8, ...BOOK_32])]) data.set(s, await loadCrypto(s));
  for (const s of [...new Set([...ETF_15, ...BOOK_24])]) data.set(s, await loadStock(s));
  const candlesOf = (s: string): Candle[] => (data.get(s) as Loaded).candles;

  const build = (spec: Spec, cost: number): SymbolSeries[] => spec.symbols.map((s) => buildSymbolSeries(s, candlesOf(s), seriesOptions(spec.kind, cost)));
  const run = (spec: Spec, cost = spec.cost): Result => {
    const series = build(spec, cost);
    const port = portfolioExcess(series);
    if (port.months[port.months.length - 1] !== LAST_MONTH) throw new Error(`${spec.id}: the portfolio ends ${port.months[port.months.length - 1]}, not ${LAST_MONTH}.`);
    return { spec, cost, series, port, stats: stats(port.months, port.excess), symbolsLive: series.filter((s) => s.months.length > 0).length };
  };

  const H = SPECS.slice(0, 3).map((spec) => run(spec));
  const d3 = run(SPECS[3]);
  const d1 = D1_COSTS.map((c) => run(SPECS[0], c));
  const d2 = H.map((r) => oosStats(r.port));
  const d5 = H.map((r) => breakEvenCost((c) => mean(portfolioExcess(build(r.spec, c)).excess), BREAK_EVEN_RANGE[0], BREAK_EVEN_RANGE[1]));
  const h = holm(
    H.map((r) => r.stats.p),
    ALPHA
  );
  const pass = H.map((_, i) => h.reject[i]);

  // Rows for data/trials.csv. Their params fix the configuration keys, so the ledger count is known before the notes are written.
  const paramsOf = (spec: Spec): string =>
    JSON.stringify({
      test: spec.id === 'D3' ? 'D3 descriptive' : spec.id,
      universe: spec.universe,
      construction: 'daily-sign L28 long-only',
      execution: spec.kind === 'crypto' ? 'signal close' : 'next session open',
      cost: `${bps(spec.cost)}bps per unit position change`,
      benchmark: 'constant mean-exposure',
      bootstrap: '10k seed42',
      data: spec.kind === 'crypto' ? 'Binance USDT daily from listing' : 'Alpaca SIP daily adjustment=all from 2016-01-04',
    });
  const ledgerText = fs.readFileSync(trialsPath(), 'utf8');
  const alreadyAppended = ledgerText.split('\n').some((l) => parseCsvLine(l)[2] === COMMAND);
  const keys = configKeys(ledgerText);
  const configsBefore = keys.size;
  for (const spec of SPECS) keys.add(configKey('tsmom-portfolio', spec.universe, paramsOf(spec)));
  const nConfigs = keys.size;
  const bonferroni = (p: number): number => Math.min(1, p * nConfigs);

  const say = (line = ''): void => console.log(line);

  say('Trial 08: real costs, the book universe and the stock sleeve');
  say(`Pre-registered in ${DOC} (committed before this script). Run ${runAt}.`);
  say(`Evaluated as of ${iso(AS_OF_MS)}: crypto candles closed before it, stock sessions dated ${LAST_MONTH}-30 or earlier. Last month used ${LAST_MONTH}.`);
  say('Signal s_t = 1 if close_t/close_{t-28} - 1 > 0 else 0 (long-only). Benchmark wbar x close-to-close, costless. Months compounded.');
  say('Portfolio = equal-weight mean of monthly excess across the symbols live that month.');
  say(`Test: H0 mean excess <= 0, one-sided percentile bootstrap of the mean, ${RESAMPLES.toLocaleString('en-US')} resamples, mulberry32(${SEED}).`);
  say('Crypto (close): r = s_t(close_{t+1}/close_t - 1) - c|s_t - s_{t-1}|. Stocks (next-open): fills at open_{t+1}, c per change.');

  say('');
  say(`=== HYPOTHESES (Holm-Bonferroni across H1-H3, alpha ${ALPHA}) ===`);
  say('test  universe  execution  cost/unit  months               n    symbols  mean %/mo   sd %    t      p (boot)');
  H.forEach((r) => {
    const s = r.stats;
    say(
      `${r.spec.id.padEnd(5)} ${r.spec.universe.padEnd(9)} ${exec(r.spec.kind).padEnd(10)} ${(bps(r.cost) + ' bps').padEnd(10)} ${`${s.first}..${s.last}`.padEnd(20)} ${String(s.n).padEnd(4)} ${String(r.symbolsLive).padEnd(8)} ${pct(s.mean).padStart(9)}  ${(s.sd * 100).toFixed(2).padStart(6)}  ${s.t.toFixed(2).padStart(5)}  ${s.p.toFixed(4)}`
    );
  });
  H.forEach((r) => {
    const live = r.port.live;
    say(`  ${r.spec.id} symbols live per month: ${Math.min(...live)} to ${Math.max(...live)} (${live[live.length - 1]} in ${LAST_MONTH})`);
  });

  say('');
  say(`Holm-Bonferroni step-down, alpha ${ALPHA}, m = 3:`);
  let stopped = false;
  h.order.forEach((idx, k) => {
    const r = H[idx];
    const threshold = ALPHA / (3 - k);
    let verdict: string;
    if (stopped) verdict = 'not rejected (the procedure stopped at an earlier step)';
    else if (h.reject[idx]) verdict = 'H0 rejected: PASS';
    else {
      verdict = 'H0 not rejected: FAIL';
      stopped = true;
    }
    say(`  step ${k + 1}  ${r.spec.id}  p = ${r.stats.p.toFixed(4)}  vs alpha/${3 - k} = ${threshold.toFixed(4)}  Holm-adjusted p = ${h.adjusted[idx].toFixed(4)}  ${verdict}`);
  });
  say(`VERDICTS: ${H.map((r, i) => `${r.spec.id} ${pass[i] ? 'PASS' : 'FAIL'}`).join(' · ')}`);
  say('');
  say(`Bonferroni-vs-ledger context (not the rule): ${configsBefore} configurations in data/trials.csv + 4 from this trial (H1, H2, H3, D3) = ${nConfigs}.`);
  H.forEach((r) => say(`  ${r.spec.id}: p x ${nConfigs} = ${bonferroni(r.stats.p).toFixed(3)}${r.stats.p * nConfigs > 1 ? ' (capped at 1)' : ''}`));

  say('');
  say(`Locked consequences that apply (recommendations; changing the book is Jalen's call):`);
  const [h1, h2, h3] = pass;
  if (!h1) say('  H1 fails: Trial 07 does not survive the fees this account pays. Crypto stays watch-only at entry-tier fees; real-money crypto waits for a cheaper venue or tier measured on this account.');
  if (h1 && !h2) say('  H1 passes, H2 fails: the 32 coins reach beyond the evidence. Restrict the crypto sleeve to T07-8 ∩ Alpaca-tradable (BTC, ETH, SOL, XRP, DOGE, ADA, LINK).');
  if (h1 && h2) say('  H1 and H2 pass: no locked consequence; the crypto sleeve has support at 30 bps on both universes.');
  if (!h3) say('  H3 fails: no portfolio-level support for 28-day momentum on US equities. Remove the stock sleeve from the paper book.');
  if (h3) say('  H3 passes: replace the 24 hand-picked names with ETF-15.');
  say('  No outcome changes a parameter: no new lookbacks, no cost-fitted variants, no re-aggregation.');

  say('');
  say('=== DESCRIPTIVES (decide nothing) ===');
  say('D1  T07-8 cost sensitivity, close execution:');
  const byCost = [...d1, H[0]].sort((a, b) => a.cost - b.cost);
  byCost.forEach((r) => say(`      ${(bps(r.cost) + ' bps').padEnd(7)} ${fmtStats(r.stats)}${r.cost === COST_CRYPTO ? '  (= H1)' : ''}`));
  say('      Trial 07 as published (2026-07-15, 15 bps, 2017-10..2026-06, 105 mo): +4.299%/mo, t=2.91, p=0.0004.');
  say(`D2  OOS era, months from ${OOS_FROM}:`);
  H.forEach((r, i) => say(`      ${r.spec.id} ${r.spec.universe.padEnd(8)} ${fmtStats(d2[i])}`));
  say(`D3  BOOK-24 with the H3 construction (next-open, ${bps(COST_STOCK)} bps). Hand-picked with hindsight, outside the Holm family:`);
  say(`      ${fmtStats(d3.stats)} · ${d3.symbolsLive} symbols`);
  say('D4  Per symbol (complete months only). wbar = mean exposure over all return days; changes/yr = units of position change per year.');
  for (const r of [...H, d3]) {
    say(`    ${r.spec.id} ${r.spec.universe} at ${bps(r.cost)} bps, ${exec(r.spec.kind)} execution:`);
    say(`    symbol      data from   months  first    last     wbar   changes/yr  mean excess %/mo  ${r.spec.kind === 'crypto' ? 'missing days' : 'gaps > 3 days'}`);
    for (const s of r.series) {
      const loaded = data.get(s.symbol) as Loaded;
      const ex = symbolExcess(s);
      say(
        `    ${s.symbol.padEnd(11)} ${day(loaded.candles[0].openTime)}  ${String(s.months.length).padStart(6)}  ${(s.months[0] ?? '-').padEnd(7)}  ${(s.months[s.months.length - 1] ?? '-').padEnd(7)}  ${s.wbar.toFixed(2).padStart(5)}  ${s.turnoverPerYear.toFixed(1).padStart(10)}  ${(ex.length ? pct(mean(ex)) : '-').padStart(16)}  ${String(loaded.missingDays).padStart(5)}${loaded.missingDays > 0 ? ` (largest gap ${loaded.largestGapDays} d)` : ''}`
      );
    }
  }
  const shortNotes = [...data].filter(([, l]) => l.shortCandles.length > 0).map(([sym, l]) => `${sym} ${l.shortCandles.join(', ')}`);
  say(`    Data notes: short crypto candles kept as ordinary days (exchange halts): ${shortNotes.length ? shortNotes.join('; ') : 'none'}.`);
  say(`D5  Break-even cost per unit change (portfolio mean excess = 0), bisection on c in [${bps(BREAK_EVEN_RANGE[0])}, ${bps(BREAK_EVEN_RANGE[1])}] bps:`);
  H.forEach((r, i) => say(`      ${r.spec.id} ${r.spec.universe.padEnd(8)} ${fmtBreakEven(d5[i])} (registered ${bps(r.cost)} bps)`));

  // Ledger rows: H1-H3 and D3, with D1, D2 and D5 in the notes.
  const resultOf = (id: Spec['id']): Result => (id === 'D3' ? d3 : H[SPECS.findIndex((s) => s.id === id)]);
  const notesOf = (spec: Spec): string => {
    const r = resultOf(spec.id);
    const s = r.stats;
    const head = `${s.n} mo ${s.first}..${s.last}; ${r.symbolsLive} symbols; EW monthly timing excess ${pct(s.mean)}%/mo (sd ${(s.sd * 100).toFixed(2)}%; t=${s.t.toFixed(2)}); bootstrap p=${s.p.toFixed(4)}`;
    if (spec.id === 'D3') {
      return `TRIAL 08 D3 DESCRIPTIVE (not a decision; hindsight-selected list outside the Holm family): BOOK-24 with the H3 construction (next-open execution; ${bps(spec.cost)}bps per unit change): ${head}. ${DOC}`;
    }
    const i = SPECS.findIndex((x) => x.id === spec.id);
    const d1Text =
      spec.id === 'H1' ? ` D1: ${d1.map((x) => `${bps(x.cost)}bps ${pct(x.stats.mean)}%/mo p=${x.stats.p.toFixed(4)}`).join('; ')}.` : '';
    return (
      `TRIAL 08 ${spec.id} ${pass[i] ? 'PASS' : 'FAIL'}: ${spec.universe} at ${bps(spec.cost)}bps per unit change (${exec(spec.kind)} execution): ${head}; ` +
      `Holm-adjusted p=${h.adjusted[i].toFixed(4)} -> ${pass[i] ? 'PASS' : 'FAIL'} at alpha 0.05 across H1-H3; Bonferroni context p x ${nConfigs} = ${bonferroni(s.p).toFixed(3)} (not the rule).` +
      `${d1Text} D2 OOS-era (>=${OOS_FROM}; ${d2[i].n} mo): ${pct(d2[i].mean)}%/mo p=${d2[i].p.toFixed(4)}. D5 break-even: ${fmtBreakEven(d5[i])}. ${DOC}`
    );
  };
  const rows: TrialRow[] = SPECS.map((spec) => {
    const s = resultOf(spec.id).stats;
    return {
      runAt,
      source: 'local-analysis',
      command: COMMAND,
      symbol: spec.universe,
      interval: '1d',
      strategy: 'tsmom-portfolio',
      params: paramsOf(spec),
      windowStart: s.first,
      windowEnd: s.last,
      setups: s.n,
      wins: null,
      losses: null,
      winRatePct: null,
      profitFactor: null,
      totalPnlPct: Number((s.mean * 100).toFixed(3)),
      avgPnlPct: null,
      maxDdPct: null,
      feeBps: Number(bps(spec.cost)),
      notes: notesOf(spec),
    };
  });

  say('');
  say('=== data/trials.csv (H1, H2, H3, D3) ===');
  if (!append) {
    for (const r of rows) say(`  ${r.symbol}: window ${r.windowStart}..${r.windowEnd}, ${r.setups} months, total_pnl_pct ${r.totalPnlPct}, fee_bps ${r.feeBps} | ${r.notes}`);
    say('  Not appended (run with --append to write these four rows).');
  } else if (alreadyAppended) {
    throw new Error(`data/trials.csv already holds ${COMMAND} rows; refusing to append them twice.`);
  } else {
    for (const r of rows) appendTrialRow(r);
    const after = fs.readFileSync(trialsPath(), 'utf8');
    const lines = after.split('\n').filter((l) => l.trim());
    for (const l of lines.slice(-4)) say(l);
    const count = configKeys(after).size;
    if (count !== nConfigs) throw new Error(`After appending, data/trials.csv counts ${count} configurations, expected ${nConfigs}.`);
    say(`  Appended 4 rows to ${trialsPath()}; the ledger now counts ${count} distinct configurations.`);
  }
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
