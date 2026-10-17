import type { PortfolioHistory } from './broker/orders';

/**
 * Cash that enters or leaves the paper account from outside the book:
 * deposits, withdrawals, journals, transfers. The bot can't make one (its
 * only writes are orders and position closes), so performance has to take
 * each one out of the returns. Alpaca journaled -$66,905.32 out of the
 * account on 2026-10-13, and the daily curve showed it as a -62.6% day
 * (docs/incidents.md).
 *
 * Alpaca's portfolio history lists cash flows by activity type when asked
 * with cashflow_types=ALL. The API reference calls them accumulated values;
 * on this account each flow appears in exactly one point, the one whose
 * window it was booked in (checked 2026-10-17). Fills, fees, and what the
 * holdings earn or cost (dividends, interest, corporate actions) are the
 * book's own result and stay in its returns. Every other type is external,
 * including a type this list has never seen.
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
