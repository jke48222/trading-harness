import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';

/**
 * Advisory file locks shared by every process that touches data/.
 *
 * Two launchd agents, the dashboard and manual commands all read-modify-write
 * the same ledger. Atomic rename stops a torn file but not a lost update: a
 * scorer that loads the ledger, fetches candles for a minute and then rewrites
 * it would silently drop any row another process appended in that minute.
 * Holding a lock across load -> modify -> write closes that window.
 *
 * Lock files hold {pid, at}. A lock whose process is gone, or that is older
 * than staleMs, is treated as abandoned by a crash and taken over.
 */

interface LockInfo {
  pid: number;
  at: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(file: string): LockInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
    return Number.isFinite(info.pid) && Number.isFinite(info.at) ? info : null;
  } catch {
    return null; // missing, or caught between create and write
  }
}

/** Try once to take the lock. Returns true on success. Clears an abandoned lock and retries once. */
function tryAcquire(file: string, staleMs: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const info = readLock(file);
    if (!info) return false;
    const abandoned = !pidAlive(info.pid) || Date.now() - info.at > staleMs;
    if (!abandoned) return false;
    // Re-read right before removing so we never delete a lock someone else just took over.
    const again = readLock(file);
    if (!again || again.pid !== info.pid || again.at !== info.at) return false;
    fs.rmSync(file, { force: true });
  }
  return false;
}

let ledgerDepth = 0;

/**
 * Run `fn` while holding the ledger lock. Re-entrant inside one process, so a
 * locked helper can call another locked helper. Waits up to `waitMs`, then
 * throws: refusing to write beats writing over someone else's row.
 */
export function withLedgerLock<T>(fn: () => T, waitMs = 30_000, staleMs = 120_000): T {
  if (ledgerDepth > 0) {
    ledgerDepth++;
    try {
      return fn();
    } finally {
      ledgerDepth--;
    }
  }
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const file = path.join(CONFIG.dataDir, '.ledger.lock');
  const deadline = Date.now() + waitMs;
  while (!tryAcquire(file, staleMs)) {
    if (Date.now() > deadline) {
      throw new Error(`The ledger has been locked by another process for over ${waitMs / 1000}s; not writing rather than risk losing a row.`);
    }
    sleepSync(50);
  }
  ledgerDepth = 1;
  try {
    return fn();
  } finally {
    ledgerDepth = 0;
    fs.rmSync(file, { force: true });
  }
}

/**
 * Non-blocking run lock for work that must never overlap (two book scans
 * could both pass the dedup check before either writes its row). Returns a
 * release function, or null when another live process holds it.
 */
export function acquireRunLock(name: string, staleMs = 3 * 3_600_000): (() => void) | null {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const file = path.join(CONFIG.dataDir, `.${name}.lock`);
  if (!tryAcquire(file, staleMs)) return null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const info = readLock(file);
    if (info && info.pid === process.pid) fs.rmSync(file, { force: true });
  };
  process.once('exit', release);
  return release;
}

/** Who holds a run lock right now (for messages), or null. */
export function runLockHolder(name: string): LockInfo | null {
  return readLock(path.join(CONFIG.dataDir, `.${name}.lock`));
}
