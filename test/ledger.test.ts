import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { row } from './helpers.ts';

// Ledger integrity: timestamp attribution, chronological inserts, and the locks that stop lost updates.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-ledger-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const memory = await import('../src/memory.ts');
const locks = await import('../src/locks.ts');

test('openEntryFor goes by timestamp: a back-dated row appended last does not reopen a closed trip', () => {
  const rows = [
    row({ timestamp: '2026-08-01T00:00:00Z', symbol: 'X', reason: 'a' }),
    row({ timestamp: '2026-08-05T00:00:00Z', symbol: 'X', action: 'SELL', mode: 'alpaca-paper-exit' }),
    row({ timestamp: '2026-08-03T00:00:00Z', symbol: 'X', reason: 'adopted later, appended last' }),
  ];
  assert.equal(memory.openEntryFor(rows, 'X'), null);
  rows.push(row({ timestamp: '2026-08-07T00:00:00Z', symbol: 'X', reason: 'reentry' }));
  assert.equal(memory.openEntryFor(rows, 'X')?.reason, 'reentry');
});

test('insertLedgerRows puts a back-dated row in chronological order', () => {
  memory.resetMemory();
  memory.appendLedgerRow(row({ timestamp: '2026-08-01T00:00:00.000Z', symbol: 'A' }));
  memory.appendLedgerRow(row({ timestamp: '2026-08-10T00:00:00.000Z', symbol: 'C' }));
  memory.insertLedgerRows([row({ timestamp: '2026-08-05T00:00:00.000Z', symbol: 'B' })]);
  assert.deepEqual(memory.loadLedger().map((r) => r.symbol), ['A', 'B', 'C']);
});

test('ledger lock is re-entrant and released afterwards', () => {
  const lockFile = path.join(process.env.DATA_DIR as string, '.ledger.lock');
  const v = locks.withLedgerLock(() => locks.withLedgerLock(() => (fs.existsSync(lockFile) ? 42 : 0)));
  assert.equal(v, 42);
  assert.equal(fs.existsSync(lockFile), false);
});

test('a live process holding the ledger lock blocks writers; a dead one is taken over', async () => {
  const lockFile = path.join(process.env.DATA_DIR as string, '.ledger.lock');
  const child = spawn('sleep', ['5']);
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, at: Date.now() }));
  assert.throws(() => locks.withLedgerLock(() => 1, 200), /locked by another process/);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(locks.withLedgerLock(() => 7, 2000), 7, 'a dead holder is cleared');
  assert.equal(fs.existsSync(lockFile), false);
});

test('run lock: a second holder is refused while the first lives', () => {
  const release = locks.acquireRunLock('book-test');
  assert.ok(release);
  const holder = locks.runLockHolder('book-test');
  assert.equal(holder?.pid, process.pid);
  // Same process, same file: the lock is held, so a second acquire must fail.
  assert.equal(locks.acquireRunLock('book-test'), null);
  release();
  const again = locks.acquireRunLock('book-test');
  assert.ok(again);
  again();
});
