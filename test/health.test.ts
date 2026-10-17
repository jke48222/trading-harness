import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mockFetch, order } from './helpers.ts';
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

const { evaluateHealth, expectedMonitorMonth, readCash, settleState } = await import('../src/health.ts');

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

// ---- cash from outside the book (docs/incidents.md, 2026-10-13 journal) ----

const at = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const flow = (date: string, amount: number, type = 'JNLC') => ({ t: at(date), date, type, amount });
const logged = (date: string, amount: number, type = 'JNLC') => ({ id: `${type}-${date}-${amount}`, type, date, amount });
const journal = flow('2026-10-14', -66905.32);
const funding = flow('2026-07-15', 100000);
const FUNDING_LOGGED = logged('2026-07-14', 100000);
const JOURNAL_KEY = 'JNLC:2026-10-14:-66905.32';
/** The account on 2026-10-17: broker cash -$16,595.09, the activity log's cash +$50,325.06, $5,899.03 of crypto sold since 00:10 UTC. */
const afterJournal = { ...acct, cash: '-16595.09', equity: '36004.19', buying_power: '0', non_marginable_buying_power: '0' };
/** What a cash read returns: the history's external flows, and the activity log's cash and external activities (the log never listed the journal). */
function cashInput(p: { flows?: (typeof journal)[]; external?: ReturnType<typeof logged>[]; logCash?: number; sales?: number; asOfMs?: number } = {}) {
  return {
    asOfMs: p.asOfMs ?? Date.now(),
    flows: p.flows ?? [funding, journal],
    rebuild: { cash: p.logCash ?? 50325.06, activities: 1306, external: p.external ?? [FUNDING_LOGGED], recentCryptoSalesUsd: p.sales ?? 5899.03 },
  };
}
const broker = (account: typeof acct) => ({ positions: [], openOrders: [], account });
const run = (p: Partial<Parameters<typeof evaluateHealth>[0]>) => evaluateHealth({ nowMs: Date.now(), heartbeats: quiet, rows: [], monitor: okMonitor, ...p });

test('health: the 2026-10-13 journal pages the first run that sees it, with the activity log gap, and negative cash pages too', () => {
  const r = run({ broker: broker(afterJournal), cash: cashInput(), knownFlows: [] });
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /^New external cash flow: JNLC -\$66,905\.32 in the 2026-10-14 history point\. The bot can't move cash/, 'the new flow leads, so the page names it');
  assert.match(r.problems[0], /activity log does not list it: broker cash is \$66,920\.15 below the \$50,325\.06 the log accounts for\. It pages once; npm run perf leaves it out of returns\.$/);
  assert.match(r.problems[1], /^Cash is -\$16,595\.09 and crypto buying power is \$0\.00: .*refuse its next crypto entry\. External cash flows since the funding total -\$66,905\.32\./);
  assert.deepEqual(r.newFlows, [JOURNAL_KEY], 'the funding of 2026-07-15 is never news');
  assert.equal(r.cashGap, false, 'the journal explains the gap; $14.83 is left, inside $50 plus the unposted fee room');
  assert.doesNotMatch(r.warnings.join(' | '), /Crypto buying power/, 'negative cash already says it, as a problem');
});

test('health: once paged, the journal is on record and negative cash keeps paging', () => {
  const second = run({ broker: broker(afterJournal), cash: cashInput(), knownFlows: [JOURNAL_KEY] });
  assert.equal(second.problems.length, 1);
  assert.match(second.problems[0], /^Cash is -\$16,595\.09/);
  assert.deepEqual(second.newFlows, []);
  assert.match(second.warnings.join(' | '), /activity log still leaves out JNLC -\$66,905\.32 \(2026-10-14 history point\); counting it, broker cash reconciles within \$14\.83/);
  assert.match(second.info.join(' | '), /External cash flow on record: JNLC -\$66,905\.32 in the 2026-10-14 history point/);
});

