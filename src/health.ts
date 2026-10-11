import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { CONFIG } from './config';
import {
  type BrokerAccount,
  type BrokerOrder,
  type BrokerPosition,
  botSymbolOf,
  getAccount,
  getBrokerPositions,
  getOpenOrders,
} from './broker/orders';
import { loadLedger, openEntryFor } from './memory';
import { runLockHolder } from './locks';
import type { ScanStats } from './bot';
import type { LedgerRow } from './types';

/**
 * Operational health check: the deadman's switch. Every PROBLEM posts a macOS
 * notification on every run while it lasts; the process then exits 2, or 1
 * when the notification could not be posted, so the launchd job's own
 * fallback notification fires.
 *
 * Until October 2026 this only warned about orphan positions and never looked
 * at open orders or broker refusals, so 35 stuck orders blocked crypto entries
 * for 11 weeks without an alert. It now pages on: a book agent that has not
 * run while health ran five times; a book scan whose steps failed, whose exit
 * manager did not run, or that could not reach the broker twice running;
 * broker refusals and unconfirmed orders; failed exits; positions with no open
 * ledger entry or outside the book's universe; bot orders resting at the
 * broker; a symbol whose wanted entry was missed four scans running; and a
 * broker health can't reach twice in a row. A regime ALARM and a day with no
 * scan in the crypto entry window post one notice each. Everything else is a
 * warning, which does not notify.
 */

/** Agents health expects, by heartbeat label (RUN_LABEL in the launchd plist). */
export const EXPECTED_AGENTS: Record<string, { maxAgeMin: number; critical: boolean; what: string }> = {
  book: { maxAgeMin: 130, critical: true, what: 'hourly book agent (real paper orders)' },
  'watch-flip': { maxAgeMin: 130, critical: false, what: 'flip-entry watch tests (simulation)' },
  'watch-sol': { maxAgeMin: 130, critical: false, what: 'SOL both-sides watch test (simulation)' },
};

export interface MonitorReading {
  month: string;
  status: string;
  trailing12: string;
}

export interface HealthInput {
  nowMs: number;
  heartbeats: ScanStats[];
  /**
   * When recent health runs happened (ms), this one included. Health and the
   * book both run on launchd's awake-time clock, so "health ran 5 times since
   * the book's last heartbeat" means hours of awake time without a book scan,
   * however long the Mac slept.
   */
  healthRunTimes?: number[];
  /** Consecutive health runs, including this one, that could not reach the broker. */
  brokerFailStreak?: number;
  /** A book scan holds its run lock right now (positions and ledger may be mid-update). */
  bookScanRunning?: boolean;
  rows: LedgerRow[];
  monitor: MonitorReading | null;
  /** Present only when broker keys are configured and the broker answered. */
  broker?: { positions: BrokerPosition[]; openOrders: BrokerOrder[]; account: BrokerAccount };
  brokerError?: string;
}

export interface HealthReport {
  problems: string[];
  warnings: string[];
  info: string[];
  /** Things worth one notification, not one every run (keyed so each is posted once). */
  notices: { key: string; text: string }[];
}

/**
 * The latest month the monitor must have reported by now. It runs at 06:00
 * local on days 1 to 5, so from the 3rd on, last month is due; the two-day
 * grace covers any time zone and a Mac that slept through the 1st.
 */
