import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { closedCandles, fetchSeriesSince, intervalToMs } from './market';
import { acquireRunLock } from './locks';
import { insertLedgerRows, ledgerPath, loadLedger, rowKey, updateLedger } from './memory';
import {
  type BrokerOrder,
  type BrokerPosition,
  botSymbolOf,
  fetchOrdersSince,
  getBrokerPositions,
} from './broker/orders';
import {
  type Fill,
  type Finding,
  type RoundTrip,
  adoptionRow,
  boundaryOfClientId,
  buildRoundTrips,
  correctedExitRow,
  missingExitRow,
  ordersToFills,
  reconcile,
  tagRunningAt,
} from './broker/fills';
import type { LedgerRow } from './types';

/** First day of the broker book (the paper execution layer went live 2026-07-15). */
export const BOOK_START_ISO = '2026-07-14T00:00:00Z';

export function fmtPrice(p: number): string {
  return p >= 10 ? p.toFixed(2) : p.toPrecision(6);
}

export interface BrokerTruth {
  orders: BrokerOrder[];
  fills: Fill[];
  trips: RoundTrip[];
  unmatchedSells: Fill[];
  positions: BrokerPosition[];
}

export async function loadBrokerTruth(sinceIso = BOOK_START_ISO): Promise<BrokerTruth> {
  const [orders, positions] = await Promise.all([fetchOrdersSince(sinceIso), getBrokerPositions()]);
  const fills = ordersToFills(orders);
  const { trips, unmatchedSells } = buildRoundTrips(fills);
  return { orders, fills, trips, unmatchedSells, positions };
}

/** Interval token of a setup tag ("tsmom28-1d-state-long" -> "1d"), defaulting to 1d. */
function tagInterval(tag: string): string {
  return tag.split('-').find((t) => /^\d+[smhdw]$/.test(t)) ?? '1d';
}

/** Close of the signal candle a bot order was placed on (from its client id), or null. */
export async function signalCloseFor(fill: Fill, tag: string): Promise<number | null> {
  const boundary = boundaryOfClientId(fill.clientOrderId);
  if (boundary == null) return null;
  const interval = tagInterval(tag);
  const iMs = intervalToMs(interval);
  try {
    const candles = closedCandles(await fetchSeriesSince(fill.botSymbol, interval, boundary - 6 * iMs));
    const c = candles.find((x) => Math.floor((x.closeTime + 1) / iMs) * iMs === boundary);
    return c ? c.close : null;
  } catch {
    return null;
  }
}

function bookTag(): string {
  return `tsmom${CONFIG.tsmomLookback}-${CONFIG.interval}-state-long`;
}

export interface RepairResult {
  adopted: number;
  exitsAdded: number;
  /** Divergences only a person should resolve (misattributed exits, unexplained positions). */
  needsReview: string[];
}

function heldSymbols(positions: BrokerPosition[]): Set<string> {
  return new Set(positions.map((p) => botSymbolOf(p.symbol)));
}

/**
 * A trip counts as closed once 99% is sold. While the broker still holds the
 * rest, the exit manager owns the position and writes the exit when it sells;
 * an exit row written now would leave the remainder looking like an orphan.
 */
export function exitStillHeld(f: Finding, held: Set<string>): boolean {
  return f.kind === 'missing-exit-row' && held.has(f.botSymbol);
}

/**
 * Bring the ledger in line with what the broker proves, for this run's
 * universe: adopt bot buys that filled after their scan gave up on them, and
 * add exit rows for bot trips the broker closed with no row (a crash between
 * the fill and the write). Runs at the start of every book scan, so the exit
 * manager can manage an adopted position within the hour. Manual trips and
 * misattributed exits are left for `npm run reconcile`.
 */
export async function repairFromBroker(log: (m: string) => void, symbols: Set<string>): Promise<RepairResult> {
  const truth = await loadBrokerTruth();
  const rows = loadLedger();
  const filledBotClientIds = new Set(truth.fills.filter((f) => f.bot).map((f) => f.clientOrderId));
  const findings = reconcile({ rows, trips: truth.trips, positions: truth.positions, filledBotClientIds, sinceMs: Date.parse(BOOK_START_ISO) });
  const today = new Date().toISOString().slice(0, 10);
  const add: LedgerRow[] = [];
  const result: RepairResult = { adopted: 0, exitsAdded: 0, needsReview: [] };
  const held = heldSymbols(truth.positions);
  for (const f of findings) {
    if (!symbols.has(f.botSymbol) || f.trip?.manual) continue;
    if (exitStillHeld(f, held)) continue;
    if (f.kind === 'missing-entry-row' && f.fill) {
      const tag = tagRunningAt(rows, Date.parse(f.fill.submittedAt), bookTag());
      add.push(adoptionRow(f.fill, tag, await signalCloseFor(f.fill, tag), fmtPrice, today));
      log(`Broker: adopting late fill ${f.fill.clientOrderId} (${f.fill.qty} ${f.fill.brokerSymbol} @ ${f.fill.price}, filled ${f.fill.filledAt}): it had no ledger row.`);
      result.adopted++;
    } else if (f.kind === 'missing-exit-row' && f.trip) {
      add.push(missingExitRow(f.trip, tagRunningAt(rows, Date.parse(f.trip.openedAt), bookTag()), fmtPrice, today));
      log(`Broker: recording the exit of ${f.botSymbol} that filled ${f.trip.closedAt} with no ledger row.`);
      result.exitsAdded++;
    } else if (f.kind === 'misattributed-exit' || f.kind === 'unbacked-entry-row') {
      result.needsReview.push(`${f.botSymbol}: ${f.kind}`);
    }
  }
  insertLedgerRows(add);
  return result;
}

