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
process.env.LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-locks-'));

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
  fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, at: Date.now(), token: 'other' }));
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

test('an empty lock file left by a crash is taken over once it is a few seconds old', () => {
  const lockFile = path.join(process.env.DATA_DIR as string, '.ledger.lock');
  fs.writeFileSync(lockFile, '');
  assert.throws(() => locks.withLedgerLock(() => 1, 200), /locked by another process/, 'a fresh empty file may be a lock being written');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);
  assert.equal(locks.withLedgerLock(() => 2, 2000), 2);
  assert.equal(fs.existsSync(lockFile), false);
});

test('a writer whose lock was taken over refuses to write', () => {
  memory.resetMemory();
  const lockFile = path.join(process.env.DATA_DIR as string, '.ledger.lock');
  assert.throws(
    () =>
      locks.withLedgerLock(() => {
        // Simulate a stall long enough for another process to break the lock and take it.
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone-else' }));
        memory.appendLedgerRow(row({ timestamp: '2026-08-01T00:00:00.000Z', symbol: 'A' }));
      }),
    /Lost the ledger lock/
  );
  assert.equal(memory.loadLedger().length, 0, 'nothing was written');
  assert.equal(fs.existsSync(lockFile), true, "release leaves another holder's lock in place");
  fs.rmSync(lockFile);
});

test('the ledger lock refuses an async callback', () => {
  assert.throws(() => locks.withLedgerLock(async () => 1), /synchronous/);
});

test('run locks are shared per broker account, outside the data directory', () => {
  const p = locks.runLockPath('book');
  assert.ok(p.startsWith(process.env.LOCK_DIR as string));
  assert.match(path.basename(p), /^book-[0-9a-f]{12}\.lock$/);
});


test('insertLedgerRows skips a row already present (two repairs racing)', () => {
  memory.resetMemory();
  const adopted = row({ timestamp: '2026-08-24T00:48:55.000Z', symbol: 'GRTUSDT', reason: '[t] Adopted late fill || broker fill 0.017181 qty 1, order bot-GRTUSDT-1787529600000' });
  const exit = row({ timestamp: '2026-10-07T00:56:37.000Z', symbol: 'DOTUSDT', action: 'SELL', mode: 'alpaca-paper-exit', reason: '[actual:t] Exit' });
  assert.equal(memory.insertLedgerRows([adopted, exit]), 2);
  const exitAgain = { ...exit, timestamp: '2026-10-07T00:58:00.000Z' }; // the same exit, stamped two minutes later
  assert.equal(memory.insertLedgerRows([adopted, exitAgain]), 0);
  assert.equal(memory.loadLedger().length, 2);
});
