import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
 * Protocol:
 * - A lock file is created complete or not at all: the content is written to
 *   a private temp file, which is then hard-linked to the lock path. link()
 *   fails with EEXIST when the lock exists, so there is never an empty lock.
 * - Each acquisition carries a random token. Release removes the lock only if
 *   it still holds our token, and a writer checks its token before writing.
 * - A lock is abandoned when its process is gone, it is older than staleMs,
 *   or it is unreadable and more than a few seconds old. Breaking one takes a
 *   short-lived break lock and re-checks under it, so two waiters can't both
 *   break it and both get in.
 */

interface LockInfo {
  pid: number;
  at: number;
  token: string;
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
    return Number.isFinite(info.pid) && Number.isFinite(info.at) && typeof info.token === 'string' ? info : null;
  } catch {
    return null;
  }
}

function ageMs(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Create `file` holding a fresh token, atomically. Returns the token, or null if it already exists. */
function linkCreate(file: string): string | null {
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const tmp = `${file}.${token}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
  try {
    fs.linkSync(tmp, file);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const UNREADABLE_GRACE_MS = 10_000;

function abandoned(file: string, staleMs: number): boolean {
  const info = readLock(file);
  if (!info) return fs.existsSync(file) && ageMs(file) > UNREADABLE_GRACE_MS;
  return !pidAlive(info.pid) || Date.now() - info.at > staleMs;
}

/** What identifies this particular lock file: its token, or for an unreadable one its mtime. */
function fingerprint(file: string): string {
  const token = readLock(file)?.token;
  if (token) return token;
  try {
    return `mtime:${fs.statSync(file).mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** Remove an abandoned lock, serialized through a short-lived break lock. */
function breakIfAbandoned(file: string, staleMs: number): void {
  const before = fingerprint(file);
  const brk = `${file}.break`;
  const brkToken = linkCreate(brk);
  if (!brkToken) {
    // Someone else is breaking it. A break lock is held for microseconds, so an old one was left by a crash.
    if (ageMs(brk) > UNREADABLE_GRACE_MS) fs.rmSync(brk, { force: true });
    return;
  }
  try {
    if (fingerprint(file) === before && abandoned(file, staleMs)) fs.rmSync(file, { force: true });
  } finally {
    if (readLock(brk)?.token === brkToken) fs.rmSync(brk, { force: true });
  }
}

function tryAcquire(file: string, staleMs: number): string | null {
  const token = linkCreate(file);
  if (token) return token;
  if (abandoned(file, staleMs)) {
    breakIfAbandoned(file, staleMs);
    return linkCreate(file);
  }
  return null;
}

function releaseIfOurs(file: string, token: string): void {
  if (readLock(file)?.token === token) fs.rmSync(file, { force: true });
}

function ledgerLockPath(): string {
  return path.join(CONFIG.dataDir, '.ledger.lock');
}

let ledgerToken: string | null = null;
let ledgerDepth = 0;

/**
 * Run `fn` while holding the ledger lock. Re-entrant inside one process, so a
 * locked helper can call another locked helper. Waits up to `waitMs`, then
 * throws: refusing to write beats writing over someone else's row. `fn` must
 * be synchronous; the lock would be released at its first await otherwise.
 */
export function withLedgerLock<T>(fn: () => T, waitMs = 30_000, staleMs = 120_000): T {
  if (ledgerDepth > 0) {
    ledgerDepth++;
    try {
      return guardSync(fn());
    } finally {
      ledgerDepth--;
    }
  }
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const file = ledgerLockPath();
  const deadline = Date.now() + waitMs;
  let token: string | null;
  while (!(token = tryAcquire(file, staleMs))) {
    if (Date.now() > deadline) {
      throw new Error(`The ledger has been locked by another process for over ${waitMs / 1000}s; not writing rather than risk losing a row.`);
    }
    sleepSync(50);
  }
  ledgerToken = token;
  ledgerDepth = 1;
  try {
    return guardSync(fn());
  } finally {
    ledgerDepth = 0;
    ledgerToken = null;
    releaseIfOurs(file, token);
  }
}

function guardSync<T>(v: T): T {
  if (v && typeof (v as { then?: unknown }).then === 'function') {
    throw new Error('withLedgerLock needs a synchronous function; an async one would release the lock at its first await.');
  }
  return v;
}

/**
 * Throws unless this process holds the ledger lock right now. Writers call it
 * just before they touch the file: a holder that stalled past staleMs may have
 * had its lock broken, and must not write over the new holder's work.
 */
export function assertLedgerLockHeld(): void {
  if (!ledgerToken || readLock(ledgerLockPath())?.token !== ledgerToken) {
    throw new Error('Lost the ledger lock (held too long, so another process took it over); not writing.');
  }
}

/** Where run locks live: shared by every checkout on this machine, so two copies of the bot can't trade one account at once. */
function runLockDir(): string {
  return process.env.LOCK_DIR ?? path.join(os.homedir(), '.cache', 'trading-harness', 'locks');
}

/** A run lock's file. Keyed to the broker account when keys are set, so it covers every data directory. */
export function runLockPath(name: string): string {
  const key = process.env.ALPACA_PAPER_KEY_ID;
  const suffix = key ? `-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}` : '';
  return path.join(runLockDir(), `${name}${suffix}.lock`);
}

/**
 * Non-blocking run lock for work that must never overlap (two book scans
 * could both pass the dedup check before either writes its row). Returns a
 * release function, or null when another live process holds it.
 */
export function acquireRunLock(name: string, staleMs = 3 * 3_600_000): (() => void) | null {
  const file = runLockPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = tryAcquire(file, staleMs);
  if (!token) return null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseIfOurs(file, token);
  };
  process.once('exit', release);
  return release;
}

/** Who holds a run lock right now (for messages), or null. */
export function runLockHolder(name: string): { pid: number; at: number } | null {
  const info = readLock(runLockPath(name));
  return info && pidAlive(info.pid) ? { pid: info.pid, at: info.at } : null;
}
