import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { type BrokerPosition, type PortfolioHistory, botSymbolOf, fetchActivities, getPortfolioHistory } from './broker/orders';
import type { RoundTrip } from './broker/fills';
import { type AlignedFlow, type CashFlow, LARGE_FLOW_SHARE, alignFlows, externalFlows, netOfFlows, periodReturn, usd } from './cashflows';
import { BOOK_START_ISO, loadBrokerTruth } from './reconcileRun';
import { type TripAttribution, attributeTrips, summarizeFees } from './report';
import { loadLedger } from './memory';
import { BOOK_CRYPTO, BOOK_STOCKS } from './universe';
import { closedCandles, fetchCandlesSince } from './market';
import { fetchStockCandles } from './stockdata';
import type { Candle } from './types';

/**
 * Account-level performance of the paper book. `npm run perf` prints it and
 * writes data/perf.json for the dashboard. Every source is read-only: Alpaca's
 * daily equity history, broker fills and positions, the CFEE activity log, the
 * ledger's model scores, and public daily closes for the benchmarks.
 *
 * Timing. Alpaca's daily history has one point per US trading day, stamped
 * 20:00 New York after the session: 00:00 UTC in summer, 01:00 UTC in winter,
 * 22:00 UTC after a 13:00 early close (checked 2026-10-11 over a year of this
 * account's history). Each point is the account's value at that moment, so
 * benchmarks are priced at the same moments: the last Binance daily close at
 * or before the stamp, and the last US session close before it. Checked 2026-10-11: the account's daily returns
 * correlate 0.73 with BTC priced this way and 0.12 with the candle that
 * carries the stamp's date (SPY: 0.43 against -0.07).
 *
 * Returns are time-weighted, net of cash that entered or left the account
 * from outside the book (src/cashflows.ts), so a journal is neither a gain
 * nor a loss. Before 2026-10-17 the curve was raw equity, and Alpaca's
 * -$66,905.32 journal of 2026-10-13 read as a -62.6% day (docs/incidents.md).
 *
 * perf.json is written only when every source answered, so the dashboard
 * never shows a half-built report.
 */

/** The book went live on 2026-07-15; its window starts at the first history point on or after this date. */
export const PERF_START_DATE = '2026-07-15';

/**
 * Points per year, for annualizing. The history has one point per US trading
 * day (crypto's weekend moves land on the next trading day's point), so a
 * year holds about 252 of them. Scaling by sqrt(365) would overstate
 * volatility and Sharpe by sqrt(365/252), about 20%.
 */
export const POINTS_PER_YEAR = 252;

/** A point is a glitch when it is more than 10% away from both neighbors while the neighbors agree within 2%. */
export const GLITCH_DEVIATION = 0.1;
export const GLITCH_NEIGHBORS_AGREE = 0.02;

const DAY_MS = 86_400_000;
/** Alpaca daily stock bars open at 00:00 New York, so the 16:00 close is 16 hours later in every season. */
const SESSION_CLOSE_MS = 16 * 3_600_000;
/** History periods tried in order until the response reaches back to the book start. */
const HISTORY_PERIODS = ['1A', '2A', '3A', '5A'];

export interface HistoryPoint {
  /** Stamp, ms epoch. */
  t: number;
  /** UTC date of the stamp, the label Alpaca's data carries. */
  date: string;
  equity: number | null;
}

export interface EquityPoint {
  t: number;
  date: string;
  equity: number;
}

export interface CurvePoint extends EquityPoint {
  /** The start equity grown by the time-weighted return to this point: what the account would hold with no external cash flows. */
  value: number;
}

/** An external cash flow inside the window, shown as an event on the curve. */
export interface FlowEvent {
  /** The history point it is booked in. */
  date: string;
  /** The point it counts at: its own, or the next one kept when its own is left out, or the neighbour whose equity moved with it; empty when no point can absorb it and it is not counted. */
  countedOn: string;
  type: string;
  amountUsd: number;
  /** Equity change over the period the flow fell in, less the flows: the book's own result. */
  bookPnlUsd: number;
  note: string;
}

export interface ExcludedPoint {
  date: string;
  equity: number;
  reason: string;
}

export interface DayMove {
  date: string;
  pct: number;
}

export interface Drawdown {
  /** Peak to trough, in % (negative, or 0 when equity never fell). */
  pct: number;
  peak: string;
  trough: string;
}

export interface SleeveStats {
  trips: number;
  winRatePct: number;
  meanGrossPct: number;
  cashPnlUsd: number;
}

export interface Sleeves<T> {
  all: T;
  crypto: T;
  stocks: T;
}

export interface Benchmark {
  name: string;
  returnPct: number;
  excessPct: number;
  note: string;
}

export interface ExecutionStats {
  tripsWithModel: number;
  gapMeanPct: number;
  gapMedianPct: number;
  entrySlipMeanBps: number;
  exitSlipMeanBps: number;
  /** Trips behind each slippage mean (printed, not part of perf.json). */
  entrySlipTrips: number;
  exitSlipTrips: number;
}