export function expectedMonitorMonth(nowMs: number): string {
  const d = new Date(nowMs - 2 * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** Health runs needed since the book's last heartbeat before a stale book pages (about 2.5 awake hours). */
const STALE_AFTER_HEALTH_RUNS = 5;

/** Pure health rules, so every one of them is testable without a broker. */
export function evaluateHealth(input: HealthInput): HealthReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const notices: { key: string; text: string }[] = [];
  const list = (xs: string[]): string => xs.slice(0, 6).join('; ') + (xs.length > 6 ? `; +${xs.length - 6} more` : '');

  // 1. Agent freshness and what each agent's last scan reported.
  const byLabel = new Map(input.heartbeats.map((h) => [h.label, h]));
  const runs = input.healthRunTimes ?? [];
  for (const [label, exp] of Object.entries(EXPECTED_AGENTS)) {
    const hb = byLabel.get(label);
    if (!hb) {
      (exp.critical ? problems : warnings).push(`No heartbeat from the ${exp.what} [${label}] — it has not run since heartbeats were added, or RUN_LABEL is missing from its plist.`);
      continue;
    }
    const atMs = Date.parse(hb.at);
    // A stamp that is unreadable or in the future (a clock step) counts as stale, never as fresh.
    const valid = Number.isFinite(atMs) && atMs <= input.nowMs + 5 * 60_000;
    const ageMin = valid ? (input.nowMs - atMs) / 60_000 : Infinity;
    info.push(`[${label}] last scan ${valid ? `${ageMin.toFixed(0)} min ago` : 'at an unreadable time'}: ${hb.symbols} symbols, ${hb.entries.length} entries, ${hb.exits.length} exits.`);
    if (ageMin > exp.maxAgeMin) {
      const runsSince = valid ? runs.filter((t) => t > atMs).length : runs.length;
      if (runsSince >= STALE_AFTER_HEALTH_RUNS) {
        (exp.critical ? problems : warnings).push(`The ${exp.what} [${label}] has not run while health ran ${runsSince} times (its last scan was ${valid ? `${ageMin.toFixed(0)} min` : 'an unknown time'} ago) — the agent is unloaded, crashing or stuck.`);
      } else {
        info.push(`[${label}] is ${valid ? `${ageMin.toFixed(0)} min` : 'of unknown age and'} old, but health has run only ${runsSince} time(s) since: the Mac was probably asleep, and launchd skips runs during sleep.`);
      }
    }
  }
  for (const hb of input.heartbeats) {
    const expected = EXPECTED_AGENTS[hb.label];
    const ageMin = (input.nowMs - Date.parse(hb.at)) / 60_000;
    // A heartbeat from an ad hoc label (a manual run) is history once it is old; only fresh ones count.
    if (!expected && !(ageMin <= 130)) {
      info.push(`[${hb.label}] old heartbeat from an ad hoc run (${Number.isFinite(ageMin) ? ageMin.toFixed(0) : '?'} min); not evaluated.`);
      continue;
    }
    const critical = expected?.critical ?? hb.execution === 'alpaca-paper';
    const sink = critical ? problems : warnings;
    if (hb.offline) {
      // A scan that woke in a Power Nap dark wake, or with the network down, did nothing and changed nothing.
      ((hb.offlineStreak ?? 1) >= 2 ? sink : warnings).push(`[${hb.label}] the last ${hb.offlineStreak ?? 1} scan(s) could not reach the broker or market data and did nothing.`);
      continue;
    }
    if (hb.stepFailures.length) sink.push(`[${hb.label}] scan steps failed: ${list(hb.stepFailures)}`);
    if (hb.execution === 'alpaca-paper' && !hb.exitsRan) sink.push(`[${hb.label}] the exit manager did not run on the last scan, so exits and the catastrophe stop were not checked.`);
    if (hb.rejects.length) sink.push(`[${hb.label}] the broker refused ${hb.rejects.length} order(s): ${list(hb.rejects)}`);
    if (hb.unknown.length) sink.push(`[${hb.label}] ${hb.unknown.length} order(s) never confirmed a final state: ${list(hb.unknown)}`);
    if (hb.exitFailures.length) sink.push(`[${hb.label}] ${hb.exitFailures.length} exit(s) failed: ${list(hb.exitFailures)}`);
    if (hb.orphans.length) sink.push(`[${hb.label}] ${hb.orphans.length} position(s) with no ledger entry: ${hb.orphans.join(', ')} — run \`npm run reconcile\`.`);
    const streaks = Object.entries(hb.entryMisses).filter(([, m]) => m.n >= 4);
    const hard = streaks.filter(([, m]) => m.kind !== 'spread');
    const soft = streaks.filter(([, m]) => m.kind === 'spread');
    if (hard.length) sink.push(`[${hb.label}] entries the strategy wanted keep failing: ${hard.map(([sym, m]) => `${sym} ${m.n}x ${m.kind}`).join(', ')}.`);
    if (soft.length) warnings.push(`[${hb.label}] spread guard has skipped these entries ${soft.map(([sym, m]) => `${sym} ${m.n}x`).join(', ')} in a row.`);
    if (hb.entriesBlocked) warnings.push(`[${hb.label}] no entries on the last scan: ${hb.entriesBlocked}.`);
    if (hb.execution === 'alpaca-paper' && expected) {
      const sinceWindowH = hb.lastCryptoWindowScan ? (input.nowMs - Date.parse(hb.lastCryptoWindowScan)) / 3_600_000 : null;
      if (sinceWindowH === null) info.push(`[${hb.label}] no scan inside the crypto entry window recorded yet.`);
      else if (sinceWindowH > 26) {
        // Once per missed day: the Mac asleep through 00:00 to 02:00 UTC every night is a setup issue, not an outage to page on every 30 minutes.
        warnings.push(`[${hb.label}] no scan has run inside the crypto entry window (00:00 to 02:00 UTC) for ${sinceWindowH.toFixed(0)} h, so no crypto entry can be placed.`);
        notices.push({ key: `crypto-window:${new Date(input.nowMs).toISOString().slice(0, 10)}`, text: `No book scan has run inside the crypto entry window (00:00 to 02:00 UTC) for ${sinceWindowH.toFixed(0)} h. Keep the Mac awake then, or no crypto entries happen.` });
      }
    }
    if (hb.needsReview.length) warnings.push(`[${hb.label}] broker fills disagree with the ledger: ${list(hb.needsReview)} — run \`npm run reconcile\`.`);
    if (hb.failures.length) warnings.push(`[${hb.label}] ${hb.failures.length} symbol(s) failed on data or logic: ${list(hb.failures)}`);
    if (hb.unfilled.length) warnings.push(`[${hb.label}] ${hb.unfilled.length} entr${hb.unfilled.length === 1 ? 'y' : 'ies'} did not fill and were canceled: ${hb.unfilled.join(', ')} (retried next scan).`);
    if (hb.spreadSkips.length) info.push(`[${hb.label}] spread guard skipped ${hb.spreadSkips.join(', ')}.`);
    if (hb.adopted) warnings.push(`[${hb.label}] adopted ${hb.adopted} late fill(s) last scan — orders are settling slower than ORDER_TIMEOUT_SEC.`);
    if (hb.exitsAdded) warnings.push(`[${hb.label}] recorded ${hb.exitsAdded} exit(s) from broker fills that had no ledger row.`);
    if (hb.swept) warnings.push(`[${hb.label}] swept ${hb.swept} stale order(s) at the start of the last scan.`);
  }

  // 2. Regime alarm and monitor freshness.
  if (!input.monitor) {
    warnings.push('No regime monitor data — run `npm run tsmom:monitor`.');
  } else {
    info.push(`Regime monitor: ${input.monitor.status} (trailing-12 ${input.monitor.trailing12 || 'n/a'}%/mo, through ${input.monitor.month}).`);
    if (input.monitor.status === 'ALARM') {
      // A promotion gate, not an outage: say it once per month it lasts, not every 30 minutes.
      warnings.push(`Regime monitor ALARM for ${input.monitor.month}: the trailing-12-month excess is negative, so the historical edge is not visible in the last year and real-money promotion is frozen.`);
      notices.push({ key: `alarm:${input.monitor.month}`, text: `Regime monitor ALARM for ${input.monitor.month}: trailing-12-month excess is negative. Promotion is frozen.` });
    }
    const want = expectedMonitorMonth(input.nowMs);
    if (input.monitor.month < want) warnings.push(`Regime monitor is behind: it reports through ${input.monitor.month}, expected ${want}.`);
  }

  // 3. Broker state against the ledger.
  if (input.brokerError) {
    // One failed check is a blip; two in a row (an hour apart) is an outage the book can't trade through.
    ((input.brokerFailStreak ?? 1) >= 2 ? problems : warnings).push(`Could not reach the broker (${input.brokerFailStreak ?? 1} check(s) in a row): ${input.brokerError}`);
  }
  if (input.broker) {
    const { positions, openOrders, account } = input.broker;
    const universe = new Set(byLabel.get('book')?.universe ?? []);
    for (const p of positions) {
      const sym = botSymbolOf(p.symbol);
      if (universe.size > 0 && !universe.has(sym)) {
        problems.push(`Broker holds ${p.qty} ${p.symbol}, which is outside the book's universe: no exit or stop manages it. Put it back in SYMBOLS (ENTRY_SKIP winds a symbol down safely) or close it.`);
        continue;
      }
      if (input.bookScanRunning) continue; // an entry may be between its fill and its row
      if (!openEntryFor(input.rows, sym)) {
        problems.push(`Broker holds ${p.qty} ${p.symbol} with no open ledger entry — the exit manager won't touch it. Run \`npm run reconcile\`.`);
      }
    }
    if (input.bookScanRunning) info.push('A book scan is running; the position-to-ledger check waits for the next health run.');
    const held = new Set(positions.map((p) => botSymbolOf(p.symbol)));
    const ledgerOpen = [...new Set(input.rows.filter((r) => r.mode === 'alpaca-paper').map((r) => r.symbol))].filter(
      (s) => openEntryFor(input.rows, s) && !held.has(s)
    );
    if (ledgerOpen.length) warnings.push(`Ledger shows open entries the broker no longer holds (an exit with no row?): ${ledgerOpen.join(', ')} — run \`npm run reconcile\`.`);
    const stale = openOrders.filter((o) => {
      const t = Date.parse(o.submitted_at ?? o.created_at ?? '');
      return (o.client_order_id || '').startsWith('bot-') && Number.isFinite(t) && input.nowMs - t > 10 * 60_000;
    });
    if (stale.length) {
      problems.push(`${stale.length} bot order(s) resting at the broker for over 10 min (${list(stale.map((o) => `${o.symbol} ${o.client_order_id}`))}) — they reserve cash and can fill with no ledger row.`);
    }
    const nmbp = Number(account.non_marginable_buying_power ?? account.cash);
    if (Number.isFinite(nmbp) && nmbp < CONFIG.perTradeUsd) {
      warnings.push(`Crypto buying power is $${nmbp.toFixed(0)}, below one $${CONFIG.perTradeUsd} position — new crypto entries will be refused.`);
    }
    info.push(`Broker: ${positions.length} positions, ${openOrders.length} open order(s), equity $${Number(account.equity).toFixed(0)}.`);
  }
  return { problems, warnings, info, notices };
}

/** Fill fields that heartbeats written by older code lack. */
export function normalizeHeartbeat(h: Partial<ScanStats> & { label: string; at: string }): ScanStats {
  return {
    startedAt: h.at,
    interval: '',
    execution: '',
    symbols: 0,
    failures: [],
    entries: [],
    partials: [],
    unfilled: [],
    unknown: [],
    rejects: [],
    spreadSkips: [],
    exits: [],
    exitFailures: [],
    orphans: [],
    swept: 0,
    adopted: 0,
    exitsAdded: 0,
    needsReview: [],
    stepFailures: [],
    exitsRan: true, // older code never recorded it; assume it ran rather than page on history
    entriesBlocked: null,
    attempts: {},
    entryMisses: {},
    lastCryptoWindowScan: null,
    offline: false,
    offlineStreak: 0,
    universe: [],
    ...h,
  } as ScanStats;
}

/** Every heartbeat in data/heartbeat/. */
export function readHeartbeats(): ScanStats[] {
  const dir = path.join(CONFIG.dataDir, 'heartbeat');
  const out: ScanStats[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      out.push(normalizeHeartbeat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
    } catch {
      /* half-written; next run */
    }
  }
  return out;
}

/** The monitor's latest row, or null when the file is missing or has no data rows. */
export function readMonitor(): MonitorReading | null {
  try {
    const lines = fs.readFileSync(path.join(CONFIG.dataDir, 'monitor_tsmom.csv'), 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length < 2) return null;
    const last = lines[lines.length - 1].split(',');
    return { month: last[0], status: last[4], trailing12: last[3] };
  } catch {
    return null;
  }
}

/**
 * Rotate any data/*.log over `maxBytes` by renaming it into data/logs-archive/.
 * A rename loses nothing: a scan still appending keeps writing to the renamed
 * file, and the next run's >> creates a fresh log. Archives older than an hour
 * are gzipped on a later run, and the newest `keep` per log are kept.
 */
export function rotateLogs(maxBytes = 25 * 1024 * 1024, keep = 6): string[] {
  const rotated: string[] = [];
  const archive = path.join(CONFIG.dataDir, 'logs-archive');
  let names: string[] = [];
  try {
    names = fs.readdirSync(CONFIG.dataDir).filter((n) => n.endsWith('.log'));
  } catch {
    return rotated;
  }
  for (const name of names) {
    const file = path.join(CONFIG.dataDir, name);
    const size = fs.statSync(file).size;
    if (size <= maxBytes) continue;
    fs.mkdirSync(archive, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    fs.renameSync(file, path.join(archive, `${name}.${stamp}`));
    rotated.push(`${name} (${(size / 1048576).toFixed(0)} MB)`);
  }
  try {
    const all = fs.readdirSync(archive);
    for (const n of all.filter((x) => !x.endsWith('.gz'))) {
      const f = path.join(archive, n);
      if (Date.now() - fs.statSync(f).mtimeMs < 3_600_000) continue;
      fs.writeFileSync(`${f}.gz`, zlib.gzipSync(fs.readFileSync(f)));
      fs.rmSync(f);
    }
    for (const name of names) {
      const olds = fs
        .readdirSync(archive)
        .filter((n) => n.startsWith(`${name}.`))
        .sort();
      for (const old of olds.slice(0, Math.max(0, olds.length - keep))) fs.rmSync(path.join(archive, old));
    }
  } catch {
    /* no archive yet */
  }
  return rotated;
}

interface HealthState {
  brokerFails: number;
  /** Recent health run times (ms), newest last. */
  runs: number[];
  /** Notice keys already posted (an ALARM month, a missed crypto window day). */
  notified: string[];
}

function healthStatePath(): string {
  return path.join(CONFIG.dataDir, 'health_state.json');
}

function readHealthState(): HealthState {
  try {
    const s = JSON.parse(fs.readFileSync(healthStatePath(), 'utf8')) as Partial<HealthState>;
    return { brokerFails: Number(s.brokerFails) || 0, runs: Array.isArray(s.runs) ? s.runs : [], notified: Array.isArray(s.notified) ? s.notified : [] };
  } catch {
    return { brokerFails: 0, runs: [], notified: [] };
  }
}

function writeHealthState(state: HealthState): void {
  try {
    const file = healthStatePath();
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...state, runs: state.runs.slice(-50), notified: state.notified.slice(-50) }));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* non-fatal */
  }
}

