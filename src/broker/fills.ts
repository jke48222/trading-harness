import { orderIdOf } from '../memory';
import type { LedgerRow } from '../types';
import { type BrokerOrder, type BrokerPosition, botSymbolOf } from './orders';

/**
 * Broker truth. The broker's fill history is the source of truth for what
 * was bought and sold; the ledger is the decision log. This module rebuilds
 * round trips from fills and reconciles them against the ledger, so a lost or
 * misattributed row is found and repaired instead of quietly skewing results.
 * Everything here is pure except the loaders at the bottom.
 */

/**
 * Client ids the scan loop generates: bot-<SYMBOL>-<signal boundary ms>, with
 * an attempt suffix since 2026-10 (bot-ETHUSDT-1784160000000-m29839480) so a
 * retry after a canceled order gets a fresh id. Probe and restore ids from the
 * July 16 incident (bot-restore-..., bot-mklimit-...) do not match.
 */
const BOT_CLIENT_ID = /^bot-([A-Z0-9]+)-(\d+)(?:-[a-z0-9]+)?$/;

export interface Fill {
  orderId: string;
  clientOrderId: string;
  brokerSymbol: string;
  botSymbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  filledAt: string;
  submittedAt: string;
  /** Placed by the scan loop (not a manual probe, smoke test or dashboard close). */
  bot: boolean;
}

export function isBotClientId(id: string): boolean {
  return BOT_CLIENT_ID.test(id);
}

/** Signal-candle boundary (ms) encoded in a bot client id, or null. */
export function boundaryOfClientId(id: string): number | null {
  const m = id.match(BOT_CLIENT_ID);
  return m ? Number(m[2]) : null;
}

export function ordersToFills(orders: BrokerOrder[]): Fill[] {
  const out: Fill[] = [];
  for (const o of orders) {
    const qty = Number(o.filled_qty);
    const price = Number(o.filled_avg_price);
    if (!(qty > 0) || !(price > 0) || !o.filled_at) continue;
    out.push({
      orderId: o.id,
      clientOrderId: o.client_order_id ?? '',
      brokerSymbol: o.symbol,
      botSymbol: botSymbolOf(o.symbol),
      side: o.side === 'sell' ? 'sell' : 'buy',
      qty,
      price,
      filledAt: o.filled_at,
      submittedAt: o.submitted_at ?? o.filled_at,
      bot: isBotClientId(o.client_order_id ?? ''),
    });
  }
  return out.sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
}

export interface RoundTrip {
  botSymbol: string;
  brokerSymbol: string;
  entries: Fill[];
  exits: Fill[];
  open: boolean;
  entryQty: number;
  entryVwap: number;
  exitQty: number;
  exitVwap: number | null;
  openedAt: string;
  closedAt: string | null;
  /** Exit VWAP vs entry VWAP, gross of every fee. Null while open. */
  grossPct: number | null;
  /** Cash out minus cash in. Includes fees taken in coin on the buy (they shrink the sold qty); excludes USD fee charges. Null while open. */
  cashPnlUsd: number | null;
  /** Any fill not placed by the scan loop (probe, smoke test, restore). */
  manual: boolean;
}

const vwap = (fills: Fill[]): number => {
  const q = fills.reduce((a, f) => a + f.qty, 0);
  return q > 0 ? fills.reduce((a, f) => a + f.qty * f.price, 0) / q : NaN;
};

/**
 * Group fills into round trips per symbol: buys open or add to a position, a
 * sell that leaves at most `dustFrac` of the bought quantity closes it. Crypto
 * fees are taken in coin on the buy, so the closing sell is ~0.1-0.3% smaller
 * than the buy; the dust allowance absorbs that.
 */
export function buildRoundTrips(fills: Fill[], dustFrac = 0.01): { trips: RoundTrip[]; unmatchedSells: Fill[] } {
  const trips: RoundTrip[] = [];
  const unmatchedSells: Fill[] = [];
  const open = new Map<string, { entries: Fill[]; exits: Fill[] }>();
  const finish = (sym: string, t: { entries: Fill[]; exits: Fill[] }, closed: boolean): void => {
    const entryQty = t.entries.reduce((a, f) => a + f.qty, 0);
    const exitQty = t.exits.reduce((a, f) => a + f.qty, 0);
    const entryVwap = vwap(t.entries);
    const exitVwap = t.exits.length ? vwap(t.exits) : null;
    trips.push({
      botSymbol: sym,
      brokerSymbol: t.entries[0].brokerSymbol,
      entries: t.entries,
      exits: t.exits,
      open: !closed,
      entryQty,
      entryVwap,
      exitQty,
      exitVwap,
      openedAt: t.entries[0].filledAt,
      closedAt: closed ? t.exits[t.exits.length - 1].filledAt : null,
      grossPct: closed && exitVwap != null ? (exitVwap / entryVwap - 1) * 100 : null,
      cashPnlUsd: closed ? t.exits.reduce((a, f) => a + f.qty * f.price, 0) - t.entries.reduce((a, f) => a + f.qty * f.price, 0) : null,
      manual: [...t.entries, ...t.exits].some((f) => !f.bot && f.side === 'buy'),
    });
  };
  for (const f of fills) {
    const cur = open.get(f.botSymbol);
    if (f.side === 'buy') {
      if (cur) cur.entries.push(f);
      else open.set(f.botSymbol, { entries: [f], exits: [] });
      continue;
    }
    if (!cur) {
      unmatchedSells.push(f);
      continue;
    }
    cur.exits.push(f);
    const bought = cur.entries.reduce((a, x) => a + x.qty, 0);
    const sold = cur.exits.reduce((a, x) => a + x.qty, 0);
    if (bought - sold <= dustFrac * bought) {
      finish(f.botSymbol, cur, true);
      open.delete(f.botSymbol);
    }
  }
  for (const [sym, t] of open) finish(sym, t, false);
  trips.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  return { trips, unmatchedSells };
}