/** The exact shape of data/perf.json (the dashboard reads it). */
export interface PerfJson {
  generatedAt: string;
  bookStart: string;
  equity: {
    start: number;
    end: number;
    returnPct: number;
    maxDrawdownPct: number;
    maxDrawdownPeak: string;
    maxDrawdownTrough: string;
    annVolPct: number;
    sharpe: number | null;
    bestDay: DayMove;
    worstDay: DayMove;
    excludedPoints: ExcludedPoint[];
    /** External cash flows inside the window, net. Every return above leaves them out. */
    netFlowsUsd: number;
    cashFlows: FlowEvent[];
  };
  /** `equity` is the broker's; `value` is the start equity grown by the time-weighted return, net of external flows. */
  curve: { date: string; equity: number; value: number }[];
  benchmarks: Benchmark[];
  realized: Sleeves<SleeveStats>;
  unrealized: Sleeves<number>;
  fees: { usd: number; inCoinCount: number };
  execution: {
    tripsWithModel: number;
    gapMeanPct: number;
    gapMedianPct: number;
    entrySlipMeanBps: number;
    exitSlipMeanBps: number;
  };
}

// ---- small math and formatting ----

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Sample standard deviation (n - 1), as the research scripts use. */
const sampleSd = (xs: number[]): number => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
};
/** Rounded for perf.json. A value that is undefined (no trips, say) is written as 0; the counts beside it say why. */
const fin = (x: number, digits: number): number => (Number.isFinite(x) ? Number(x.toFixed(digits)) : 0);
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

function signed(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return 'n/a';
  const r = Number(x.toFixed(digits));
  return `${r >= 0 ? '+' : ''}${r.toFixed(digits)}`;
}
const pct = (x: number, digits = 2): string => (Number.isFinite(x) ? `${signed(x, digits)}%` : 'n/a');
function money(x: number): string {
  const r = Number(x.toFixed(2));
  return `${r < 0 ? '-' : ''}$${Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const signedMoney = (x: number): string => `${Number(x.toFixed(2)) > 0 ? '+' : ''}${money(x)}`;

/** Word-wrap `text` to `width` columns, every line prefixed with `indent`. Text that already fits is kept as written. */
export function wrap(text: string, width: number, indent: string): string[] {
  if (indent.length + text.length <= width) return [indent + text];
  const lines: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + w.length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

// ---- equity ----

export function historyPoints(h: PortfolioHistory): HistoryPoint[] {
  return h.timestamp.map((s, i) => ({ t: s * 1000, date: isoDate(s * 1000), equity: h.equity[i] ?? null }));
}

/** True when the history starts on or before `startDate`, so the book's first day is inside it. */
export function coversStart(h: PortfolioHistory, startDate = PERF_START_DATE): boolean {
  return h.timestamp.length > 0 && isoDate(h.timestamp[0] * 1000) <= startDate;
}

/**
 * Split out one-day glitches: a point more than `deviation` away from both
 * neighbors while the neighbors agree within `agree` (2026-09-09: 75,118.07
 * between 99,750.90 and 99,918.66). A real move that lasts two days or more
 * is kept, and so is a point whose neighbors disagree. The first and last
 * points have one neighbor and are never judged. With `flows` (counted at
 * their stamps), each comparison leaves out the cash that moved in between,
 * so a journal and its reversal the next day are not a bad print, and a bad
 * print on the day a flow lands still is.
 */
export function findGlitches(
  points: EquityPoint[],
  deviation = GLITCH_DEVIATION,
  agree = GLITCH_NEIGHBORS_AGREE,
  flows: { t: number; amount: number }[] = []
): { kept: EquityPoint[]; glitches: (ExcludedPoint & { t: number })[] } {
  const kept: EquityPoint[] = [];
  const glitches: (ExcludedPoint & { t: number })[] = [];
  const flowIn = (a: number, b: number): number => flows.filter((f) => f.t > a && f.t <= b).reduce((s, f) => s + f.amount, 0);
  points.forEach((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    const into = prev ? flowIn(prev.t, p.t) : 0;
    const out = next ? flowIn(p.t, next.t) : 0;
    const rOut = next ? periodReturn(p.equity, next.equity, out) : NaN;
    if (prev && next && rOut > -1) {
      // The point's move from the day before, its move to the day after (as the point against the next), and the two days together, each net of the flows in them.
      const vsPrev = periodReturn(prev.equity, p.equity, into);
      const vsNext = 1 / (1 + rOut) - 1;
      const neighbors = periodReturn(prev.equity, next.equity, into + out);
      if (Math.abs(vsPrev) > deviation && Math.abs(vsNext) > deviation && Math.abs(neighbors) <= agree) {
        glitches.push({
          t: p.t,
          date: p.date,
          equity: p.equity,
          reason:
            `one-day outlier: ${pct(vsPrev * 100)} vs ${prev.date} and ${pct(vsNext * 100)} vs ${next.date}, ` +
            `which agree within ${Math.abs(neighbors * 100).toFixed(2)}%${into || out ? ', net of outside cash' : ''}`,
        });
        return;
      }
    }
    kept.push(p);
  });
  return { kept, glitches };
}

/** Largest peak-to-trough fall, with the dates of that peak and trough. */
export function maxDrawdown(points: EquityPoint[]): Drawdown {
  if (!points.length) return { pct: 0, peak: '', trough: '' };
  let peak = points[0];
  let out: Drawdown = { pct: 0, peak: peak.date, trough: peak.date };
  for (const p of points) {
    if (p.equity >= peak.equity) peak = p;
    const dd = (p.equity / peak.equity - 1) * 100;
    if (dd < out.pct) out = { pct: dd, peak: peak.date, trough: p.date };
  }
  return out;
}

/** Return from each point to the next, in %, dated by the later point. */
export function dailyMoves(points: EquityPoint[]): DayMove[] {
  return points.slice(1).map((p, i) => ({ date: p.date, pct: (p.equity / points[i].equity - 1) * 100 }));
}

/**
 * The window's flows as events. Each is dated by the history point Alpaca
 * books it in and names the point it counts at, with the book's own result
 * over that period, so a reader can see the flow and the market move apart.
 * A large flow that neither its own point nor a neighbour moves with is
 * flagged: its period's return is likely wrong by about its size.
 */
export function flowEvents(curve: EquityPoint[], flows: AlignedFlow[]): FlowEvent[] {
  const events: FlowEvent[] = [];
  if (curve.length < 2) return events;
  const first = curve[0].t;
  const last = curve[curve.length - 1].t;
  for (const f of flows) {
    // A flow no point can absorb is described where Alpaca books it.
    const at = f.at ?? f.t;
    if (at <= first || at > last) continue;
    const i = curve.findIndex((p) => p.t >= at);
    const a = curve[i - 1];
    const b = curve[i];
    const inPeriod = flows.filter((x) => x.at != null && x.at > a.t && x.at <= b.t).reduce((s, x) => s + x.amount, 0);
    const moved = b.equity - a.equity;
    const own = moved - inPeriod;
    let note = `Equity moved ${usd(moved, true)} from ${a.date} to ${b.date}; the book's own result was ${usd(own, true)}.`;
    if (f.at == null) note += ' Not counted: the equity here and a point either side is too small to have held it, so these returns include it; check those points by hand.';
    else if (b.date !== f.date && b.t === f.at) note += ` Alpaca books it in the ${f.date} point, but the equity moved with it at ${b.date}, so it counts there.`;
    else if (b.date !== f.date) note += ` Booked in the ${f.date} point, which is left out, so it counts at ${b.date}.`;
    if (f.at != null && Math.abs(f.amount) >= LARGE_FLOW_SHARE * a.equity && Math.abs(own) > 0.5 * Math.abs(f.amount)) {
      note += ' Equity barely moved with this flow here or a point either side, so the returns around it are likely wrong by about its size; check those points by hand.';
    }
    events.push({ date: f.date, countedOn: f.at == null ? '' : b.date, type: f.type, amountUsd: f.amount, bookPnlUsd: own, note });
  }
  return events;
}

