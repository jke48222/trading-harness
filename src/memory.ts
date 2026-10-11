import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { assertLedgerLockHeld, withLedgerLock } from './locks';
import type { LedgerRow } from './types';

const LEDGER_HEADER = 'timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl';
const LEARNINGS_HEADER =
  '# Learnings\n\n' +
  'Plain-English lessons distilled from REAL paper/replay outcomes only.\n' +
  'Nothing here is seeded or invented — if this file is empty, the bot has not lost yet (or has no history).\n\n';

export function ledgerPath(): string {
  return path.join(CONFIG.dataDir, 'ledger.csv');
}

export function learningsPath(): string {
  return path.join(CONFIG.dataDir, 'learnings.md');
}

/** Create `file` with `body` unless it exists. Exclusive: a check-then-write could truncate a ledger another process just created and appended to. */
function createIfMissing(file: string, body: string): void {
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

export function ensureMemoryFiles(): void {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  createIfMissing(ledgerPath(), LEDGER_HEADER + '\n');
  createIfMissing(learningsPath(), LEARNINGS_HEADER);
}

/**
 * Write a whole file atomically (temp file + rename), so a reader never sees
 * half of it. `beforeRename` runs between the two and may throw to abort; the
 * temp file is removed whenever the rename doesn't happen.
 */
export function writeAtomic(file: string, body: string, beforeRename?: () => void): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    beforeRename?.();
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function resetMemory(): void {
  withLedgerLock(() => {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    assertLedgerLockHeld();
    writeAtomic(ledgerPath(), LEDGER_HEADER + '\n');
    writeAtomic(learningsPath(), LEARNINGS_HEADER);
  });
}

export function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replaceAll('"', '""') + '"';
  }
  return value;
}

/** Minimal CSV line parser that understands double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function rowLine(row: LedgerRow): string {
  return [row.timestamp, row.symbol, row.action, row.price, row.quantity, row.reason, row.mode, row.outcome, row.pnl]
    .map(csvEscape)
    .join(',');
}

export function appendLedgerRow(row: LedgerRow): void {
  withLedgerLock(() => {
    ensureMemoryFiles();
    assertLedgerLockHeld();
    fs.appendFileSync(ledgerPath(), rowLine(row) + '\n');
  });
}

/** Remove temp files a killed writer left in data/ (`<file>.<pid>.tmp`, older than an hour). */
function sweepStaleTemps(): void {
  try {
    for (const name of fs.readdirSync(CONFIG.dataDir)) {
      if (!/\.\d+\.tmp$/.test(name)) continue;
      const file = path.join(CONFIG.dataDir, name);
      if (Date.now() - fs.statSync(file).mtimeMs > 3_600_000) fs.rmSync(file, { force: true });
    }
  } catch {
    /* best effort */
  }
}

/**
 * Rewrite the whole ledger. Written atomically (temp file + rename) under the
 * ledger lock, so a crash mid-write can't truncate it and a concurrent writer
 * can't interleave. Prefer updateLedger, which also re-reads under the lock:
 * rewriting rows loaded earlier can drop rows appended since.
 */
export function writeLedger(rows: LedgerRow[]): void {
  withLedgerLock(() => {
    ensureMemoryFiles();
    sweepStaleTemps();
    const lines = rows.map(rowLine);
    const body = LEDGER_HEADER + '\n' + lines.join('\n') + (lines.length ? '\n' : '');
    // A stalled holder whose lock was taken over must not rename over the new holder's write.
    writeAtomic(ledgerPath(), body, assertLedgerLockHeld);
  });
}

/**
 * Read-modify-write the ledger under the lock. The mutator gets the freshest
 * rows; return false to skip the write. This is the only safe way to change
 * existing rows while other agents may be appending.
 */
export function updateLedger(mutate: (rows: LedgerRow[]) => boolean | void): void {
  withLedgerLock(() => {
    const rows = loadLedger();
    if (mutate(rows) !== false) writeLedger(rows);
  });
}

/** Stable identity of a row, for applying computed updates to a freshly loaded ledger. */
export function rowKey(row: LedgerRow): string {
  return [row.timestamp, row.symbol, row.action, row.mode, row.price].join('|');
}

/** True when `nr` is already in the ledger: the same order id on a row of the same mode, or an exit for the same symbol within 5 minutes. */
function isDuplicate(rows: LedgerRow[], nr: LedgerRow): boolean {
  const id = orderIdOf(nr);
  if (id && rows.some((r) => r.mode === nr.mode && orderIdOf(r) === id)) return true;
  if (nr.mode === 'alpaca-paper-exit') {
    const t = Date.parse(nr.timestamp);
    return rows.some((r) => r.mode === 'alpaca-paper-exit' && r.symbol === nr.symbol && Math.abs(Date.parse(r.timestamp) - t) <= 5 * 60_000);
  }
  return false;
}

