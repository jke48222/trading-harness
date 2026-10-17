import type { BrokerActivity, PortfolioHistory } from './broker/orders';

/**
 * Cash that enters or leaves the paper account from outside the book:
 * deposits, withdrawals, journals, transfers. The bot can't make one (its
 * only writes are orders and position closes), so each one is news to
 * health, and performance has to take it out of the returns. Alpaca
 * journaled -$66,905.32 out of the account on 2026-10-13, and the daily
 * curve showed it as a -62.6% day (docs/incidents.md).
 *
 * Alpaca's portfolio history lists cash flows by activity type when asked
 * with cashflow_types=ALL. The API reference calls them accumulated values;
 * on this account each flow appears in exactly one point, the one whose
 * window it was booked in (checked 2026-10-17). The activity log is a second
 * record, and the two disagree: the log never listed that journal, and the
 * history can show a flow a day or more after the log does. Fills, fees,
 * and what the holdings earn or cost (dividends, interest, corporate
 * actions) are the book's own result and stay in its returns. Every other
 * type is external, including a type this list has never seen.
 */

// Alpaca's activity types as its API reference lists them (2026-10-17), plus older names for the same corporate actions (SC, SSO, SSP, OPXRC, CIL).
const BOOK_TYPES = new Set([
  'FILL', 'CFEE', 'FEE', 'CGD', 'MA', 'NC', 'OPASN', 'OPCA', 'OPCSH', 'OPEXC', 'OPEXP', 'OPTRD',
  'PTC', 'PTR', 'REO', 'REORG', 'SPIN', 'SPLIT', 'VOF', 'WH', 'SC', 'SSO', 'SSP', 'OPXRC', 'CIL',
]);

/** True for a cash flow from outside the book: anything but fills, fees, dividends, interest and corporate actions. */
export function isExternalFlowType(type: string): boolean {
  return !(BOOK_TYPES.has(type) || type.startsWith('DIV') || type.startsWith('INT'));
}

/**
 * The account was funded with $100,000 by a JNLC on 2026-07-14, which the
 * daily history books in its 2026-07-15 point, the book's first (perf's
 * PERF_START_DATE). A flow booked on or before that point is the funding.
 */
export const FUNDED_THROUGH = '2026-07-15';

export interface CashFlow {
  /** Stamp of the history point the flow is booked in, ms epoch. */
  t: number;
  /** UTC date of that stamp: the label perf and the dashboard give the point. */
  date: string;
  type: string;
  /** USD, positive into the account. */
  amount: number;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const cents = (x: number): number => Math.round(x * 100) / 100;

/** -$66,905.32; with `sign`, +$100,000.00 for an inflow. */
export function usd(x: number, sign = false): string {
  const r = cents(x);
  const body = `$${Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return r < 0 ? `-${body}` : sign && r > 0 ? `+${body}` : body;
}

/** External flows in a portfolio history, one per type per point, oldest first. */
export function externalFlows(h: PortfolioHistory): CashFlow[] {
  const out: CashFlow[] = [];
  for (const [type, values] of Object.entries(h.cashflow ?? {})) {
    if (!isExternalFlowType(type) || !Array.isArray(values)) continue;
    values.forEach((v, i) => {
      const s = h.timestamp[i];
      const amount = cents(Number(v));
      if (s == null || !Number.isFinite(amount) || amount === 0) return;
      out.push({ t: s * 1000, date: isoDate(s * 1000), type, amount });
    });
  }
  return out.sort((a, b) => a.t - b.t || a.type.localeCompare(b.type));
}

/** Health remembers each flow it has paged on by this key, so a flow whose amount later changes pages again. */
export const flowKey = (f: Pick<CashFlow, 'type' | 'date' | 'amount'>): string => `${f.type}:${f.date}:${f.amount.toFixed(2)}`;

const DAY_MS = 86_400_000;
const dayOf = (date: string): number => Date.parse(`${date}T00:00:00Z`);

// ---- returns net of flows ----

/**
 * One period's return net of the flows in it: its equity change less the
 * flows, over the equity at its start plus half the flows. That is the
 * Modified Dietz method with every flow at mid-period, because a daily point
 * says which day a flow landed, not when in the day: the 2026-10-13 journal
 * landed at 11:00 UTC, about halfway through its point's day. With no flow it
 * is the plain return. NaN when the period can't be valued (the start
 * equity plus half the flow is zero or below).
 */
export function periodReturn(start: number, end: number, flow: number): number {
  const base = start + flow / 2;
  return base > 0 ? (end - start - flow) / base : NaN;
}

/**
 * Time-weighted values of `points`, net of external cash flows. A period runs
 * from one point to the next and holds the flows booked after its start up to
 * and including its end; its return is `periodReturn`, chained. Flows at or
 * before the first point are its capital, and a flow on a point left out (no
 * value, a glitch) counts at the next point kept. `value` starts at the first
 * point's equity. Throws when a period can't be valued or would lose
 * everything, which only a flow booked a day off from its equity can cause.
 */
export function netOfFlows(points: { t: number; date: string; equity: number }[], flows: { t: number; amount: number }[]): { value: number; ret: number | null; flow: number }[] {
  const fs = [...flows].sort((a, b) => a.t - b.t);
  let j = 0;
  while (j < fs.length && points.length && fs[j].t <= points[0].t) j++;
  const out: { value: number; ret: number | null; flow: number }[] = [];
  let value = points.length ? points[0].equity : NaN;
  points.forEach((p, i) => {
    if (i === 0) {
      out.push({ value, ret: null, flow: 0 });
      return;
    }
    let flow = 0;
    while (j < fs.length && fs[j].t <= p.t) flow += fs[j++].amount;
    const ret = periodReturn(points[i - 1].equity, p.equity, flow);
    if (!(ret > -1)) {
      throw new Error(
        `The broker history's equity and cash flows disagree at ${p.date}: net of ${usd(flow, true)} in flows, the account would have lost everything that day. Check whether a flow is booked a day off.`
      );
    }
    value *= 1 + ret;
    out.push({ value, ret, flow });
  });
  return out;
}

