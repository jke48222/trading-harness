import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
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
import type { ScanStats } from './bot';
import type { LedgerRow } from './types';

/**
 * Operational health check: the deadman's switch. Exits non-zero on any
 * PROBLEM, which the launchd health agent turns into a macOS notification.
 *
 * Until October 2026 this only warned about orphan positions and never looked
 * at open orders or broker refusals, so 35 stuck orders blocked crypto entries
 * for 11 weeks without an alert. Anything that means the book is not doing
 * what the strategy says is now a PROBLEM.
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
}

/**
 * The latest month the monitor must have reported by now. It runs on the 1st
 * (06:00 local), so from the 3rd on, last month is due; the two-day grace
 * covers any time zone and a Mac that slept through the 1st.
 */
export function expectedMonitorMonth(nowMs: number): string {
  const d = new Date(nowMs - 2 * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** Pure health rules, so every one of them is testable without a broker. */
export function evaluateHealth(input: HealthInput): HealthReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const list = (xs: string[]): string => xs.slice(0, 6).join('; ') + (xs.length > 6 ? `; +${xs.length - 6} more` : '');

  // 1. Agent freshness and what each agent's last scan reported.
  const byLabel = new Map(input.heartbeats.map((h) => [h.label, h]));
  for (const [label, exp] of Object.entries(EXPECTED_AGENTS)) {
    const hb = byLabel.get(label);
    if (!hb) {
      (exp.critical ? problems : warnings).push(`No heartbeat from the ${exp.what} [${label}] — it has not run since heartbeats were added, or RUN_LABEL is missing from its plist.`);
      continue;
    }
    const ageMin = (input.nowMs - Date.parse(hb.at)) / 60_000;
    info.push(`[${label}] last scan ${ageMin.toFixed(0)} min ago: ${hb.symbols} symbols, ${hb.entries.length} entries, ${hb.exits.length} exits.`);
    if (ageMin > exp.maxAgeMin) {
      (exp.critical ? problems : warnings).push(`The ${exp.what} [${label}] last ran ${ageMin.toFixed(0)} min ago (limit ${exp.maxAgeMin}) — Mac asleep, or the agent is unloaded or crashing.`);
    }
  }
  for (const hb of input.heartbeats) {
    const critical = EXPECTED_AGENTS[hb.label]?.critical ?? hb.execution === 'alpaca-paper';
    const sink = critical ? problems : warnings;
    if (hb.rejects.length) sink.push(`[${hb.label}] the broker refused ${hb.rejects.length} order(s): ${list(hb.rejects)}`);
    if (hb.unknown.length) sink.push(`[${hb.label}] ${hb.unknown.length} order(s) never confirmed a final state: ${list(hb.unknown)}`);
    if (hb.exitFailures.length) sink.push(`[${hb.label}] ${hb.exitFailures.length} exit(s) failed: ${list(hb.exitFailures)}`);
    if (hb.orphans.length) sink.push(`[${hb.label}] ${hb.orphans.length} position(s) with no ledger entry: ${hb.orphans.join(', ')} — run \`npm run reconcile\`.`);
    if (hb.failures.length) warnings.push(`[${hb.label}] ${hb.failures.length} symbol(s) failed on data or logic: ${list(hb.failures)}`);
    if (hb.unfilled.length) warnings.push(`[${hb.label}] ${hb.unfilled.length} entr${hb.unfilled.length === 1 ? 'y' : 'ies'} did not fill and were canceled: ${hb.unfilled.join(', ')} (retried next scan).`);
    if (hb.spreadSkips.length) info.push(`[${hb.label}] spread guard skipped ${hb.spreadSkips.join(', ')}.`);
    if (hb.adopted) warnings.push(`[${hb.label}] adopted ${hb.adopted} late fill(s) last scan — orders are settling slower than ORDER_TIMEOUT_SEC.`);
    if (hb.swept) warnings.push(`[${hb.label}] swept ${hb.swept} stale order(s) at the start of the last scan.`);
  }

  // 2. Regime alarm and monitor freshness.
  if (!input.monitor) {
    warnings.push('No regime monitor data — run `npm run tsmom:monitor`.');
  } else {
    info.push(`Regime monitor: ${input.monitor.status} (trailing-12 ${input.monitor.trailing12 || 'n/a'}%/mo, through ${input.monitor.month}).`);
    if (input.monitor.status === 'ALARM') problems.push('Regime monitor ALARM — trailing-12-month excess is negative; the historical edge is not visible in the last year.');
    const want = expectedMonitorMonth(input.nowMs);
    if (input.monitor.month < want) warnings.push(`Regime monitor is behind: it reports through ${input.monitor.month}, expected ${want}.`);
  }

  // 3. Broker state against the ledger.
  if (input.brokerError) warnings.push(`Could not reach the broker: ${input.brokerError}`);
  if (input.broker) {
    const { positions, openOrders, account } = input.broker;
    for (const p of positions) {
      const sym = botSymbolOf(p.symbol);
      if (!openEntryFor(input.rows, sym)) {
        problems.push(`Broker holds ${p.qty} ${p.symbol} with no open ledger entry — the exit manager won't touch it. Run \`npm run reconcile\`.`);
      }
    }
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
  return { problems, warnings, info };
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
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ScanStats);
    } catch {
      /* half-written; next run */
    }
  }
  return out;
}

export function readMonitor(): MonitorReading | null {
  try {
    const lines = fs.readFileSync(path.join(CONFIG.dataDir, 'monitor_tsmom.csv'), 'utf8').split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1].split(',');
    return { month: last[0], status: last[4], trailing12: last[3] };
  } catch {
    return null;
  }
}

/**
 * Gzip any data/*.log over `maxBytes` into data/logs-archive/ and truncate it,
 * keeping the newest `keep` archives per log. Agents append with >>, which
 * reopens the file every run, so truncating between runs is safe.
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
    fs.writeFileSync(path.join(archive, `${name}.${stamp}.gz`), zlib.gzipSync(fs.readFileSync(file)));
    fs.truncateSync(file, 0);
    rotated.push(`${name} (${(size / 1048576).toFixed(0)} MB)`);
    const olds = fs
      .readdirSync(archive)
      .filter((n) => n.startsWith(`${name}.`) && n.endsWith('.gz'))
      .sort();
    for (const old of olds.slice(0, Math.max(0, olds.length - keep))) fs.rmSync(path.join(archive, old));
  }
  return rotated;
}

export async function runHealth(): Promise<void> {
  const input: HealthInput = {
    nowMs: Date.now(),
    heartbeats: readHeartbeats(),
    rows: loadLedger(),
    monitor: readMonitor(),
  };
  if (process.env.ALPACA_PAPER_KEY_ID) {
    try {
      const [positions, openOrders, account] = await Promise.all([getBrokerPositions(), getOpenOrders(), getAccount()]);
      input.broker = { positions, openOrders, account };
    } catch (err) {
      input.brokerError = (err as Error).message;
    }
  }
  const report = evaluateHealth(input);
  for (const r of rotateLogs()) report.info.push(`Rotated ${r} into data/logs-archive/.`);
  for (const i of report.info) console.log(i);
  for (const w of report.warnings) console.log(`WARN: ${w}`);
  for (const p of report.problems) console.log(`PROBLEM: ${p}`);
  if (report.problems.length === 0) {
    console.log(`Health: OK${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ''}.`);
  } else {
    console.log(`Health: ${report.problems.length} PROBLEM(S) — investigate.`);
    process.exitCode = 1;
  }
}
