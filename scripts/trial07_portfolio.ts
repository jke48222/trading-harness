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
import {
  annSharpe,
  bootstrapP,
  buildSymbolSeries,
  countConfigs,
  mean,
  mulberry32,
  portfolioExcess,
  sd,
  symbolExcess,
  type SymbolSeries,
} from '../src/tsmomPortfolio';

const UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'];
const SELECTED5 = ['ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT', 'SOLUSDT'];
const L = 28;
const COST_PER_UNIT = 0.0015; // 15 bps per unit of position change = 30 bps round trip

async function buildSeries(symbol: string, bothSides: boolean): Promise<SymbolSeries> {
  const candles = closedCandles(await fetchCandlesSince(symbol, '1d', Date.now() - 9600 * intervalToMs('1d')));
  // The sign at each close is applied to the next day's return, charged per unit of
  // position change. Partial first and last calendar months are dropped (the
  // pre-registered rule; the old slice(1, -1) also dropped a finished last month when run on the 1st).
  return buildSymbolSeries(symbol, candles, {
    lookback: L,
    costPerUnit: COST_PER_UNIT,
    execution: 'close',
    bothSides,
    monthBy: 'closeTime',
    maxGapDays: 0,
    nowMs: Date.now(),
  });
}

(async () => {
  const longOnly: SymbolSeries[] = [];
  for (const sym of UNIVERSE) longOnly.push(await buildSeries(sym, false));
  const bothSides: SymbolSeries[] = [];
  for (const sym of UNIVERSE) bothSides.push(await buildSeries(sym, true));

  console.log('Per-symbol (long-only, canonical daily-sign TSMOM-28, 15 bps per position change):');
  console.log('symbol     months  wbar   turns/yr  meanExcess%/mo  annExcessSharpe  annRawSharpe');
  for (const s of longOnly) {
    const ex = symbolExcess(s);
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
  const nConfigs = countConfigs(fs.readFileSync('data/trials.csv', 'utf8'));

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