/**
 * Insert rows at their chronological position (after the last row with an
 * earlier or equal timestamp), so a back-dated row (an adopted late fill) sits
 * where a reader expects it instead of at the end of the file. A row already
 * present (two repairs racing) is skipped. Returns how many were inserted.
 */
export function insertLedgerRows(newRows: LedgerRow[]): number {
  if (newRows.length === 0) return 0;
  let inserted = 0;
  updateLedger((rows) => {
    for (const nr of [...newRows].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
      if (isDuplicate(rows, nr)) continue;
      const t = Date.parse(nr.timestamp);
      let at = rows.length;
      while (at > 0 && Date.parse(rows[at - 1].timestamp) > t) at--;
      rows.splice(at, 0, nr);
      inserted++;
    }
    return inserted > 0;
  });
  return inserted;
}

/** The client order id a broker row recorded ("order bot-ETHUSDT-1784160000000"), if any. */
export function orderIdOf(row: LedgerRow): string | null {
  const m = row.reason.match(/order (bot-[A-Za-z0-9]+-\d+(?:-[a-z0-9]+)?)/);
  return m ? m[1] : null;
}

/** Fill price recorded on a broker entry row ("broker fill 0.8266"), if any. */
export function entryFillOf(row: LedgerRow): number | null {
  const m = row.reason.match(/broker fill ([0-9.eE+-]+)/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) ? v : null;
}

/**
 * The broker entry row that the symbol's current position belongs to: the
 * latest `alpaca-paper` BUY with no `alpaca-paper-exit` at or after it. Ordered
 * by timestamp, never by file position, so back-dated rows attribute correctly.
 * Returns null when the symbol has no open entry (flat, or an orphan position).
 */
export function openEntryFor(rows: LedgerRow[], botSymbol: string): LedgerRow | null {
  let entry: LedgerRow | null = null;
  let entryT = -Infinity;
  let exitT = -Infinity;
  for (const r of rows) {
    if (r.symbol !== botSymbol) continue;
    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t)) continue;
    if (r.mode === 'alpaca-paper' && r.action === 'BUY' && t >= entryT) {
      entry = r;
      entryT = t;
    } else if (r.mode === 'alpaca-paper-exit' && t > exitT) {
      exitT = t;
    }
  }
  return entry && entryT > exitT ? entry : null;
}

export function loadLedger(): LedgerRow[] {
  if (!fs.existsSync(ledgerPath())) return [];
  const lines = fs
    .readFileSync(ledgerPath(), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  const rows: LedgerRow[] = [];
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (c.length < 9) continue;
    rows.push({
      timestamp: c[0],
      symbol: c[1],
      action: c[2],
      price: c[3],
      quantity: c[4],
      reason: c[5],
      mode: c[6],
      outcome: c[7],
      pnl: c[8],
    });
  }
  return rows;
}

export function memoryIsEmpty(): boolean {
  return loadLedger().length === 0;
}

export function loadLearnings(): string {
  if (!fs.existsSync(learningsPath())) return '';
  return fs.readFileSync(learningsPath(), 'utf8');
}

/**
 * Insert or update the single lesson line for a setup tag. Lessons are keyed
 * by "[tag]" so repeated replays refresh one line instead of piling up
 * near-duplicates.
 */
export function upsertLesson(tag: string, text: string): void {
  // Same lock as the ledger: two scorers refreshing lessons at once would
  // otherwise each rewrite the file from their own stale copy.
  withLedgerLock(() => {
    ensureMemoryFiles();
    const marker = `[${tag}]`;
    const lessonLine = `- ${marker} ${text}`;
    const lines = loadLearnings().split('\n');
    const idx = lines.findIndex((l) => l.includes(marker));
    if (idx >= 0) {
      lines[idx] = lessonLine;
    } else {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push(lessonLine);
    }
    writeAtomic(learningsPath(), lines.join('\n').replace(/\n*$/, '\n'), assertLedgerLockHeld);
  });
}

export function learningsWarnsAbout(tag: string): boolean {
  return loadLearnings().includes(`[${tag}]`);
}

/** Lesson lines mentioning a tag, for display. */
export function lessonsFor(tag: string): string[] {
  return loadLearnings()
    .split('\n')
    .filter((l) => l.includes(`[${tag}]`));
}

/** Paper position in base units, derived from executed scan rows in the ledger. */
export function paperPosition(symbol: string): number {
  let pos = 0;
  for (const row of loadLedger()) {
    if (row.symbol !== symbol || row.mode !== 'scan') continue;
    const q = Number(row.quantity);
    if (!Number.isFinite(q)) continue;
    if (row.action === 'BUY') pos += q;
    if (row.action === 'SELL') pos -= q;
  }
  return pos;
}
