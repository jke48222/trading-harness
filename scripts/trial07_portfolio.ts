/**
 * Trial 07 (pre-registered in docs/trial_07_portfolio_reanalysis.md BEFORE running):
 * portfolio-level test of the TSMOM-28 family on the UNSELECTED 8-crypto universe.
 *
 * Canonical construction: daily sign-based exposure (long-only), 15 bps per unit
 * of position change, monthly compounding, timing excess vs the strategy's own
 * constant average exposure. One primary number: bootstrap p on the equal-weight
 * portfolio's monthly timing excess.
 */
import * as fs from 'node:fs';
import '../src/config';
import { closedCandles, fetchCandlesSince, intervalToMs } from '../src/market';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'];
const SELECTED5 = ['ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT', 'SOLUSDT'];
const L = 28;
const COST_PER_UNIT = 0.0015; // 15 bps per unit of position change = 30 bps round trip

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
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
};
function bootstrapP(xs: number[], resamples: number, rand: () => number): number {
  let atOrBelow = 0;
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rand() * xs.length)];
    if (s / xs.length <= 0) atOrBelow++;
  }
  return Math.max(atOrBelow / resamples, 1 / resamples);
}

interface SymbolSeries {
  symbol: string;
  months: string[]; // sorted keys with full data
  stratM: Map<string, number>;
  benchM: Map<string, number>;
  bhM: Map<string, number>;
  wbar: number;
  turnoverPerYear: number;
  nDays: number;
}

async function buildSeries(symbol: string, bothSides: boolean): Promise<SymbolSeries> {
  const candles = closedCandles(await fetchCandlesSince(symbol, '1d', Date.now() - 9600 * intervalToMs('1d')));
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
  // exposure applied to day i's return is pos[i-1]; turnover charged on pos[i-1] vs pos[i-2]
  const start = L + 2;
  for (let i = start; i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    wUsed.push(pos[i - 1]);
    turnover += Math.abs(pos[i - 1] - pos[i - 2]);
    const rStrat = pos[i - 1] * rAsset - COST_PER_UNIT * Math.abs(pos[i - 1] - pos[i - 2]);
    const key = ym(t[i]);
    stratAcc.set(key, (stratAcc.get(key) ?? 1) * (1 + rStrat));
    bhAcc.set(key, (bhAcc.get(key) ?? 1) * (1 + rAsset));
    // benchmark applied after wbar is known — store asset growth, convert later
  }
  const wbar = mean(wUsed);
  const benchKeys = new Map<string, number>();
  for (let i = start; i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    const key = ym(t[i]);
    benchKeys.set(key, (benchKeys.get(key) ?? 1) * (1 + wbar * rAsset));
  }
  for (const [k, v] of benchKeys) benchAcc.set(k, v);
  const keys = [...stratAcc.keys()].sort();
  const full = keys.slice(1, -1); // drop partial first and last calendar months
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

function portfolioExcess(series: SymbolSeries[]): { months: string[]; excess: number[]; raw: number[]; bh: number[] } {
  const all = new Set<string>();
  for (const s of series) for (const m of s.months) all.add(m);
  const months = [...all].sort();
  const excess: number[] = [];
  const raw: number[] = [];
  const bh: number[] = [];
  const outMonths: string[] = [];
  for (const m of months) {
    const have = series.filter((s) => s.stratM.has(m));
    if (have.length === 0) continue;
    outMonths.push(m);
    excess.push(mean(have.map((s) => (s.stratM.get(m) as number) - (s.benchM.get(m) as number))));
    raw.push(mean(have.map((s) => s.stratM.get(m) as number)));
    bh.push(mean(have.map((s) => s.bhM.get(m) as number)));
  }
  return { months: outMonths, excess, raw, bh };
}

function annSharpe(xs: number[]): number {
  return (mean(xs) / sd(xs)) * Math.sqrt(12);
}

function countConfigs(): number {
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
      delete obj.window;
      params = JSON.stringify(obj);
    } catch {
      /* keep raw */
    }
    keys.add(`${c[5]}|${c[3].replace('BINANCE:', '')}|${params}`);
  }
  return keys.size;
}

