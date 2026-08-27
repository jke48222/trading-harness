import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// CONFIG is a frozen singleton read at import, so ALL test config must be set
// BEFORE the dynamic imports below. Tests then exercise the exported leaf
// functions against this one fixed configuration.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
process.env.EXECUTION = 'sim';
process.env.FAST_MA = '2';
process.env.SLOW_MA = '3';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_STATE = 'off';
process.env.BUDGET = '100000';
process.env.CRYPTO_CLUSTER_CAP_PCT = '70';
process.env.MAX_OPEN_POSITIONS = '50';
process.env.PER_TRADE_USD = '2000';
process.env.VOL_TARGET_PCT = '4';
process.env.VOL_SIZE_FLOOR = '0.25';
process.env.MAX_DAILY_LOSS_PCT = '8';

const { smaCrossSignalAt, tsmomSignalAt } = await import('../src/strategy.ts');
const { computeSetups } = await import('../src/replay.ts');
const { csvEscape, appendLedgerRow, loadLedger, writeLedger, resetMemory } = await import('../src/memory.ts');
const risk = await import('../src/portfolioRisk.ts');
import type { Candle } from '../src/types.ts';

function series(closes: number[]): Candle[] {
  const iMs = 86_400_000;
  return closes.map((c, i) => ({ openTime: i * iMs, open: c, high: c, low: c, close: c, volume: 1, closeTime: (i + 1) * iMs - 1 }));
}
function acct(equity: number) {
  return { account_number: 'x', status: 'ACTIVE', cash: '0', equity: String(equity), portfolio_value: String(equity), buying_power: '0' };
}

test('sma-cross fires BUY on a fresh upward crossover, not before', () => {
  const c = series([10, 9, 8, 7, 12, 13]); // fast(2) crosses above slow(3) on the rally
  assert.equal(smaCrossSignalAt(c, 3).action, 'HOLD', 'no cross while falling');
  const anyBuy = [4, 5].some((i) => smaCrossSignalAt(c, i).action === 'BUY');
  assert.ok(anyBuy, 'expected a BUY once fast crosses above slow');
});

test('tsmom flip: BUY on the candle momentum turns positive, HOLD otherwise', () => {
  const flip = series([10, 10, 10, 9, 11]); // i=4: +10% vs close[1]; i=3 was -10% → fresh flip up
  assert.equal(tsmomSignalAt(flip, 4).action, 'BUY');
  const noflip = series([10, 11, 12, 13, 14]); // momentum already positive at i-1 → no fresh flip
  assert.equal(tsmomSignalAt(noflip, 4).action, 'HOLD');
});

test('replay scoring: pnl = gross return minus the fee, classified win/loss', () => {
  // warmup = lookback+1 = 4; fresh flip up at i=4 (close[3]≤close[0], close[4]>close[1]); exit at i+2.
  const c = series([100, 100, 100, 95, 105, 108, 112, 115]);
  const { setups } = computeSetups(c);
  const scored = setups.filter((s) => s.outcome !== 'incomplete' && s.action === 'BUY' && s.exitPrice != null);
  assert.ok(scored.length > 0, 'expected a scored BUY setup');
  for (const s of scored) {
    const gross = ((s.exitPrice! - s.entryPrice) / s.entryPrice) * 100;
    assert.ok(Math.abs((s.pnlPct ?? 0) - (gross - 0.3)) < 1e-6, 'pnl must be gross minus 30 bps');
    assert.equal(s.outcome, (s.pnlPct ?? 0) > 0 ? 'win' : (s.pnlPct ?? 0) < 0 ? 'loss' : 'flat');
  }
});

test('csv escape round-trips fields with commas and quotes', () => {
  resetMemory();
  const tricky = 'has,comma "and" quote';
  appendLedgerRow({ timestamp: 't', symbol: 'X', action: 'BUY', price: '1', quantity: '1', reason: tricky, mode: 'scan', outcome: 'open', pnl: '' });
  assert.equal(loadLedger()[0].reason, tricky);
  assert.equal(csvEscape('a,b'), '"a,b"');
});

test('atomic writeLedger replaces content without corruption', () => {
  resetMemory();
  appendLedgerRow({ timestamp: 't1', symbol: 'A', action: 'BUY', price: '1', quantity: '1', reason: 'r', mode: 'scan', outcome: 'open', pnl: '' });
  const rows = loadLedger();
  rows[0].outcome = 'win';
  rows[0].pnl = '1.5';
  writeLedger(rows);
  const back = loadLedger();
  assert.equal(back.length, 1);
  assert.equal(back[0].outcome, 'win');
});

test('risk: realized volatility and vol-scaled sizing clamp correctly', () => {
  assert.equal(risk.realizedVolPct(series([100, 100, 100, 100, 100])), 0);
  const flat = risk.volScaledNotional(series([100, 100, 100, 100, 100]));
  assert.equal(flat.notional, 2000, 'zero-vol → full size');
  const volatile = risk.volScaledNotional(series([100, 110, 99, 109, 98, 108]));
  assert.ok(volatile.frac >= 0.25 && volatile.frac < 1, 'high vol → scaled down but not below floor');
  assert.ok(volatile.notional < 2000);
});

test('risk: daily-loss kill switch triggers past the threshold', () => {
  resetMemory();
  const now = Date.UTC(2026, 6, 15, 12, 0, 0);
  risk.dayStartEquity(100_000, now);
  assert.equal(risk.dailyLossHalt(acct(95_000), now).halted, false, '-5% must not halt');
  assert.equal(risk.dailyLossHalt(acct(90_000), now).halted, true, '-10% must halt');
});

test('risk: crypto cluster cap blocks over-concentration', () => {
  const ctx = { entriesHalted: false, haltReason: '', dailyPnlPct: 0, deployed: 69_000, cryptoDeployed: 69_000, openCount: 34, openSymbols: new Set<string>() };
  const d = risk.evaluateEntry('ETHUSDT', 'ETHUSD', series([100, 101, 102, 103, 104, 105]), ctx);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /cluster cap/);
});

test('risk: halt denies every new entry', () => {
  const ctx = { entriesHalted: true, haltReason: 'kill switch', dailyPnlPct: -9, deployed: 0, cryptoDeployed: 0, openCount: 0, openSymbols: new Set<string>() };
  assert.equal(risk.evaluateEntry('BTCUSDT', 'BTCUSD', series([100, 101, 102, 103, 104, 105]), ctx).allowed, false);
});

test('risk: a clean entry is allowed and sized', () => {
  const ctx = { entriesHalted: false, haltReason: '', dailyPnlPct: 1, deployed: 0, cryptoDeployed: 0, openCount: 0, openSymbols: new Set<string>() };
  const d = risk.evaluateEntry('BTCUSDT', 'BTCUSD', series([100, 100, 100, 100, 100, 100]), ctx);
  assert.equal(d.allowed, true);
  assert.ok(d.notional > 0 && d.notional <= 2000);
});
