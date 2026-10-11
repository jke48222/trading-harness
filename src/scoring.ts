import { CONFIG } from './config';
import { closedCandles, fetchSeriesSince, intervalToMs } from './market';
import { ledgerPath, learningsPath, loadLedger, rowKey, updateLedger, upsertLesson } from './memory';
import type { LedgerRow } from './types';
import { isSingleLookback, maxLookback, ruleOfStateTag, votesAt, type VoteRule } from './voteRule';

/**
 * Scores matured paper trades so the forward record has real win/loss
 * outcomes, using the same model as replay: enter at the signal candle's
 * close, net of a round-trip cost (rowCostBps). The exit depends on the construction:
 *
 *   flip / horizon rows   exit EVAL_HORIZON trading candles later (index-based,
 *                         so stock overnight gaps behave exactly like replay)
 *   state rows (...-state-long, the book)
 *                         exit at the first close where the rule the row's tag
 *                         names reaches its exit: momentum no longer positive
 *                         under Trial 07's rule, the vote at its exit count
 *                         under a vote (Trial 09)
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
/** Marker of the current state-scoring model. Rows scored before it are re-scored once. */
const MODEL_V2 = '|| model v2:';
const STATE_MARKER_V1 = '|| model: state exit';

function setupTagOf(row: LedgerRow): string | null {
  const m = row.reason.match(/^\[([^\]]+)\]/);
  return m ? m[1] : null;
}

/** The rule a state row was entered under, from its tag; null for any other row. */
export function stateRuleOf(tag: string | null): VoteRule | null {
  return ruleOfStateTag(tag);
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
 * Index of the state-construction exit: the first candle after entry where
 * the rule's vote is at or below its exit count (for Trial 07's rule: the
 * trailing return is not positive). Null when the rule still holds on every
 * candle so far (the model trade is still open). 'insufficient' when the
 * series starts too late to test the first candle after entry: silently
 * skipping it once made stock exits days late.
 */
export function stateExitIndex(closes: number[], entryIdx: number, rule: VoteRule): number | null | 'insufficient' {
  if (entryIdx + 1 - maxLookback(rule) < 0) return 'insufficient';
  for (let j = entryIdx + 1; j < closes.length; j++) {
    if (votesAt(closes, j, rule.lookbacks) <= rule.exit) return j;
  }
  return null;
}

/**
 * Round-trip cost a row is scored at. Real paper rows use the measured cost
 * of their sleeve; replays and simulations use the run's FEE_BPS, the basis
 * their trials registered.
 */
export function rowCostBps(row: LedgerRow): number {
  if (row.mode !== 'alpaca-paper') return CONFIG.feeBps;
  return row.symbol.endsWith('USDT') ? CONFIG.feeBpsCrypto : CONFIG.feeBpsStocks;
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
  /** The row as it was read; the update applies only if nobody changed it since. */
  seenOutcome: string;
  seenReason: string;
}

/**
 * True for state rows scored under an older model: the fixed 28-candle
 * horizon (no marker), or model v1 (one cost for every symbol and too short a
 * window for stocks). Each is re-scored once, keeping its old figure.
 */
function needsStateRescore(r: LedgerRow): boolean {
  return (
    stateRuleOf(setupTagOf(r)) !== null &&
    (r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'flat') &&
    !r.reason.includes(MODEL_V2)
  );
}

/** Why an already-scored row's figure changed, for the note kept in its reason. */
function rescoreNote(r: LedgerRow, today: string, horizon: number): string {
  return r.reason.includes(STATE_MARKER_V1)
    ? ` (re-scored ${today} under model v2; was ${r.pnl}%)`
    : ` (re-scored ${today} under model v2; the fixed ${horizon}-candle horizon had given ${r.pnl}%)`;
}

