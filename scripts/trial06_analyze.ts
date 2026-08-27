/**
 * Trial 06 analysis (pre-registered in docs/trial_06_multiple_testing_correction.md
 * BEFORE this ran): drift-adjusted bootstrap test per candidate, BH-FDR within the
 * candidate family (Tier 1) and Bonferroni against the full disclosed search
 * (Tier 2), plus required forward sample sizes.
 *
 * Usage: npx tsx scripts/trial06_analyze.ts <export1.json> <export2.json> ...
 */
import * as fs from 'node:fs';
import '../src/config';
import { closedCandles, fetchCandlesSince, intervalToMs } from '../src/market';

interface ExportedSetup {
  t: string;
  action: 'BUY' | 'SELL';
  pnl: number;
}
interface CandidateExport {
  symbol: string;
  interval: string;
  strategy: string;
  lookback: number;
  horizon: number;
  feeBps: number;
  longOnly: boolean;
  windowStart: string;
  windowEnd: string;
  setups: ExportedSetup[];
}

/** Deterministic PRNG so the bootstrap is reproducible (pre-registered seed 42). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Acklam's inverse normal CDF approximation (sufficient precision for thresholds). */
function invNorm(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`invNorm domain: ${p}`);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}
function skew(xs: number[]): number {
  const m = mean(xs);
  const s = sd(xs);
  return xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0) / xs.length;
}

/** One-sided bootstrap p for H0: E[x] <= 0 — fraction of resampled means <= 0. */
function bootstrapP(xs: number[], resamples: number, rand: () => number): number {
  let atOrBelow = 0;
  const n = xs.length;
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)];
    if (s / n <= 0) atOrBelow++;
  }
  return Math.max(atOrBelow / resamples, 1 / resamples); // never report exactly 0
}

/** Unconditional mean 28d gross return (%) over the candidate's OOS window. */
async function driftGross(symbol: string, windowStartIso: string, horizon: number): Promise<number> {
  const candles = closedCandles(await fetchCandlesSince(symbol, '1d', Date.now() - 9600 * intervalToMs('1d')));
  const start = Date.parse(windowStartIso);
  const idx = candles.findIndex((c) => c.closeTime >= start);
  let sum = 0;
  let n = 0;
  for (let i = idx; i + horizon < candles.length; i++) {
    sum += (candles[i + horizon].close / candles[i].close - 1) * 100;
    n++;
  }
  return sum / n;
}

/** Unique tested configurations in trials.csv (window/fee views of one hypothesis collapsed). */
function countConfigs(): { rows: number; configs: number } {
  const lines = fs.readFileSync('data/trials.csv', 'utf8').split('\n').filter((l) => l.trim());
  const parse = (line: string): string[] => {
    const out: string[] = [];
    let f = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          f += '"';
          i++;
        } else if (ch === '"') q = false;
        else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        out.push(f);
        f = '';
      } else f += ch;
    }
    out.push(f);
    return out;
  };
  const keys = new Set<string>();
  for (const line of lines.slice(1)) {
    const c = parse(line);
    if (c.length < 19) continue;
    let params = c[6];
    try {
      const obj = JSON.parse(params);
      delete obj.window; // IS/OOS/full views of the same hypothesis
      params = JSON.stringify(obj);
    } catch {
      /* keep raw */
    }
    keys.add(`${c[5]}|${c[3].replace('BINANCE:', '')}|${params}`);
  }
  return { rows: lines.length - 1, configs: keys.size };
}

(async () => {
  const RESAMPLES = 10_000;
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('pass export JSON paths');
  const { rows, configs } = countConfigs();
  const zBonf = invNorm(1 - 0.05 / configs);
  console.log(`Trials ledger: ${rows} rows, ${configs} unique configurations.`);
  console.log(`Tier 2 Bonferroni threshold: p <= ${(0.05 / configs).toFixed(5)} (z >= ${zBonf.toFixed(2)})\n`);

  interface Row {
    name: string;
    n: number;
    meanRaw: number;
    driftL: number;
    meanEx: number;
    sdEx: number;
    skewEx: number;
    tEx: number;
    pRaw: number;
    pEx: number;
    nReq05: number | null;
    nReq01: number | null;
  }
  const out: Row[] = [];

  for (const file of files) {
    const exp: CandidateExport = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fee = exp.feeBps / 100;
    const g = await driftGross(exp.symbol, exp.windowStart, exp.horizon);
    const bLong = g - fee;
    const bShort = -g - fee;
    const raw = exp.setups.map((s) => s.pnl);
    const excess = exp.setups.map((s) => s.pnl - (s.action === 'BUY' ? bLong : bShort));
    const rand1 = mulberry32(42);
    const rand2 = mulberry32(42);
    const m = mean(excess);
    const s = sd(excess);
    const zA05 = invNorm(0.95);
    const zA01 = invNorm(0.99);
    const zB = invNorm(0.8);
    const nReq = (zA: number): number | null => (m > 0 ? Math.ceil((((zA + zB) * s) / m) ** 2) : null);
    out.push({
      name: `${exp.symbol} ${exp.longOnly ? 'long-only' : 'both-sides'}`,
      n: excess.length,
      meanRaw: mean(raw),
      driftL: bLong,
      meanEx: m,
      sdEx: s,
      skewEx: skew(excess),
      tEx: (m / s) * Math.sqrt(excess.length),
      pRaw: bootstrapP(raw, RESAMPLES, rand1),
      pEx: bootstrapP(excess, RESAMPLES, rand2),
      nReq05: nReq(zA05),
      nReq01: nReq(zA01),
    });
  }

  // Tier 1: BH-FDR at q=0.10 within the candidate family (on drift-adjusted p).
  const q = 0.1;
  const sorted = [...out].sort((a, b) => a.pEx - b.pEx);
  let kPass = 0;
  sorted.forEach((r, i) => {
    if (r.pEx <= ((i + 1) / sorted.length) * q) kPass = i + 1;
  });
  const bhPass = new Set(sorted.slice(0, kPass).map((r) => r.name));

  console.log('candidate            n   meanRaw%  drift_bL%  meanExcess%  sdEx%   skew   t     p_raw    p_excess  BH(q=.10)  Bonf(N)   nReq@.05  nReq@.01');
  for (const r of out) {
    const bh = bhPass.has(r.name) ? 'PASS' : 'fail';
    const bonf = r.pEx <= 0.05 / configs ? 'PASS' : 'fail';
    console.log(
      `${r.name.padEnd(20)} ${String(r.n).padEnd(3)} ${r.meanRaw.toFixed(3).padStart(8)}  ${r.driftL.toFixed(3).padStart(8)}  ${r.meanEx.toFixed(3).padStart(10)}  ${r.sdEx.toFixed(2).padStart(6)} ${r.skewEx.toFixed(2).padStart(6)} ${r.tEx.toFixed(2).padStart(5)}  ${r.pRaw.toFixed(4).padStart(7)}  ${r.pEx.toFixed(4).padStart(8)}  ${bh.padEnd(9)}  ${bonf.padEnd(8)} ${String(r.nReq05 ?? '—').padStart(8)}  ${String(r.nReq01 ?? '—').padStart(8)}`
    );
  }
  console.log(
    '\nVerdict key (pre-registered): Bonf PASS = corrected-significant candidate; BH-only PASS = indeterminate, forward sample decides (nReq cols); BH fail = demoted to watch, pilot-ineligible.'
  );
  console.log('drift_bL = long-leg no-skill benchmark (window mean 28d return − 30 bps). Short-leg benchmark is its mirror; SOL excess uses per-leg benchmarks.');
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
