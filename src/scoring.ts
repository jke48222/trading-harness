import { CONFIG } from './config';
import { closedCandles, fetchSeriesSince, intervalToMs } from './market';
import { ledgerPath, learningsPath, loadLedger, rowKey, updateLedger, upsertLesson } from './memory';
import type { LedgerRow } from './types';

/**
 * Scores matured paper trades so the forward record has real win/loss
 * outcomes, using the same model as replay: enter at the signal candle's
 * close, net of FEE_BPS round trip. The exit depends on the construction:
 *
 *   flip / horizon rows   exit EVAL_HORIZON trading candles later (index-based,
 *                         so stock overnight gaps behave exactly like replay)
 *   state rows (...-state-long, the Trial 07 book)
 *                         exit at the first close where trailing momentum is
 *                         no longer positive, the rule the live book follows
 *
 * Rows store wall-clock execution time, not the signal candle, so the scorer
 * derives the signal candle from the candle grid and VERIFIES it against the
 * recorded entry price before scoring. If it cannot be matched to real market
 * data the row stays open and the mismatch is reported; an outcome is never
 * guessed.
 *
 * Network work happens first; results are then applied to a freshly loaded
 * ledger under the lock, so rows other agents appended meanwhile survive.
 */

const SCORABLE_MODES = new Set(['scan', 'scan-filtered', 'alpaca-paper']);
const STATE_MARKER = '|| model: state exit';

function setupTagOf(row: LedgerRow): string | null {
  const m = row.reason.match(/^\[([^\]]+)\]/);
  return m ? m[1] : null;
}

/** Trailing-momentum lookback of a state tag ("tsmom28-1d-state-long" -> 28), else null. */
export function stateLookbackOf(tag: string | null): number | null {
  const m = tag?.match(/^tsmom(\d+)-\w+-state-long$/);
  return m ? Number(m[1]) : null;
}

/**
 * The interval a row was traded on, parsed from its setup tag (e.g.
 * "bullish-cross-9/21-5m" -> 5m, "tsmom28-1d-flip-long" -> 1d). Each scan
 * config scores ONLY rows matching its own interval, so a 5m job never grades
 * a daily trade with the wrong candle grid or horizon. Unparsable tags belong
 * to the current config (legacy rows).
 */
function rowInterval(row: LedgerRow): string {
  const tag = setupTagOf(row);
  if (!tag) return CONFIG.interval;
  const token = tag.split('-').find((t) => /^\d+[smhdw]$/.test(t));
  return token ?? CONFIG.interval;
}

function shortIso(t: number): string {
  return new Date(t).toISOString().slice(0, 16) + 'Z';
}

/**
 * Tolerance follows the recorded precision: legacy rows carry 2 decimals
 * (abs 0.011 covers the rounding); newer rows carry >=4 significant decimals,
 * so a relative tolerance keeps verification meaningful even for micro-priced
 * coins (SHIB/PEPE/BONK).
 */
function priceMatches(recordedStr: string, candleClose: number): boolean {
  const recorded = Number(recordedStr);
  const decimals = (recordedStr.split('.')[1] ?? '').length;
  const tol = decimals >= 4 ? Math.max(recorded * 2e-4, 1e-9) : Math.max(0.011, recorded * 2e-5);
  return Math.abs(recorded - candleClose) <= tol;
}

/**
 * Index of the state-construction exit: the first candle after entry whose
 * trailing L-candle return is not positive. Null when momentum is still
 * positive on every candle so far (the model trade is still open).
 */
export function stateExitIndex(closes: number[], entryIdx: number, L: number): number | null {
  for (let j = entryIdx + 1; j < closes.length; j++) {
    if (j - L < 0) continue;
    if (closes[j] / closes[j - L] - 1 <= 0) return j;
  }
  return null;
}

export interface ScoringResult {
  scored: number;
  pending: number;
  unmatched: number;
}

interface Update {
  outcome: string;
  pnl: string;
  reasonSuffix: string;
}

/** True for state rows scored before state scoring existed (fixed-horizon outcome, no state marker). */
function needsStateRescore(r: LedgerRow): boolean {
  return (
    stateLookbackOf(setupTagOf(r)) !== null &&
    (r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'flat') &&
    !r.reason.includes(STATE_MARKER)
  );
}

