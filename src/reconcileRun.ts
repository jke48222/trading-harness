import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { closedCandles, fetchSeriesSince, intervalToMs } from './market';
import { insertLedgerRows, ledgerPath, loadLedger, orderIdOf, rowKey, updateLedger } from './memory';
import {
  type BrokerOrder,
  type BrokerPosition,
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

/**
 * Write the missing ledger row for every bot buy that filled after its scan
 * gave up on it (the order settled late). Runs at the start of every book scan,
 * so the exit manager can manage the position within the hour.
 */
export async function adoptLateFills(log: (m: string) => void, lookbackDays = 14, symbols?: Set<string>): Promise<number> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const fills = ordersToFills(await fetchOrdersSince(since)).filter(
    (f) => f.side === 'buy' && f.bot && (!symbols || symbols.has(f.botSymbol))
  );
  const rows = loadLedger();
  const known = new Set(rows.map(orderIdOf).filter(Boolean) as string[]);
  const today = new Date().toISOString().slice(0, 10);
  const adopt: LedgerRow[] = [];
  for (const f of fills) {
    if (known.has(f.clientOrderId)) continue;
    const tag = tagRunningAt(rows, Date.parse(f.submittedAt), bookTag());
    adopt.push(adoptionRow(f, tag, await signalCloseFor(f, tag), fmtPrice, today));
    log(`Broker: adopting late fill ${f.clientOrderId} (${f.qty} ${f.brokerSymbol} @ ${f.price}, filled ${f.filledAt}) — it had no ledger row.`);
  }
  insertLedgerRows(adopt);
  return adopt.length;
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
  for (const f of findings.filter((x) => x.kind === 'missing-exit-row' && x.trip)) {
    const trip = f.trip as RoundTrip;
    newExits.push(missingExitRow(trip, tagRunningAt(rows, Date.parse(trip.openedAt), bookTag()), fmtPrice, today));
  }
  if (adoptions.length + corrections.size + newExits.length === 0) {
    console.log('Nothing the broker can prove automatically; the findings above need a person.');
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
  console.log(
    `Applied: ${adoptions.length} adopted entr${adoptions.length === 1 ? 'y' : 'ies'}, ${corrections.size} corrected exit(s), ` +
      `${newExits.length} added exit(s). Backup: ${backup}`
  );
  return findings;
}

