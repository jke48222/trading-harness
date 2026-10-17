import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { CONFIG } from '../config';
import { appendLedgerRow, entryFillOf, loadLedger, openEntryFor, orderIdOf } from '../memory';
import {
  type BrokerAccount,
  type BrokerOrder,
  type BrokerPosition,
  botSymbolOf,
  closePaperPosition,
  fetchActivities,
  getAccount,
  getBrokerPositions,
  getOpenOrders,
  getPortfolioHistory,
  positionMatches,
} from '../broker/orders';
import { reconcile } from '../broker/fills';
import { EXPECTED_AGENTS, evaluateHealth, expectedMonitorMonth, gatherHealthInput, readCashReadOnly } from '../health';
import { attributeTrips, summarizeFees } from '../report';
import { BOOK_START_ISO, loadBrokerTruth } from '../reconcileRun';
import type { LedgerRow } from '../types';
import { BOOK_ENV, COMMANDS, isCommand } from './commands';
import { requestAllowed } from './guard';
import { acquireRunLock } from '../locks';
import { tripCashSince, tripReturnPct } from '../exitPricing';
import { MANUAL_CLOSE } from '../portfolioRisk';
import { trialsPath } from '../trials';
import {
  OPS_CLOCK_START,
  type HealthPayload,
  type PerfPayload,
  type ReportPayload,
  isRetiredScannerRow,
  opsGate,
  shapeHealth,
  shapeLiveEquity,
  shapePerf,
  shapeReport,
  swrCache,
  tripsGate,
} from './payloads';

/**
 * Local dashboard for the paper-trading bot. Binds to 127.0.0.1 ONLY.
 * Reads real data (live Alpaca paper account, broker fills, the ledger, agent
 * heartbeats, data/perf.json, the regime monitor) and can run a whitelisted set
 * of the bot's own npm commands. All order activity goes through the same
 * hardcoded-paper-host adapter as the agents.
 */
const PORT = Number(process.env.DASH_PORT ?? 8787);
const ROOT = process.cwd();
const PAGE = path.join(ROOT, 'public', 'dashboard.html');
const dataFile = (name: string): string => path.join(CONFIG.dataDir, name);

/** The fee the book's ledger scores are net of; attribution adds it back so model and actual are both gross. */
const BOOK_FEE_BPS = Number(BOOK_ENV.FEE_BPS);

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(s);
}

/**
 * The page may run inline script and style and call this server, nothing else:
 * no third-party code, no framing by another site (its buttons place paper
 * orders), no referrer leaking the local URL.
 */
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function tagOf(row: LedgerRow): string {
  const m = row.reason.match(/^\[([^\]]+)\]/);
  return m ? m[1] : '';
}

// ---- broker snapshot (account, positions, open orders) ----

interface BrokerSnapshot {
  account: BrokerAccount;
  positions: BrokerPosition[];
  openOrders: BrokerOrder[];
}

/** One broker round shared by /api/summary and /api/health, so a page refresh asks once and both panels agree. */
const brokerSnapshot = swrCache<BrokerSnapshot>(
  async () => {
    const [account, positions, openOrders] = await Promise.all([getAccount(), getBrokerPositions(), getOpenOrders()]);
    return { account, positions, openOrders };
  },
  { ttlMs: 10_000, retryMs: 5_000, staleWhileRevalidate: false }
);

async function snapshot(): Promise<BrokerSnapshot> {
  const c = await brokerSnapshot.get();
  if (c.error || !c.value) throw new Error(c.error ?? 'The broker did not answer.');
  return c.value;
}

// ---- local files ----

function monitorStatus(): { rows: { month: string; excess: number; symbols: number; trailing12: number | null; status: string }[]; latest: unknown | null } {
  try {
    const lines = fs.readFileSync(dataFile('monitor_tsmom.csv'), 'utf8').split('\n').filter((l) => l.trim());
    const rows = lines.slice(1).map((l) => {
      const [month, excess, symbols, t12, status] = l.split(',');
      return { month, excess: Number(excess), symbols: Number(symbols), trailing12: t12 === '' ? null : Number(t12), status };
    });
    return { rows, latest: rows[rows.length - 1] ?? null };
  } catch {
    return { rows: [], latest: null };
  }
}

