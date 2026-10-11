import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { iso, mockFetch, order, row } from './helpers.ts';

// One whole book scan (runScan) against a scripted broker and data API, plus the pure rules it uses.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scan-'));
process.env.LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scan-locks-'));
Object.assign(process.env, {
  RUN_LABEL: 'book', SYMBOLS: 'AAPL', EXECUTION: 'alpaca-paper', TSMOM_STATE: 'on', LONG_ONLY: 'on', STRATEGY: 'tsmom',
  INTERVAL: '1d', TSMOM_LOOKBACK: '28', EVAL_HORIZON: '28', FEE_BPS: '30', BUDGET: '100000', PER_TRADE_USD: '2000',
  MAX_OPEN_POSITIONS: '50', ENTRY_WINDOW_MIN: '120', LIMIT_SLIPPAGE_BPS: '30', ORDER_TIMEOUT_SEC: '5',
  ALPACA_PAPER_KEY_ID: 'test-key', ALPACA_PAPER_SECRET: 'test-secret',
});

const memory = await import('../src/memory.ts');
const { runScan, nextEntryMisses } = await import('../src/bot.ts');
const { stopCooldownActive } = await import('../src/portfolioRisk.ts');

const DAY = 86_400_000;
const now = Date.now();

/** 200 closed daily stock bars: a slow drift, a run from 120 to 200, then a crash to 130 (momentum still positive). */
function crashBars(): { t: string; o: number; h: number; l: number; c: number; v: number }[] {
  const n = 200;
  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const c = k >= 29 ? 100 + (n - 1 - 29 - k) * 0.1 : k > 14 ? 120 + (29 - k) * (80 / 15) : 200 - (14 - k) * (70 / 14);
    closes.push(Number(c.toFixed(2)));
  }
  closes[n - 1 - 28] = 120;
  closes[n - 1] = 130;
  return closes.map((c, i) => ({ t: new Date(now - 2 * DAY - (n - 1 - i) * DAY).toISOString(), o: c, h: c, l: c, c, v: 1000 }));
}

test('a catastrophe stop is not undone in the same scan (it used to re-buy at the stop price)', async () => {
  memory.resetMemory();
  memory.appendLedgerRow(
    row({
      timestamp: iso(now - 14 * DAY),
      symbol: 'AAPL',
      price: '199.00',
      reason: '[tsmom28-1d-state-long] up || broker fill 200 qty 10, order bot-AAPL-1790000000000-m1',
    })
  );
  const bars = crashBars();
  let closed = false;
  const m = mockFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v2/stocks/AAPL/bars')) return { body: { bars, next_page_token: null } };
    if (url.includes('/quotes/latest')) return { body: { quote: { bp: 129.9, ap: 130.1, t: new Date().toISOString() } } };
    if (url.endsWith('/v2/clock')) return { body: { is_open: true, next_open: iso(now + DAY), next_close: iso(now + 3_600_000) } };
    if (url.includes('/v2/orders?status=')) return { body: [] };
    if (url.endsWith('/v2/account')) return { body: { account_number: 'x', status: 'ACTIVE', cash: '90000', equity: '100000', portfolio_value: '100000', buying_power: '90000' } };
    if (url.endsWith('/v2/positions') && method === 'GET') {
      return { body: closed ? [] : [{ symbol: 'AAPL', qty: '10', avg_entry_price: '200', market_value: '1300', unrealized_pl: '-700', current_price: '130' }] };
    }
    if (method === 'DELETE' && url.endsWith('/v2/positions/AAPL')) {
      closed = true;
      return { body: order({ id: 'close1', symbol: 'AAPL', side: 'sell', status: 'filled', filled_qty: '10', filled_avg_price: '130' }) };
    }
    if (url.endsWith('/v2/orders/close1')) return { body: order({ id: 'close1', symbol: 'AAPL', side: 'sell', status: 'filled', filled_qty: '10', filled_avg_price: '130' }) };
    if (method === 'POST' && url.endsWith('/v2/orders')) return { status: 500, body: { message: 'no entry should be placed' } };
    return { status: 404, body: { message: `unmocked ${method} ${url}` } };
  });
  const realLog = console.log;
  console.log = () => {};
  try {
    await runScan();
  } finally {
    console.log = realLog;
    m.restore();
  }
  const rows = memory.loadLedger().filter((r) => r.symbol === 'AAPL');
  assert.equal(rows.length, 2, 'the old entry and the stop exit, and no fresh entry');
  assert.match(rows[1].reason, /CATASTROPHE STOP/);
  assert.equal(rows[1].pnl, '-35.0000');
  assert.ok(!m.calls.some((c) => c.startsWith('POST') && c.endsWith('/v2/orders')), 'no buy order was sent');
  const hb = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR as string, 'heartbeat', 'book.json'), 'utf8'));
  assert.equal(hb.exitsRan, true);
  assert.equal(hb.attempts.AAPL, 'neutral', 'a cooldown is by design, not a missed entry');
  assert.deepEqual(hb.stepFailures, []);
});

