import type { ScanStats } from '../bot';
import type { Finding } from '../broker/fills';
import type { BrokerPosition } from '../broker/orders';
import type { HealthReport, MonitorReading } from '../health';
import type { TripAttribution } from '../report';

/**
 * Pure shapers for the dashboard's JSON endpoints. The server does the I/O
 * (heartbeat files, the ledger, broker calls, data/perf.json) and hands the
 * results here, so every rule about what the page shows can be tested without
 * a broker, a clock or a socket.
 */

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown): number | null => (isNum(x) ? x : null);
const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number | null => (xs.length ? sum(xs) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const signedPct = (x: number | null, d = 2): string => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);

// ---- health ----

export interface AgentExpectation {
  maxAgeMin: number;
  critical: boolean;
  what: string;
}

/** What one agent's last scan did (lists of symbols, as the heartbeat records them). */
export interface LastScan {
  entries: string[];
  exits: string[];
  rejects: string[];
  unfilled: string[];
  orphans: string[];
  failures: string[];
  unknown: string[];
  exitFailures: string[];
  partials: string[];
  spreadSkips: string[];
  swept: number;
  adopted: number;
}

/**
 * fresh: within its age limit. stale: older than the limit (or an unreadable
 * stamp). missing: expected, but no heartbeat file. unscheduled: a heartbeat
 * no agent is expected to write (a manual run with its own RUN_LABEL).
 */
export type AgentState = 'fresh' | 'stale' | 'missing' | 'unscheduled';

export interface AgentView {
  label: string;
  what: string;
  expected: boolean;
  critical: boolean;
  maxAgeMin: number | null;
  state: AgentState;
  at: string | null;
  ageMin: number | null;
  durationSec: number | null;
  execution: string | null;
  interval: string | null;
  symbols: number | null;
  last: LastScan | null;
}

export type HealthStatus = 'ok' | 'warning' | 'problem';

export interface HealthPayload {
  asOf: string;
  status: HealthStatus;
  problems: string[];
  warnings: string[];
  info: string[];
  agents: AgentView[];
  monitor: MonitorReading | null;
  /** Null when the broker was not checked (no keys) or did not answer. */
  broker: { positions: number; openOrders: number; equity: number | null } | null;
  brokerChecked: boolean;
  brokerError: string | null;
}

function agentView(label: string, exp: AgentExpectation | null, hb: ScanStats | null, nowMs: number): AgentView {
  const atMs = hb ? Date.parse(hb.at) : NaN;
  const startedMs = hb ? Date.parse(hb.startedAt) : NaN;
  const ageMin = Number.isFinite(atMs) ? Math.max(0, (nowMs - atMs) / 60_000) : null;
  let state: AgentState;
  if (!exp) state = 'unscheduled';
  else if (!hb) state = 'missing';
  else state = ageMin == null || ageMin > exp.maxAgeMin ? 'stale' : 'fresh';
  return {
    label,
    what: exp?.what ?? 'not a scheduled agent (a manual or one-off run)',
    expected: exp != null,
    critical: exp?.critical ?? hb?.execution === 'alpaca-paper',
    maxAgeMin: exp?.maxAgeMin ?? null,
    state,
    at: hb && Number.isFinite(atMs) ? hb.at : null,
    ageMin,
    durationSec: Number.isFinite(atMs) && Number.isFinite(startedMs) && atMs >= startedMs ? (atMs - startedMs) / 1000 : null,
    execution: hb ? strOrNull(hb.execution) : null,
    interval: hb ? strOrNull(hb.interval) : null,
    symbols: hb ? numOrNull(hb.symbols) : null,
    last: hb
      ? {
          entries: strs(hb.entries),
          exits: strs(hb.exits),
          rejects: strs(hb.rejects),
          unfilled: strs(hb.unfilled),
          orphans: strs(hb.orphans),
          failures: strs(hb.failures),
          unknown: strs(hb.unknown),
          exitFailures: strs(hb.exitFailures),
          partials: strs(hb.partials),
          spreadSkips: strs(hb.spreadSkips),
          swept: numOrNull(hb.swept) ?? 0,
          adopted: numOrNull(hb.adopted) ?? 0,
        }
      : null,
  };
}