(async () => {
  const longOnly: SymbolSeries[] = [];
  for (const sym of UNIVERSE) longOnly.push(await buildSeries(sym, false));
  const bothSides: SymbolSeries[] = [];
  for (const sym of UNIVERSE) bothSides.push(await buildSeries(sym, true));

  console.log('Per-symbol (long-only, canonical daily-sign TSMOM-28, 15 bps per position change):');
  console.log('symbol     months  wbar   turns/yr  meanExcess%/mo  annExcessSharpe  annRawSharpe');
  for (const s of longOnly) {
    const ex = s.months.map((m) => (s.stratM.get(m) as number) - (s.benchM.get(m) as number));
    const raw = s.months.map((m) => s.stratM.get(m) as number);
    console.log(
      `${s.symbol.padEnd(10)} ${String(s.months.length).padEnd(6)} ${s.wbar.toFixed(2).padStart(5)} ${s.turnoverPerYear.toFixed(1).padStart(9)}  ${(mean(ex) * 100).toFixed(3).padStart(13)}  ${annSharpe(ex).toFixed(2).padStart(15)}  ${annSharpe(raw).toFixed(2).padStart(12)}`
    );
  }

  // PRIMARY (locked): equal-weight all-8 long-only portfolio monthly timing excess.
  const port = portfolioExcess(longOnly);
  const m = mean(port.excess);
  const s = sd(port.excess);
  const tStat = (m / s) * Math.sqrt(port.excess.length);
  const p = bootstrapP(port.excess, 10_000, mulberry32(42));
  const nConfigs = countConfigs();

  console.log(`\n=== PRIMARY (pre-registered) ===`);
  console.log(`Equal-weight ALL-8 long-only portfolio: ${port.excess.length} months (${port.months[0]} -> ${port.months[port.months.length - 1]})`);
  console.log(`mean timing excess ${(m * 100).toFixed(3)}%/mo · sd ${(s * 100).toFixed(2)}% · t=${tStat.toFixed(2)} · ann excess Sharpe ${annSharpe(port.excess).toFixed(2)}`);
  console.log(`bootstrap p (one-sided, 10k, seed 42) = ${p.toFixed(4)} · decision threshold 0.05`);
  console.log(`Bonferroni context (not the decision rule): p x ${nConfigs + 1} configs = ${(p * (nConfigs + 1)).toFixed(3)}`);
  console.log(`VERDICT: ${p <= 0.05 ? 'PASS — family is portfolio-level significant; redesign forward gate around monthly returns' : 'FAIL — TSMOM-28 family REJECTED per pre-registration'}`);

  // Descriptives.
  console.log(`\n--- Descriptives (non-decisional) ---`);
  console.log(`Portfolio raw: mean ${(mean(port.raw) * 100).toFixed(2)}%/mo, ann Sharpe ${annSharpe(port.raw).toFixed(2)} · EW buy-and-hold: mean ${(mean(port.bh) * 100).toFixed(2)}%/mo, ann Sharpe ${annSharpe(port.bh).toFixed(2)}`);
  const sel = portfolioExcess(longOnly.filter((x) => SELECTED5.includes(x.symbol)));
  console.log(`Selected-5 portfolio excess: mean ${(mean(sel.excess) * 100).toFixed(3)}%/mo, p=${bootstrapP(sel.excess, 10_000, mulberry32(42)).toFixed(4)} (${sel.excess.length} mo) — selection-inflation check`);
  const both = portfolioExcess(bothSides);
  console.log(`Both-sides all-8 portfolio excess: mean ${(mean(both.excess) * 100).toFixed(3)}%/mo, p=${bootstrapP(both.excess, 10_000, mulberry32(42)).toFixed(4)} (${both.excess.length} mo)`);
  const cut = '2023-12';
  const recentIdx = port.months.map((mm, i) => (mm >= cut ? i : -1)).filter((i) => i >= 0);
  const recent = recentIdx.map((i) => port.excess[i]);
  console.log(`OOS-era subsample (months >= ${cut}): mean ${(mean(recent) * 100).toFixed(3)}%/mo, p=${bootstrapP(recent, 10_000, mulberry32(42)).toFixed(4)} (${recent.length} mo)`);
  if (p <= 0.05) {
    const zA = 1.6449;
    const zB = 0.8416;
    const nReq = Math.ceil((((zA + zB) * s) / m) ** 2);
    console.log(`Forward gate if adopted: n_req ${nReq} monthly observations at alpha=.05 / 80% power.`);
  }
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
