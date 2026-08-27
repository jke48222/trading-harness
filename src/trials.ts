import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { csvEscape } from './memory';

/**
 * Trials ledger — one row for EVERY configuration ever evaluated, win or lose.
 *
 * Why this exists (deep-research finding F6): a backtest result without a
 * disclosed trial count is formally worthless — with enough undisclosed looks
 * at the same data, something always appears "profitable" by chance. This file
 * is the disclosure. It is append-only and is deliberately NOT wiped by
 * `memory:reset`: trade memory is re-learnable, the count of looks is not.
 */

const TRIALS_HEADER =
  'run_at,source,command,symbol,interval,strategy,params,window_start,window_end,' +
  'setups,wins,losses,win_rate_pct,profit_factor,total_pnl_pct,avg_pnl_pct,max_dd_pct,fee_bps,notes';

export interface TrialRow {
  /** ISO timestamp of when the trial was run (not the data window). */
  runAt: string;
  /** Where the numbers came from, e.g. 'local-replay', 'tradingview-mcp'. */
  source: string;
  /** The command/action that produced the numbers. */
  command: string;
  symbol: string;
  interval: string;
  strategy: string;
  /** JSON string of every knob that defines this configuration. */
  params: string;
  windowStart: string;
  windowEnd: string;
  setups: number | null;
  wins: number | null;
  losses: number | null;
  winRatePct: number | null;
  profitFactor: number | null;
  totalPnlPct: number | null;
  avgPnlPct: number | null;
  maxDdPct: number | null;
  feeBps: number | null;
  notes: string;
}

export function trialsPath(): string {
  return path.join(CONFIG.dataDir, 'trials.csv');
}

export function ensureTrialsFile(): void {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  if (!fs.existsSync(trialsPath())) fs.writeFileSync(trialsPath(), TRIALS_HEADER + '\n');
}

function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function appendTrialRow(t: TrialRow): void {
  ensureTrialsFile();
  const line = [
    t.runAt,
    t.source,
    t.command,
    t.symbol,
    t.interval,
    t.strategy,
    t.params,
    t.windowStart,
    t.windowEnd,
    fmt(t.setups),
    fmt(t.wins),
    fmt(t.losses),
    fmt(t.winRatePct),
    fmt(t.profitFactor),
    fmt(t.totalPnlPct),
    fmt(t.avgPnlPct),
    fmt(t.maxDdPct),
    fmt(t.feeBps),
    t.notes,
  ]
    .map(csvEscape)
    .join(',');
  fs.appendFileSync(trialsPath(), line + '\n');
}

/** Count of recorded trials, for the "disclosed trial count" line in reports. */
export function trialCount(): number {
  if (!fs.existsSync(trialsPath())) return 0;
  return fs
    .readFileSync(trialsPath(), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '').length - 1;
}
