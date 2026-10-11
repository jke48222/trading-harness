import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { iso, mockFetch, order, row } from './helpers.ts';
import type { Candle } from '../src/types.ts';

// The book under Trial 09's v2: votes over 7/14/28/56 candles, enter at 3, exit at 1 or fewer.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-vote-'));
process.env.LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-vote-locks-'));
Object.assign(process.env, {
  RUN_LABEL: 'book', SYMBOLS: 'AAPL', EXECUTION: 'alpaca-paper', TSMOM_STATE: 'on', LONG_ONLY: 'on', STRATEGY: 'tsmom',
  INTERVAL: '1d', TSMOM_LOOKBACK: '28', TSMOM_LOOKBACKS: '7,14,28,56', TSMOM_ENTER_VOTES: '3', TSMOM_EXIT_VOTES: '1',
  EVAL_HORIZON: '28', FEE_BPS: '30', BUDGET: '100000', PER_TRADE_USD: '2000', MAX_OPEN_POSITIONS: '50',
  ENTRY_WINDOW_MIN: '120', LIMIT_SLIPPAGE_BPS: '30', ORDER_TIMEOUT_SEC: '5',
  ALPACA_PAPER_KEY_ID: 'test-key', ALPACA_PAPER_SECRET: 'test-secret',
});

const vr = await import('../src/voteRule.ts');
const { CONFIG } = await import('../src/config.ts');
const { tsmomSignalAt } = await import('../src/strategy.ts');
const { stopCooldownActive } = await import('../src/portfolioRisk.ts');
const memory = await import('../src/memory.ts');
const { runScan } = await import('../src/bot.ts');

const DAY = 86_400_000;
const now = Date.now();
const V2 = { lookbacks: [7, 14, 28, 56], enter: 3, exit: 1 };

/** 100 flat closes, then the four lookback points set so the last close's vote is easy to read. */
function closesWith(points: Record<number, number>, n = 120): number[] {
  const closes = new Array(n).fill(100);
  for (const [back, value] of Object.entries(points)) closes[n - 1 - Number(back)] = value;
  return closes;
}

/** Daily candles from closes, the last one closed two days ago. */
function daily(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const openTime = now - 2 * DAY - (closes.length - 1 - i) * DAY;
    return { openTime, open: c, high: c, low: c, close: c, volume: 1, closeTime: openTime + DAY - 1 };
  });
}

test('the config carries v2, and its tag round-trips while Trial 07\'s keeps its old form', () => {
  assert.deepEqual(CONFIG.tsmomRule, V2);
  assert.equal(vr.stateTag(V2, '1d'), 'tsmom7/14/28/56-in3out1-1d-state-long');
  assert.deepEqual(vr.ruleOfStateTag(vr.stateTag(V2, '1d')), V2);
  assert.equal(vr.stateTag({ lookbacks: [28], enter: 1, exit: 0 }, '1d'), 'tsmom28-1d-state-long');
  assert.equal(vr.ruleOfStateTag('tsmom7/14-1d-state-long'), null, 'a vote without its counts is not a rule');
  assert.equal(vr.ruleProblem(V2), null);
  assert.match(vr.ruleProblem({ lookbacks: [7, 14], enter: 1, exit: 1 }) ?? '', /below the entry/);
  assert.match(vr.ruleProblem({ lookbacks: [7, 7], enter: 2, exit: 0 }) ?? '', /distinct/);
});

test('several lookbacks without vote counts stop the config check', () => {
  const configUrl = new URL('../src/config.ts', import.meta.url).href;
  const env = { ...process.env, TSMOM_LOOKBACKS: '7,14', TSMOM_ENTER_VOTES: '', TSMOM_EXIT_VOTES: '' } as Record<string, string | undefined>;
  delete env.TSMOM_ENTER_VOTES;
  delete env.TSMOM_EXIT_VOTES;
  assert.throws(
    () => execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `const m = await import(${JSON.stringify(configUrl)}); m.validateConfig();`], { env: env as NodeJS.ProcessEnv, stdio: 'pipe' }),
    /set TSMOM_ENTER_VOTES and TSMOM_EXIT_VOTES/
  );
});

test('v2 enters on three positive lookbacks and not on two', () => {
  // Points 7, 14, 28 and 56 candles back; the last close is 100.
  const three = daily(closesWith({ 7: 95, 14: 96, 28: 97, 56: 101 }));
  const buy = tsmomSignalAt(three, three.length - 1);
  assert.equal(buy.action, 'BUY');
  assert.equal(buy.setupTag, 'tsmom7/14/28/56-in3out1-1d-state-long');
  assert.match(buy.reason, /3 of 4 lookbacks positive/);
  const two = daily(closesWith({ 7: 95, 14: 96, 28: 101, 56: 102 }));
  const hold = tsmomSignalAt(two, two.length - 1);
  assert.equal(hold.action, 'HOLD');
  assert.match(hold.reason, /2 of 4 lookbacks positive .* entry needs 3/);
});