export type FindingKind = 'missing-entry-row' | 'misattributed-exit' | 'missing-exit-row' | 'orphan-position' | 'unbacked-entry-row' | 'manual-trip';

export interface Finding {
  kind: FindingKind;
  botSymbol: string;
  detail: string;
  trip?: RoundTrip;
  fill?: Fill;
  row?: LedgerRow;
}

/** Recorded "entry fill X" on an exit row. */
function exitRowEntryFill(row: LedgerRow): number | null {
  const m = row.reason.match(/entry fill ([0-9.eE+-]+)/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) ? v : null;
}

/** The ledger exit row written for a trip: same symbol, stamped within minutes after the closing fill. */
export function exitRowFor(rows: LedgerRow[], trip: RoundTrip): LedgerRow | null {
  if (!trip.closedAt) return null;
  const t = Date.parse(trip.closedAt);
  let best: LedgerRow | null = null;
  let bestGap = Infinity;
  for (const r of rows) {
    if (r.mode !== 'alpaca-paper-exit' || r.symbol !== trip.botSymbol) continue;
    const gap = Date.parse(r.timestamp) - t;
    if (gap < -5 * 60_000 || gap > 30 * 60_000) continue;
    if (Math.abs(gap) < bestGap) {
      best = r;
      bestGap = Math.abs(gap);
    }
  }
  return best;
}

/**
 * Compare broker round trips with the ledger. Findings:
 * - missing-entry-row: a bot buy filled but no ledger row names its order (late fill after a timeout).
 * - misattributed-exit: an exit row computed its P&L against another trip's entry fill.
 * - missing-exit-row: a bot trip closed at the broker with no exit row.
 * - orphan-position: the broker holds a position the ledger can't attribute.
 * - unbacked-entry-row: a ledger entry row whose order never filled at the broker.
 * - manual-trip: a trip that includes a non-bot buy (reported, never auto-fixed).
 */
export function reconcile(input: {
  rows: LedgerRow[];
  trips: RoundTrip[];
  positions: BrokerPosition[];
  filledBotClientIds: Set<string>;
  sinceMs: number;
}): Finding[] {
  const { rows, trips, positions, filledBotClientIds, sinceMs } = input;
  const findings: Finding[] = [];
  const entryByClientId = new Map<string, LedgerRow>();
  for (const r of rows) {
    if (r.mode !== 'alpaca-paper' || r.action !== 'BUY') continue;
    const id = orderIdOf(r);
    if (id) entryByClientId.set(id, r);
  }

  for (const trip of trips) {
    for (const f of trip.entries) {
      if (f.bot && !entryByClientId.has(f.clientOrderId)) {
        const lagS = (Date.parse(f.filledAt) - Date.parse(f.submittedAt)) / 1000;
        findings.push({
          kind: 'missing-entry-row',
          botSymbol: trip.botSymbol,
          detail: `${f.clientOrderId} bought ${f.qty} @ ${f.price}, filled ${f.filledAt} (${lagS.toFixed(0)}s after submit) with no ledger row`,
          trip,
          fill: f,
        });
      }
    }
    if (trip.manual) {
      findings.push({
        kind: 'manual-trip',
        botSymbol: trip.botSymbol,
        detail: `trip opened ${trip.openedAt} includes a non-bot buy (${trip.entries.filter((f) => !f.bot).map((f) => f.clientOrderId || f.orderId).join(', ')}); not auto-fixed`,
        trip,
      });
      continue;
    }
    if (trip.open || !trip.entries.some((f) => f.bot)) continue;
    const exitRow = exitRowFor(rows, trip);
    if (!exitRow) {
      findings.push({
        kind: 'missing-exit-row',
        botSymbol: trip.botSymbol,
        detail: `closed ${trip.closedAt} at ${trip.exitVwap} (entry ${trip.entryVwap}, ${trip.grossPct?.toFixed(2)}%) with no exit row`,
        trip,
      });
      continue;
    }
    const recorded = exitRowEntryFill(exitRow);
    if (recorded == null || Math.abs(recorded / trip.entryVwap - 1) > 1e-4) {
      findings.push({
        kind: 'misattributed-exit',
        botSymbol: trip.botSymbol,
        detail: `exit ${exitRow.timestamp} recorded entry fill ${recorded} (${exitRow.pnl}%) but this trip's entry fill is ${trip.entryVwap} (${trip.grossPct?.toFixed(4)}%)`,
        trip,
        row: exitRow,
      });
    }
  }

  for (const p of positions) {
    const sym = botSymbolOf(p.symbol);
    const trip = trips.find((t) => t.open && t.botSymbol === sym);
    const missing = findings.some((f) => f.kind === 'missing-entry-row' && f.trip === trip);
    const ledgerIds = new Set(
      rows.filter((r) => r.symbol === sym && r.mode === 'alpaca-paper' && r.action === 'BUY').map((r) => orderIdOf(r))
    );
    const attributed = trip ? trip.entries.some((f) => f.bot && ledgerIds.has(f.clientOrderId)) : false;
    if (!attributed) {
      findings.push({
        kind: 'orphan-position',
        botSymbol: sym,
        detail: trip
          ? `broker holds ${p.qty} ${p.symbol} from ${trip.openedAt}${missing ? ' (its entry row is missing; adopting it fixes this)' : ''}`
          : `broker holds ${p.qty} ${p.symbol} but no fill in the window explains it`,
        trip,
      });
    }
  }

  for (const [id, row] of entryByClientId) {
    if (Date.parse(row.timestamp) < sinceMs) continue;
    if (!filledBotClientIds.has(id)) {
      findings.push({ kind: 'unbacked-entry-row', botSymbol: row.symbol, detail: `${row.timestamp} names ${id}, which never filled`, row });
    }
  }
  return findings;
}

