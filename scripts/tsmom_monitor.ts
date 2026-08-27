/**
 * TSMOM regime monitor — the forward role Trial 07 assigned to this family:
 * re-compute the exact passed construction (daily-sign TSMOM-28 long-only,
 * unselected 8-crypto universe, 15 bps per position change, monthly timing
 * excess vs constant-mean-exposure benchmark) and watch whether the historical
 * effect is still alive.
 *
 * Pre-registered alarm (docs/paper_phase_protocol.md): trailing-12-month mean
 * excess < 0 → ALARM (historical effect not visible in the last year).
 * Trailing-6 < 0 → warning. Output appended-in-place to data/monitor_tsmom.csv.
 *
 * Run monthly (launchd com.jalenedusei.trading.tsmom-monitor) or manually via
 * `npm run tsmom:monitor`.
 */
import * as fs from 'node:fs';
import '../src/config';
import { closedCandles, fetchCandlesSince, intervalToMs } from '../src/market';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'];
const L = 28;
const COST_PER_UNIT = 0.0015;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

interface MonthMaps {
  months: string[];
  stratM: Map<string, number>;
  benchM: Map<string, number>;
}

async function buildSeries(symbol: string): Promise<MonthMaps> {
  const candles = closedCandles(await fetchCandlesSince(symbol, '1d', Date.now() - 9600 * intervalToMs('1d')));
  const c = candles.map((x) => x.close);
  const t = candles.map((x) => x.closeTime);
  const pos: number[] = new Array(c.length).fill(0);
  for (let i = L; i < c.length; i++) pos[i] = c[i] / c[i - L] - 1 > 0 ? 1 : 0;
  const ym = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
  const stratAcc = new Map<string, number>();
  const wUsed: number[] = [];
  const start = L + 2;
  for (let i = start; i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    wUsed.push(pos[i - 1]);
    const rStrat = pos[i - 1] * rAsset - COST_PER_UNIT * Math.abs(pos[i - 1] - pos[i - 2]);
    const key = ym(t[i]);
    stratAcc.set(key, (stratAcc.get(key) ?? 1) * (1 + rStrat));
  }
  const wbar = mean(wUsed);
  const benchAcc = new Map<string, number>();
  for (let i = start; i < c.length; i++) {
    const rAsset = c[i] / c[i - 1] - 1;
    const key = ym(t[i]);
    benchAcc.set(key, (benchAcc.get(key) ?? 1) * (1 + wbar * rAsset));
  }
  const keys = [...stratAcc.keys()].sort();
  const full = keys.slice(1, -1); // drop partial edge months
  const stratM = new Map<string, number>();
  const benchM = new Map<string, number>();
  for (const k of full) {
    stratM.set(k, (stratAcc.get(k) as number) - 1);
    benchM.set(k, (benchAcc.get(k) as number) - 1);
  }
  return { months: full, stratM, benchM };
}

(async () => {
  const series: MonthMaps[] = [];
  for (const sym of UNIVERSE) series.push(await buildSeries(sym));

  const all = new Set<string>();
  for (const s of series) for (const m of s.months) all.add(m);
  const months = [...all].sort();
  const rows: { month: string; excess: number; n: number }[] = [];
  for (const m of months) {
    const have = series.filter((s) => s.stratM.has(m));
    if (have.length === 0) continue;
    rows.push({ month: m, excess: mean(have.map((s) => (s.stratM.get(m) as number) - (s.benchM.get(m) as number))), n: have.length });
  }

  const csv = ['month,portfolio_excess_pct,symbols,trailing12_mean_pct,status'];
  for (let i = 0; i < rows.length; i++) {
    const window = rows.slice(Math.max(0, i - 11), i + 1).map((r) => r.excess);
    const t12 = window.length === 12 ? mean(window) : NaN;
    const status = Number.isNaN(t12) ? 'warmup' : t12 < 0 ? 'ALARM' : 'ok';
    csv.push(`${rows[i].month},${(rows[i].excess * 100).toFixed(3)},${rows[i].n},${Number.isNaN(t12) ? '' : (t12 * 100).toFixed(3)},${status}`);
  }
  fs.writeFileSync('data/monitor_tsmom.csv', csv.join('\n') + '\n');

  const last12 = rows.slice(-12);
  const t12 = mean(last12.map((r) => r.excess));
  const t6 = mean(rows.slice(-6).map((r) => r.excess));
  console.log(`TSMOM regime monitor — ${rows.length} completed months through ${rows[rows.length - 1].month} (written to data/monitor_tsmom.csv)`);
  console.log('Last 12 months (portfolio timing excess %/mo):');
  for (const r of last12) console.log(`  ${r.month}  ${(r.excess * 100).toFixed(2).padStart(7)}%  (${r.n} symbols)`);
  console.log(`Trailing-12 mean: ${(t12 * 100).toFixed(3)}%/mo · trailing-6 mean: ${(t6 * 100).toFixed(3)}%/mo`);
  if (t12 < 0) console.log('STATUS: ALARM — trailing-12-month excess is negative: the historical effect is NOT visible in the last year.');
  else if (t6 < 0) console.log('STATUS: warning — trailing-6-month excess negative (trailing-12 still positive).');
  else console.log('STATUS: ok — the historical effect remains visible.');
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