export async function scoreMaturedScanTrades(log: (msg: string) => void = console.log): Promise<ScoringResult> {
  const { interval, evalHorizon } = CONFIG;
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
          const stateRule = stateRuleOf(tag);
          return { row, tag, stateRule, signalBoundary: Math.floor(Date.parse(row.timestamp) / iMs) * iMs };
        });

      // Calendar lower bound for fixed-horizon rows: nothing can mature before
      // signal + horizon x interval, so skip the fetch (keeps the cycle cheap).
      // State rows can exit on the very next candle, so they always qualify.
      const ready = plans.filter((p) => p.stateRule !== null || now >= p.signalBoundary + evalHorizon * iMs);
      for (const p of plans.filter((x) => !ready.includes(x))) {
        const minsLeft = Math.ceil((p.signalBoundary + evalHorizon * iMs - now) / 60_000);
        log(
          `Scoring: ${symbol} ${p.row.action} @ ${p.row.price} (${p.row.timestamp}) still maturing — ` +
            `earliest exit ~${shortIso(p.signalBoundary + evalHorizon * iMs)} (${minsLeft} min).`
        );
        pending++;
      }
      if (ready.length === 0) continue;

      // State rows need L candles before the entry to test the first candle
      // after it. Stocks trade about 5 days in 7, so reach back twice as far.
      const maxL = Math.max(0, ...ready.map((p) => (p.stateRule ? maxLookback(p.stateRule) : 0)));
      const reach = symbol.endsWith('USDT') ? 1 : 2;
      const earliest = Math.min(...ready.map((p) => p.signalBoundary)) - (maxL + 5) * reach * iMs;
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

        let exitIdx: number;
        let rule: string;
        const seen = { seenOutcome: p.row.outcome, seenReason: p.row.reason };
        if (p.stateRule !== null) {
          const found = stateExitIndex(closes, entryIdx, p.stateRule);
          rule = isSingleLookback(p.stateRule)
            ? `state exit (trailing ${p.stateRule.lookbacks[0]}-candle return turned non-positive)`
            : `state exit (votes over ${p.stateRule.lookbacks.join('/')} fell to ${p.stateRule.exit} or fewer)`;
          if (found === 'insufficient') {
            unmatched++;
            log(`Scoring: ${symbol} ${p.row.timestamp} — fetched history starts too late to test the state exit; row left as it is.`);
            continue;
          }
          if (found === null) {
            if (p.row.outcome !== 'open') {
              // Scored under an older model, but the state model is still in the trade.
              updates.set(rowKey(p.row), { outcome: 'open', pnl: '', reasonSuffix: ` ${MODEL_V2} state exit not reached by ${today}${rescoreNote(p.row, today, evalHorizon)}`, ...seen });
            }
            pending++;
            continue;
          }
          exitIdx = found;
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
        const cost = rowCostBps(p.row);
        const pnlPct = grossPct - cost / 100;
        const outcome = pnlPct > 0 ? 'win' : pnlPct < 0 ? 'loss' : 'flat';
        let reasonSuffix = '';
        if (p.stateRule !== null) {
          // Date from the candle's open: an Alpaca session bar closes at 03:59 UTC the next day.
          const exitDay = new Date(candles[exitIdx].openTime).toISOString().slice(0, 10);
          reasonSuffix = ` ${MODEL_V2} state exit ${exitDay} at ${exitClose}, net of ${cost} bps`;
          if (p.row.outcome !== 'open' && Math.abs(Number(p.row.pnl) - pnlPct) > 0.00005) reasonSuffix += rescoreNote(p.row, today, evalHorizon);
        }
        updates.set(rowKey(p.row), { outcome, pnl: pnlPct.toFixed(4), reasonSuffix, ...seen });
        const kind = p.row.mode === 'scan-filtered' ? ' [counterfactual — filter declined this signal]' : '';
        log(
          `Scoring: ${symbol} ${p.row.action} @ ${recordedPrice} (signal ${shortIso(candles[entryIdx].closeTime)}) -> ` +
            `exit ${exitClose} after ${rule} = ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% (${outcome}) net of ${cost} bps.${kind}`
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
        // Another scorer may have finished this row since it was read; leave it.
        if (!u || r.outcome !== u.seenOutcome || r.reason !== u.seenReason) continue;
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
          `(replay + live scan, net ${net.toFixed(2)}% after ${CONFIG.feeBps} bps costs), last loss ${shortIso(lastLoss)}. ` +
          `Skip fresh ${tag} signals while prior losses >= ${CONFIG.memoryMinLosses} and net PnL is negative.`
      );
    }
    log(`Scoring: ${lessonKeys.size} lesson(s) refreshed in ${learningsPath()} from real live-scan losses.`);
  }

  return { scored: applied, pending, unmatched };
}