test('stopCooldownActive: holds after a stop until momentum turns, and only after a stop', () => {
  const day = (i: number): number => Date.parse('2026-01-01T00:00:00Z') + i * DAY;
  const candles = Array.from({ length: 40 }, (_, i) => ({ openTime: day(i), open: 1, high: 1, low: 1, close: 100 + i, volume: 1, closeTime: day(i + 1) - 1 }));
  const stopAt = new Date(day(30)).toISOString();
  const stopRows = [
    row({ timestamp: new Date(day(10)).toISOString(), symbol: 'X' }),
    row({ timestamp: stopAt, symbol: 'X', action: 'SELL', mode: 'alpaca-paper-exit', reason: '[actual:t] Exit: CATASTROPHE STOP: position down -31%' }),
  ];
  assert.equal(stopCooldownActive(stopRows, 'X', candles, 3), true, 'momentum stayed positive since the stop');
  const turned = candles.map((c, i) => (i === 35 ? { ...c, close: 10 } : c));
  assert.equal(stopCooldownActive(stopRows, 'X', turned, 3), false, 'one non-positive close after the stop ends the cooldown');
  const flipRows = [stopRows[0], { ...stopRows[1], reason: '[actual:t] Exit: momentum flipped non-positive' }];
  assert.equal(stopCooldownActive(flipRows, 'X', candles, 3), false, 'an ordinary exit has no cooldown');
});

test('nextEntryMisses: misses add up, neutral scans keep the count, an entry resets it', () => {
  const syms = ['A', 'B', 'C', 'D'];
  let m = nextEntryMisses({}, { A: 'miss:unfilled', B: 'miss:spread', C: 'ok' }, syms);
  assert.deepEqual(m, { A: { n: 1, kind: 'unfilled' }, B: { n: 1, kind: 'spread' } });
  m = nextEntryMisses(m, { A: 'neutral', B: 'miss:spread' }, syms); // outside the window for A; D not scanned
  assert.deepEqual(m, { A: { n: 1, kind: 'unfilled' }, B: { n: 2, kind: 'spread' } });
  m = nextEntryMisses(m, { A: 'miss:refused', B: 'ok' }, syms);
  assert.deepEqual(m, { A: { n: 2, kind: 'refused' } });
});

const portfolioRisk = await import('../src/portfolioRisk.ts');
const { isStopExit } = portfolioRisk;
const { inCryptoEntryWindow } = await import('../src/bot.ts');

test('isStopExit: a stop exit rebuilt from broker fills still counts, a state exit never does', () => {
  const repaired = row({ mode: 'alpaca-paper-exit', action: 'SELL', reason: '[actual:t] Exit recorded 2026-10-12 from broker fills (no row was written at the time); entry fill 200', pnl: '-35.0000' });
  assert.equal(isStopExit(repaired, 30), true);
  assert.equal(isStopExit({ ...repaired, reason: '[actual:t] Exit: momentum flipped non-positive (-3.10%) — state exit', pnl: '-35.0000' }, 30), false);
  assert.equal(isStopExit({ ...repaired, pnl: '-5.0000' }, 30), false);
});

test('a manual close from the dashboard starts the re-entry cooldown, at any P&L', () => {
  const { MANUAL_CLOSE } = portfolioRisk;
  const manual = row({ mode: 'alpaca-paper-exit', action: 'SELL', reason: `[actual:t] ${MANUAL_CLOSE}; entry fill 200 (order bot-X-1)`, pnl: '4.2000' });
  assert.equal(isStopExit(manual, 30), true, 'closed by hand while the signal says hold: the next scan must not buy it straight back');
});

test('inCryptoEntryWindow follows ENTRY_WINDOW_MIN after the 00:00 UTC close', () => {
  assert.equal(inCryptoEntryWindow(Date.parse('2026-10-12T01:30:00Z')), true);
  assert.equal(inCryptoEntryWindow(Date.parse('2026-10-12T02:30:00Z')), false);
});

