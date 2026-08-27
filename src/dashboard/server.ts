import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { CONFIG } from '../config';
import { loadLedger, appendLedgerRow } from '../memory';
import { closePaperPosition, getAccount, getBrokerPositions, getPortfolioHistory, positionMatches } from '../broker/orders';
import type { LedgerRow } from '../types';

/**
 * Local dashboard for the paper-trading bot. Binds to 127.0.0.1 ONLY.
 * Reads real data (live Alpaca paper account, the ledger, trials, monitor)
 * and can run a whitelisted set of the bot's own npm commands. All order
 * activity goes through the same hardcoded-paper-host adapter as the agents.
 */
const PORT = Number(process.env.DASH_PORT ?? 8787);
const ROOT = process.cwd();
const PAGE = path.join(ROOT, 'public', 'dashboard.html');

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function tagOf(row: LedgerRow): string {
  const m = row.reason.match(/^\[([^\]]+)\]/);
  return m ? m[1] : '';
}

function readTail(file: string, bytes = 6000): string {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function agentHealth(): unknown[] {
  const agents = [
    { id: 'tsmom-daily', label: 'Daily book (real orders, hourly)', log: 'data/tsmom-scan.log' },
    { id: 'scan-5m', label: '5m sim scanner (pipeline exerciser)', log: 'data/scan.log' },
    { id: 'monitor', label: 'Regime monitor (monthly)', log: 'data/monitor.log' },
  ];
  return agents.map((a) => {
    const p = path.join(ROOT, a.log);
    let lastWrite: string | null = null;
    let lastError: string | null = null;
    try {
      lastWrite = fs.statSync(p).mtime.toISOString();
      const tail = readTail(p);
      const err = tail.split('\n').reverse().find((l) => l.includes('BLOCKED'));
      lastError = err ? err.slice(0, 200) : null;
    } catch {
      /* no log yet */
    }
    return { ...a, lastWrite, lastError };
  });
}

function monitorStatus(): { rows: unknown[]; latest: unknown | null } {
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'data', 'monitor_tsmom.csv'), 'utf8').split('\n').filter((l) => l.trim());
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
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk_state.json'), 'utf8')) as { utcDay: string; dayStartEquity: number };
    if (st.utcDay !== new Date().toISOString().slice(0, 10)) return { dayStart: null, pnlPct: null, halted: false };
    const pnlPct = st.dayStartEquity > 0 ? ((equity - st.dayStartEquity) / st.dayStartEquity) * 100 : 0;
    return { dayStart: st.dayStartEquity, pnlPct, halted: pnlPct <= -CONFIG.maxDailyLossPct };
  } catch {
    return { dayStart: null, pnlPct: null, halted: false };
  }
}

async function summary(): Promise<unknown> {
  const [account, positions] = await Promise.all([getAccount(), getBrokerPositions()]);
  const rows = loadLedger();
  const entries = rows.filter((r) => r.mode === 'alpaca-paper' && r.action === 'BUY');
  const enriched = positions.map((p) => {
    const entry = [...entries].reverse().find((e) => positionMatches(p.symbol, e.symbol));
    const fill = entry?.reason.match(/broker fill ([0-9.eE-]+)/);
    const slip = entry?.reason.match(/slippage ([+-][0-9.]+) bps/);
    return {
      symbol: p.symbol,
      botSymbol: entry?.symbol ?? (p.symbol.endsWith('USD') && p.symbol.length > 4 ? `${p.symbol.slice(0, -3)}USDT` : p.symbol),
      qty: Number(p.qty),
      entry: fill ? Number(fill[1]) : Number(p.avg_entry_price),
      now: Number(p.current_price),
      value: Number(p.market_value),
      unrealized: Number(p.unrealized_pl),
      unrealizedPct: (Number(p.unrealized_pl) / (Number(p.market_value) - Number(p.unrealized_pl))) * 100,
      openedAt: entry?.timestamp ?? null,
      tag: entry ? tagOf(entry) : null,
      slippageBps: slip ? Number(slip[1]) : null,
      kind: p.symbol.endsWith('USD') && p.symbol.length > 4 ? 'crypto' : 'stock',
    };
  });
  const deployed = enriched.reduce((a, p) => a + Math.abs(p.value), 0);
  return {
    asOf: new Date().toISOString(),
    account: {
      number: account.account_number,
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
    agents: agentHealth(),
    monitor: monitorStatus().latest,
    ledgerRows: rows.length,
  };
}

async function equityCurve(): Promise<unknown> {
  try {
    const h = await getPortfolioHistory('1M', '1D');
    const points = h.timestamp
      .map((t, i) => ({ t: t * 1000, equity: h.equity[i], plPct: h.profit_loss_pct[i] }))
      .filter((p) => p.equity != null);
    return { points };
  } catch (err) {
    return { points: [], error: (err as Error).message };
  }
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

function activity(limit: number): unknown {
  const rows = loadLedger().slice(-limit).reverse();
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
    const lines = fs.readFileSync(path.join(ROOT, 'data', 'trials.csv'), 'utf8').split('\n').filter((l) => l.trim());
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
      return { runAt: c[0], source: c[1], command: c[2], symbol: c[3], strategy: c[5], notes: c[18]?.slice(0, 200) ?? '' };
    });
    return { total: lines.length - 1, recent };
  } catch {
    return { total: 0, recent: [] };
  }
}