/** The setup tag running at time t: the tag of the latest broker entry row before t, else the fallback. */
export function tagRunningAt(rows: LedgerRow[], t: number, fallback: string): string {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const r of rows) {
    if (r.mode !== 'alpaca-paper' || r.action !== 'BUY') continue;
    const rt = Date.parse(r.timestamp);
    if (rt <= t && rt > bestT) {
      const m = r.reason.match(/^\[([^\]]+)\]/);
      if (m) {
        best = m[1];
        bestT = rt;
      }
    }
  }
  return best ?? fallback;
}

/** The ledger row a late fill should have produced. `signalClose` is the signal candle's close (null when unavailable). */
export function adoptionRow(fill: Fill, tag: string, signalClose: number | null, fmt: (p: number) => string, today: string): LedgerRow {
  const lagS = (Date.parse(fill.filledAt) - Date.parse(fill.submittedAt)) / 1000;
  return {
    timestamp: fill.submittedAt,
    symbol: fill.botSymbol,
    action: 'BUY',
    price: fmt(signalClose ?? fill.price),
    quantity: String(fill.qty),
    reason:
      `[${tag}] Adopted late fill: the scan timed out on this order and wrote no row, then it filled ` +
      `${fill.filledAt} (${lagS.toFixed(0)}s after submit). Row added ${today} from broker fills` +
      `${signalClose == null ? '; signal close unavailable, price is the fill' : ''}. ` +
      `|| broker fill ${fill.price} qty ${fill.qty}, order ${fill.clientOrderId}`,
    mode: 'alpaca-paper',
    outcome: 'open',
    pnl: '',
  };
}

/** Corrected copy of an exit row whose P&L used another trip's entry fill. */
export function correctedExitRow(row: LedgerRow, trip: RoundTrip, today: string): LedgerRow {
  const pct = trip.grossPct as number;
  const entryIds = trip.entries.map((f) => f.clientOrderId).join('+');
  return {
    ...row,
    reason: row.reason.replace(/entry fill [0-9.eE+-]+/, `entry fill ${trip.entryVwap}`) +
      ` || Corrected ${today} from broker fills: the entry was ${entryIds} at ${trip.entryVwap}; this row had ${row.pnl}% against ${exitRowEntryFill(row)} from an earlier trip.`,
    outcome: pct > 0 ? 'win' : pct < 0 ? 'loss' : 'flat',
    pnl: pct.toFixed(4),
  };
}

/** Exit row for a bot trip the broker closed without the ledger recording it. */
export function missingExitRow(trip: RoundTrip, tag: string, fmt: (p: number) => string, today: string): LedgerRow {
  const pct = trip.grossPct as number;
  return {
    timestamp: trip.closedAt as string,
    symbol: trip.botSymbol,
    action: 'SELL',
    price: fmt(trip.exitVwap as number),
    quantity: String(trip.exitQty),
    reason: `[actual:${tag}] Exit recorded ${today} from broker fills (no row was written at the time); entry fill ${trip.entryVwap}; ACTUAL round-trip P&L from real paper fills, gross of Alpaca fees.`,
    mode: 'alpaca-paper-exit',
    outcome: pct > 0 ? 'win' : pct < 0 ? 'loss' : 'flat',
    pnl: pct.toFixed(4),
  };
}