export async function scoreMaturedScanTrades(log: (msg: string) => void = console.log): Promise<ScoringResult> {
  const { interval, evalHorizon, feeBps } = CONFIG;
  const iMs = intervalToMs(interval);
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);

  const candidates = loadLedger().filter(
    (r) =>
      SCORABLE_MODES.has(r.mode) &&
      (r.outcome === 'open' || needsStateRescore(r)) &&
      (r.action === 'BUY' || r.action === 'SELL') &&
      rowInterval(r) === interval
  );
  if (candidates.length === 0) {
    log(`Scoring: no open ${interval} trades to score (other intervals are scored by their own scan config).`);
    return { scored: 0, pending: 0, unmatched: 0 };
  }

  let pending = 0;
  let unmatched = 0;
  const updates = new Map<string, Update>();
  const lessonKeys = new Set<string>(); // symbol|tag pairs that took a real loss

  const symbols = [...new Set(candidates.map((r) => r.symbol))];
  for (const symbol of symbols) {
    try {
      const plans = candidates
        .filter((r) => r.symbol === symbol)
        .map((row) => {
          const tag = setupTagOf(row);
          const stateL = stateLookbackOf(tag);
          return { row, tag, stateL, signalBoundary: Math.floor(Date.parse(row.timestamp) / iMs) * iMs };
        });

      // Calendar lower bound for fixed-horizon rows: nothing can mature before
      // signal + horizon x interval, so skip the fetch (keeps the cycle cheap).
      // State rows can exit on the very next candle, so they always qualify.
      const ready = plans.filter((p) => p.stateL !== null || now >= p.signalBoundary + evalHorizon * iMs);
      for (const p of plans.filter((x) => !ready.includes(x))) {
        const minsLeft = Math.ceil((p.signalBoundary + evalHorizon * iMs - now) / 60_000);
        log(
          `Scoring: ${symbol} ${p.row.action} @ ${p.row.price} (${p.row.timestamp}) still maturing — ` +
            `earliest exit ~${shortIso(p.signalBoundary + evalHorizon * iMs)} (${minsLeft} min).`
        );
        pending++;
      }
      if (ready.length === 0) continue;

      const maxL = Math.max(0, ...ready.map((p) => p.stateL ?? 0));
      const earliest = Math.min(...ready.map((p) => p.signalBoundary)) - (maxL + 5) * iMs;
      const candles = closedCandles(await fetchSeriesSince(symbol, interval, earliest));
      const closes = candles.map((c) => c.close);
      const byBoundary = new Map<number, number>(); // grid boundary -> candle index
      candles.forEach((c, i) => byBoundary.set(Math.floor((c.closeTime + 1) / iMs) * iMs, i));

      for (const p of ready) {
        const recordedPrice = Number(p.row.price);

        // Locate + verify the entry candle: at the derived boundary, else step
        // back (a scan that ran right at a boundary signaled on the prior candle).
        let entryIdx: number | undefined;
        for (let back = 0; back <= 3; back++) {
          const idx = byBoundary.get(p.signalBoundary - back * iMs);
          if (idx !== undefined && priceMatches(p.row.price, candles[idx].close)) {
            entryIdx = idx;
            break;
          }
        }
        if (entryIdx === undefined) {
          unmatched++;
          log(
            `Scoring: could not verify the entry candle for ${symbol} ${p.row.action} @ ${p.row.price} ` +
              `(${p.row.timestamp}) against real market data — row stays as it is, no outcome is invented.`
          );
          continue;
        }

        let exitIdx: number | null;
        let rule: string;
        if (p.stateL !== null) {
          exitIdx = stateExitIndex(closes, entryIdx, p.stateL);
          rule = `state exit (trailing ${p.stateL}-candle return turned non-positive)`;
          if (exitIdx === null) {
            if (p.row.outcome !== 'open') {
              // Scored under the old fixed horizon, but the state model is still in the trade.
              updates.set(rowKey(p.row), {
                outcome: 'open',
                pnl: '',
                reasonSuffix: ` ${STATE_MARKER} not reached by ${today} (re-scored; the fixed ${evalHorizon}-candle horizon had given ${p.row.pnl}%)`,
              });
            }
            pending++;
            continue;
          }
        } else {
          exitIdx = entryIdx + evalHorizon;
          rule = `${evalHorizon} candles`;
          if (exitIdx >= candles.length) {
            log(
              `Scoring: ${symbol} ${p.row.action} @ ${p.row.price} — only ${candles.length - 1 - entryIdx} of ${evalHorizon} ` +
                `trading candles have printed since the signal (market hours) — still pending.`
            );
            pending++;
            continue;
          }
        }

        const exitClose = candles[exitIdx].close;
        const grossPct =
          p.row.action === 'BUY'
            ? ((exitClose - recordedPrice) / recordedPrice) * 100
            : ((recordedPrice - exitClose) / recordedPrice) * 100;
        const pnlPct = grossPct - feeBps / 100;
        const outcome = pnlPct > 0 ? 'win' : pnlPct < 0 ? 'loss' : 'flat';
        let reasonSuffix = '';
        if (p.stateL !== null) {
          const exitDay = new Date(candles[exitIdx].closeTime).toISOString().slice(0, 10);
          reasonSuffix = ` ${STATE_MARKER} ${exitDay} at ${exitClose}`;
          if (p.row.outcome !== 'open') reasonSuffix += ` (re-scored ${today}; the fixed ${evalHorizon}-candle horizon had given ${p.row.pnl}%)`;
        }
        updates.set(rowKey(p.row), { outcome, pnl: pnlPct.toFixed(4), reasonSuffix });
        const kind = p.row.mode === 'scan-filtered' ? ' [counterfactual — filter declined this signal]' : '';
        log(
          `Scoring: ${symbol} ${p.row.action} @ ${recordedPrice} (signal ${shortIso(candles[entryIdx].closeTime)}) -> ` +
            `exit ${exitClose} after ${rule} = ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% (${outcome}) net of ${feeBps} bps.${kind}`
        );
        if (p.tag && outcome === 'loss' && p.row.mode === 'scan') lessonKeys.add(`${symbol}|${p.tag}`);
      }
    } catch (err) {
      // One symbol's data outage (or missing stock-data keys on a fresh clone)
      // must not abort scoring for the rest.
      log(`Scoring: skipped ${symbol} this cycle — ${(err as Error).message.split('\n')[0]}`);
    }
  }

  let applied = 0;
  if (updates.size > 0) {
    updateLedger((rows) => {
      for (const r of rows) {
        const u = updates.get(rowKey(r));
        if (!u) continue;
        r.outcome = u.outcome;
        r.pnl = u.pnl;
        r.reason += u.reasonSuffix;
        applied++;
      }
      return applied > 0;
    });
    log(`Scoring: ${applied} outcome(s) written to ${ledgerPath()} — the forward record now has real results.`);
  }

  // Refresh the one lesson line per tag that just took a real live loss, using
  // ALL recorded outcomes for that symbol+tag so memory blocks on combined evidence.
  if (lessonKeys.size > 0) {
    const rows = loadLedger();
    for (const key of lessonKeys) {
      const [symbol, tag] = key.split('|');
      const tagRows = rows.filter(
        (r) => r.symbol === symbol && r.reason.includes(`[${tag}]`) && (r.outcome === 'win' || r.outcome === 'loss')
      );
      const wins = tagRows.filter((r) => r.outcome === 'win').length;
      const losses = tagRows.filter((r) => r.outcome === 'loss').length;
      const net = tagRows.reduce((a, r) => a + (Number(r.pnl) || 0), 0);
      const lastLoss = tagRows
        .filter((r) => r.outcome === 'loss')
        .map((r) => Date.parse(r.timestamp))
        .reduce((a, b) => Math.max(a, b), 0);
      upsertLesson(
        tag,
        `Lost ${losses} of ${wins + losses} real recorded setups on ${symbol} ${interval} ` +
          `(replay + live scan, net ${net.toFixed(2)}% after ${feeBps} bps costs), last loss ${shortIso(lastLoss)}. ` +
          `Skip fresh ${tag} signals while prior losses >= ${CONFIG.memoryMinLosses} and net PnL is negative.`
      );
    }
    log(`Scoring: ${lessonKeys.size} lesson(s) refreshed in ${learningsPath()} from real live-scan losses.`);
  }

  return { scored: applied, pending, unmatched };
}