/**
 * Annualized volatility (%) and Sharpe from per-point returns (fractions):
 * rf 0, sample sd, scaled by sqrt(perYear). Sharpe is null when undefined
 * (fewer than two returns, or no variation).
 */
export function riskStats(returns: number[], perYear = POINTS_PER_YEAR): { annVolPct: number; sharpe: number | null } {
  const sd = sampleSd(returns);
  if (!Number.isFinite(sd)) return { annVolPct: NaN, sharpe: null };
  return { annVolPct: sd * Math.sqrt(perYear) * 100, sharpe: sd > 0 ? (mean(returns) / sd) * Math.sqrt(perYear) : null };
}

export interface EquityStats {
  bookStart: string;
  /** Window points used for every statistic (excluded points removed), with their value net of external flows. */
  curve: CurvePoint[];
  /** Window points left out, each with its reason. */
  excluded: ExcludedPoint[];
  start: CurvePoint;
  end: CurvePoint;
  /** Time-weighted, net of external flows; drawdown, volatility, Sharpe and the best and worst days use the same returns. */
  returnPct: number;
  drawdown: Drawdown;
  /** Max drawdown with glitch points left in, to show what the filter changed. */
  unfilteredDrawdownPct: number;
  annVolPct: number;
  sharpe: number | null;
  best: DayMove;
  worst: DayMove;
  /** Daily returns behind the volatility and Sharpe. */
  returns: number;
  /** External cash flows inside the window. */
  flows: FlowEvent[];
  netFlowsUsd: number;
}

/**
 * Equity statistics for the window that starts at `startDate`, net of the
 * external cash `flows`. Points with no usable value, points stamped after
 * `nowMs` (a day still in progress) and one-day glitches are excluded and
 * listed. Glitches are judged on the whole funded history, so the window's
 * first point is checked against the day before it, and on values net of
 * flows, so a journal reversed the next day can't pass for a bad print.
 */
