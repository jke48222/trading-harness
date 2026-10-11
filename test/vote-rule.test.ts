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
  RUN_LABEL: 'book', SYMBOLS: 'SOLUSDT,AAPL', EXECUTION: 'alpaca-paper', TSMOM_STATE: 'on', LONG_ONLY: 'on', STRATEGY: 'tsmom',
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

/** Binance klines for daily candles. */
function klines(c: Candle[]): unknown[] {
  return c.map((x) => [x.openTime, String(x.open), String(x.high), String(x.low), String(x.close), '1', x.closeTime]);
}

/**
 * One book scan with the given held positions (both entered under Trial 07's
 * 28-day rule) and daily closes per symbol. Returns which positions were sold
 * and the ledger rows.
 */
async function scan(closesBy: { SOLUSDT: number[]; AAPL: number[] }, held: ('SOLUSDT' | 'AAPL')[]): Promise<{ sold: string[]; rows: ReturnType<typeof memory.loadLedger> }> {
  memory.resetMemory();
  for (const sym of held) memory.appendLedgerRow(row({ timestamp: iso(now - 30 * DAY), symbol: sym, price: '100.00', reason: `[tsmom28-1d-state-long] up || broker fill 100 qty 10, order bot-${sym}-1790000000000-m1` }));
  const sold: string[] = [];
  const brokerSym = (s: string): string => (s === 'SOLUSDT' ? 'SOLUSD' : s);
  const fill = (s: string) => order({ id: `close-${s}`, symbol: brokerSym(s), side: 'sell', status: 'filled', filled_qty: '10', filled_avg_price: '100' });
  const m = mockFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.includes('klines') && url.includes('symbol=SOLUSDT')) return { body: klines(daily(closesBy.SOLUSDT)) };
    if (url.includes('/v2/stocks/AAPL/bars')) return { body: { bars: daily(closesBy.AAPL).map((c) => ({ t: new Date(c.openTime).toISOString(), o: c.open, h: c.high, l: c.low, c: c.close, v: 1000 })), next_page_token: null } };
    if (url.endsWith('/v2/clock')) return { body: { is_open: true, next_open: iso(now + DAY), next_close: iso(now + 3_600_000) } };
    if (url.includes('/v2/orders?status=')) return { body: [] };
    if (url.endsWith('/v2/account')) return { body: { account_number: 'x', status: 'ACTIVE', cash: '90000', equity: '100000', portfolio_value: '100000', buying_power: '90000', non_marginable_buying_power: '90000' } };
    if (url.endsWith('/v2/positions') && method === 'GET') {
      return { body: held.filter((h) => !sold.includes(h)).map((h) => ({ symbol: brokerSym(h), qty: '10', avg_entry_price: '100', market_value: '1000', unrealized_pl: '0', current_price: '100' })) };
    }
    for (const h of held) {
      if (method === 'DELETE' && url.endsWith(`/v2/positions/${brokerSym(h)}`)) {
        sold.push(h);
        return { body: fill(h) };
      }
      if (url.endsWith(`/v2/orders/close-${h}`)) return { body: fill(h) };
    }
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
  return { sold, rows: memory.loadLedger() };
}

/** Flat closes for the symbol not under test: the vote stays flat and the 28-day rule holds nothing. */
const quietCloses = closesWith({});

test('a crypto position opened under the 28-day rule holds at two votes, inside the vote\'s band', async () => {
  const { sold, rows } = await scan({ SOLUSDT: closesWith({ 7: 95, 14: 96, 28: 101, 56: 102 }), AAPL: quietCloses }, ['SOLUSDT']);
  assert.deepEqual(sold, [], 'two votes: hold, though the 28-day return is negative');
  assert.equal(rows.filter((r) => r.mode === 'alpaca-paper-exit').length, 0);
});

test('a crypto position exits at one vote, under the live rule', async () => {
  const { sold, rows } = await scan({ SOLUSDT: closesWith({ 7: 95, 14: 101, 28: 101, 56: 102 }), AAPL: quietCloses }, ['SOLUSDT']);
  assert.deepEqual(sold, ['SOLUSDT']);
  const exit = rows.find((r) => r.mode === 'alpaca-paper-exit');
  assert.ok(exit);
  assert.match(exit.reason, /1 of 4 lookbacks positive, at or below the exit count of 1 — state exit/);
});

test('a stock being wound down exits under the rule it was opened with', async () => {
  // Two votes (the vote would hold) but a negative 28-day return (the 28-day rule exits).
  const { sold, rows } = await scan({ SOLUSDT: quietCloses, AAPL: closesWith({ 7: 95, 14: 96, 28: 101, 56: 102 }) }, ['AAPL']);
  assert.deepEqual(sold, ['AAPL']);
  assert.match((rows.find((r) => r.mode === 'alpaca-paper-exit') as { reason: string }).reason, /momentum flipped non-positive \(-0\.99%\) — state exit/);
});

test('an entry the book missed is made while the vote stays long, even at two votes', () => {
  // A rising run takes the vote long (four votes); the last close sits at two votes, inside the band.
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
  closes[119 - 7] = 230;
  closes[119 - 14] = 230;
  const c = daily(closes);
  const sig = tsmomSignalAt(c, c.length - 1);
  assert.equal(sig.action, 'BUY', 'the rule is long, so a flat book buys');
  assert.match(sig.reason, /2 of 4 lookbacks positive .* the vote has been long since/);
});