test('after a stop, v2\'s wait lasts until a close with one vote or none', () => {
  const stopAt = now - 10 * DAY;
  const rows = [
    row({ timestamp: iso(now - 40 * DAY), symbol: 'X' }),
    row({ timestamp: iso(stopAt), symbol: 'X', action: 'SELL', mode: 'alpaca-paper-exit', reason: '[actual:t] Exit: CATASTROPHE STOP: position down -31%' }),
  ];
  // A rising series votes 3 or 4 on every close since the stop; only the last close is shaped.
  const rising = (shape: Record<number, number>): number[] => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
    for (const [back, value] of Object.entries(shape)) closes[119 - Number(back)] = value;
    return closes;
  };
  // Last close 219: below the closes 7 and 14 back (230), above 28 and 56 back: two votes, so the wait holds.
  assert.equal(stopCooldownActive(rows, 'X', daily(rising({ 7: 230, 14: 230 })), V2), true);
  // Below 28 back as well: one vote, the exit condition on a close since the stop, so the wait is over.
  assert.equal(stopCooldownActive(rows, 'X', daily(rising({ 7: 230, 14: 230, 28: 230 })), V2), false);
});

/** One book scan with a held AAPL position (entered under v1) and the given daily closes. */
async function scanWithHeld(closes: number[]): Promise<{ exited: boolean; rows: ReturnType<typeof memory.loadLedger> }> {
  memory.resetMemory();
  memory.appendLedgerRow(row({ timestamp: iso(now - 30 * DAY), symbol: 'AAPL', price: '100.00', reason: '[tsmom28-1d-state-long] up || broker fill 100 qty 10, order bot-AAPL-1790000000000-m1' }));
  const bars = daily(closes).map((c) => ({ t: new Date(c.openTime).toISOString(), o: c.open, h: c.high, l: c.low, c: c.close, v: 1000 }));
  let closed = false;
  const m = mockFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/v2/stocks/AAPL/bars')) return { body: { bars, next_page_token: null } };
    if (url.includes('/quotes/latest')) return { body: { quote: { bp: 99.9, ap: 100.1, t: new Date().toISOString() } } };
    if (url.endsWith('/v2/clock')) return { body: { is_open: true, next_open: iso(now + DAY), next_close: iso(now + 3_600_000) } };
    if (url.includes('/v2/orders?status=')) return { body: [] };
    if (url.endsWith('/v2/account')) return { body: { account_number: 'x', status: 'ACTIVE', cash: '90000', equity: '100000', portfolio_value: '100000', buying_power: '90000' } };
    if (url.endsWith('/v2/positions') && method === 'GET') {
      return { body: closed ? [] : [{ symbol: 'AAPL', qty: '10', avg_entry_price: '100', market_value: '1000', unrealized_pl: '0', current_price: '100' }] };
    }
    if (method === 'DELETE' && url.endsWith('/v2/positions/AAPL')) {
      closed = true;
      return { body: order({ id: 'v2close', symbol: 'AAPL', side: 'sell', status: 'filled', filled_qty: '10', filled_avg_price: '100' }) };
    }
    if (url.endsWith('/v2/orders/v2close')) return { body: order({ id: 'v2close', symbol: 'AAPL', side: 'sell', status: 'filled', filled_qty: '10', filled_avg_price: '100' }) };
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
    process.exitCode = 0;
  }
  return { exited: closed, rows: memory.loadLedger().filter((r) => r.symbol === 'AAPL') };
}

test('the book holds a position at two votes, above v2\'s exit count', async () => {
  const { exited, rows } = await scanWithHeld(closesWith({ 7: 95, 14: 96, 28: 101, 56: 102 }));
  assert.equal(exited, false, 'two votes is inside the band: hold');
  assert.equal(rows.length, 1);
});

test('the book exits at one vote, whichever rule opened the position', async () => {
  const { exited, rows } = await scanWithHeld(closesWith({ 7: 95, 14: 101, 28: 101, 56: 102 }));
  assert.equal(exited, true);
  const exit = rows.find((r) => r.mode === 'alpaca-paper-exit');
  assert.ok(exit);
  assert.match(exit.reason, /1 of 4 lookbacks positive, at or below the exit count of 1 — state exit/);
});