export function analyzeEquity(points: HistoryPoint[], startDate: string, nowMs: number, flows: CashFlow[] = []): EquityStats {
  const inWindow = (p: { date: string }): boolean => p.date >= startDate;
  const excluded: ExcludedPoint[] = [];
  const usable: EquityPoint[] = [];
  for (const p of points) {
    const e = p.equity;
    if (e == null || !Number.isFinite(e) || e <= 0) {
      // Alpaca reports 0 before the account was funded; only gaps inside the window are listed.
      if (inWindow(p)) excluded.push({ date: p.date, equity: 0, reason: e == null ? 'no equity value in the broker history' : `unusable equity value ${e}` });
      continue;
    }
    if (p.t > nowMs) {
      if (inWindow(p)) excluded.push({ date: p.date, equity: e, reason: 'the day is still in progress' });
      continue;
    }
    usable.push({ t: p.t, date: p.date, equity: e });
  }
  // Flows booked on or before the start funded the book; they are its capital, not news.
  const live = alignFlows(
    usable.filter(inWindow),
    flows.filter((f) => f.date > startDate)
  );
  const counted = live.filter((f) => f.at != null).map((f) => ({ t: f.at as number, amount: f.amount }));
  const valued = (pts: EquityPoint[]): EquityPoint[] => netOfFlows(pts, counted).map((v, i) => ({ ...pts[i], equity: v.value }));
  // Outliers are judged net of the flows around them. Points are told apart by stamp: an early close puts two points on one UTC date.
  const { glitches } = findGlitches(usable, GLITCH_DEVIATION, GLITCH_NEIGHBORS_AGREE, counted);
  const glitchStamps = new Set(glitches.map((g) => g.t));
  excluded.push(...glitches.filter(inWindow).map((g) => ({ date: g.date, equity: g.equity, reason: g.reason })));
  excluded.sort((a, b) => a.date.localeCompare(b.date));

  const kept = usable.filter((p) => !glitchStamps.has(p.t) && inWindow(p));
  if (kept.length < 2) {
    throw new Error(`The equity history has ${kept.length} usable point(s) since ${startDate}; at least 2 are needed.`);
  }
  const adj = netOfFlows(kept, counted);
  const curve: CurvePoint[] = kept.map((p, i) => ({ ...p, value: adj[i].value }));
  const moves: DayMove[] = curve.slice(1).map((p, i) => ({ date: p.date, pct: (adj[i + 1].ret as number) * 100 }));
  const { annVolPct, sharpe } = riskStats(moves.map((m) => m.pct / 100));
  const start = curve[0];
  const end = curve[curve.length - 1];
  const events = flowEvents(kept, live);
  let unfilteredDrawdownPct = NaN;
  try {
    unfilteredDrawdownPct = maxDrawdown(valued(usable.filter(inWindow))).pct;
  } catch {
    // A bad print against a large flow can't be valued; the report then says nothing about it.
  }
  return {
    bookStart: start.date,
    curve,
    excluded,
    start,
    end,
    returnPct: (end.value / start.value - 1) * 100,
    drawdown: maxDrawdown(curve.map((p) => ({ ...p, equity: p.value }))),
    unfilteredDrawdownPct,
    annVolPct,
    sharpe,
    best: moves.reduce((a, b) => (b.pct > a.pct ? b : a)),
    worst: moves.reduce((a, b) => (b.pct < a.pct ? b : a)),
    returns: moves.length,
    flows: events,
    netFlowsUsd: events.filter((x) => x.countedOn).reduce((s, x) => s + x.amountUsd, 0),
  };
}

// ---- benchmarks ----

export interface PriceAt {
  close: number;
  /** When that close printed, ms epoch. */
  at: number;
}

/** When a daily candle's close printed: a Binance day ends at the next 00:00 UTC, a US session at 16:00 New York. */
export function closeTimeOf(c: Candle, crypto: boolean): number {
  return crypto ? c.closeTime + 1 : c.openTime + SESSION_CLOSE_MS;
}

/**
 * The last close printed at or before `t`, or null when there is none or it
 * is older than `maxAgeMs`. Crypto must have closed within 26 hours: the
 * candle ending at 00:00 UTC is 0 to 1 hour before a normal stamp but 22
 * hours before an early-close day's 22:00 UTC stamp. A stock may be up to 4
 * days old (weekend plus holiday), though a trading-day stamp always finds
 * that day's session.
 */
export function closeAsOf(candles: Candle[], t: number, crypto: boolean, maxAgeMs = crypto ? 26 * 3_600_000 : 4 * DAY_MS): PriceAt | null {
  let best: PriceAt | null = null;
  for (const c of candles) {
    const at = closeTimeOf(c, crypto);
    if (at <= t && c.close > 0 && (!best || at > best.at)) best = { close: c.close, at };
  }
  return best && t - best.at <= maxAgeMs ? best : null;
}

export interface Leg {
  symbol: string;
  start: PriceAt | null;
  end: PriceAt | null;
  /** Set when the price fetch failed. */
  error?: string;
}

export function legReturnPct(leg: Leg): number | null {
  return leg.start && leg.end ? (leg.end.close / leg.start.close - 1) * 100 : null;
}