/**
 * Everything the health rules look at. `record` is true for the scheduled
 * check, which counts this run and the broker failure streak; the dashboard
 * reads with `record` false and changes nothing.
 */
export async function gatherHealthInput(record: boolean): Promise<{ input: HealthInput; state: HealthState }> {
  const state = readHealthState();
  const nowMs = Date.now();
  const input: HealthInput = {
    nowMs,
    heartbeats: readHeartbeats(),
    rows: [],
    monitor: readMonitor(),
    healthRunTimes: record ? [...state.runs, nowMs] : state.runs,
    bookScanRunning: runLockHolder('book') != null,
  };
  if (process.env.ALPACA_PAPER_KEY_ID) {
    try {
      const [positions, openOrders, account] = await Promise.all([getBrokerPositions(), getOpenOrders(), getAccount()]);
      input.broker = { positions, openOrders, account };
      input.brokerFailStreak = 0;
    } catch (err) {
      input.brokerError = (err as Error).message;
      input.brokerFailStreak = state.brokerFails + 1;
    }
  }
  // Read the ledger after the broker snapshot, so a fill that lands in between shows as a position whose row is already there.
  input.rows = loadLedger();
  if (record) {
    state.runs = input.healthRunTimes ?? [];
    state.brokerFails = input.brokerFailStreak ?? 0;
  }
  return { input, state };
}