/**
 * A flow this large against the equity before it is checked for the point it
 * really belongs to. Smaller flows can't be told from a market day (a $5,000
 * deposit on a -5% day reads like a flow booked a day off), and a day off
 * costs them little.
 */
export const LARGE_FLOW_SHARE = 0.2;

export interface AlignedFlow extends CashFlow {
  /**
   * Stamp of the point the flow counts at: `t`, unless the equity moved with
   * it a point earlier or later. Null when no point can absorb it (the equity
   * less the flow would be zero or below there and on either side): it is
   * left out of the netting, and perf flags it.
   */
  at: number | null;
}

/**
 * Where each flow counts. Alpaca books a flow in the point whose window it
 * happened in, and the equity steps in the same point (the 2026-10-13
 * journal), but the funding sits one point after the equity shows it, so the
 * two records can disagree. Counted a point off, a flow puts a false return
 * of about its own size into two days and leaves the level wrong after them.
 * So a flow of 20% of equity or more whose own point barely moves with it
 * (the rest of that point's change is over half the flow) moves to the next
 * or previous point when that leaves both periods within a fifth of the flow.
 * A bad print next to the flow can fit that loosely too (2026-09-09 printed
 * $24,632 low for one day); perf then finds it as an outlier net of the flow,
 * leaves it out, and the flow counts at the next point. A flow booked in
 * a day still in progress can move back to the last point the same way. A
 * flow its point can't absorb at all moves to the neighbour that can, fit or
 * not, or else is left uncounted. Any other flow that fits neither neighbour
 * stays where it is booked, and perf flags it.
 */
export function alignFlows(points: { t: number; equity: number }[], flows: CashFlow[]): AlignedFlow[] {
  const out: AlignedFlow[] = flows.map((f) => ({ ...f, at: f.t }));
  const n = points.length;
  const period = (t: number): number => points.findIndex((p) => p.t >= t);
  const flowAt = (j: number, fs: AlignedFlow[]): number => fs.filter((x) => x.at != null && period(x.at) === j).reduce((s, x) => s + x.amount, 0);
  const own = (j: number, fs: AlignedFlow[]): number => points[j].equity - points[j - 1].equity - flowAt(j, fs);
  const possible = (j: number, fs: AlignedFlow[]): boolean => periodReturn(points[j - 1].equity, points[j].equity, flowAt(j, fs)) > -1;
  const placed = (f: AlignedFlow, j: number): AlignedFlow[] => out.map((x) => (x === f ? { ...x, at: points[j].t } : x));
  for (const f of out) {
    const size = Math.abs(f.amount);
    const k = period(f.t);
    if (k === 0 || n < 2) continue; // the first point's capital
    if (k === -1) {
      // Booked in a day still in progress: it counts there, unless the last point already moved with it.
      const last = n - 1;
      if (size < LARGE_FLOW_SHARE * points[last - 1].equity || Math.abs(own(last, out)) <= 0.5 * size) continue;
      const moved = placed(f, last);
      if (possible(last, moved) && Math.abs(own(last, moved)) <= 0.2 * size) f.at = points[last].t;
      continue;
    }
    const impossible = !possible(k, out);
    if (!impossible && (size < LARGE_FLOW_SHARE * points[k - 1].equity || Math.abs(own(k, out)) <= 0.5 * size)) continue;
    let best: { at: number; worst: number } | null = null;
    for (const j of [k - 1, k + 1]) {
      if (j < 1 || j >= n) continue;
      const moved = placed(f, j);
      if (!possible(k, moved) || !possible(j, moved)) continue;
      const worst = Math.max(Math.abs(own(k, moved)), Math.abs(own(j, moved)));
      if ((impossible || worst <= 0.2 * size) && (!best || worst < best.worst)) best = { at: points[j].t, worst };
    }
    if (best) f.at = best.at;
    else if (impossible) f.at = null;
  }
  return out;
}

