/**
 * Trial 11 (registered in docs/trial_11_combination.md, committed in 794fa9b
 * before this script existed): what the crypto book, the cross-asset trend
 * sleeve and SPY do together under six fixed mixes. Descriptive: no test, no
 * decision.
 *
 * Choices the registration leaves open, fixed before any statistic was computed:
 * - The crypto sleeve's rule comes from Trial 09's switch rule, recomputed here
 *   from the same data (v2 if the mean v2 - v1 excess is positive both from
 *   2021-01 and over every month; else v1). Its monthly return is the
 *   equal-weight mean strategy return at 30 bps, from candle 58.
 * - The trend sleeve is Trial 10's XA-11 long/flat at 5 bps, the equal-weight
 *   mean strategy return. SPY is held, adjusted for dividends.
 * - The window is the months all three cover, to 2026-09. M5 starts in the
 *   window's 13th month, so a second table repeats every mix over M5's months.
 * - Annualized mean = 12 x monthly mean; volatility = sqrt(12) x monthly sd;
 *   Sharpe = their ratio (against zero). Drawdown compounds the monthly series.
 *   "SPY's 12 worst months" are chosen within each table's window.
 *
 * Usage. Stock bars need the Alpaca paper data keys in the environment; GET only.
 *   npx tsx scripts/trial11_combination.ts            # print the report
 *   npx tsx scripts/trial11_combination.ts --append   # also append M4-M6 to data/trials.csv
 */
import * as fs from 'node:fs';
import { appendTrialRow, trialsPath, type TrialRow } from '../src/trials';
import {
  AS_OF_MS,
  CRYPTO_FIRST_INDEX,
  LAST_MONTH,
  TREND,
  TREND_FIRST_INDEX,
  V1,
  V2,
  XA_11,
  cryptoOptions,
  loadCrypto,
  loadStock,
  stockOptions,
  voteSleeve,
  type Loaded,
} from '../src/trialData';
import { configKey, configKeys, correlation, maxDrawdownOf, mean, parseCsvLine, pathFromPositions, sd, seriesFromPath } from '../src/tsmomPortfolio';
import type { Candle } from '../src/types';
import { BOOK_CRYPTO } from '../src/universe';

const COMMAND = 'trial11-combination';
const DOC = 'docs/trial_11_combination.md';
const DECISION_FROM = '2021-01';

