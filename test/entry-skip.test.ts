import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { iso, mockFetch } from './helpers.ts';

// A book scan whose one symbol takes no new entries (ENTRY_SKIP), as the stocks
// being wound down and the pairs Alpaca's paper simulator never fills do.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-skip-'));
process.env.LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-skip-locks-'));
Object.assign(process.env, {
  RUN_LABEL: 'book', SYMBOLS: 'AAPL', ENTRY_SKIP: 'AAPL', EXECUTION: 'alpaca-paper', TSMOM_STATE: 'on', LONG_ONLY: 'on', STRATEGY: 'tsmom',
  INTERVAL: '1d', TSMOM_LOOKBACK: '28', EVAL_HORIZON: '28', FEE_BPS: '30', BUDGET: '100000', PER_TRADE_USD: '2000',
  MAX_OPEN_POSITIONS: '50', ENTRY_WINDOW_MIN: '120', LIMIT_SLIPPAGE_BPS: '30', ORDER_TIMEOUT_SEC: '5',
  ALPACA_PAPER_KEY_ID: 'test-key', ALPACA_PAPER_SECRET: 'test-secret',
});

const memory = await import('../src/memory.ts');
const { runScan } = await import('../src/bot.ts');

const DAY = 86_400_000;
const now = Date.now();

test('a symbol with entries off drops its missed-entry count, so health stops paging on it', async () => {
  memory.resetMemory();
  // The count a pair built up while the paper simulator left every order unfilled.
  const heartbeat = path.join(process.env.DATA_DIR as string, 'heartbeat', 'book.json');
  fs.mkdirSync(path.dirname(heartbeat), { recursive: true });
  fs.writeFileSync(heartbeat, JSON.stringify({ label: 'book', entryMisses: { AAPL: { n: 5, kind: 'unfilled' } } }));
  const n = 120;
  const bars = Array.from({ length: n }, (_, i) => {
    const c = 100 + i; // steady uptrend: momentum positive, the state signal says BUY
    return { t: new Date(now - 2 * DAY - (n - 1 - i) * DAY).toISOString(), o: c, h: c, l: c, c, v: 1000 };
  });
  const m = mockFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v2/stocks/AAPL/bars')) return { body: { bars, next_page_token: null } };
    if (url.endsWith('/v2/clock')) return { body: { is_open: true, next_open: iso(now + DAY), next_close: iso(now + 3_600_000) } };
    if (url.includes('/v2/orders?status=')) return { body: [] };
    if (url.endsWith('/v2/account')) return { body: { account_number: 'x', status: 'ACTIVE', cash: '90000', equity: '100000', portfolio_value: '100000', buying_power: '90000' } };
    if (url.endsWith('/v2/positions') && method === 'GET') return { body: [] };
    return { status: 404, body: { message: `unmocked ${method} ${url}` } };
  });
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await runScan();
  } finally {
    console.log = realLog;
    m.restore();
  }
  assert.ok(lines.some((l) => /AAPL: BUY signal not taken .*ENTRY_SKIP/.test(l)), 'the skip is logged with its reason');
  assert.ok(!m.calls.some((c) => c.startsWith('POST')), 'no order was sent');
  const hb = JSON.parse(fs.readFileSync(heartbeat, 'utf8'));
  assert.equal(hb.attempts.AAPL, 'ok');
  assert.deepEqual(hb.entryMisses, {}, 'the old count is gone, so health has nothing to page on');
  assert.deepEqual(hb.stepFailures, []);
});

test('a symbol with entries off builds no missed-entry count when its data fails, and the failure is still reported', async () => {
  memory.resetMemory();
  const heartbeat = path.join(process.env.DATA_DIR as string, 'heartbeat', 'book.json');
  fs.mkdirSync(path.dirname(heartbeat), { recursive: true });
  fs.writeFileSync(heartbeat, JSON.stringify({ label: 'book', entryMisses: { AAPL: { n: 5, kind: 'unfilled' } } }));
  const m = mockFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v2/stocks/AAPL/bars')) return { status: 500, body: { message: 'data API down' } };
    if (url.endsWith('/v2/clock')) return { body: { is_open: true, next_open: iso(now + DAY), next_close: iso(now + 3_600_000) } };
    if (url.includes('/v2/orders?status=')) return { body: [] };
    if (url.endsWith('/v2/account')) return { body: { account_number: 'x', status: 'ACTIVE', cash: '90000', equity: '100000', portfolio_value: '100000', buying_power: '90000' } };
    if (url.endsWith('/v2/positions') && method === 'GET') return { body: [] };
    return { status: 404, body: { message: `unmocked ${method} ${url}` } };
  });
  const realLog = console.log;
  console.log = () => {};
  try {
    await runScan();
  } finally {
    console.log = realLog;
    m.restore();
    process.exitCode = 0; // the failed symbol scan sets it; the test runner would report the file as failed
  }
  const hb = JSON.parse(fs.readFileSync(heartbeat, 'utf8'));
  assert.equal(hb.failures.length, 1, 'the data failure is still a warning');
  assert.equal(hb.attempts.AAPL, 'ok', "not 'miss:error': no entry was wanted");
  assert.deepEqual(hb.entryMisses, {});
});