function dailyRisk(equity: number): { dayStart: number | null; pnlPct: number | null; halted: boolean } {
  try {
    const st = JSON.parse(fs.readFileSync(dataFile('risk_state.json'), 'utf8')) as { utcDay: string; dayStartEquity: number };
    if (st.utcDay !== new Date().toISOString().slice(0, 10)) return { dayStart: null, pnlPct: null, halted: false };
    const pnlPct = st.dayStartEquity > 0 ? ((equity - st.dayStartEquity) / st.dayStartEquity) * 100 : 0;
    return { dayStart: st.dayStartEquity, pnlPct, halted: pnlPct <= -CONFIG.maxDailyLossPct };
  } catch {
    return { dayStart: null, pnlPct: null, halted: false };
  }
}

/** data/perf.json, written by src/perf.ts. Absent or unreadable is a normal state the page explains, never a 404. */
function perf(): PerfPayload {
  let text: string;
  try {
    text = fs.readFileSync(dataFile('perf.json'), 'utf8');
  } catch {
    return { missing: true };
  }
  try {
    return shapePerf(JSON.parse(text), Date.now());
  } catch (err) {
    return { missing: true, error: `data/perf.json could not be read: ${firstLine(err)}` };
  }
}

// ---- endpoints ----

async function summary(): Promise<unknown> {
  const { account, positions } = await snapshot();
  const rows = loadLedger();
  const enriched = positions.map((p) => {
    const sym = botSymbolOf(p.symbol);
    // The position belongs to the symbol's open entry by timestamp, the rule the exit manager uses.
    const entry = openEntryFor(rows, sym);
    const fill = entry ? entryFillOf(entry) : null;
    const slip = entry?.reason.match(/slippage ([+-][0-9.]+) bps/);
    const cost = Number(p.market_value) - Number(p.unrealized_pl);
    return {
      symbol: p.symbol,
      botSymbol: sym,
      qty: Number(p.qty),
      entry: fill ?? Number(p.avg_entry_price),
      now: Number(p.current_price),
      value: Number(p.market_value),
      unrealized: Number(p.unrealized_pl),
      unrealizedPct: cost ? (Number(p.unrealized_pl) / cost) * 100 : 0,
      openedAt: entry?.timestamp ?? null,
      tag: entry ? tagOf(entry) : null,
      slippageBps: slip ? Number(slip[1]) : null,
      kind: sym.endsWith('USDT') ? 'crypto' : 'stock',
    };
  });
  const deployed = enriched.reduce((a, p) => a + Math.abs(p.value), 0);
  return {
    asOf: new Date().toISOString(),
    account: {
      // Only the last four characters: the page gets screenshotted, and the full id has no use there.
      number: `···${String(account.account_number ?? '').slice(-4)}`,
      status: account.status,
      equity: Number(account.equity),
      cash: Number(account.cash),
      buyingPower: Number(account.buying_power),
    },
    budget: { max: CONFIG.budgetUsd, perTrade: CONFIG.perTradeUsd, maxPositions: CONFIG.maxOpenPositions, deployed },
    risk: {
      ...dailyRisk(Number(account.equity)),
      maxDailyLossPct: CONFIG.maxDailyLossPct,
      cryptoDeployed: enriched.filter((p) => p.kind === 'crypto').reduce((a, p) => a + Math.abs(p.value), 0),
      cryptoCap: (CONFIG.cryptoClusterCapPct / 100) * CONFIG.budgetUsd,
      cryptoClusterCapPct: CONFIG.cryptoClusterCapPct,
    },
    positions: enriched.sort((a, b) => b.value - a.value),
    monitor: monitorStatus().latest,
    ledgerRows: rows.length,
  };
}

/**
 * The cash side of /api/health: five years of daily history and the newest
 * account activities on top of the scheduled run's ledger. It changes slowly,
 * so the page's 30-second refresh reads it at most once a minute; health
 * skips the cash reconcile when a book scan has run since this was read.
 */
const cashSide = swrCache(readCashReadOnly, { ttlMs: 60_000, retryMs: 30_000, staleWhileRevalidate: true });

async function cashInput(): ReturnType<typeof readCashReadOnly> {
  const c = await cashSide.get();
  if (!c.value) throw new Error(c.error ?? 'The broker did not answer.');
  // A read from before the dashboard's last order or command lacks its fills, so it may not be reconciled against cash read after them.
  return c.at == null ? { ...c.value, rebuild: null, skipped: 'The cash reconcile waits for a fresh read after the last order.' } : c.value;
}

/**
 * Agent heartbeats, the regime monitor and (when keys are set) live broker
 * state, judged by the same rules as `npm run health`. Read-only: unlike the
 * CLI it never rotates logs.
 */
