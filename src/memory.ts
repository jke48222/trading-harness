import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
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

export function ensureMemoryFiles(): void {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  if (!fs.existsSync(ledgerPath())) fs.writeFileSync(ledgerPath(), LEDGER_HEADER + '\n');
  if (!fs.existsSync(learningsPath())) fs.writeFileSync(learningsPath(), LEARNINGS_HEADER);
}

export function resetMemory(): void {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  fs.writeFileSync(ledgerPath(), LEDGER_HEADER + '\n');
  fs.writeFileSync(learningsPath(), LEARNINGS_HEADER);
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

export function appendLedgerRow(row: LedgerRow): void {
  ensureMemoryFiles();
  const line = [
    row.timestamp,
    row.symbol,
    row.action,
    row.price,
    row.quantity,
    row.reason,
    row.mode,
    row.outcome,
    row.pnl,
  ]
    .map(csvEscape)
    .join(',');
  fs.appendFileSync(ledgerPath(), line + '\n');
}

/**
 * Rewrite the whole ledger (scoring fills outcomes into existing rows).
 * Written atomically: a temp file + rename, so a crash mid-write can never
 * leave a truncated ledger — the rename either fully succeeds or the old file
 * is untouched. This protects the real forward record, which is the project's
 * one irreplaceable asset.
 */
export function writeLedger(rows: LedgerRow[]): void {
  ensureMemoryFiles();
  const lines = rows.map((row) =>
    [row.timestamp, row.symbol, row.action, row.price, row.quantity, row.reason, row.mode, row.outcome, row.pnl]
      .map(csvEscape)
      .join(',')
  );
  const body = LEDGER_HEADER + '\n' + lines.join('\n') + (lines.length ? '\n' : '');
  const tmp = ledgerPath() + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, ledgerPath());
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
  fs.writeFileSync(learningsPath(), lines.join('\n').replace(/\n*$/, '\n'));
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
