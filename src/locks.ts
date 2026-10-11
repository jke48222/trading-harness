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
 * On macOS the kernel holds the lock: the file is opened with O_EXLOCK, and
 * the lock lasts exactly as long as the descriptor. It goes away when the
 * holder closes it or dies, and a stalled holder keeps it. There is nothing to
 * break and no staleness to guess, and the lock file is never deleted (a
 * waiter on the old inode and a newcomer on a new one would both get in).
 *
 * Elsewhere (Linux CI) a lock file is created complete or not at all, by
 * hard-linking a written temp file; it carries a random token, is released
 * only by its owner, and an abandoned one (dead pid, older than staleMs, or
 * unreadable and a few seconds old) is broken under a short-lived break lock
 * with a re-check. Writers verify they still hold it before they write.
 */

interface LockInfo {
  pid: number;
  at: number;
  token: string;
}

/** O_EXLOCK from <fcntl.h> on darwin: an exclusive flock taken atomically with the open. */
const O_EXLOCK = 0x20;
const KERNEL_LOCKS = process.platform === 'darwin' && process.env.LOCK_MODE !== 'link';

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

function newToken(): string {
  return `${process.pid}-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------- kernel locks (macOS)

/** Try once to take the kernel lock on `file`. Returns the open descriptor, or null if another holder has it. */
function kernelTry(file: string, token: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | O_EXLOCK | fs.constants.O_NONBLOCK, 0o644);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return null;
    throw err;
  }
  // Record who holds it, for messages only; the lock itself is the descriptor.
  const info = Buffer.from(JSON.stringify({ pid: process.pid, at: Date.now(), token }));
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, info, 0, info.length, 0);
  return fd;
}

// ---------------------------------------------------------------- link locks (elsewhere)

function ageMs(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Create `file` holding `token`, atomically. Returns false if it already exists. */
function linkCreate(file: string, token: string): boolean {
  const tmp = `${file}.${token}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
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

/** Remove `file` only if it is still the same file that was judged removable. */
function removeIfUnchanged(file: string, seen: string): void {
  if (fingerprint(file) === seen) fs.rmSync(file, { force: true });
}

/** Remove an abandoned lock, serialized through a short-lived break lock. */
function breakIfAbandoned(file: string, staleMs: number): void {
  const before = fingerprint(file);
  const brk = `${file}.break`;
  const brkToken = newToken();
  if (!linkCreate(brk, brkToken)) {
    // Someone else is breaking it. A break lock lives for microseconds, so an
    // old one was left by a crash; remove that one only, never a fresh one.
    if (ageMs(brk) > UNREADABLE_GRACE_MS) removeIfUnchanged(brk, fingerprint(brk));
    return;
  }
  try {
    if (fingerprint(file) === before && abandoned(file, staleMs)) fs.rmSync(file, { force: true });
  } finally {
    if (readLock(brk)?.token === brkToken) fs.rmSync(brk, { force: true });
  }
}

function linkTry(file: string, token: string, staleMs: number): boolean {
  if (linkCreate(file, token)) return true;
  if (abandoned(file, staleMs)) {
    breakIfAbandoned(file, staleMs);
    return linkCreate(file, token);
  }
  return false;
}

// ---------------------------------------------------------------- common

interface Held {
  file: string;
  token: string;
  fd: number | null;
}

function tryAcquire(file: string, staleMs: number): Held | null {
  const token = newToken();
  if (KERNEL_LOCKS) {
    const fd = kernelTry(file, token);
    return fd == null ? null : { file, token, fd };
  }
  return linkTry(file, token, staleMs) ? { file, token, fd: null } : null;
}

function release(held: Held): void {
  if (held.fd != null) {
    // Clear the holder record so runLockHolder reads "free"; the kernel drops
    // the lock on close, and the file itself stays.
    fs.ftruncateSync(held.fd, 0);
    fs.closeSync(held.fd);
    return;
  }
  if (readLock(held.file)?.token === held.token) fs.rmSync(held.file, { force: true });
}

function stillHeld(held: Held): boolean {
  if (held.fd != null) return true; // a kernel lock can't be taken from a live descriptor
  return readLock(held.file)?.token === held.token;
}

function ledgerLockPath(): string {
  return path.join(CONFIG.dataDir, '.ledger.lock');
}

let ledgerHeld: Held | null = null;
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
  let held: Held | null;
  while (!(held = tryAcquire(file, staleMs))) {
    if (Date.now() > deadline) {
      throw new Error(`The ledger has been locked by another process for over ${waitMs / 1000}s; not writing rather than risk losing a row.`);
    }
    sleepSync(50);
  }
  ledgerHeld = held;
  ledgerDepth = 1;
  try {
    return guardSync(fn());
  } finally {
    ledgerDepth = 0;
    ledgerHeld = null;
    release(held);
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
 * just before they touch the file: with link locks, a holder that stalled past
 * staleMs may have had its lock broken, and must not write over the new
 * holder's work.
 */
export function assertLedgerLockHeld(): void {
  if (!ledgerHeld || !stillHeld(ledgerHeld)) {
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
  const held = tryAcquire(file, staleMs);
  if (!held) return null;
  let released = false;
  const done = (): void => {
    if (released) return;
    released = true;
    release(held);
  };
  process.once('exit', done);
  return done;
}

/**
 * Who holds a run lock right now (for messages and health), or null when it
 * is free. Reads the holder record and never takes the lock itself: a probe
 * that held it even briefly could make a starting book scan skip its hour. A
 * released lock has an empty record; a crashed holder's pid is gone.
 */
export function runLockHolder(name: string): { pid: number; at: number } | null {
  const info = readLock(runLockPath(name));
  return info && pidAlive(info.pid) ? { pid: info.pid, at: info.at } : null;
}

/** Which lock mechanism this process uses (for tests and messages). */
export const LOCK_MECHANISM: 'kernel' | 'link' = KERNEL_LOCKS ? 'kernel' : 'link';