test('health: a reversal pages once, from whichever record shows it first, and never as a false gap', () => {
  const reversal = flow('2026-10-21', 66905.32);
  const restored = broker({ ...afterJournal, cash: '50310.23', non_marginable_buying_power: '50310.23' });
  // The log lists the reversal before the history books it: it pages from the log, and cash reconciles.
  const fromLog = run({ broker: restored, cash: cashInput({ external: [FUNDING_LOGGED, logged('2026-10-20', 66905.32)], logCash: 50325.06 + 66905.32 }), knownFlows: [JOURNAL_KEY] });
  assert.equal(fromLog.problems.length, 1);
  assert.match(fromLog.problems[0], /^New external cash flow: JNLC \+\$66,905\.32 in the activity log, dated 2026-10-20; the daily history does not show it yet\. .* It pages once\.$/);
  assert.equal(fromLog.cashGap, false, 'the log has it and so does broker cash: no gap');
  assert.deepEqual(fromLog.newFlows, ['log:JNLC-2026-10-20-66905.32'], 'a flow seen in the log is keyed by its activity id');
  // The history books it a day later: the same flow, so no second page.
  const booked = run({ broker: restored, cash: cashInput({ flows: [funding, journal, reversal], external: [FUNDING_LOGGED, logged('2026-10-20', 66905.32)], logCash: 50325.06 + 66905.32 }), knownFlows: [JOURNAL_KEY, ...fromLog.newFlows] });
  assert.deepEqual([booked.problems, booked.newFlows, booked.cashGap], [[], [], false]);
  assert.deepEqual(booked.seenFlows, ['JNLC:2026-10-21:66905.32'], 'the history\'s key for it is kept too');
  // Or, like the journal, it is in the history and missing from the log: it pages from the history, and the two flows net out of the gap.
  const historyOnly = run({ broker: restored, cash: cashInput({ flows: [funding, journal, reversal] }), knownFlows: [JOURNAL_KEY] });
  assert.equal(historyOnly.problems.length, 1);
  assert.match(historyOnly.problems[0], /^New external cash flow: JNLC \+\$66,905\.32 in the 2026-10-21 history point/);
  assert.equal(historyOnly.cashGap, false);
});

test('health: a flow both records show pairs across a holiday weekend, a mixed point leaves no false gap, and a re-applied journal pages again', () => {
  // A Saturday deposit before Presidents' Day: the log dates it 2027-02-13, the history books it in the 2027-02-17 point.
  const deposit = { t: Date.parse('2027-02-17T01:00:00Z'), date: '2027-02-17', type: 'CSD', amount: 5000 };
  const holiday = run({ broker: broker({ ...acct, cash: '55325.06' }), cash: cashInput({ flows: [funding, deposit], external: [FUNDING_LOGGED, logged('2027-02-13', 5000, 'CSD')], logCash: 55325.06 }), knownFlows: ['log:CSD-2027-02-13-5000'] });
  assert.deepEqual([holiday.problems, holiday.warnings, holiday.cashGap], [[], [], false], 'one flow, not two: no gap and no second page');
  // One point books a logged $10,000 and an unlogged $66,905.32 together: the unlogged part explains the gap.
  const mixed = flow('2026-10-20', 76905.32);
  const both = run({ broker: broker({ ...acct, cash: String(50325.06 + 76905.32) }), cash: cashInput({ flows: [funding, mixed], external: [FUNDING_LOGGED, logged('2026-10-19', 10000)], logCash: 60325.06, sales: 0 }), knownFlows: [] });
  assert.equal(both.cashGap, false);
  assert.equal(both.problems.length, 1, 'the point pages once; its logged part does not page again from the log');
  assert.match(both.problems[0], /^New external cash flow: JNLC \+\$76,905\.32 in the 2026-10-20 history point/);
  // After the journal and its reversal, the same -$66,905.32 lands again three days later: that is news.
  const again = run({ broker: broker(afterJournal), cash: cashInput({ flows: [funding, journal, flow('2026-10-21', 66905.32), flow('2026-10-24', -66905.32)] }), knownFlows: [JOURNAL_KEY, 'JNLC:2026-10-21:66905.32'] });
  assert.match(again.problems[0], /^New external cash flow: JNLC -\$66,905\.32 in the 2026-10-24 history point/);
});