async function health(): Promise<HealthPayload> {
  // The same input `npm run health` builds (awake-time run history, broker
  // streak, book lock, ledger read after the broker), without recording a run.
  const { input } = await gatherHealthInput(false, { cash: cashInput });
  const nowMs = input.nowMs;
  const brokerChecked = Boolean(process.env.ALPACA_PAPER_KEY_ID);
  return shapeHealth({
    nowMs,
    expected: EXPECTED_AGENTS,
    heartbeats: input.heartbeats,
    report: evaluateHealth(input),
    monitor: input.monitor,
    broker: input.broker
      ? { positions: input.broker.positions.length, openOrders: input.broker.openOrders.length, equity: Number(input.broker.account.equity) }
      : null,
    brokerChecked,
    brokerError: input.brokerError ?? null,
  });
}

/** The book from broker fills: every order since the book start, rebuilt into round trips. Several paginated GETs, so cached. */
async function loadReport(): Promise<ReportPayload> {
  const [truth, fees] = await Promise.all([
    loadBrokerTruth(),
    fetchActivities('CFEE', BOOK_START_ISO).then(
      (acts) => ({ fees: summarizeFees(acts), feesError: null }),
      (err: unknown) => ({ fees: null, feesError: firstLine(err) })
    ),
  ]);
  const rows = loadLedger();
  const findings = reconcile({
    rows,
    trips: truth.trips,
    positions: truth.positions,
    filledBotClientIds: new Set(truth.fills.filter((f) => f.bot).map((f) => f.clientOrderId)),
    sinceMs: Date.parse(BOOK_START_ISO),
  });
  return shapeReport({
    asOfMs: Date.now(),
    bookStart: BOOK_START_ISO.slice(0, 10),
    feeBps: BOOK_FEE_BPS,
    attributions: attributeTrips(truth.trips, rows, BOOK_FEE_BPS),
    positions: truth.positions,
    unmatchedSells: truth.unmatchedSells.length,
    fees: fees.fees,
    feesError: fees.feesError,
    findings,
  });
}

const REPORT_TTL_MS = 5 * 60_000;
const brokerReport = swrCache(loadReport, { ttlMs: REPORT_TTL_MS, retryMs: 60_000, staleWhileRevalidate: true });

async function report(): Promise<{ code: number; body: unknown }> {
  const c = await brokerReport.get();
  if (!c.value) return { code: 502, body: { error: `Broker truth unavailable: ${c.error ?? 'no answer from the broker'}` } };
  return { code: 200, body: { ...c.value, cache: { ttlSec: REPORT_TTL_MS / 1000, refreshing: c.refreshing, refreshError: c.error } } };
}

const equityHistory = swrCache(async () => shapeLiveEquity(await getPortfolioHistory('1M', '1D')), { ttlMs: 60_000, retryMs: 30_000, staleWhileRevalidate: true });

async function equityCurve(): Promise<unknown> {
  const c = await equityHistory.get();
  return c.value ?? { points: [], error: c.error };
}

function book(): unknown {
  interface Agg {
    n: number;
    total: number;
    wins: number;
  }
  const actual = new Map<string, Agg>();
  const model = new Map<string, Agg>();
  const add = (m: Map<string, Agg>, sym: string, pnl: number): void => {
    const a = m.get(sym) ?? { n: 0, total: 0, wins: 0 };
    a.n++;
    a.total += pnl;
    if (pnl > 0) a.wins++;
    m.set(sym, a);
  };
  for (const r of loadLedger()) {
    const pnl = Number(r.pnl);
    if (r.pnl === '' || !Number.isFinite(pnl)) continue;
    if (r.mode === 'alpaca-paper-exit') add(actual, r.symbol, pnl);
    if (r.mode === 'alpaca-paper' && ['win', 'loss', 'flat'].includes(r.outcome)) add(model, r.symbol, pnl);
  }
  const syms = [...new Set([...actual.keys(), ...model.keys()])];
  return syms.map((s) => ({
    symbol: s,
    actual: actual.get(s) ?? null,
    model: model.get(s) ?? null,
  }));
}