test('a crash close that both breaches the stop and turns momentum is a plain state exit (no cooldown)', async () => {
  memory.resetMemory();
  memory.appendLedgerRow(row({ timestamp: iso(now - 14 * DAY), symbol: 'AAPL', price: '199.00', reason: '[tsmom28-1d-state-long] up || broker fill 200 qty 10, order bot-AAPL-1790000000000-m1' }));
  const bars = crashBars();
  const last = bars.length - 1;
  bars[last] = { ...bars[last], o: 110, h: 110, l: 110, c: 110 }; // below the close 28 sessions back (120): momentum turns
  let closed = false;
  const m = mockFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v2/stocks/AAPL/bars')) return { body: { bars, next_page_token: null } };
    if (url.endsWith('/v2/clock')) return { body: { is_open: true, next_open: iso(now + DAY), next_close: iso(now + 3_600_000) } };
    if (url.includes('/v2/orders?status=')) return { body: [] };
    if (url.endsWith('/v2/account')) return { body: { account_number: 'x', status: 'ACTIVE', cash: '90000', equity: '100000', portfolio_value: '100000', buying_power: '90000' } };
    if (url.endsWith('/v2/positions') && method === 'GET') return { body: closed ? [] : [{ symbol: 'AAPL', qty: '10', avg_entry_price: '200', market_value: '1100', unrealized_pl: '-900', current_price: '110' }] };
    if (method === 'DELETE' && url.endsWith('/v2/positions/AAPL')) {
      closed = true;
      return { body: order({ id: 'close2', symbol: 'AAPL', side: 'sell', status: 'filled', filled_qty: '10', filled_avg_price: '110' }) };
    }
    if (url.endsWith('/v2/orders/close2')) return { body: order({ id: 'close2', symbol: 'AAPL', side: 'sell', status: 'filled', filled_qty: '10', filled_avg_price: '110' }) };
    return { status: 404, body: { message: `unmocked ${method} ${url}` } };
  });
  const realLog = console.log;
  console.log = () => {};
  try {
    await runScan();
  } finally {
    console.log = realLog;
    m.restore();
  }
  const exit = memory.loadLedger().find((r) => r.mode === 'alpaca-paper-exit');
  assert.match(exit?.reason ?? '', /state exit/);
  assert.doesNotMatch(exit?.reason ?? '', /CATASTROPHE/);
});

test('an order the broker accepts and then rejects counts as refused, not merely unfilled', async () => {
  memory.resetMemory();
  const n = 120;
  const bars = Array.from({ length: n }, (_, i) => {
    const c = 100 + i; // steady uptrend: momentum positive, the state signal says BUY
    return { t: new Date(now - 2 * DAY - (n - 1 - i) * DAY).toISOString(), o: c, h: c, l: c, c, v: 1000 };
  });
  const m = mockFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v2/stocks/AAPL/bars')) return { body: { bars, next_page_token: null } };
    if (url.includes('/quotes/latest')) return { body: { quote: { bp: 218.9, ap: 219.1, t: new Date().toISOString() } } };
    if (url.endsWith('/v2/clock')) return { body: { is_open: true, next_open: iso(now + DAY), next_close: iso(now + 3_600_000) } };
    if (url.includes('/v2/orders?status=')) return { body: [] };
    if (url.endsWith('/v2/account')) return { body: { account_number: 'x', status: 'ACTIVE', cash: '90000', equity: '100000', portfolio_value: '100000', buying_power: '90000' } };
    if (url.endsWith('/v2/positions') && method === 'GET') return { body: [] };
    if (method === 'POST' && url.endsWith('/v2/orders')) return { body: order({ id: 'b9', symbol: 'AAPL', status: 'new' }) };
    if (url.endsWith('/v2/orders/b9')) return { body: order({ id: 'b9', symbol: 'AAPL', status: 'rejected', filled_qty: '0' }) };
    return { status: 404, body: { message: `unmocked ${method} ${url}` } };
  });
  const realLog = console.log;
  console.log = () => {};
  try {
    await runScan();
  } finally {
    console.log = realLog;
    m.restore();
  }
  process.exitCode = 0; // runScan flags the reject for launchd; this test expects it
  const hb = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR as string, 'heartbeat', 'book.json'), 'utf8'));
  assert.equal(hb.rejects.length, 1);
  assert.equal(hb.attempts.AAPL, 'miss:refused');
  assert.deepEqual(hb.unfilled, []);
});
