import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

// macOS kernel locks (O_EXLOCK): the lock lives exactly as long as the holder's descriptor.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-klock-'));
process.env.LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-klock-run-'));
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';
delete process.env.LOCK_MODE;

const locks = await import('../src/locks.ts');
const darwin = process.platform === 'darwin';

/** Start a child that takes a lock, reports 'held', and keeps it until killed. */
async function holder(kind: 'ledger' | 'run'): Promise<ReturnType<typeof spawn>> {
  const script = path.join(process.env.DATA_DIR as string, `hold-${kind}.mts`);
  const src = path.resolve('src/locks.ts');
  fs.writeFileSync(
    script,
    kind === 'ledger'
      ? `const l = await import(${JSON.stringify(src)}); l.withLedgerLock(() => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); });`
      : `const l = await import(${JSON.stringify(src)}); if (l.acquireRunLock('book')) process.stdout.write('held\\n'); setTimeout(() => {}, 60_000);`
  );
  const child = spawn(process.execPath, ['--import', 'tsx', script], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (b: Buffer) => b.toString().includes('held') && resolve());
    child.once('exit', () => reject(new Error('holder exited before taking the lock')));
  });
  return child;
}

test('kernel ledger lock: a live holder blocks writers whatever its age; its death frees the lock', { skip: !darwin }, async () => {
  assert.equal(locks.LOCK_MECHANISM, 'kernel');
  const child = await holder('ledger');
  assert.throws(() => locks.withLedgerLock(() => 1, 300, 1), /locked by another process/, 'staleMs=1 does not let anyone break a kernel lock');
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(locks.withLedgerLock(() => 2, 2000), 2);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR as string, '.ledger.lock')), 'the lock file is never deleted');
});

test('kernel ledger lock: a frozen holder keeps it (no lock-breaking, no lost update)', { skip: !darwin }, async () => {
  const child = await holder('ledger');
  child.kill('SIGSTOP');
  assert.throws(() => locks.withLedgerLock(() => 1, 300, 1), /locked by another process/);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
});

test('kernel run lock: one holder across processes; the holder record follows it', { skip: !darwin }, async () => {
  const child = await holder('run');
  assert.equal(locks.acquireRunLock('book'), null);
  assert.equal(locks.runLockHolder('book')?.pid, child.pid);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(locks.runLockHolder('book'), null, 'a dead holder is not reported');
  const release = locks.acquireRunLock('book');
  assert.ok(release);
  assert.equal(locks.runLockHolder('book')?.pid, process.pid);
  release();
  assert.equal(locks.runLockHolder('book'), null, 'released: the record is cleared');
});