test('health: a journal landing in a point already paged is news; equal deposits a day apart page twice; a reversal in the log is never swallowed', () => {
  const restored = broker({ ...afterJournal, cash: '50310.23', non_marginable_buying_power: '50310.23' });
  // Run 1 paged a $10,000 journal from the log, and the 10-20 point booked it. Then the same point takes an unlisted -$30,000 too.
  const deposit = logged('2026-10-19', 10000);
  const before = [JOURNAL_KEY, 'log:JNLC-2026-10-19-10000', 'JNLC:2026-10-20:10000.00'];
  const merged = run({
    broker: broker({ ...afterJournal, cash: String(-16595.09 + 10000 - 30000) }),
    cash: cashInput({ flows: [funding, journal, flow('2026-10-20', -20000)], external: [FUNDING_LOGGED, deposit], logCash: 50325.06 + 10000 }),
    knownFlows: before,
  });
  assert.match(merged.problems[0], /^New external cash flow: JNLC -\$20,000\.00 in the 2026-10-20 history point \(it read \+\$10,000\.00 when health last saw it\)\. .*Alpaca's activity log does not list it/);
  // The point nets a deposit and a journal of opposite signs, which one point's total can't tell apart, so the reconcile is $10,000 off and warns.
  assert.equal(merged.cashGap, true);
  // Two $5,000 deposits a day apart: the first is paged and booked; the second, on the day the first was booked, still pages.
  const first = logged('2026-10-19', 5000, 'CSD');
  const second = { ...logged('2026-10-20', 5000, 'CSD'), id: 'CSD-second' };
  const twice = run({
    broker: broker({ ...acct, cash: String(50325.06 + 10000) }),
    cash: cashInput({ flows: [funding, flow('2026-10-20', 5000, 'CSD')], external: [FUNDING_LOGGED, first, second], logCash: 50325.06 + 10000 }),
    knownFlows: ['log:CSD-2026-10-19-5000'],
  });
  assert.equal(twice.problems.length, 1);
  assert.match(twice.problems[0], /^New external cash flow: CSD \+\$5,000\.00 in the activity log, dated 2026-10-20/);
  assert.deepEqual(twice.newFlows, ['log:CSD-second']);
  // Alpaca's reversal shows in the log a day after the journal's point, before the history books it: no false gap, one page.
  const early = run({ broker: restored, cash: cashInput({ external: [FUNDING_LOGGED, logged('2026-10-15', 66905.32)], logCash: 50325.06 + 66905.32 }), knownFlows: [JOURNAL_KEY] });
  assert.equal(early.cashGap, false);
  assert.deepEqual(early.newFlows, ['log:JNLC-2026-10-15-66905.32']);
  assert.match(early.warnings.join(' | '), /still leaves out JNLC -\$66,905\.32 \(2026-10-14 history point\); counting it, broker cash reconciles within \$14\.83/);
});

test('health: cash that no record explains warns once and pages on the second run in a row', () => {
  const account = { ...acct, cash: '50825.06' }; // $500 more than the log, and no flow in the history
  const input = { broker: broker(account), cash: cashInput({ flows: [funding] }) };
  const first = run({ ...input, cashGapRuns: 0 });
  assert.deepEqual(first.problems, []);
  assert.match(first.warnings.join(' | '), /Broker cash \$50,825\.06 is \$500\.00 above what the activity log accounts for \(\$50,325\.06\): cash moved with no record of it\. It pages if the next health run finds it too\./);
  assert.equal(first.cashGap, true);
  const second = run({ ...input, cashGapRuns: 1 });
  assert.match(second.problems.join(' | '), /cash moved with no record of it\.$/);
  // Within $50 it reconciles, and says so.
  const fine = run({ ...input, broker: broker({ ...acct, cash: '50365.06' }), cashGapRuns: 1 });
  assert.deepEqual(fine.problems, []);
  assert.equal(fine.cashGap, false);
  assert.match(fine.info.join(' | '), /Broker cash reconciles with the activity log \(1306 activities\) within \$40\.00/);
});

test('health: sell fees the log has not posted yet widen the low side only', () => {
  const gap = (cash: string, sales: number) => run({ broker: broker({ ...acct, cash }), cash: cashInput({ flows: [funding], logCash: 50000, sales }) }).cashGap;
  assert.equal(gap('49920', 10000), false, '$80 below: $50 plus 0.3% of $10,000 sold');
  assert.equal(gap('49910', 10000), true, '$90 below is past it');
  assert.equal(gap('50060', 10000), true, 'fees only ever take cash, so $60 above is not explained by them');
});

test('health: the cash reconcile waits while a book scan runs or has run since the log was read', () => {
  const now = Date.now();
  const scanned = [hb({ at: new Date(now - 5 * 60_000).toISOString() }), quiet[1], quiet[2]];
  const input = { nowMs: now, heartbeats: scanned, broker: broker({ ...acct, cash: '90000' }), cash: cashInput({ flows: [funding], asOfMs: now - 60_000 }) };
  const running = run({ ...input, bookScanRunning: true });
  assert.equal(running.cashGap, null);
  assert.match(running.info.join(' | '), /cash reconcile waits/);
  const since = run({ ...input, heartbeats: [hb({ at: new Date(now - 30_000).toISOString() }), quiet[1], quiet[2]] });
  assert.equal(since.cashGap, null, 'a scan finished after the dashboard read the log: its fills are not in that read');
  assert.equal(run(input).cashGap, true);
});

test('health: a failed cash read warns once and pages on the second; a failed log read still pages a new journal', () => {
  const once = run({ broker: broker(afterJournal), cashError: 'GET /v2/account/portfolio/history -> HTTP 500', cashFailStreak: 1 });
  assert.match(once.warnings.join(' | '), /Cash checks did not run: GET \/v2\/account\/portfolio\/history -> HTTP 500 \(1 check\(s\) in a row\)/);
  assert.equal(once.problems.length, 1, 'negative cash still pages: it needs only the account');
  assert.match(once.problems[0], /^Cash is -\$16,595\.09 and crypto buying power is \$0\.00/);
  assert.equal(once.cashGap, null);
  const twice = run({ broker: broker(acct), cashError: 'HTTP 500', cashFailStreak: 2 });
  assert.match(twice.problems.join(' | '), /Cash checks did not run: HTTP 500 \(2 check\(s\) in a row\)/);
  // The log read failed, but the history answered: the journal pages anyway, without a reconcile.
  const logDown = run({ broker: broker(afterJournal), cash: { asOfMs: Date.now(), flows: [funding, journal], rebuild: null, logError: 'A FEE activity has no readable amount' }, cashFailStreak: 2, knownFlows: [] });
  assert.match(logDown.problems[0], /^New external cash flow: JNLC -\$66,905\.32 in the 2026-10-14 history point\. The bot can't move cash, so this came from Alpaca or from you\. It pages once/);
  assert.match(logDown.problems.join(' | '), /activity log could not be read, so broker cash was not reconciled: A FEE activity has no readable amount \(2 check\(s\) in a row\)/);
  assert.equal(logDown.cashGap, null);
  const skipped = run({ broker: broker(acct), cash: { asOfMs: Date.now(), flows: [funding], rebuild: null, skipped: 'The cash reconcile starts after the first scheduled health run reads the whole activity log.' }, cashFailStreak: 0 });
  assert.deepEqual([skipped.problems, skipped.warnings], [[], []]);
  assert.match(skipped.info.join(' | '), /starts after the first scheduled health run/);
});

test('settleState: new flows are remembered only once their page posted; the gap streak counts runs that checked', () => {
  const state = { brokerFails: 0, runs: [], notified: [], knownFlows: ['JNLC:2026-10-14:-66905.32'], cashGaps: 1, cashFails: 0, cashLedger: null };
  const report = { problems: ['p'], warnings: [], info: [], notices: [], newFlows: ['JNLC:2026-10-21:66905.32', 'JNLC:2026-10-20:66905.32'], seenFlows: ['JNLC:2026-10-13:-66905.32'], cashGap: true };
  const posted = settleState(state, report, true);
  assert.deepEqual(posted.knownFlows, ['JNLC:2026-10-14:-66905.32', 'JNLC:2026-10-13:-66905.32', 'JNLC:2026-10-21:66905.32', 'JNLC:2026-10-20:66905.32']);
  assert.equal(posted.cashGaps, 2);
  assert.deepEqual(settleState(state, report, false).knownFlows, [...state.knownFlows, 'JNLC:2026-10-13:-66905.32'], 'no page posted: the new flow pages again next run, but a known flow\'s other key is kept');
  assert.equal(settleState(state, { ...report, cashGap: false }, true).cashGaps, 0);
  assert.equal(settleState(state, { ...report, cashGap: null }, true).cashGaps, 1, 'a run that could not check keeps the streak');
});

test('readCash: GET requests only; a full read without a ledger, the last few days with one, and the history even when the log fails', async () => {
  const historyBody = { timestamp: [at('2026-10-13') / 1000, at('2026-10-14') / 1000], equity: [103601.89, 38742.05], profit_loss_pct: [0, -0.626], cashflow: { JNLC: [0, -66905.32], CFEE: [-9.77, -12.53] } };
  const acts = [
    { id: 'a1', activity_type: 'JNLC', date: '2026-07-14', created_at: '2026-07-14T08:29:25Z', net_amount: '100000', status: 'executed' },
    { id: 'a2', activity_type: 'FILL', transaction_time: '2026-10-16T00:10:15Z', price: '186.255', qty: '10', side: 'sell', symbol: 'SOL/USD' },
  ];
  let activitiesStatus = 200;
  const mock = mockFetch((url) => {
    if (url.includes('/v2/account/portfolio/history')) return { body: historyBody };
    if (url.includes('/v2/account/activities')) return { status: activitiesStatus, body: activitiesStatus === 200 ? acts : { message: 'boom' } };
    return { status: 404, body: {} };
  });
  try {
    const now = Date.parse('2026-10-17T21:00:00Z');
    const full = await readCash(null, now, true);
    assert.ok(mock.calls.every((c) => c.startsWith('GET ')), 'reads only');
    assert.ok(mock.calls.some((c) => c.includes('period=5A') && c.includes('cashflow_types=ALL')), 'five years of history, every cash flow');
    assert.ok(mock.calls.some((c) => c.includes('/v2/account/activities?direction=desc&page_size=100') && !c.includes('after=')), 'no ledger: the whole log');
    assert.equal(full.input.rebuild?.cash, 100000 + 1862.55);
    assert.deepEqual(full.input.flows.map((f) => f.amount), [-66905.32]);
    assert.ok(full.ledger);

    mock.calls.length = 0;
    const ledger = { ...full.ledger, fullAt: new Date(now - 86_400_000).toISOString() };
    await readCash(ledger, now, true);
    const after = new Date(Date.parse(ledger.through) - 86_400_000).toISOString();
    assert.ok(mock.calls.some((c) => c.includes(`after=${encodeURIComponent(after)}`)), 'a ledger: from a day before it ends');
    mock.calls.length = 0;
    await readCash(ledger, now, true, true);
    assert.ok(mock.calls.some((c) => c.includes('/v2/account/activities') && !c.includes('after=')), 'forced: the whole log again');

    mock.calls.length = 0;
    const dashboard = await readCash(null, now, false);
    assert.equal(dashboard.input.rebuild, null);
    assert.match(dashboard.input.skipped ?? '', /first scheduled health run/);
    assert.ok(!mock.calls.some((c) => c.includes('/v2/account/activities')), 'the dashboard never reads the whole log');

    activitiesStatus = 500;
    const down = await readCash(ledger, now, true);
    assert.deepEqual(down.input.flows.map((f) => f.amount), [-66905.32], 'the history still answers');
    assert.match(down.input.logError ?? '', /HTTP 500/);
    assert.equal(down.ledger, null, 'nothing new to keep');
  } finally {
    mock.restore();
  }
  const broken = mockFetch(() => ({ status: 503, body: { message: 'down' } }));
  try {
    await assert.rejects(readCash(null, Date.now(), true), /HTTP 503/);
  } finally {
    broken.restore();
  }
});
