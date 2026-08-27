import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { getBrokerPositions, positionMatches } from './broker/orders';
import { loadLedger } from './memory';

/**
 * Operational health check — the deadman's-switch the project was missing.
 * Reports agent freshness, the regime alarm, and ledger/broker reconciliation.
 * Exits non-zero on any problem so it can drive a launchd/cron alert.
 */
export async function runHealth(): Promise<void> {
  const problems: string[] = [];
  const warn: string[] = [];
  const ROOT = process.cwd();

  // 1. Agent freshness (heartbeat + log mtimes).
  const heartbeatPath = path.join(CONFIG.dataDir, 'heartbeat.json');
  try {
    const hb = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')) as { at: string; symbols: number; failures: number };
    const ageMin = (Date.now() - Date.parse(hb.at)) / 60_000;
    console.log(`Heartbeat: last scan ${ageMin.toFixed(0)} min ago (${hb.symbols} symbols, ${hb.failures} failures).`);
    if (ageMin > 130) problems.push(`No scan heartbeat for ${ageMin.toFixed(0)} min — the hourly agent may be dead (Mac asleep? launchd unloaded?).`);
    if (hb.failures > 0) warn.push(`Last scan had ${hb.failures} symbol failure(s) — check data/tsmom-scan.log.`);
  } catch {
    warn.push('No heartbeat file yet — run a scan, or the agent has never run since this was added.');
  }

  // 2. Regime alarm.
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'data', 'monitor_tsmom.csv'), 'utf8').split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1].split(',');
    const status = last[4];
    console.log(`Regime monitor: ${status} (trailing-12 ${last[3] || 'n/a'}%/mo, ${last[0]}).`);
    if (status === 'ALARM') problems.push('Regime monitor ALARM — trailing-12-month excess is negative; the historical edge is not visible in the last year.');
  } catch {
    warn.push('No regime monitor data — run `npm run tsmom:monitor`.');
  }

  // 3. Ledger ↔ broker reconciliation (only if broker configured).
  if (process.env.ALPACA_PAPER_KEY_ID) {
    try {
      const positions = await getBrokerPositions();
      const rows = loadLedger();
      const openEntries = rows.filter((r) => r.mode === 'alpaca-paper' && r.action === 'BUY');
      // A broker position with no matching un-exited ledger entry = orphan.
      for (const p of positions) {
        const hasEntry = openEntries.some((e) => positionMatches(p.symbol, e.symbol));
        if (!hasEntry) warn.push(`Broker holds ${p.symbol} with no attributable ledger entry — reconcile (the exit manager won't touch it).`);
      }
      console.log(`Reconciliation: ${positions.length} broker positions, ${openEntries.length} entry rows.`);
    } catch (err) {
      warn.push(`Could not reach the broker for reconciliation: ${(err as Error).message}`);
    }
  }

  for (const w of warn) console.log(`WARN: ${w}`);
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  if (problems.length === 0) {
    console.log(`Health: OK${warn.length ? ` (${warn.length} warning(s))` : ''}.`);
  } else {
    console.log(`Health: ${problems.length} PROBLEM(S) — investigate.`);
    process.exitCode = 1;
  }
}