/** The newest ledger rows, without the retired 5-minute scanner's history. */
function activity(limit: number): unknown {
  const rows = loadLedger()
    .filter((r) => !isRetiredScannerRow(r))
    .slice(-limit)
    .reverse();
  return rows.map((r) => {
    let kind = 'other';
    if (r.mode === 'alpaca-paper' && r.action === 'BUY') kind = 'entry';
    else if (r.mode === 'alpaca-paper-exit') kind = 'exit';
    else if (r.mode === 'scan-filtered') kind = 'filtered';
    else if (r.action === 'SKIP') kind = 'skip';
    else if (['win', 'loss', 'flat'].includes(r.outcome)) kind = 'scored';
    else if (r.outcome === 'open') kind = 'sim-entry';
    return {
      time: r.timestamp,
      symbol: r.symbol,
      action: r.action,
      mode: r.mode,
      outcome: r.outcome,
      pnl: r.pnl === '' ? null : Number(r.pnl),
      kind,
      tag: tagOf(r),
      reason: r.reason.replace(/^\[[^\]]+\]\s*/, '').slice(0, 220),
    };
  });
}

function trials(limit: number): unknown {
  try {
    const lines = fs.readFileSync(trialsPath(), 'utf8').split('\n').filter((l) => l.trim());
    const parse = (line: string): string[] => {
      const out: string[] = [];
      let f = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') {
            f += '"';
            i++;
          } else if (ch === '"') q = false;
          else f += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') {
          out.push(f);
          f = '';
        } else f += ch;
      }
      out.push(f);
      return out;
    };
    const recent = lines.slice(1).slice(-limit).reverse().map((l) => {
      const c = parse(l);
      const notes = c[18] ?? '';
      return { runAt: c[0], source: c[1], command: c[2], symbol: c[3], strategy: c[5], notes: notes.length > 200 ? `${notes.slice(0, 199)}…` : notes };
    });
    return { total: lines.length - 1, recent };
  } catch {
    return { total: 0, recent: [] };
  }
}

/** The promotion gates of docs/paper_phase_protocol.md, with live progress where a number exists. */
async function gates(): Promise<unknown> {
  const rows = loadLedger();
  const ledgerExits = rows.filter((r) => r.mode === 'alpaca-paper-exit').length;
  const truth = await brokerReport.get();
  const mon = monitorStatus().latest as { month?: string; status?: string; trailing12?: number } | null;
  const want = expectedMonitorMonth(Date.now());
  const monCurrent = !!mon?.month && mon.month >= want;
  return {
    gates: [
      opsGate(Date.now(), OPS_CLOCK_START),
      tripsGate(truth.value, truth.error, ledgerExits),
      {
        id: 'alarm',
        label: 'Regime monitor: no ALARM',
        progress: !mon ? 'no data yet' : `${mon.status} · trailing-12 ${mon.trailing12 ?? 'n/a'}%/mo · through ${mon.month}${monCurrent ? '' : ` (behind: ${want} expected)`}`,
        // A stale "ok" proves nothing about the months it hasn't seen.
        done: !!mon && monCurrent && mon.status !== 'ALARM',
      },
      {
        id: 'evidence',
        label: 'Evidence review (all strategies currently WATCH)',
        progress: 'Trial 06: watch · Trial 07: portfolio pass, recent era silent · Trial 08: crypto holds at real costs, stocks fail',
        done: false,
      },
      { id: 'fidelity', label: 'Final fidelity period at real scale ($300)', progress: CONFIG.budgetUsd <= 500 ? 'in fidelity mode' : `discovery mode ($${CONFIG.budgetUsd.toLocaleString()})`, done: false },
      { id: 'amend', label: 'User amends §2 and owns the switch', progress: 'paper-only per constitution', done: false },
    ],
    note: "Process guidance from docs/paper_phase_protocol.md. The real-money decision is the user's alone.",
  };
}

let commandBusy: string | null = null;

function runCommand(name: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const cmd = COMMANDS[name];
    execFile(
      'npm',
      cmd.args,
      // A book scan settles every order it places; killing one mid-order would
      // leave an order the ledger never hears about, so it gets no time limit.
      { cwd: ROOT, env: { ...process.env, ...cmd.env }, timeout: name === 'scan-book' ? 0 : 15 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = (stdout + '\n' + stderr).trim().split('\n').slice(-30).join('\n');
        resolve({ ok: !err, output });
      }
    );
  });
}

/** After anything that can trade, re-read the broker instead of serving the pre-trade picture. */
function invalidateBrokerCaches(): void {
  brokerSnapshot.invalidate();
  brokerReport.invalidate();
  equityHistory.invalidate();
  cashSide.invalidate();
}

async function manualClose(botSymbol: string): Promise<unknown> {
  // A book scan may be exiting or repairing this symbol right now; one at a time.
  const release = acquireRunLock('book');
  if (!release) throw new Error('A book scan is running; try the close again in a minute.');
  try {
    return await closeAndRecord(botSymbol);
  } finally {
    release();
  }
}