/**
 * The /api/health payload: evaluateHealth's verdict plus one row per agent.
 * Expected agents come first, in the order health declares them, then any
 * other heartbeat by label.
 */
export function shapeHealth(input: {
  nowMs: number;
  expected: Record<string, AgentExpectation>;
  heartbeats: ScanStats[];
  report: HealthReport;
  monitor: MonitorReading | null;
  broker: { positions: number; openOrders: number; equity: number | null } | null;
  brokerChecked: boolean;
  brokerError: string | null;
}): HealthPayload {
  const byLabel = new Map<string, ScanStats>();
  for (const hb of input.heartbeats) if (hb && typeof hb.label === 'string') byLabel.set(hb.label, hb);
  const agents: AgentView[] = [];
  for (const [label, exp] of Object.entries(input.expected)) {
    agents.push(agentView(label, exp, byLabel.get(label) ?? null, input.nowMs));
    byLabel.delete(label);
  }
  for (const label of [...byLabel.keys()].sort()) agents.push(agentView(label, null, byLabel.get(label) as ScanStats, input.nowMs));
  const { problems, warnings, info } = input.report;
  return {
    asOf: new Date(input.nowMs).toISOString(),
    status: problems.length ? 'problem' : warnings.length ? 'warning' : 'ok',
    problems,
    warnings,
    info,
    agents,
    monitor: input.monitor,
    broker: input.broker,
    brokerChecked: input.brokerChecked,
    brokerError: input.brokerError,
  };
}

// ---- broker-truth report ----

export type Sleeve = 'crypto' | 'stocks';

/** The book's two sleeves: crypto trades as <COIN>USDT in the bot's symbols, everything else is a US stock or ETF. */
export function sleeveOf(botSymbol: string): Sleeve {
  return botSymbol.endsWith('USDT') ? 'crypto' : 'stocks';
}

export interface SleeveStats {
  trips: number;
  wins: number;
  winRatePct: number | null;
  meanGrossPct: number | null;
  medianGrossPct: number | null;
  cashPnlUsd: number;
}

export interface SlipStats {
  trips: number;
  meanBps: number | null;
  medianBps: number | null;
}

export interface SymbolRow {
  symbol: string;
  sleeve: Sleeve;
  trips: number;
  wins: number;
  winRatePct: number;
  meanGrossPct: number | null;
  cashPnlUsd: number;
  /** Trips of this symbol that also carry a model score. */
  modelScored: number;
  modelMeanPct: number | null;
  /** Mean of actual minus model over the scored trips, in % points. */
  gapMeanPct: number | null;
  lastClosedAt: string | null;
}

export interface ReportPayload {
  asOf: string;
  bookStart: string;
  feeBps: number;
  sleeves: { all: SleeveStats; crypto: SleeveStats; stocks: SleeveStats };
  gap: {
    tripsWithModel: number;
    modelMeanPct: number | null;
    actualMeanPct: number | null;
    gapMeanPct: number | null;
    gapMedianPct: number | null;
    entrySlip: SlipStats;
    exitSlip: SlipStats;
  };
  fees: { usd: number; inCoinCount: number } | null;
  feesError: string | null;
  open: { positions: number; deployedUsd: number; openTrips: number };
  excluded: { manualTrips: number; unmatchedSells: number };
  /** Null when reconcile was not run. `attention` leaves out manual probe trips, which are reported but never repaired. */
  reconcile: { attention: number; byKind: Record<string, number>; details: string[] } | null;
  symbols: SymbolRow[];
}

