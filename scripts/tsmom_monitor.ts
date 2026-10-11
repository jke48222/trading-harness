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
import * as path from 'node:path';
import { CONFIG } from '../src/config';
import { closedCandles, fetchCandlesSince, intervalToMs } from '../src/market';
import { writeAtomic } from '../src/memory';
import { buildSymbolSeries, mean, portfolioExcess, type SymbolSeries } from '../src/tsmomPortfolio';
import { TRIAL07_CRYPTO } from '../src/universe';

const UNIVERSE = TRIAL07_CRYPTO;
const L = 28;
const COST_PER_UNIT = 0.0015;

async function buildSeries(symbol: string): Promise<SymbolSeries> {
  const candles = closedCandles(await fetchCandlesSince(symbol, '1d', Date.now() - 9600 * intervalToMs('1d')));
  // Keep only months the return series fully covers (crypto trades daily, so no gap allowed).
  return buildSymbolSeries(symbol, candles, {
    lookback: L,
    costPerUnit: COST_PER_UNIT,
    execution: 'close',
    monthBy: 'closeTime',
    maxGapDays: 0,
    nowMs: Date.now(),
  });
}

(async () => {
  const series: SymbolSeries[] = [];
  for (const sym of UNIVERSE) series.push(await buildSeries(sym));

  // Equal-weight portfolio excess across the symbols live each month.
  const port = portfolioExcess(series);
  const rows = port.months.map((month, i) => ({ month, excess: port.excess[i], n: port.live[i] }));

  const csv = ['month,portfolio_excess_pct,symbols,trailing12_mean_pct,status'];
  for (let i = 0; i < rows.length; i++) {
    const window = rows.slice(Math.max(0, i - 11), i + 1).map((r) => r.excess);
    const t12 = window.length === 12 ? mean(window) : NaN;
    const status = Number.isNaN(t12) ? 'warmup' : t12 < 0 ? 'ALARM' : 'ok';
    csv.push(`${rows[i].month},${(rows[i].excess * 100).toFixed(3)},${rows[i].n},${Number.isNaN(t12) ? '' : (t12 * 100).toFixed(3)},${status}`);
  }
  // Atomic: health and the dashboard read this file every few minutes.
  writeAtomic(path.join(CONFIG.dataDir, 'monitor_tsmom.csv'), csv.join('\n') + '\n');

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