test('health raises a problem when the book scanned under a different rule from the checkout\'s', async () => {
  const { evaluateHealth, expectedBookRule, expectedMonitorMonth } = await import('../src/health.ts');
  assert.equal(expectedBookRule(), 'tsmom7/14/28/56-in3out1-1d-state-long', 'read from this checkout\'s book plist');
  const base = { label: 'book', at: new Date().toISOString(), startedAt: '', interval: '1d', execution: 'alpaca-paper', symbols: 56, failures: [], entries: [], partials: [], unfilled: [], unknown: [], rejects: [], spreadSkips: [], exits: [], exitFailures: [], orphans: [], swept: 0, adopted: 0, exitsAdded: 0, needsReview: [], stepFailures: [], exitsRan: true, entriesBlocked: null, attempts: {}, entryMisses: {}, lastCryptoWindowScan: new Date().toISOString(), offline: false, offlineStreak: 0, universe: [], rule: 'tsmom28-1d-state-long' };
  const watch = (label: string) => ({ ...base, label, execution: 'sim', rule: '' });
  const input = { nowMs: Date.now(), heartbeats: [base, watch('watch-flip'), watch('watch-sol')], rows: [], monitor: { month: expectedMonitorMonth(Date.now()), status: 'ok', trailing12: '1' } };
  const stale = evaluateHealth({ ...input, expectedBookRule: 'tsmom7/14/28/56-in3out1-1d-state-long' });
  assert.match(stale.problems.join(' | '), /scanned under tsmom28-1d-state-long, but this checkout's agent definition says tsmom7\/14\/28\/56-in3out1-1d-state-long/);
  assert.deepEqual(evaluateHealth({ ...input, expectedBookRule: 'tsmom28-1d-state-long' }).problems, []);
});

test('an unreadable close is an error, not zero votes (zero would sell)', () => {
  assert.throws(() => vr.votesAt([100, 101, Number.NaN, 103], 3, [1, 2]), /unreadable close/);
  assert.throws(() => vr.votesAt([100, 101, 102, Number.NaN], 3, [1]), /unreadable close/);
});

test('a trip opened under the 28-day rule and closed under the vote has no model score or exit slippage', async () => {
  const { attributeTrips } = await import('../src/report.ts');
  const t = { botSymbol: 'SOLUSDT', brokerSymbol: 'SOLUSD', entries: [{ orderId: 'b', clientOrderId: 'bot-SOLUSDT-1790000000000-m1', brokerSymbol: 'SOLUSD', botSymbol: 'SOLUSDT', side: 'buy' as const, qty: 10, price: 100, filledAt: iso(now - 9 * DAY), submittedAt: iso(now - 9 * DAY), bot: true }], exits: [], open: false, entryQty: 10, entryVwap: 100, exitQty: 10, exitVwap: 110, openedAt: iso(now - 9 * DAY), closedAt: iso(now - DAY), grossPct: 10, cashPnlUsd: 100, manual: false };
  const entryRow = row({ timestamp: iso(now - 9 * DAY), symbol: 'SOLUSDT', price: '100', outcome: 'win', pnl: '8', reason: '[tsmom28-1d-state-long] up || broker fill 100 qty 10, order bot-SOLUSDT-1790000000000-m1 || model v2: state exit 2026-10-01 at 108, net of 60 bps' });
  const exitUnderVote = row({ timestamp: iso(now - DAY), symbol: 'SOLUSDT', action: 'SELL', mode: 'alpaca-paper-exit', reason: '[actual:t] Exit: 1 of 4 lookbacks positive, at or below the exit count of 1 — state exit; entry fill 100' });
  const switched = attributeTrips([t], [entryRow, exitUnderVote], 30)[0];
  assert.equal(switched.ruleChanged, true);
  assert.equal(switched.modelGrossPct, null);
  assert.equal(switched.exitSlipBps, null);
  assert.ok(switched.entrySlipBps !== null, 'the entry was made under its own rule: its slippage stands');
  const exitUnderOld = { ...exitUnderVote, reason: '[actual:t] Exit: momentum flipped non-positive (-1.20%) — state exit; entry fill 100' };
  const same = attributeTrips([t], [entryRow, exitUnderOld], 30)[0];
  assert.equal(same.ruleChanged, false);
  assert.equal(same.modelGrossPct, 8.6);
});

test('a stop older than the first close the vote can check no longer blocks re-entry', () => {
  const rows = [
    row({ timestamp: iso(now - 200 * DAY), symbol: 'X' }),
    // The window below holds 120 daily closes; the vote can first check candle 56, about 63 days back.
    row({ timestamp: iso(now - 100 * DAY), symbol: 'X', action: 'SELL', mode: 'alpaca-paper-exit', reason: '[actual:t] Exit: CATASTROPHE STOP: position down -31%' }),
  ];
  const rising = daily(Array.from({ length: 120 }, (_, i) => 100 + i));
  assert.equal(stopCooldownActive(rows, 'X', rising, V2), false);
});

test('a candle window too short for the vote stops the config check', () => {
  const configUrl = new URL('../src/config.ts', import.meta.url).href;
  assert.throws(
    () => execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `const m = await import(${JSON.stringify(configUrl)}); m.validateConfig();`], { env: { ...process.env, SCAN_CANDLES: '58' }, stdio: 'pipe' }),
    /SCAN_CANDLES is 58; the state rule needs at least 59/
  );
});
