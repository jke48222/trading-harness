import { CONFIG } from './config';
import { type RoundTrip, exitRowFor } from './broker/fills';
import { type BrokerActivity, fetchActivities } from './broker/orders';
import { BOOK_START_ISO, loadBrokerTruth } from './reconcileRun';
import { loadLedger, orderIdOf } from './memory';
import type { LedgerRow } from './types';
import { exitRuleKind, isSingleLookback, ruleOfStateTag } from './voteRule';

/**
 * Trade-level report from broker truth. "Actual" is what the fills say;
 * "model" is the ledger's score for the same entry under the construction's
 * own rule (state exit for the book). The gap between them, split into entry
 * and exit slippage, is the execution cost the promotion gates ask for.
 */

export interface TripAttribution {
  trip: RoundTrip;
  entryRow: LedgerRow | null;
  /** Model gross %: the ledger pnl plus the cost it was scored at, so both sides are gross. */
  modelGrossPct: number | null;
  /** Entry fill vs the signal close the model entered at, bps (positive = paid more). */
  entrySlipBps: number | null;
  /** Exit fill vs the close the model exited at, bps (positive = sold higher). */
  exitSlipBps: number | null;
  /**
   * Opened under one state rule and closed under another (the 2026-10-11
   * switch to Trial 09's vote). Its model score follows the entry's rule and
   * its exit the live one, so the gap between them would measure the rule
   * change, not execution: model score and exit slippage are left out.
   */
  ruleChanged: boolean;
}

/**
 * The latest model exit recorded on a row: model v2 notes carry the cost the
 * row was scored at; older notes do not, and were all scored at the fallback.
 */
export function lastModelExit(reason: string): { date: string; price: number; costBps: number | null } | null {
  let last: RegExpMatchArray | null = null;
  for (const m of reason.matchAll(/state exit (\d{4}-\d{2}-\d{2}) at ([0-9.eE+-]+)(?:, net of ([0-9.]+) bps)?/g)) last = m;
  if (!last) return null;
  return { date: last[1], price: Number(last[2]), costBps: last[3] != null ? Number(last[3]) : null };
}

