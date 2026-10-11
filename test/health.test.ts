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
  return { label: 'book', at: new Date().toISOString(), startedAt: '', interval: '1d', execution: 'alpaca-paper', symbols: 56, failures: [], entries: [], partials: [], unfilled: [], unknown: [], rejects: [], spreadSkips: [], exits: [], exitFailures: [], orphans: [], swept: 0, adopted: 0, exitsAdded: 0, needsReview: [], stepFailures: [], exitsRan: true, entriesBlocked: null, attempts: {}, entryMisses: {}, lastCryptoWindowScan: new Date().toISOString(), offline: false, offlineStreak: 0, universe: [], rule: '', ...p };
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
  const runs = [1, 2, 3, 4, 5].map((i) => now - i * 30 * 60_000); // health ran five times since the book did
  const r = evaluateHealth({
    nowMs: now,
    heartbeats: [hb({ at: new Date(now - 3 * 3_600_000).toISOString(), rejects: ['XRPUSDT: HTTP 403 insufficient balance'] }), quiet[1], quiet[2]],
    healthRunTimes: runs,
    rows: [],
    monitor: { ...okMonitor, month: '2026-01' },
    broker: {
      positions: [{ symbol: 'BONKUSD', qty: '1', avg_entry_price: '1', market_value: '1', unrealized_pl: '0', current_price: '1' }],
      openOrders: [order({ client_order_id: 'bot-LDOUSDT-1', status: 'new', submitted_at: new Date(now - 3_600_000).toISOString() })],
      account: { ...acct, non_marginable_buying_power: '0' },
    },
  });
  const all = r.problems.join(' | ');
  assert.match(all, /has not run while health ran 5 times \(its last scan was 180 min ago\)/);
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

test('health: a book scan that aborted, or skipped its exit manager, pages', () => {
  const r = evaluateHealth({ nowMs: Date.now(), heartbeats: [hb({ stepFailures: ['exits: HTTP 401'], exitsRan: false }), quiet[1], quiet[2]], rows: [], monitor: okMonitor });
  assert.match(r.problems.join(' | '), /scan steps failed: exits: HTTP 401/);
  assert.match(r.problems.join(' | '), /exit manager did not run/);
});

test('health: a wanted entry missed four scans running pages; a spread streak only warns', () => {
  const r = evaluateHealth({
    nowMs: Date.now(),
    heartbeats: [hb({ entryMisses: { LDOUSDT: { n: 4, kind: 'unfilled' }, PAXGUSDT: { n: 9, kind: 'spread' }, ONDOUSDT: { n: 3, kind: 'refused' } } }), quiet[1], quiet[2]],
    rows: [],
    monitor: okMonitor,
  });
  assert.match(r.problems.join(' | '), /LDOUSDT 4x unfilled/);
  assert.doesNotMatch(r.problems.join(' | '), /ONDOUSDT/, 'three misses is not yet a pattern');
  assert.match(r.warnings.join(' | '), /PAXGUSDT 9x/);
});

test('health: an old heartbeat from an ad hoc run never pages', () => {
  const old = hb({ label: 'tsmom-state-1d-alpaca-paper-56sym', at: new Date(Date.now() - 30 * 86_400_000).toISOString(), orphans: ['BONKUSDT'] });
  const r = evaluateHealth({ nowMs: Date.now(), heartbeats: [...quiet, old], rows: [], monitor: okMonitor });
  assert.deepEqual(r.problems, []);
});

test('health: staleness is counted in awake time (health runs), so sleep neither pages nor hides a dead agent', () => {
  const now = Date.now();
  const stale = [hb({ at: new Date(now - 8 * 3_600_000).toISOString() }), quiet[1], quiet[2]];
  // The Mac slept 8 hours: health has only run twice since the book's last scan.
  const justWoke = evaluateHealth({ nowMs: now, heartbeats: stale, rows: [], monitor: okMonitor, healthRunTimes: [now - 30 * 60_000, now] });
  assert.equal(justWoke.problems.length, 0);
  // Awake for 2.5 hours and still no book scan: the agent is dead, whenever the Mac last woke.
  const dead = evaluateHealth({ nowMs: now, heartbeats: stale, rows: [], monitor: okMonitor, healthRunTimes: [4, 3, 2, 1, 0].map((i) => now - i * 30 * 60_000) });
  assert.match(dead.problems.join(' | '), /has not run while health ran 5 times/);
  // An unreadable stamp is stale, never fresh.
  const garbled = evaluateHealth({ nowMs: now, heartbeats: [hb({ at: 'not a date' }), quiet[1], quiet[2]], rows: [], monitor: okMonitor, healthRunTimes: [4, 3, 2, 1, 0].map((i) => now - i * 30 * 60_000) });
  assert.match(garbled.problems.join(' | '), /has not run while health ran 5 times/);
});