const iso = (ms: number): string => new Date(ms).toISOString();
const pct = (x: number, digits = 2): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}`;

interface Measures {
  n: number;
  annMean: number;
  annVol: number;
  sharpe: number;
  worst: number;
  maxDd: number;
  inSpyWorst: number;
}

function measure(xs: number[], spyWorstIdx: number[]): Measures {
  const m = mean(xs);
  const s = sd(xs);
  return { n: xs.length, annMean: 12 * m, annVol: Math.sqrt(12) * s, sharpe: (m / s) * Math.sqrt(12), worst: Math.min(...xs), maxDd: maxDrawdownOf(xs), inSpyWorst: mean(spyWorstIdx.map((i) => xs[i])) };
}

(async () => {
  const append = process.argv.includes('--append');
  const runAt = iso(Date.now());

  const data = new Map<string, Loaded>();
  for (const s of XA_11) data.set(s, await loadStock(s));
  for (const s of BOOK_CRYPTO) data.set(s, await loadCrypto(s));
  const candlesOf = (s: string): Candle[] => (data.get(s) as Loaded).candles;

  // The crypto sleeve, by Trial 09's switch rule.
  const v1 = voteSleeve(BOOK_CRYPTO, candlesOf, V1, cryptoOptions(0.003, CRYPTO_FIRST_INDEX));
  const v2 = voteSleeve(BOOK_CRYPTO, candlesOf, V2, cryptoOptions(0.003, CRYPTO_FIRST_INDEX));
  const diff = v1.port.months.map((_, i) => v2.port.excess[i] - v1.port.excess[i]);
  const decIdx = v1.port.months.map((m, i) => (m >= DECISION_FROM ? i : -1)).filter((i) => i >= 0);
  const switchToV2 = mean(decIdx.map((i) => diff[i])) > 0 && mean(diff) > 0;
  const crypto = switchToV2 ? v2 : v1;

  const trend = voteSleeve(XA_11, candlesOf, TREND, stockOptions(0.0005, TREND_FIRST_INDEX));
  const spyCandles = candlesOf('SPY');
  const spyPath = pathFromPositions(spyCandles, new Array(spyCandles.length).fill(1), stockOptions(0, 2));
  const spy = seriesFromPath('SPY', spyPath, { maxGapDays: 4, nowMs: AS_OF_MS });

  const cMap = new Map(crypto.port.months.map((m, i) => [m, crypto.port.raw[i]]));
  const tMap = new Map(trend.port.months.map((m, i) => [m, trend.port.raw[i]]));
  const months = spy.months.filter((m) => cMap.has(m) && tMap.has(m) && m <= LAST_MONTH);
  if (months[months.length - 1] !== LAST_MONTH) throw new Error(`The common window ends ${months[months.length - 1]}, not ${LAST_MONTH}.`);
  const c = months.map((m) => cMap.get(m) as number);
  const t = months.map((m) => tMap.get(m) as number);
  const s = months.map((m) => spy.bhM.get(m) as number);

  // M5: equal risk from the prior 12 months, from the window's 13th month.
  const m5: number[] = [];
  for (let i = 12; i < months.length; i++) {
    const wc = 1 / sd(c.slice(i - 12, i));
    const wt = 1 / sd(t.slice(i - 12, i));
    m5.push((wc * c[i] + wt * t[i]) / (wc + wt));
  }
  const mixes: Record<string, number[]> = {
    'M1 crypto': c,
    'M2 trend': t,
    'M3 SPY': s,
    'M4 crypto 50 / trend 50': c.map((x, i) => 0.5 * x + 0.5 * t[i]),
    'M6 thirds': c.map((x, i) => (x + t[i] + s[i]) / 3),
  };
  const worstIdx = (xs: number[]): number[] => xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]).slice(0, 12).map((p) => p[1]);

  const say = (line = ''): void => console.log(line);
  const row = (name: string, x: Measures): string =>
    `  ${name.padEnd(26)} ${String(x.n).padStart(4)}  ${pct(x.annMean).padStart(8)}  ${(x.annVol * 100).toFixed(1).padStart(6)}%  ${x.sharpe.toFixed(2).padStart(6)}  ${pct(x.worst).padStart(8)}  ${pct(x.maxDd).padStart(8)}  ${pct(x.inSpyWorst).padStart(8)}`;
  const header = `  ${'mix'.padEnd(26)} ${'mo'.padStart(4)}  ${'ann.mean'.padStart(8)}  ${'vol'.padStart(7)}  ${'Sharpe'.padStart(6)}  ${'worst mo'.padStart(8)}  ${'max DD'.padStart(8)}  ${'SPY-12'.padStart(8)}`;

  say('Trial 11: the mix of crypto momentum, cross-asset trend and an index core (descriptive)');
  say(`Registered in ${DOC} (commit 794fa9b, before this script). Run ${runAt}. Evaluated as of ${iso(AS_OF_MS)}.`);
  say(`Crypto sleeve: BOOK-32 under ${switchToV2 ? 'v2' : 'v1'} (Trial 09's switch rule), 30 bps. Trend sleeve: XA-11 long/flat, 5 bps. SPY held.`);
  say(`Window: ${months[0]}..${months[months.length - 1]} (${months.length} months). SPY-12 = mean monthly return in SPY's 12 worst months of the window.`);
  say('');
  say('Correlation of monthly returns:');
  say(`  crypto-trend ${correlation(c, t).toFixed(3)} · crypto-SPY ${correlation(c, s).toFixed(3)} · trend-SPY ${correlation(t, s).toFixed(3)}`);
  say('');
  say('Full window (M5 needs 12 months of history, so it is in the second table):');
  say(header);
  const spyWorstFull = worstIdx(s);
  for (const [name, xs] of Object.entries(mixes)) say(row(name, measure(xs, spyWorstFull)));
  say('');
  say(`M5's window (${months[12]}..${months[months.length - 1]}, ${m5.length} months), every mix:`);
  say(header);
  const spyWorstM5 = worstIdx(s.slice(12));
  for (const [name, xs] of Object.entries(mixes)) say(row(name, measure(xs.slice(12), spyWorstM5)));
  say(row('M5 crypto/trend equal risk', measure(m5, spyWorstM5)));

  // Ledger rows for the three new mixes.
  const paramsOf = (mix: string, weights: string) =>
    JSON.stringify({ test: `${mix} descriptive`, crypto: `BOOK-32 ${switchToV2 ? 'v2' : 'v1'} 30bps`, trend: 'XA-11 long/flat 5bps', index: 'SPY held', weights, rebalance: 'monthly' });
  const specs = [
    { id: 'M4', params: paramsOf('M4', 'crypto 0.5, trend 0.5'), xs: mixes['M4 crypto 50 / trend 50'], from: months[0] },
    { id: 'M5', params: paramsOf('M5', 'equal risk, prior 12 months'), xs: m5, from: months[12] },
    { id: 'M6', params: paramsOf('M6', 'one third each'), xs: mixes['M6 thirds'], from: months[0] },
  ];
  const ledgerText = fs.readFileSync(trialsPath(), 'utf8');
  const alreadyAppended = ledgerText.split('\n').some((l) => parseCsvLine(l)[2] === COMMAND);
  const keysAfter = configKeys(ledgerText);
  for (const x of specs) keysAfter.add(configKey('mix-portfolio', 'MIX', x.params));
  const rows: TrialRow[] = specs.map((x) => {
    const m = measure(x.xs, worstIdx(x.id === 'M5' ? s.slice(12) : s));
    return {
      runAt,
      source: 'local-analysis',
      command: COMMAND,
      symbol: 'MIX',
      interval: '1M',
      strategy: 'mix-portfolio',
      params: x.params,
      windowStart: x.from,
      windowEnd: months[months.length - 1],
      setups: x.xs.length,
      wins: null,
      losses: null,
      winRatePct: null,
      profitFactor: null,
      totalPnlPct: Number((mean(x.xs) * 100).toFixed(3)),
      avgPnlPct: null,
      maxDdPct: Number((m.maxDd * 100).toFixed(2)),
      feeBps: null,
      notes: `TRIAL 11 ${x.id} DESCRIPTIVE (no test, no decision): monthly return ${pct(mean(x.xs), 3)}%/mo, annualized ${pct(m.annMean)}% at ${(m.annVol * 100).toFixed(1)}% volatility, Sharpe ${m.sharpe.toFixed(2)}, max drawdown ${pct(m.maxDd)}%. ${DOC}`,
    };
  });
  say('');
  say('=== data/trials.csv (M4, M5, M6) ===');
  if (!append) {
    for (const r of rows) say(`  ${r.windowStart}..${r.windowEnd} | ${r.notes}`);
    say('  Not appended (run with --append to write these three rows).');
  } else if (alreadyAppended) {
    throw new Error(`data/trials.csv already holds ${COMMAND} rows; refusing to append them twice.`);
  } else {
    for (const r of rows) appendTrialRow(r);
    const count = configKeys(fs.readFileSync(trialsPath(), 'utf8')).size;
    if (count !== keysAfter.size) throw new Error(`After appending, data/trials.csv counts ${count} configurations, expected ${keysAfter.size}.`);
    say(`  Appended 3 rows to ${trialsPath()}; the ledger now counts ${count} distinct configurations.`);
  }
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