// ---- cash rebuilt from the activity log ----

/** When an activity happened: a fill's execution time, or when a non-trade activity was created, which is what the API's `after` filters on. */
export function activityTime(a: BrokerActivity): number {
  return Date.parse(a.transaction_time ?? a.created_at ?? `${a.date ?? ''}T00:00:00Z`);
}

/** What one activity did to cash: a fill moves price times quantity, anything else its net amount. Fees taken in coin carry 0. */
export function cashEffect(a: BrokerActivity): number {
  if (a.status === 'canceled') return 0;
  if (a.activity_type === 'FILL') {
    const v = Number(a.price) * Number(a.qty);
    return a.side === 'buy' ? -v : v;
  }
  return Number(a.net_amount ?? 0);
}

const isCryptoPair = (symbol = ''): boolean => symbol.includes('/') || (symbol.endsWith('USD') && symbol.length > 4);

export interface ExternalActivity {
  /** Alpaca's activity id: health keys a flow it saw in the log by this, so two equal flows on different days never share a key. */
  id: string;
  type: string;
  date: string;
  amount: number;
}

/** The activity log summed up to `through`, kept in data/health_state.json so a health run reads only the last few days. */
export interface CashLedger {
  /** Activities at or before this time (ISO) are summed in `cash`; later ones are read again every run. */
  through: string;
  cash: number;
  count: number;
  /** External activities through `through` (JNLC, CSD, ...), to match against the history's flows. */
  external: ExternalActivity[];
  /** When the log was last read in full (ISO). */
  fullAt: string;
}

export interface CashRebuild {
  /** Cash as the activity log has it. */
  cash: number;
  activities: number;
  external: ExternalActivity[];
  /** Crypto sold in the last 48 hours (USD). Broker cash takes the sell fee at once; the log posts it a day or so later. */
  recentCryptoSalesUsd: number;
}

/** Activities older than this are summed into the ledger for good; newer ones are re-read every run, so a late posting still counts. */
export const SETTLE_MS = 3 * 86_400_000;
/** The whole log is re-read at least this often, which catches anything posted more than SETTLE_MS late. */
export const FULL_READ_MS = 7 * 86_400_000;

/**
 * Cash from the activity log. With no `prior`, `rows` is the whole log; with
 * one, `rows` covers at least everything after `prior.through`, and older rows
 * are skipped because the ledger already holds them. Returns the rebuild and
 * the ledger to keep for the next run. Throws on an activity it can't read
 * rather than guess at cash.
 */