function sleeveStats(set: TripAttribution[]): SleeveStats {
  const g = set.map((a) => a.trip.grossPct).filter(isNum);
  const wins = g.filter((x) => x > 0).length;
  return {
    trips: set.length,
    wins,
    winRatePct: set.length ? (wins / set.length) * 100 : null,
    meanGrossPct: mean(g),
    medianGrossPct: median(g),
    cashPnlUsd: sum(set.map((a) => a.trip.cashPnlUsd ?? 0)),
  };
}

function slipStats(xs: (number | null)[]): SlipStats {
  const v = xs.filter(isNum);
  return { trips: v.length, meanBps: mean(v), medianBps: median(v) };
}

const scoredGap = (a: TripAttribution): number | null =>
  isNum(a.trip.grossPct) && isNum(a.modelGrossPct) ? a.trip.grossPct - a.modelGrossPct : null;

/**
 * The /api/report payload: the book from broker fills, the same cut
 * `npm run report` prints (closed round trips, manual probe trips excluded,
 * gross of fees), plus the model-vs-actual gap, fees, reconcile and one row
 * per symbol. Rows sort by trip count: per-symbol return ranks are noise
 * until a symbol has dozens of trips (Trial 06).
 */
export function shapeReport(input: {
  asOfMs: number;
  bookStart: string;
  feeBps: number;
  attributions: TripAttribution[];
  positions: BrokerPosition[];
  unmatchedSells: number;
  fees: { usd: number; inCoin: number } | null;
  feesError?: string | null;
  findings?: Finding[] | null;
}): ReportPayload {
  const all = input.attributions;
  const closed = all.filter((a) => !a.trip.open && !a.trip.manual);
  const crypto = closed.filter((a) => sleeveOf(a.trip.botSymbol) === 'crypto');
  const stocks = closed.filter((a) => sleeveOf(a.trip.botSymbol) === 'stocks');
  const withModel = closed.filter((a) => scoredGap(a) != null);
  const gaps = withModel.map((a) => scoredGap(a) as number);

  const bySymbol = new Map<string, TripAttribution[]>();
  for (const a of closed) bySymbol.set(a.trip.botSymbol, [...(bySymbol.get(a.trip.botSymbol) ?? []), a]);
  const symbols: SymbolRow[] = [...bySymbol].map(([symbol, set]) => {
    const g = set.map((a) => a.trip.grossPct).filter(isNum);
    const scored = set.filter((a) => scoredGap(a) != null);
    const wins = g.filter((x) => x > 0).length;
    const closes = set.map((a) => a.trip.closedAt).filter((x): x is string => typeof x === 'string').sort();
    return {
      symbol,
      sleeve: sleeveOf(symbol),
      trips: set.length,
      wins,
      winRatePct: (wins / set.length) * 100,
      meanGrossPct: mean(g),
      cashPnlUsd: sum(set.map((a) => a.trip.cashPnlUsd ?? 0)),
      modelScored: scored.length,
      modelMeanPct: mean(scored.map((a) => a.modelGrossPct as number)),
      gapMeanPct: mean(scored.map((a) => scoredGap(a) as number)),
      lastClosedAt: closes.length ? closes[closes.length - 1] : null,
    };
  });
  symbols.sort((a, b) => b.trips - a.trips || b.cashPnlUsd - a.cashPnlUsd || a.symbol.localeCompare(b.symbol));

  let reconcile: ReportPayload['reconcile'] = null;
  if (input.findings) {
    const byKind: Record<string, number> = {};
    for (const f of input.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    const attention = input.findings.filter((f) => f.kind !== 'manual-trip');
    reconcile = { attention: attention.length, byKind, details: attention.slice(0, 8).map((f) => `${f.kind} ${f.botSymbol}: ${f.detail}`) };
  }

  return {
    asOf: new Date(input.asOfMs).toISOString(),
    bookStart: input.bookStart,
    feeBps: input.feeBps,
    sleeves: { all: sleeveStats(closed), crypto: sleeveStats(crypto), stocks: sleeveStats(stocks) },
    gap: {
      tripsWithModel: withModel.length,
      modelMeanPct: mean(withModel.map((a) => a.modelGrossPct as number)),
      actualMeanPct: mean(withModel.map((a) => a.trip.grossPct as number)),
      gapMeanPct: mean(gaps),
      gapMedianPct: median(gaps),
      entrySlip: slipStats(closed.map((a) => a.entrySlipBps)),
      exitSlip: slipStats(closed.map((a) => a.exitSlipBps)),
    },
    fees: input.fees ? { usd: input.fees.usd, inCoinCount: input.fees.inCoin } : null,
    feesError: input.feesError ?? null,
    open: {
      positions: input.positions.length,
      deployedUsd: sum(input.positions.map((p) => Math.abs(Number(p.market_value)) || 0)),
      openTrips: all.filter((a) => a.trip.open).length,
    },
    excluded: { manualTrips: all.filter((a) => a.trip.manual).length, unmatchedSells: input.unmatchedSells },
    reconcile,
    symbols,
  };
}

// ---- promotion gates 1 and 2 ----

export interface Gate {
  id: string;
  label: string;
  progress: string;
  done: boolean;
}

/**
 * When gate 1's four-week clock last started. docs/paper_phase_protocol.md:
 * it restarted on 2026-10-11 after the resting-order incident
 * (docs/incidents.md). Move it whenever an incident restarts the clock.
 */
export const OPS_CLOCK_START = '2026-10-11';

/** Gate 1: at least 4 consecutive weeks (28 days) of clean operations since the clock last started. */
export function opsGate(nowMs: number, clockStart: string): Gate {
  const days = Math.max(0, Math.floor((nowMs - Date.parse(`${clockStart}T00:00:00Z`)) / 86_400_000));
  return { id: 'ops', label: '≥ 4 weeks clean operations', progress: `${Math.min(days, 28)}/28 days since ${clockStart} (the clock restarts after an incident)`, done: days >= 28 };
}

/**
 * Gate 2 of docs/paper_phase_protocol.md: at least 10 completed real-fill
 * round trips with the model-vs-actual gap quantified. Counted from broker
 * fills (trips that carry a model score, so the gap is measured on each);
 * the ledger's exit count is only quoted when broker truth is unavailable.
 */
export function tripsGate(report: Pick<ReportPayload, 'sleeves' | 'gap'> | null, reportError: string | null, ledgerExits: number): Gate {
  const label = '≥ 10 real-fill round trips (cost gap measured)';
  if (!report) {
    return {
      id: 'trips',
      label,
      progress: `broker truth unavailable${reportError ? ` (${reportError})` : ''}; the ledger records ${ledgerExits} exits`,
      done: false,
    };
  }
  const g = report.gap;
  const measured = g.tripsWithModel > 0 && g.gapMeanPct != null;
  const counts = `${g.tripsWithModel}/10 broker round trips with a model score (${report.sleeves.all.trips} closed)`;
  return {
    id: 'trips',
    label,
    progress: measured ? `${counts} · gap ${signedPct(g.gapMeanPct)} mean, ${signedPct(g.gapMedianPct)} median` : `${counts} · gap not measured yet`,
    done: measured && g.tripsWithModel >= 10,
  };
}

// ---- data/perf.json ----

export interface PerfRealized {
  trips: number | null;
  winRatePct: number | null;
  meanGrossPct: number | null;
  cashPnlUsd: number | null;
}

export interface PerfData {
  missing: false;
  generatedAt: string | null;
  ageMin: number | null;
  bookStart: string | null;
  equity: {
    start: number | null;
    end: number | null;
    returnPct: number | null;
    maxDrawdownPct: number | null;
    maxDrawdownPeak: string | null;
    maxDrawdownTrough: string | null;
    annVolPct: number | null;
    sharpe: number | null;
    bestDay: { date: string; pct: number } | null;
    worstDay: { date: string; pct: number } | null;
    excludedPoints: { date: string; equity: number | null; reason: string }[];
  };
  curve: { date: string; equity: number }[];
  /** Underwater curve from `curve`: % below the running peak (0 at a new high). */
  drawdown: { date: string; pct: number }[];
  benchmarks: { name: string; returnPct: number | null; excessPct: number | null; note: string }[];
  realized: { all: PerfRealized; crypto: PerfRealized; stocks: PerfRealized };
  unrealized: { all: number | null; crypto: number | null; stocks: number | null };
  fees: { usd: number | null; inCoinCount: number | null };
  execution: {
    tripsWithModel: number | null;
    gapMeanPct: number | null;
    gapMedianPct: number | null;
    entrySlipMeanBps: number | null;
    exitSlipMeanBps: number | null;
  };
}

export type PerfPayload = { missing: true; error?: string } | PerfData;

const dayMove = (x: unknown): { date: string; pct: number } | null => {
  const o = obj(x);
  return typeof o.date === 'string' && o.date && isNum(o.pct) ? { date: o.date, pct: o.pct } : null;
};

const realized = (x: unknown): PerfRealized => {
  const o = obj(x);
  return { trips: numOrNull(o.trips), winRatePct: numOrNull(o.winRatePct), meanGrossPct: numOrNull(o.meanGrossPct), cashPnlUsd: numOrNull(o.cashPnlUsd) };
};

/** % below the running peak at each point, from a date-sorted equity curve. */
export function underwater(curve: { date: string; equity: number }[]): { date: string; pct: number }[] {
  let peak = -Infinity;
  return curve.map((p) => {
    peak = Math.max(peak, p.equity);
    return { date: p.date, pct: (p.equity / peak - 1) * 100 };
  });
}

/**
 * Normalize data/perf.json (written by src/perf.ts) for the page. Tolerant on
 * purpose: a field the writer dropped or renamed comes through as null and
 * the page shows a dash, instead of the whole panel failing.
 */
export function shapePerf(raw: unknown, nowMs: number): PerfPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { missing: true, error: 'data/perf.json is not a JSON object.' };
  const r = raw as Record<string, unknown>;
  const e = obj(r.equity);
  const generatedAt = strOrNull(r.generatedAt);
  const genMs = generatedAt ? Date.parse(generatedAt) : NaN;
  const curve = (Array.isArray(r.curve) ? r.curve : [])
    .map(obj)
    .filter((p) => typeof p.date === 'string' && p.date !== '' && isNum(p.equity) && p.equity > 0)
    .map((p) => ({ date: p.date as string, equity: p.equity as number }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const excludedPoints = (Array.isArray(e.excludedPoints) ? e.excludedPoints : [])
    .map(obj)
    .filter((p) => typeof p.date === 'string' && p.date !== '')
    .map((p) => ({ date: p.date as string, equity: numOrNull(p.equity), reason: typeof p.reason === 'string' ? p.reason : '' }));
  const benchmarks = (Array.isArray(r.benchmarks) ? r.benchmarks : [])
    .map(obj)
    .filter((b) => typeof b.name === 'string' && b.name !== '')
    .map((b) => ({ name: b.name as string, returnPct: numOrNull(b.returnPct), excessPct: numOrNull(b.excessPct), note: typeof b.note === 'string' ? b.note : '' }));
  const rz = obj(r.realized);
  const un = obj(r.unrealized);
  const fees = obj(r.fees);
  const ex = obj(r.execution);
  return {
    missing: false,
    generatedAt,
    ageMin: Number.isFinite(genMs) ? Math.max(0, (nowMs - genMs) / 60_000) : null,
    bookStart: strOrNull(r.bookStart),
    equity: {
      start: numOrNull(e.start),
      end: numOrNull(e.end),
      returnPct: numOrNull(e.returnPct),
      maxDrawdownPct: numOrNull(e.maxDrawdownPct),
      maxDrawdownPeak: strOrNull(e.maxDrawdownPeak),
      maxDrawdownTrough: strOrNull(e.maxDrawdownTrough),
      annVolPct: numOrNull(e.annVolPct),
      sharpe: numOrNull(e.sharpe),
      bestDay: dayMove(e.bestDay),
      worstDay: dayMove(e.worstDay),
      excludedPoints,
    },
    curve,
    drawdown: underwater(curve),
    benchmarks,
    realized: { all: realized(rz.all), crypto: realized(rz.crypto), stocks: realized(rz.stocks) },
    unrealized: { all: numOrNull(un.all), crypto: numOrNull(un.crypto), stocks: numOrNull(un.stocks) },
    fees: { usd: numOrNull(fees.usd), inCoinCount: numOrNull(fees.inCoinCount) },
    execution: {
      tripsWithModel: numOrNull(ex.tripsWithModel),
      gapMeanPct: numOrNull(ex.gapMeanPct),
      gapMedianPct: numOrNull(ex.gapMedianPct),
      entrySlipMeanBps: numOrNull(ex.entrySlipMeanBps),
      exitSlipMeanBps: numOrNull(ex.exitSlipMeanBps),
    },
  };
}

// ---- activity feed ----

/** Interval token of a ledger row's setup tag ("[bullish-cross-9/21-5m] ..." -> "5m"), or null. */
export function tagIntervalOf(reason: string): string | null {
  const m = reason.match(/^\[([^\]]+)\]/);
  if (!m) return null;
  return m[1].split('-').find((t) => /^\d+[smhdw]$/.test(t)) ?? null;
}

/** Rows the retired 5-minute crossover scanner wrote. They stay in the ledger as history but no longer belong in the live feed. */
export function isRetiredScannerRow(row: { reason: string }): boolean {
  return tagIntervalOf(row.reason) === '5m';
}

// ---- cache ----

export interface CacheRead<T> {
  value: T | null;
  /** When `value` was loaded (ms epoch), or null before the first success. */
  at: number | null;
  /** The last load's error, cleared by the next success. */
  error: string | null;
  refreshing: boolean;
}

/**
 * A single-value cache with in-flight de-duplication, so concurrent requests
 * share one broker round. With `staleWhileRevalidate`, an expired value is
 * returned at once while a refresh runs in the background (a cold cache still
 * waits). After a failed load, no new attempt starts for `retryMs`, so a
 * broker outage is not hammered by every page refresh.
 */
export function swrCache<T>(
  load: () => Promise<T>,
  opts: { ttlMs: number; retryMs: number; staleWhileRevalidate: boolean; now?: () => number }
): { get: () => Promise<CacheRead<T>>; invalidate: () => void } {
  const now = opts.now ?? Date.now;
  let value: T | null = null;
  let at: number | null = null;
  let error: string | null = null;
  let errorAt = -Infinity;
  let inflight: Promise<void> | null = null;
  // Bumped by invalidate(): a load that started before it may predate the change, so it is kept but not trusted as fresh.
  let generation = 0;

  const refresh = (): Promise<void> => {
    if (!inflight) {
      const started = generation;
      inflight = Promise.resolve()
        .then(load)
        .then(
          (v) => {
            value = v;
            at = started === generation ? now() : null;
            error = null;
          },
          (err: unknown) => {
            error = (err instanceof Error ? err.message : String(err)).split('\n')[0];
            errorAt = now();
          }
        )
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
  const read = (): CacheRead<T> => ({ value, at, error, refreshing: inflight != null });

  return {
    async get(): Promise<CacheRead<T>> {
      const fresh = at != null && now() - at < opts.ttlMs;
      const backingOff = error != null && now() - errorAt < opts.retryMs;
      if (!fresh && !backingOff) {
        const p = refresh();
        if (value === null || !opts.staleWhileRevalidate) await p;
      } else if (value === null && inflight) {
        await inflight;
      }
      return read();
    },
    /** Force the next get() to reload (the stale value is kept for stale-while-revalidate). */
    invalidate(): void {
      generation++;
      at = null;
      errorAt = -Infinity;
    },
  };
}