test('health: a regime ALARM is a warning plus a once-a-month notice, not a page every 30 minutes', () => {
  const r = evaluateHealth({ nowMs: Date.now(), heartbeats: quiet, rows: [], monitor: { ...okMonitor, status: 'ALARM' } });
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings.join(' | '), /ALARM/);
  assert.deepEqual(r.notices.map((n) => n.key), [`alarm:${okMonitor.month}`]);
});

test('health: an offline scan warns once and pages when it repeats', () => {
  const once = evaluateHealth({ nowMs: Date.now(), heartbeats: [hb({ offline: true, offlineStreak: 1, exitsRan: false }), quiet[1], quiet[2]], rows: [], monitor: okMonitor });
  assert.deepEqual(once.problems, [], 'one dark-wake scan with no network is not an outage');
  const twice = evaluateHealth({ nowMs: Date.now(), heartbeats: [hb({ offline: true, offlineStreak: 2, exitsRan: false }), quiet[1], quiet[2]], rows: [], monitor: okMonitor });
  assert.match(twice.problems.join(' | '), /last 2 scan\(s\) could not reach/);
});

test('health: a position outside the book universe pages (nothing manages it)', () => {
  const positions = [{ symbol: 'XLKX', qty: '3', avg_entry_price: '1', market_value: '1', unrealized_pl: '0', current_price: '1' }];
  const r = evaluateHealth({ nowMs: Date.now(), heartbeats: [hb({ universe: ['BTCUSDT', 'SPY'] }), quiet[1], quiet[2]], rows: [], monitor: okMonitor, broker: { positions, openOrders: [], account: acct } });
  assert.match(r.problems.join(' | '), /outside the book's universe/);
});

test('health: the broker unreachable once warns, twice in a row pages', () => {
  const once = evaluateHealth({ nowMs: Date.now(), heartbeats: quiet, rows: [], monitor: okMonitor, brokerError: 'HTTP 503', brokerFailStreak: 1 });
  assert.equal(once.problems.length, 0);
  const twice = evaluateHealth({ nowMs: Date.now(), heartbeats: quiet, rows: [], monitor: okMonitor, brokerError: 'HTTP 503', brokerFailStreak: 2 });
  assert.match(twice.problems.join(' | '), /Could not reach the broker \(2 check/);
});

test('health: while a book scan runs, a position without its row yet is not an orphan', () => {
  const positions = [{ symbol: 'ETHUSD', qty: '1', avg_entry_price: '1', market_value: '1', unrealized_pl: '0', current_price: '1' }];
  const r = evaluateHealth({ nowMs: Date.now(), heartbeats: quiet, rows: [], monitor: okMonitor, bookScanRunning: true, broker: { positions, openOrders: [], account: acct } });
  assert.deepEqual(r.problems, []);
});


test('health: no scan inside the crypto entry window for over a day warns and notifies once a day', () => {
  const now = Date.now();
  const r = evaluateHealth({ nowMs: now, heartbeats: [hb({ lastCryptoWindowScan: new Date(now - 30 * 3_600_000).toISOString() }), quiet[1], quiet[2]], rows: [], monitor: okMonitor });
  assert.deepEqual(r.problems, [], 'a sleeping Mac is a habit to fix, not a 30-minute page');
  assert.match(r.warnings.join(' | '), /crypto entry window/);
  assert.deepEqual(r.notices.map((n) => n.key), [`crypto-window:${new Date(now).toISOString().slice(0, 10)}`]);
  const fresh = evaluateHealth({ nowMs: now, heartbeats: [hb({ lastCryptoWindowScan: null }), quiet[1], quiet[2]], rows: [], monitor: okMonitor });
  assert.deepEqual([fresh.problems, fresh.notices], [[], []], 'not yet recorded is info only');
});