/** Post a macOS notification. Returns false when it could not be posted (no osascript, not macOS). */
export function notify(title: string, message: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    // AppleScript string literals take the same escapes JSON produces for quotes and backslashes.
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The scheduled health check. Problems post a notification naming the first
 * one, every run while they last, and the process exits 2 ("problems, already
 * notified"); if posting fails it exits 1 so the launchd job's fallback
 * notification fires. Notices (an ALARM month) are posted once each.
 */
export async function runHealth(): Promise<void> {
  const { input, state } = await gatherHealthInput(true);
  const report = evaluateHealth(input);
  for (const r of rotateLogs()) report.info.push(`Rotated ${r} into data/logs-archive/.`);
  for (const i of report.info) console.log(i);
  for (const w of report.warnings) console.log(`WARN: ${w}`);
  for (const p of report.problems) console.log(`PROBLEM: ${p}`);
  for (const n of report.notices) {
    if (state.notified.includes(n.key)) continue;
    if (notify('Trading bot notice', n.text)) state.notified.push(n.key);
  }
  writeHealthState(state);
  if (report.problems.length === 0) {
    console.log(`Health: OK${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ''}.`);
    return;
  }
  console.log(`Health: ${report.problems.length} PROBLEM(S) — investigate.`);
  const first = report.problems[0].slice(0, 180);
  const more = report.problems.length > 1 ? ` (+${report.problems.length - 1} more; see data/health.log)` : '';
  process.exitCode = notify('Trading bot alert', first + more) ? 2 : 1;
}