/** Start and end prices of one symbol at two stamps. */
export function legFromCandles(symbol: string, candles: Candle[], t0: number, t1: number): Leg {
  const crypto = symbol.endsWith('USDT');
  return { symbol, start: closeAsOf(candles, t0, crypto), end: closeAsOf(candles, t1, crypto) };
}

/**
 * Equal dollars in every symbol at the start, held: the return is the mean of
 * the symbol returns. A symbol with no price at the start (or end), or whose
 * fetch failed, is left out and listed with the reason.
 */
export function equalWeight(
  legs: Leg[],
  startDate: string,
  endDate: string
): { returnPct: number; used: number; excluded: { symbol: string; reason: string }[] } {
  const rets: number[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  for (const l of legs) {
    if (l.error) excluded.push({ symbol: l.symbol, reason: `no data (${l.error})` });
    else if (!l.start) excluded.push({ symbol: l.symbol, reason: `no price at the start (${startDate})` });
    else if (!l.end) excluded.push({ symbol: l.symbol, reason: `no price at the end (${endDate})` });
    else rets.push(legReturnPct(l) as number);
  }
  return { returnPct: mean(rets), used: rets.length, excluded };
}

// ---- broker P&L, fees, execution ----

const isCryptoTrip = (t: RoundTrip): boolean => t.botSymbol.endsWith('USDT');

/** Closed, non-manual round trips per sleeve: count, win rate, mean gross %, cash P&L. */
export function sleeveStats(trips: RoundTrip[]): Sleeves<SleeveStats> {
  const closed = trips.filter((t) => !t.open && !t.manual);
  const stat = (set: RoundTrip[]): SleeveStats => {
    const g = set.map((t) => t.grossPct as number);
    return {
      trips: set.length,
      winRatePct: set.length ? (g.filter((x) => x > 0).length / set.length) * 100 : NaN,
      meanGrossPct: mean(g),
      cashPnlUsd: set.reduce((s, t) => s + (t.cashPnlUsd ?? 0), 0),
    };
  };
  return { all: stat(closed), crypto: stat(closed.filter(isCryptoTrip)), stocks: stat(closed.filter((t) => !isCryptoTrip(t))) };
}

/** Crypto by the broker's asset class when present, else by symbol (positions spell crypto BTCUSD). */
function isCryptoPosition(p: BrokerPosition & { asset_class?: string }): boolean {
  return p.asset_class ? p.asset_class === 'crypto' : botSymbolOf(p.symbol).endsWith('USDT');
}

/** Unrealized P&L (USD) of open broker positions, per sleeve. */
export function unrealizedSplit(positions: BrokerPosition[]): Sleeves<number> {
  let crypto = 0;
  let stocks = 0;
  for (const p of positions) {
    const v = Number(p.unrealized_pl);
    if (isCryptoPosition(p)) crypto += v;
    else stocks += v;
  }
  return { all: crypto + stocks, crypto, stocks };
}

/**
 * Buy fees Alpaca took in coin on the open crypto positions, valued at the
 * entry price. The broker's unrealized P&L leaves them out: its cost basis is
 * the smaller quantity held at the full entry price. They reach cash P&L when
 * the position closes and sells the smaller quantity.
 */
export function openCoinFeesUsd(positions: BrokerPosition[], trips: RoundTrip[]): number {
  let usd = 0;
  for (const p of positions) {
    if (!isCryptoPosition(p)) continue;
    const trip = trips.find((t) => t.open && t.botSymbol === botSymbolOf(p.symbol));
    if (trip) usd += (trip.entryQty - trip.exitQty - Number(p.qty)) * trip.entryVwap;
  }
  return usd;
}

/** Model vs actual on closed, non-manual trips, the same cut `npm run report` prints. */
export function executionStats(attrib: TripAttribution[]): ExecutionStats {
  const closed = attrib.filter((a) => !a.trip.open && !a.trip.manual);
  const withModel = closed.filter((a) => a.modelGrossPct != null);
  const gap = withModel.map((a) => (a.trip.grossPct as number) - (a.modelGrossPct as number));
  const entry = closed.map((a) => a.entrySlipBps).filter((x): x is number => x != null);
  const exit = closed.map((a) => a.exitSlipBps).filter((x): x is number => x != null);
  return {
    tripsWithModel: withModel.length,
    gapMeanPct: mean(gap),
    gapMedianPct: median(gap),
    entrySlipMeanBps: mean(entry),
    exitSlipMeanBps: mean(exit),
    entrySlipTrips: entry.length,
    exitSlipTrips: exit.length,
  };
}

// ---- assembling perf.json ----

export interface PerfParts {
  generatedAt: string;
  equity: EquityStats;
  /** Benchmark returns before the account's excess is taken. */
  benchmarks: { name: string; returnPct: number; note: string }[];
  realized: Sleeves<SleeveStats>;
  unrealized: Sleeves<number>;
  fees: { usd: number; inCoin: number };
  execution: ExecutionStats;
}

/** Build perf.json, field for field in the published shape, rounded for reading. */
export function buildPerfJson(p: PerfParts): PerfJson {
  const e = p.equity;
  const sleeve = (s: SleeveStats): SleeveStats => ({
    trips: s.trips,
    winRatePct: fin(s.winRatePct, 2),
    meanGrossPct: fin(s.meanGrossPct, 4),
    cashPnlUsd: fin(s.cashPnlUsd, 2),
  });
  return {
    generatedAt: p.generatedAt,
    bookStart: e.bookStart,
    equity: {
      start: fin(e.start.equity, 2),
      end: fin(e.end.equity, 2),
      returnPct: fin(e.returnPct, 4),
      maxDrawdownPct: fin(e.drawdown.pct, 4),
      maxDrawdownPeak: e.drawdown.peak,
      maxDrawdownTrough: e.drawdown.trough,
      annVolPct: fin(e.annVolPct, 4),
      sharpe: e.sharpe == null || !Number.isFinite(e.sharpe) ? null : fin(e.sharpe, 4),
      bestDay: { date: e.best.date, pct: fin(e.best.pct, 4) },
      worstDay: { date: e.worst.date, pct: fin(e.worst.pct, 4) },
      excludedPoints: e.excluded.map((x) => ({ date: x.date, equity: fin(x.equity, 2), reason: x.reason })),
      netFlowsUsd: fin(e.netFlowsUsd, 2),
      cashFlows: e.flows.map((f) => ({ date: f.date, countedOn: f.countedOn, type: f.type, amountUsd: fin(f.amountUsd, 2), bookPnlUsd: fin(f.bookPnlUsd, 2), note: f.note })),
    },
    curve: e.curve.map((x) => ({ date: x.date, equity: fin(x.equity, 2), value: fin(x.value, 2) })),
    benchmarks: p.benchmarks.map((b) => ({
      name: b.name,
      returnPct: fin(b.returnPct, 4),
      excessPct: fin(e.returnPct - b.returnPct, 4),
      note: b.note,
    })),
    realized: { all: sleeve(p.realized.all), crypto: sleeve(p.realized.crypto), stocks: sleeve(p.realized.stocks) },
    unrealized: { all: fin(p.unrealized.all, 2), crypto: fin(p.unrealized.crypto, 2), stocks: fin(p.unrealized.stocks, 2) },
    fees: { usd: fin(p.fees.usd, 2), inCoinCount: p.fees.inCoin },
    execution: {
      tripsWithModel: p.execution.tripsWithModel,
      gapMeanPct: fin(p.execution.gapMeanPct, 4),
      gapMedianPct: fin(p.execution.gapMedianPct, 4),
      entrySlipMeanBps: fin(p.execution.entrySlipMeanBps, 2),
      exitSlipMeanBps: fin(p.execution.exitSlipMeanBps, 2),
    },
  };
}

// ---- the printed report ----

export interface RenderContext {
  /** Max drawdown with the glitch points left in. */
  unfilteredDrawdownPct: number;
  entrySlipTrips: number;
  exitSlipTrips: number;
  openPositions: number;
  /** Coin fees inside the open crypto positions that the broker's unrealized P&L leaves out. */
  openCoinFeesUsd: number;
  /** Where perf.json went. */
  outPath: string;
}

const WIDTH = 72;

/** The plain-text report, one string per line, none wider than 72 columns. */
export function renderPerf(perf: PerfJson, ctx: RenderContext): string[] {
  const e = perf.equity;
  const out: string[] = [];
  const row = (label: string, value: string): void => {
    const head = `  ${label.padEnd(16)}`;
    const lines = wrap(value, WIDTH, ' '.repeat(head.length));
    lines[0] = head + lines[0].trimStart();
    out.push(...lines);
  };
  const note = (text: string, indent = '  '): void => {
    out.push(...wrap(text, WIDTH, indent));
  };
  const last = perf.curve[perf.curve.length - 1];

  out.push(`Account performance: Alpaca paper book since ${perf.bookStart}`);
  out.push(`Generated ${perf.generatedAt.slice(0, 16).replace('T', ' ')} UTC`);
  out.push('');
  out.push('Equity (broker daily history)');
  note('One point per US trading day, stamped 00:00 UTC: the account after that session.');
  row('start', `${money(e.start)}  ${perf.bookStart}`);
  row('end', `${money(e.end)}  ${last ? last.date : ''}`);
  if (e.cashFlows.length) row('external flows', `${signedMoney(e.netFlowsUsd)} net (${e.cashFlows.length})`);
  row('return', `${pct(e.returnPct)} time-weighted`);
  row('max drawdown', `${pct(e.maxDrawdownPct)}  peak ${e.maxDrawdownPeak}, trough ${e.maxDrawdownTrough}`);
  row('volatility', `${e.annVolPct.toFixed(2)}% a year`);
  row('Sharpe', e.sharpe == null ? 'n/a' : e.sharpe.toFixed(2));
  row('best day', `${pct(e.bestDay.pct)}  ${e.bestDay.date}`);
  row('worst day', `${pct(e.worstDay.pct)}  ${e.worstDay.date}`);
  row('points', `${perf.curve.length} used, ${e.excludedPoints.length} excluded`);
  note(
    'Every return is time-weighted: each day leaves out cash that entered or left the account from outside ' +
      'the book, so a deposit, withdrawal or journal is neither a gain nor a loss. A flow is taken to land ' +
      'at mid-day, since the history shows the day but not the hour.'
  );
  note(
    `Sharpe: rf 0, mean over sample sd of the daily returns, times sqrt(${POINTS_PER_YEAR}). ` +
      `Volatility uses the same scaling. A year of this history holds about ${POINTS_PER_YEAR} points, ` +
      'not 365: crypto moves over a weekend land on the next trading day.'
  );
  if (e.cashFlows.length) {
    out.push('  External cash flows, left out of every return:');
    for (const f of e.cashFlows) {
      out.push(`    ${f.date}  ${f.type}  ${signedMoney(f.amountUsd)}`);
      note(f.note, '      ');
    }
  }
  if (e.excludedPoints.length) {
    out.push('  Excluded from every statistic and the curve:');
    for (const x of e.excludedPoints) {
      out.push(`    ${x.date}  ${money(x.equity)}`);
      note(x.reason, '      ');
    }
    if (Number.isFinite(ctx.unfilteredDrawdownPct) && ctx.unfilteredDrawdownPct !== e.maxDrawdownPct) {
      note(`With the outliers left in, the max drawdown would read ${pct(ctx.unfilteredDrawdownPct)}.`);
    }
  }

  out.push('');
  out.push('Benchmarks (buy and hold over the same window)');
  for (const b of perf.benchmarks) {
    out.push(`  ${b.name.padEnd(34)}${pct(b.returnPct).padStart(8)}   excess ${signed(b.excessPct)} pts`);
    note(b.note, '    ');
  }
  note('Excess is the account return minus the benchmark return, in percentage points.');
  note('The benchmarks stay fully invested; the book holds cash while its signals are off.');

  out.push('');
  out.push('Realized (closed round trips from broker fills)');
  note('Manual probe trips excluded. Mean is gross of fees; cash P&L includes fees taken in coin.');
  out.push(`  ${'sleeve'.padEnd(8)}${'trips'.padStart(6)}${'win'.padStart(7)}${'mean'.padStart(10)}${'cash P&L'.padStart(15)}`);
  for (const [name, s] of [['all', perf.realized.all], ['crypto', perf.realized.crypto], ['stocks', perf.realized.stocks]] as const) {
    const win = s.trips ? `${s.winRatePct.toFixed(0)}%` : 'n/a';
    const m = s.trips ? pct(s.meanGrossPct) : 'n/a';
    out.push(`  ${name.padEnd(8)}${String(s.trips).padStart(6)}${win.padStart(7)}${m.padStart(10)}${signedMoney(s.cashPnlUsd).padStart(15)}`);
  }

  out.push('');
  out.push(`Unrealized (${ctx.openPositions} open broker positions, as of now)`);
  for (const [name, v] of [['all', perf.unrealized.all], ['crypto', perf.unrealized.crypto], ['stocks', perf.unrealized.stocks]] as const) {
    out.push(`  ${name.padEnd(8)}${signedMoney(v).padStart(15)}`);
  }
  if (Math.abs(ctx.openCoinFeesUsd) >= 0.005) {
    note(
      `Alpaca's figure. It leaves out ${money(ctx.openCoinFeesUsd)} of buy fees taken in coin on the open crypto ` +
        'positions; they reach cash P&L when those positions close.'
    );
  }

  out.push('');
  out.push(`Crypto fees (CFEE activity since ${BOOK_START_ISO.slice(0, 10)})`);
  row('charged in USD', money(perf.fees.usd));
  row('taken in coin', `${perf.fees.inCoinCount} fees, already inside cash P&L`);

  out.push('');
  out.push('Execution (closed trips, gross on both sides)');
  const x = perf.execution;
  row('model-scored', `${x.tripsWithModel} trips`);
  row('model gap', x.tripsWithModel ? `mean ${pct(x.gapMeanPct)}, median ${pct(x.gapMedianPct)} (actual minus model)` : 'n/a');
  row('entry slippage', ctx.entrySlipTrips ? `${signed(x.entrySlipMeanBps, 1)} bps mean vs signal close (${ctx.entrySlipTrips} trips)` : 'n/a');
  row('exit slippage', ctx.exitSlipTrips ? `${signed(x.exitSlipMeanBps, 1)} bps mean vs model exit close (${ctx.exitSlipTrips} trips)` : 'n/a');

  out.push('');
  out.push(`Wrote ${ctx.outPath}`);
  return out;
}

// ---- fetching (read-only) ----

/** Daily account history that reaches back to the book start, widening the period if needed. */
async function fetchBookHistory(): Promise<PortfolioHistory> {
  for (const period of HISTORY_PERIODS) {
    const h = await getPortfolioHistory(period, '1D');
    if (coversStart(h)) return h;
  }
  throw new Error(`Alpaca's portfolio history does not reach back to ${PERF_START_DATE}, even with period ${HISTORY_PERIODS[HISTORY_PERIODS.length - 1]}.`);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/** Daily closes for one symbol around the window: Binance for crypto, Alpaca SIP adjusted for splits and dividends for stocks. */
async function fetchLeg(symbol: string, t0: number, t1: number): Promise<Leg> {
  const since = t0 - 10 * DAY_MS;
  try {
    const candles = await withRetry(async () =>
      symbol.endsWith('USDT')
        ? closedCandles(await fetchCandlesSince(symbol, '1d', since))
        : fetchStockCandles(symbol, '1d', 10000, since, { feed: 'sip', adjustment: 'all' })
    );
    return legFromCandles(symbol, candles, t0, t1);
  } catch (err) {
    return { symbol, start: null, end: null, error: firstLine(err) };
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const fmtClose = (x: number): string => (x >= 10 ? x.toFixed(2) : x.toPrecision(6));

/** A single-symbol benchmark, or a thrown error: perf.json is not written without it. */
function singleBenchmark(name: string, leg: Leg | undefined, describe: (l: Leg) => string): { name: string; returnPct: number; note: string } {
  const r = leg ? legReturnPct(leg) : null;
  if (!leg || r == null) {
    throw new Error(`${name}: no ${leg?.error ? `data (${leg.error})` : 'price at the start or end of the window'}; perf.json was not written.`);
  }
  return { name, returnPct: r, note: describe(leg) };
}

export function perfPath(): string {
  return path.join(CONFIG.dataDir, 'perf.json');
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** `npm run perf`: print the account report and write data/perf.json. GET requests only. */
export async function runPerf(): Promise<void> {
  const nowMs = Date.now();
  const history = await fetchBookHistory();
  const equity = analyzeEquity(historyPoints(history), PERF_START_DATE, nowMs, externalFlows(history));
  const truth = await loadBrokerTruth();
  const fees = summarizeFees(await fetchActivities('CFEE', BOOK_START_ISO));
  const execution = executionStats(attributeTrips(truth.trips, loadLedger(), CONFIG.feeBps));

  const t0 = equity.start.t;
  const t1 = equity.end.t;
  const universe = [...BOOK_CRYPTO, ...BOOK_STOCKS];
  const symbols = [...new Set(['BTCUSDT', 'SPY', ...universe])];
  const legs = new Map((await mapPool(symbols, 4, (s) => fetchLeg(s, t0, t1))).map((l) => [l.symbol, l] as const));
  const stamp = (ms: number): string => `${isoDate(ms)} 00:00 UTC`;

  const btc = singleBenchmark('BTC buy-and-hold', legs.get('BTCUSDT'), (l) =>
    `Binance BTCUSDT daily close at the first and last stamps: ${fmtClose(l.start!.close)} (${stamp(l.start!.at)}) to ${fmtClose(l.end!.close)} (${stamp(l.end!.at)}).`
  );
  const spy = singleBenchmark('SPY buy-and-hold', legs.get('SPY'), (l) =>
    `Alpaca SIP close of the last session before each stamp, adjusted for splits and dividends: ` +
    `${fmtClose(l.start!.close)} (${isoDate(l.start!.at)}) to ${fmtClose(l.end!.close)} (${isoDate(l.end!.at)}).`
  );
  const ew = equalWeight(universe.map((s) => legs.get(s) as Leg), equity.start.date, equity.end.date);
  if (ew.used === 0) throw new Error('Equal-weight universe: no symbol has prices at both ends of the window; perf.json was not written.');
  const nCrypto = BOOK_CRYPTO.length;
  const nStocks = BOOK_STOCKS.length;
  const ewNote =
    `${ew.used} of ${universe.length} book symbols (${nCrypto} crypto, ${nStocks} stocks), equal dollars at the first stamp's ` +
    `closes, held; the return is the mean of the symbol returns. ` +
    (ew.excluded.length ? `Excluded: ${ew.excluded.map((x) => `${x.symbol} (${x.reason})`).join('; ')}.` : 'None excluded.');

  const perf = buildPerfJson({
    generatedAt: new Date(nowMs).toISOString(),
    equity,
    benchmarks: [btc, spy, { name: 'Equal-weight universe buy-and-hold', returnPct: ew.returnPct, note: ewNote }],
    realized: sleeveStats(truth.trips),
    unrealized: unrealizedSplit(truth.positions),
    fees,
    execution,
  });
  const out = perfPath();
  writeJsonAtomic(out, perf);
  console.log(
    renderPerf(perf, {
      unfilteredDrawdownPct: Number.isFinite(equity.unfilteredDrawdownPct) ? fin(equity.unfilteredDrawdownPct, 4) : NaN,
      entrySlipTrips: execution.entrySlipTrips,
      exitSlipTrips: execution.exitSlipTrips,
      openPositions: truth.positions.length,
      openCoinFeesUsd: openCoinFeesUsd(truth.positions, truth.trips),
      outPath: out,
    }).join('\n')
  );
}
