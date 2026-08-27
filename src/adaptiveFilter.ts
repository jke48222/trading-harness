import { CONFIG } from './config';
import { learningsWarnsAbout, loadLedger, memoryIsEmpty } from './memory';
import type { MemoryVerdict } from './types';

/**
 * The three questions the bot asks before any BUY or SELL:
 *   1. Has this symbol lost on a similar setup before?
 *   2. Does the learnings file warn about this setup?
 *   3. Is this signal repeating a known bad trade?
 *
 * Only REAL recorded outcomes can block a trade. A setup is blocked when the
 * ledger shows >= MEMORY_MIN_LOSSES real losses with net-negative PnL for the
 * same symbol + setup tag AND learnings.md carries a warning for that tag.
 *
 * `beforeTime` (ms epoch) makes replay chronology honest: when scoring a
 * historical setup, only outcomes recorded from strictly earlier setups count.
 */
export function consultMemory(symbol: string, setupTag: string, beforeTime?: number): MemoryVerdict {
  const marker = `[${setupTag}]`;
  const rows = loadLedger().filter((r) => {
    if (r.symbol !== symbol) return false;
    if (!r.reason.includes(marker)) return false;
    if (r.outcome !== 'win' && r.outcome !== 'loss') return false;
    if (beforeTime !== undefined) {
      const t = Date.parse(r.timestamp);
      if (!Number.isFinite(t) || t >= beforeTime) return false;
    }
    return true;
  });

  const priorWins = rows.filter((r) => r.outcome === 'win').length;
  const priorLosses = rows.filter((r) => r.outcome === 'loss').length;
  const priorPnlPct = rows.reduce((sum, r) => sum + (Number(r.pnl) || 0), 0);

  if (rows.length === 0) {
    const hint = memoryIsEmpty()
      ? ' Memory is empty — run `npm run replay:raw` to seed it from real historical outcomes.'
      : '';
    return {
      blocked: false,
      reason: `No real prior outcomes recorded for ${setupTag} on ${symbol}.${hint}`,
      priorWins,
      priorLosses,
      priorPnlPct,
    };
  }

  const warned = learningsWarnsAbout(setupTag);
  const blocked = warned && priorLosses >= CONFIG.memoryMinLosses && priorPnlPct < 0;

  if (blocked) {
    return {
      blocked,
      reason:
        `Ledger shows ${priorLosses} real prior losses vs ${priorWins} wins on ${setupTag} ` +
        `(net ${priorPnlPct.toFixed(2)}%) and learnings.md warns about it — this signal repeats a known bad trade, so SKIP.`,
      priorWins,
      priorLosses,
      priorPnlPct,
    };
  }
  return {
    blocked,
    reason:
      `Prior record for ${setupTag}: ${priorWins}W/${priorLosses}L, net ${priorPnlPct.toFixed(2)}% — ` +
      `no block (blocking needs >= ${CONFIG.memoryMinLosses} losses, net-negative PnL, and a learnings warning).`,
    priorWins,
    priorLosses,
    priorPnlPct,
  };
}
