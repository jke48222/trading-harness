import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { order } from './helpers.ts';
import type { ScanStats } from '../src/bot.ts';

// Health rules: what pages you, what only warns.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-health-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const { evaluateHealth, expectedMonitorMonth } = await import('../src/health.ts');

function hb(p: Partial<ScanStats>): ScanStats {
  return { label: 'book', at: new Date().toISOString(), startedAt: '', interval: '1d', execution: 'alpaca-paper', symbols: 56, failures: [], entries: [], partials: [], unfilled: [], unknown: [], rejects: [], spreadSkips: [], exits: [], exitFailures: [], orphans: [], swept: 0, adopted: 0, ...p };
}

const okMonitor = { month: expectedMonitorMonth(Date.now()), status: 'ok', trailing12: '0.6' };

const quiet = [hb({}), hb({ label: 'watch-flip', execution: 'sim' }), hb({ label: 'watch-sol', execution: 'sim' })];

const acct = { account_number: 'x', status: 'ACTIVE', cash: '50000', equity: '100000', portfolio_value: '100000', buying_power: '0', non_marginable_buying_power: '50000' };

test('health: a quiet, healthy book has no problems', () => {
  const r = evaluateHealth({ nowMs: Date.now(), heartbeats: quiet, rows: [], monitor: okMonitor, broker: { positions: [], openOrders: [], account: acct } });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
});

test('health: broker refusals, a stale book, orphans and resting orders are all PROBLEMs', () => {
  const now = Date.now();
  const r = evaluateHealth({
    nowMs: now,
    heartbeats: [hb({ at: new Date(now - 3 * 3_600_000).toISOString(), rejects: ['XRPUSDT: HTTP 403 insufficient balance'] }), quiet[1], quiet[2]],
    rows: [],
    monitor: { ...okMonitor, month: '2026-01' },
    broker: {
      positions: [{ symbol: 'BONKUSD', qty: '1', avg_entry_price: '1', market_value: '1', unrealized_pl: '0', current_price: '1' }],
      openOrders: [order({ client_order_id: 'bot-LDOUSDT-1', status: 'new', submitted_at: new Date(now - 3_600_000).toISOString() })],
      account: { ...acct, non_marginable_buying_power: '0' },
    },
  });
  const all = r.problems.join(' | ');
  assert.match(all, /last ran 180 min ago/);
  assert.match(all, /refused 1 order/);
  assert.match(all, /BONKUSD with no open ledger entry/);
  assert.match(all, /resting at the broker/);
  assert.match(r.warnings.join(' | '), /monitor is behind/);
  assert.match(r.warnings.join(' | '), /buying power/);
});

test('expectedMonitorMonth: from the 3rd, last month is due', () => {
  assert.equal(expectedMonitorMonth(Date.parse('2026-10-11T03:00:00Z')), '2026-09');
  assert.equal(expectedMonitorMonth(Date.parse('2026-10-02T12:00:00Z')), '2026-08', 'grace for the run on the 1st');
  assert.equal(expectedMonitorMonth(Date.parse('2026-10-03T00:00:01Z')), '2026-09');
});