function backupLedger(): string {
  const dir = path.join(CONFIG.dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `ledger-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  fs.copyFileSync(ledgerPath(), dest);
  return dest;
}

function describe(f: Finding): string {
  return `  ${f.kind.padEnd(19)} ${f.botSymbol.padEnd(10)} ${f.detail}`;
}

/**
 * `npm run reconcile`: compare broker fills with the ledger and print every
 * divergence. With --apply, back the ledger up and repair what the broker
 * proves: adopt late fills, correct misattributed exits, add missing exits.
 * Manual trips (probes, smoke tests) are reported, never rewritten.
 */
export async function runReconcile(apply: boolean): Promise<Finding[]> {
  const truth = await loadBrokerTruth();
  const rows = loadLedger();
  const filledBotClientIds = new Set(truth.fills.filter((f) => f.bot).map((f) => f.clientOrderId));
  const findings = reconcile({ rows, trips: truth.trips, positions: truth.positions, filledBotClientIds, sinceMs: Date.parse(BOOK_START_ISO) });
  const closed = truth.trips.filter((t) => !t.open);
  console.log(
    `Broker truth since ${BOOK_START_ISO.slice(0, 10)}: ${truth.orders.length} orders, ${truth.fills.length} fills, ` +
      `${closed.length} closed round trips, ${truth.trips.length - closed.length} open, ${truth.positions.length} positions.`
  );
  for (const s of truth.unmatchedSells) console.log(`  note: sell with no earlier buy in the window — ${s.botSymbol} ${s.filledAt} (${s.clientOrderId || s.orderId})`);
  if (findings.length === 0) {
    console.log('Reconcile: the ledger agrees with the broker. Nothing to fix.');
    return findings;
  }
  console.log(`Reconcile: ${findings.length} finding(s):`);
  for (const f of findings) console.log(describe(f));
  if (!apply) {
    console.log('Dry run. Re-run with `npm run reconcile -- --apply` to repair what the broker proves (the ledger is backed up first).');
    return findings;
  }

  const today = new Date().toISOString().slice(0, 10);
  const adoptions: LedgerRow[] = [];
  for (const f of findings.filter((x) => x.kind === 'missing-entry-row' && x.fill && !x.trip?.manual)) {
    const fill = f.fill as Fill;
    const tag = tagRunningAt(rows, Date.parse(fill.submittedAt), bookTag());
    adoptions.push(adoptionRow(fill, tag, await signalCloseFor(fill, tag), fmtPrice, today));
  }
  const corrections = new Map<string, LedgerRow>();
  for (const f of findings.filter((x) => x.kind === 'misattributed-exit' && x.row && x.trip)) {
    corrections.set(rowKey(f.row as LedgerRow), correctedExitRow(f.row as LedgerRow, f.trip as RoundTrip, today));
  }
  const newExits: LedgerRow[] = [];
  const held = heldSymbols(truth.positions);
  for (const f of findings.filter((x) => exitStillHeld(x, held))) {
    console.log(`  left for the exit manager: ${f.botSymbol} (the broker still holds the rest of the position; its exit row is written when it sells)`);
  }
  for (const f of findings.filter((x) => x.kind === 'missing-exit-row' && x.trip && !exitStillHeld(x, held))) {
    const trip = f.trip as RoundTrip;
    newExits.push(missingExitRow(trip, tagRunningAt(rows, Date.parse(trip.openedAt), bookTag()), fmtPrice, today));
  }
  if (adoptions.length + corrections.size + newExits.length === 0) {
    console.log('Nothing the broker can prove automatically; the findings above need a person.');
    return findings;
  }
  // A book scan repairs the same rows; never apply alongside one.
  const release = acquireRunLock('book');
  if (!release) {
    console.log('A book scan is running; nothing was applied. Run this again in a minute.');
    return findings;
  }
  const backup = backupLedger();
  updateLedger((all) => {
    for (let i = 0; i < all.length; i++) {
      const c = corrections.get(rowKey(all[i]));
      if (c) all[i] = c;
    }
  });
  insertLedgerRows([...adoptions, ...newExits]);
  release();
  console.log(
    `Applied: ${adoptions.length} adopted entr${adoptions.length === 1 ? 'y' : 'ies'}, ${corrections.size} corrected exit(s), ` +
      `${newExits.length} added exit(s). Backup: ${backup}`
  );
  return findings;
}