async function closeAndRecord(botSymbol: string): Promise<unknown> {
  const positions = await getBrokerPositions();
  const pos = positions.find((p) => positionMatches(p.symbol, botSymbol));
  if (!pos) throw new Error(`No open position matches ${botSymbol}.`);
  // Attribute by timestamp to the symbol's open entry, the same rule the exit manager uses.
  const entry = openEntryFor(loadLedger(), botSymbol);
  const order = await closePaperPosition(botSymbol);
  // Same pricing as the exit manager: every sell since the entry, cash-based for stocks.
  const costBasis = Number(pos.market_value) - Number(pos.unrealized_pl);
  const cash = entry
    ? await tripCashSince(botSymbol, entry.timestamp, order, costBasis)
    : { exitPrice: Number(order.filled_avg_price), exitQty: Number(order.filled_qty), buyCost: costBasis };
  const exitFill = cash.exitPrice;
  const entryFill = entry ? (entryFillOf(entry) ?? Number(entry.price)) : Number(pos.avg_entry_price);
  const actualPct = tripReturnPct(botSymbol.endsWith('USDT'), entryFill, cash);
  // Closing a position the book holds overrides a signal that still says hold,
  // so it starts the re-entry cooldown. Closing an orphan is cleanup: the book
  // never held it, and may enter it on its own rule.
  const what = entry ? MANUAL_CLOSE : 'Orphan position closed via dashboard';
  appendLedgerRow({
    timestamp: new Date().toISOString(),
    symbol: entry?.symbol ?? botSymbol,
    action: 'SELL',
    price: String(exitFill),
    quantity: String(cash.exitQty),
    reason: `[actual:${entry ? tagOf(entry) : 'manual'}] ${what}; entry fill ${entryFill} (order ${entry ? (orderIdOf(entry) ?? 'unknown') : 'none: no open ledger entry'}); ACTUAL round-trip P&L from real paper fills, gross of Alpaca fees.`,
    mode: 'alpaca-paper-exit',
    outcome: actualPct > 0 ? 'win' : actualPct < 0 ? 'loss' : 'flat',
    pnl: actualPct.toFixed(4),
  });
  return { closed: botSymbol, exitFill, actualPct };
}

const MAX_BODY_BYTES = 16 * 1024;

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c: Buffer) => {
      b += c;
      if (b.length > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // The guard runs first, for every request: own Host only, and POSTs only from this page.
    if (!requestAllowed(req.method ?? 'GET', req.headers, PORT, new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`).pathname)) {
      return json(res, 403, { error: 'Forbidden: the dashboard only answers its own page on this machine.' });
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, PAGE_HEADERS);
      res.end(fs.readFileSync(PAGE));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/summary') return json(res, 200, await summary());
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, await health());
    if (req.method === 'GET' && url.pathname === '/api/report') {
      const r = await report();
      return json(res, r.code, r.body);
    }
    if (req.method === 'GET' && url.pathname === '/api/perf') return json(res, 200, perf());
    if (req.method === 'GET' && url.pathname === '/api/book') return json(res, 200, book());
    if (req.method === 'GET' && url.pathname === '/api/activity') {
      const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? 60)) || 60));
      return json(res, 200, activity(limit));
    }
    if (req.method === 'GET' && url.pathname === '/api/equity') return json(res, 200, await equityCurve());
    if (req.method === 'GET' && url.pathname === '/api/monitor') return json(res, 200, monitorStatus());
    if (req.method === 'GET' && url.pathname === '/api/trials') return json(res, 200, trials(10));
    if (req.method === 'GET' && url.pathname === '/api/gates') return json(res, 200, await gates());
    if (req.method === 'POST' && url.pathname === '/api/command') {
      const { name } = JSON.parse((await readBody(req)) || '{}') as { name?: string };
      if (!isCommand(name)) return json(res, 400, { error: 'Unknown command.' });
      if (commandBusy) return json(res, 409, { error: `Busy running ${commandBusy}. Wait for it to finish.` });
      commandBusy = name;
      try {
        const result = await runCommand(name);
        return json(res, 200, result);
      } finally {
        commandBusy = null;
        invalidateBrokerCaches();
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/close') {
      const { symbol } = JSON.parse((await readBody(req)) || '{}') as { symbol?: string };
      if (!symbol || typeof symbol !== 'string') return json(res, 400, { error: 'symbol required' });
      try {
        return json(res, 200, await manualClose(symbol));
      } finally {
        invalidateBrokerCaches();
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${PORT} (localhost only; paper account only, the order host is hardcoded to paper).`);
});