/** `feeBps` is the fallback cost for rows whose model note does not record one. */
export function attributeTrips(trips: RoundTrip[], rows: LedgerRow[], feeBps: number): TripAttribution[] {
  const byClientId = new Map<string, LedgerRow>();
  for (const r of rows) {
    if (r.mode !== 'alpaca-paper' || r.action !== 'BUY') continue;
    const id = orderIdOf(r);
    if (id) byClientId.set(id, r);
  }
  return trips.map((trip) => {
    const entryRow = trip.entries.map((f) => byClientId.get(f.clientOrderId)).find(Boolean) ?? null;
    let modelGrossPct: number | null = null;
    let entrySlipBps: number | null = null;
    let exitSlipBps: number | null = null;
    if (entryRow) {
      const signalClose = Number(entryRow.price);
      if (signalClose > 0) entrySlipBps = (trip.entryVwap / signalClose - 1) * 10_000;
      const exit = lastModelExit(entryRow.reason);
      if ((entryRow.outcome === 'win' || entryRow.outcome === 'loss' || entryRow.outcome === 'flat') && entryRow.pnl !== '') {
        modelGrossPct = Number(entryRow.pnl) + (exit?.costBps ?? feeBps) / 100;
      }
      if (exit && trip.exitVwap != null) exitSlipBps = (trip.exitVwap / exit.price - 1) * 10_000;
    }
    const entryRule = entryRow ? ruleOfStateTag(entryRow.reason.match(/^\[([^\]]+)\]/)?.[1] ?? null) : null;
    const exitRow = exitRowFor(rows, trip);
    const exitKind = exitRow ? exitRuleKind(exitRow.reason) : null;
    const ruleChanged = !!entryRule && !!exitKind && (isSingleLookback(entryRule) ? exitKind === 'vote' : exitKind === 'single');
    if (ruleChanged) {
      modelGrossPct = null;
      exitSlipBps = null;
    }
    return { trip, entryRow, modelGrossPct, entrySlipBps, exitSlipBps, ruleChanged };
  });
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number, d = 2): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}%` : 'n/a');
const bp = (x: number): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(0)} bps` : 'n/a');
const bp1 = (x: number): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(1)} bps` : 'n/a');

/** USD charged as crypto fees (CFEE "USD" rows) and the count of fees taken in coin. */
export function summarizeFees(acts: BrokerActivity[]): { usd: number; inCoin: number } {
  let usd = 0;
  let inCoin = 0;
  for (const a of acts) {
    if (a.activity_type !== 'CFEE') continue;
    if ((a.description ?? '').includes('Non USD')) inCoin++;
    else usd += -Number(a.net_amount ?? 0);
  }
  return { usd, inCoin };
}

export async function runReport(): Promise<void> {
  const truth = await loadBrokerTruth();
  const rows = loadLedger();
  const attrib = attributeTrips(truth.trips, rows, CONFIG.feeBps);
  const closed = attrib.filter((a) => !a.trip.open && !a.trip.manual);
  const crypto = closed.filter((a) => a.trip.botSymbol.endsWith('USDT'));
  const stocks = closed.filter((a) => !a.trip.botSymbol.endsWith('USDT'));

  console.log(`Book since ${BOOK_START_ISO.slice(0, 10)}, from broker fills (gross of fees; manual probe trips excluded):`);
  for (const [name, set] of [['All', closed], ['Crypto', crypto], ['Stocks', stocks]] as const) {
    const g = set.map((a) => a.trip.grossPct as number);
    const usd = set.reduce((s, a) => s + (a.trip.cashPnlUsd ?? 0), 0);
    console.log(
      `  ${name.padEnd(7)} ${String(set.length).padStart(3)} round trips · win ${set.length ? ((g.filter((x) => x > 0).length / set.length) * 100).toFixed(0) : '0'}% · ` +
        `mean ${pct(mean(g))} · median ${pct(median(g))} · cash P&L $${usd.toFixed(0)}`
    );
  }

  const withModel = closed.filter((a) => a.modelGrossPct != null);
  const entrySlips = closed.map((a) => a.entrySlipBps).filter((x): x is number => x != null);
  const exitSlips = closed.map((a) => a.exitSlipBps).filter((x): x is number => x != null);
  console.log(`\nModel vs actual (${withModel.length} closed trips with a model score, gross both sides):`);
  if (withModel.length) {
    const gap = withModel.map((a) => (a.trip.grossPct as number) - (a.modelGrossPct as number));
    console.log(`  model mean ${pct(mean(withModel.map((a) => a.modelGrossPct as number)))} · actual mean ${pct(mean(withModel.map((a) => a.trip.grossPct as number)))} · gap mean ${pct(mean(gap))}, median ${pct(median(gap))}`);
  }
  const switched = closed.filter((a) => a.ruleChanged).length;
  if (switched) console.log(`  ${switched} trip(s) opened under the 28-day rule and closed under the vote are left out of the model and exit figures (the rule change, not execution).`);
  console.log(`  entry fill vs signal close: mean ${bp(mean(entrySlips))}, median ${bp(median(entrySlips))} (${entrySlips.length} trips; includes drift since the close)`);
  console.log(`  exit fill vs model exit close: mean ${bp(mean(exitSlips))}, median ${bp(median(exitSlips))} (${exitSlips.length} trips)`);
  // Each sleeve is scored at its own cost (FEE_BPS_CRYPTO, FEE_BPS_STOCKS), so measure each on its own.
  for (const [name, set] of [['crypto', crypto], ['stocks', stocks]] as const) {
    const en = set.map((a) => a.entrySlipBps).filter((x): x is number => x != null);
    const ex = set.map((a) => a.exitSlipBps).filter((x): x is number => x != null);
    console.log(`  ${name}: entry ${bp1(mean(en))} (median ${bp1(median(en))}, ${en.length} trips) · exit ${bp1(mean(ex))} (median ${bp1(median(ex))}, ${ex.length} trips)`);
  }

  try {
    const fees = summarizeFees(await fetchActivities('CFEE', BOOK_START_ISO));
    console.log(`\nCrypto fees charged: $${fees.usd.toFixed(2)} in USD, plus ${fees.inCoin} fee(s) taken in coin (those shrink the sold quantity and are inside cash P&L).`);
  } catch (err) {
    console.log(`\nCrypto fees: unavailable (${(err as Error).message.split('\n')[0]}).`);
  }

  console.log('\nPer symbol (actual = broker fills; model = ledger score for the same entries):');
  const syms = [...new Set(closed.map((a) => a.trip.botSymbol))];
  const agg = syms.map((s) => {
    const set = closed.filter((a) => a.trip.botSymbol === s);
    const act = set.reduce((x, a) => x + (a.trip.grossPct as number), 0);
    const mod = set.filter((a) => a.modelGrossPct != null);
    return { s, n: set.length, act, wins: set.filter((a) => (a.trip.grossPct as number) > 0).length, mod: mod.reduce((x, a) => x + (a.modelGrossPct as number), 0), nm: mod.length };
  });
  for (const a of agg.sort((x, y) => y.act - x.act)) {
    console.log(`  ${a.s.padEnd(11)} ${String(a.n).padStart(2)} trips · actual ${pct(a.act).padStart(8)} · wins ${a.wins}/${a.n} · model ${a.nm ? pct(a.mod) : '—'}${a.nm < a.n ? ` (${a.nm} scored)` : ''}`);
  }
  const open = truth.trips.filter((t) => t.open);
  const deployed = truth.positions.reduce((x, p) => x + Math.abs(Number(p.market_value)), 0);
  console.log(`\nOpen: ${truth.positions.length} positions ($${deployed.toFixed(0)}), ${open.length} open trips at the broker.`);
  console.log('Small samples rank noise, not skill: a symbol needs dozens of trips before "best" means anything (Trial 06).');
}