function gates(): unknown {
  const rows = loadLedger();
  const firstBroker = rows.find((r) => r.mode === 'alpaca-paper');
  const opsDays = firstBroker ? Math.floor((Date.now() - Date.parse(firstBroker.timestamp)) / 86_400_000) : 0;
  const roundTrips = rows.filter((r) => r.mode === 'alpaca-paper-exit').length;
  const mon = monitorStatus().latest as { status?: string; trailing12?: number } | null;
  return {
    gates: [
      { id: 'ops', label: '≥ 4 weeks clean operations', progress: `${opsDays}/28 days`, done: opsDays >= 28 },
      { id: 'trips', label: '≥ 10 real-fill round trips (cost gap measured)', progress: `${roundTrips}/10 trips`, done: roundTrips >= 10 },
      { id: 'alarm', label: 'Regime monitor: no ALARM', progress: mon ? `${mon.status} · trailing-12 ${mon.trailing12 ?? '—'}%/mo` : 'no data yet', done: !!mon && mon.status !== 'ALARM' },
      { id: 'evidence', label: 'Evidence review (all strategies currently WATCH)', progress: 'Trial 06: watch · Trial 07: portfolio pass, OOS-era silent', done: false },
      { id: 'fidelity', label: 'Final fidelity period at real scale ($300)', progress: CONFIG.budgetUsd <= 500 ? 'in fidelity mode' : `discovery mode ($${CONFIG.budgetUsd.toLocaleString()})`, done: false },
      { id: 'amend', label: 'User amends §2 and owns the switch', progress: 'paper-only per constitution', done: false },
    ],
    note: 'Process guidance from docs/paper_phase_protocol.md — the real-money decision is the user\'s alone.',
  };
}

/** Whitelisted commands — each runs one of the bot's own npm scripts with fixed env. */
const COMMANDS: Record<string, { label: string; args: string[]; env: Record<string, string> }> = {
  'scan-book': {
    label: 'Scan the book now (state construction, real paper orders)',
    args: ['run', 'scan'],
    env: {
      TSMOM_STATE: 'on',
      EXECUTION: 'alpaca-paper',
      STRATEGY: 'tsmom',
      INTERVAL: '1d',
      TSMOM_LOOKBACK: '28',
      EVAL_HORIZON: '28',
      FEE_BPS: '30',
      LONG_ONLY: 'on',
      SYMBOLS:
        'AAVEUSDT,ADAUSDT,ARBUSDT,AVAXUSDT,BATUSDT,BCHUSDT,BONKUSDT,BTCUSDT,CRVUSDT,DOGEUSDT,DOTUSDT,ETHUSDT,FILUSDT,GRTUSDT,LDOUSDT,LINKUSDT,LTCUSDT,ONDOUSDT,PAXGUSDT,PEPEUSDT,POLUSDT,RENDERUSDT,SHIBUSDT,SKYUSDT,SOLUSDT,SUSHIUSDT,TRUMPUSDT,UNIUSDT,WIFUSDT,XRPUSDT,XTZUSDT,YFIUSDT,SPY,QQQ,IWM,DIA,AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AVGO,AMD,NFLX,JPM,V,UNH,XOM,LLY,COST,WMT,JNJ,PG,BAC',
    },
  },
  'score-daily': {
    label: 'Score matured daily trades',
    args: ['run', 'score'],
    env: { STRATEGY: 'tsmom', INTERVAL: '1d', TSMOM_LOOKBACK: '28', EVAL_HORIZON: '28', FEE_BPS: '30' },
  },
  monitor: { label: 'Recompute regime monitor', args: ['run', 'tsmom:monitor'], env: {} },
};