export function foldCash(prior: CashLedger | null, rows: BrokerActivity[], nowMs: number): { rebuild: CashRebuild; ledger: CashLedger } {
  const baseT = prior ? Date.parse(prior.through) : -Infinity;
  const through = Math.max(baseT, nowMs - SETTLE_MS);
  let cash = prior?.cash ?? 0;
  let count = prior?.count ?? 0;
  const external = [...(prior?.external ?? [])];
  const settled = { cash, count, external: [...external] };
  let sales = 0;
  for (const a of rows) {
    const t = activityTime(a);
    const v = cashEffect(a);
    if (!Number.isFinite(t) || !Number.isFinite(v)) {
      throw new Error(`A ${a.activity_type} activity has no readable ${Number.isFinite(t) ? 'amount' : 'time'}; the cash rebuild stops rather than guess.`);
    }
    if (t <= baseT) continue;
    // An external activity that moves no cash (a stock journal at $0) is not a cash flow.
    const ext = isExternalFlowType(a.activity_type) && a.status !== 'canceled' && cents(v) !== 0 ? { id: a.id, type: a.activity_type, date: a.date?.slice(0, 10) || isoDate(t), amount: cents(v) } : null;
    cash += v;
    count++;
    if (ext) external.push(ext);
    if (t <= through) {
      settled.cash += v;
      settled.count++;
      if (ext) settled.external.push(ext);
    }
    if (a.activity_type === 'FILL' && a.side !== 'buy' && isCryptoPair(a.symbol) && t > nowMs - 2 * 86_400_000) sales += v;
  }
  return {
    rebuild: { cash, activities: count, external, recentCryptoSalesUsd: sales },
    ledger: { through: new Date(through).toISOString(), cash: settled.cash, count: settled.count, external: settled.external, fullAt: prior?.fullAt ?? new Date(nowMs).toISOString() },
  };
}

export interface FlowMatch {
  /** Each history flow with the log activities it pairs with (none for a flow the log leaves out). */
  pairs: { flow: CashFlow; acts: ExternalActivity[] }[];
  /** The part of each history flow the log does not account for, like the 2026-10-13 journal. */
  historyOnly: { flow: CashFlow; amount: number }[];
  /** External activities the history does not show, or not yet: its daily point can come days after the log. */
  logOnly: ExternalActivity[];
}

/**
 * Pair the history's external flows with the activity log's. A flow books in
 * the first point after it happens, which is the next session's point: over
 * a holiday weekend, or after the 2026-12-24 early close, that is 4 or 5 days
 * after the activity's date. So a flow pairs with activities of its type
 * dated from a day after its point to 6 days before it. A point stamped at
 * 00:00 UTC on day D holds what happened by then, so the activities dated 1
 * to 6 days before it come first, then its own day, then the day after: one
 * of the same amount, else a few that sum to it (a point holds the sum of its
 * window). Failing both, the log is taken to list part of it: the activities
 * of the same sign dated before its day, if they come to less than the flow,
 * and the rest of the flow is left unlisted. An activity of the other sign is
 * never part of it, so a journal can't swallow its own reversal; the price is
 * that a deposit and a journal in one point can't be told apart. The whole
 * log is matched, not just the history's span, so a flow at the edge of the
 * span still finds its activity.
 */
export function matchFlows(flows: CashFlow[], external: ExternalActivity[]): FlowMatch {
  const unused = [...external];
  const pairs: FlowMatch['pairs'] = [];
  const historyOnly: FlowMatch['historyOnly'] = [];
  for (const f of [...flows].sort((a, b) => a.t - b.t)) {
    const lag = (a: ExternalActivity): number => (dayOf(f.date) - dayOf(a.date)) / DAY_MS;
    const rank = (a: ExternalActivity): number => (lag(a) >= 1 ? lag(a) : 7 - lag(a));
    const near = unused.filter((a) => a.type === f.type && lag(a) >= -1 && lag(a) <= 6).sort((a, b) => rank(a) - rank(b));
    const one = near.find((a) => Math.abs(a.amount - f.amount) < 0.005);
    let acts = one ? [one] : summingTo(near, f.amount);
    if (!acts) {
      const part = near.filter((a) => lag(a) >= 1 && Math.sign(a.amount) === Math.sign(f.amount));
      acts = Math.abs(part.reduce((s, a) => s + a.amount, 0)) < Math.abs(f.amount) ? part : [];
    }
    for (const a of acts) unused.splice(unused.indexOf(a), 1);
    pairs.push({ flow: f, acts });
    const rest = cents(f.amount - acts.reduce((s, a) => s + a.amount, 0));
    if (rest !== 0) historyOnly.push({ flow: f, amount: rest });
  }
  return { pairs, historyOnly, logOnly: unused };
}

/** The first set of up to 10 activities whose amounts sum to `target` to the cent, or null. */
function summingTo(xs: ExternalActivity[], target: number): ExternalActivity[] | null {
  const pool = xs.slice(0, 10);
  for (let mask = 1; mask < 1 << pool.length; mask++) {
    let sum = 0;
    for (let i = 0; i < pool.length; i++) if (mask & (1 << i)) sum += pool[i].amount;
    if (Math.abs(sum - target) < 0.005) return pool.filter((_, i) => mask & (1 << i));
  }
  return null;
}