let commandBusy: string | null = null;

function runCommand(name: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const cmd = COMMANDS[name];
    execFile(
      'npm',
      cmd.args,
      { cwd: ROOT, env: { ...process.env, ...cmd.env }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = (stdout + '\n' + stderr).trim().split('\n').slice(-30).join('\n');
        resolve({ ok: !err, output });
      }
    );
  });
}

async function manualClose(botSymbol: string): Promise<unknown> {
  const positions = await getBrokerPositions();
  const pos = positions.find((p) => positionMatches(p.symbol, botSymbol));
  if (!pos) throw new Error(`No open position matches ${botSymbol}.`);
  const rows = loadLedger();
  const entry = [...rows].reverse().find((r) => r.mode === 'alpaca-paper' && positionMatches(pos.symbol, r.symbol) && r.action === 'BUY');
  const order = await closePaperPosition(botSymbol);
  const exitFill = Number(order.filled_avg_price);
  const entryFillMatch = entry?.reason.match(/broker fill ([0-9.eE-]+)/);
  const entryFill = entryFillMatch ? Number(entryFillMatch[1]) : entry ? Number(entry.price) : exitFill;
  const actualPct = ((exitFill - entryFill) / entryFill) * 100;
  appendLedgerRow({
    timestamp: new Date().toISOString(),
    symbol: entry?.symbol ?? botSymbol,
    action: 'SELL',
    price: String(exitFill),
    quantity: order.filled_qty,
    reason: `[actual:${entry ? tagOf(entry) : 'manual'}] Manual close via dashboard; entry fill ${entryFill}; ACTUAL round-trip P&L from real paper fills, gross of Alpaca fees.`,
    mode: 'alpaca-paper-exit',
    outcome: actualPct > 0 ? 'win' : actualPct < 0 ? 'loss' : 'flat',
    pnl: actualPct.toFixed(4),
  });
  return { closed: botSymbol, exitFill, actualPct };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(PAGE));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/summary') return json(res, 200, await summary());
    if (req.method === 'GET' && url.pathname === '/api/book') return json(res, 200, book());
    if (req.method === 'GET' && url.pathname === '/api/activity') return json(res, 200, activity(Number(url.searchParams.get('limit') ?? 60)));
    if (req.method === 'GET' && url.pathname === '/api/equity') return json(res, 200, await equityCurve());
    if (req.method === 'GET' && url.pathname === '/api/monitor') return json(res, 200, monitorStatus());
    if (req.method === 'GET' && url.pathname === '/api/trials') return json(res, 200, trials(10));
    if (req.method === 'GET' && url.pathname === '/api/gates') return json(res, 200, gates());
    if (req.method === 'POST' && url.pathname === '/api/command') {
      const { name } = JSON.parse((await readBody(req)) || '{}') as { name?: string };
      if (!name || !COMMANDS[name]) return json(res, 400, { error: 'Unknown command.' });
      if (commandBusy) return json(res, 409, { error: `Busy running ${commandBusy} — wait for it to finish.` });
      commandBusy = name;
      try {
        const result = await runCommand(name);
        return json(res, 200, result);
      } finally {
        commandBusy = null;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/close') {
      const { symbol } = JSON.parse((await readBody(req)) || '{}') as { symbol?: string };
      if (!symbol) return json(res, 400, { error: 'symbol required' });
      return json(res, 200, await manualClose(symbol));
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${PORT} (localhost only; paper account only — the order host is hardcoded to paper).`);
});
