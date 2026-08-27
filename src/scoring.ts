import { CONFIG } from './config';
import { closedCandles, fetchSeriesSince, intervalToMs } from './market';
import { ledgerPath, learningsPath, loadLedger, upsertLesson, writeLedger } from './memory';
import type { Candle, LedgerRow } from './types';

/**
 * Scores matured live-scan paper trades so the forward record has real
 * win/loss outcomes, using the exact model replay uses: enter at the signal
 * candle's close, exit at the close EVAL_HORIZON *trading candles* later
 * (index-based, so stock overnight gaps behave exactly like the replay),
 * net of FEE_BPS round trip.
 *
 * Two row kinds are scored:
 *   mode 'scan'          — trades the bot actually took (position-affecting)
 *   mode 'scan-filtered' — signals a filter (e.g. HTF regime) declined; scored
 *                          as counterfactuals so the filter itself is testable
 *
 * Scan rows store wall-clock execution time, not the signal candle, so the
 * scorer derives the signal candle from the candle grid and VERIFIES it
 * against the recorded entry price before scoring. If the entry candle cannot
 * be matched to real market data, the row stays open and the mismatch is
 * reported — an outcome is never guessed.
 */

const SCORABLE_MODES = new Set(['scan', 'scan-filtered', 'alpaca-paper']);

function setupTagOf(row: LedgerRow): string | null {
  const m = row.reason.match(/^\[([^\]]+)\]/);
  return m ? m[1] : null;
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

export interface ScoringResult {
  scored: number;
  pending: number;
  unmatched: number;
}

export async function scoreMaturedScanTrades(log: (msg: string) => void = console.log): Promise<ScoringResult> {
  const { interval, evalHorizon, feeBps } = CONFIG;
  const iMs = intervalToMs(interval);
  const now = Date.now();

  const rows = loadLedger();
  const open = rows.filter(
    (r) =>
      SCORABLE_MODES.has(r.mode) &&
      r.outcome === 'open' &&
      (r.action === 'BUY' || r.action === 'SELL') &&
      rowInterval(r) === interval
  );
  if (open.length === 0) {
    log(`Scoring: no open ${interval} scan trades to score (other intervals are scored by their own scan config).`);
    return { scored: 0, pending: 0, unmatched: 0 };
  }

  let scored = 0;
  let pending = 0;
  let unmatched = 0;
  const lessonKeys = new Set<string>(); // symbol|tag pairs that took a real loss

  const symbols = [...new Set(open.map((r) => r.symbol))];
  for (const symbol of symbols) {
    const plans = open
      .filter((r) => r.symbol === symbol)
      .map((row) => {
        const execT = Date.parse(row.timestamp);
        const signalBoundary = Math.floor(execT / iMs) * iMs;
        return { row, signalBoundary };
      });

    // Calendar lower bound: before signal + horizon×interval nothing can be
    // matured, so skip the fetch entirely (keeps the cron cycle cheap).
    const maybeMatured = plans.filter((p) => now >= p.signalBoundary + evalHorizon * iMs);
    for (const p of plans.filter((x) => now < x.signalBoundary + evalHorizon * iMs)) {
      const minsLeft = Math.ceil((p.signalBoundary + evalHorizon * iMs - now) / 60_000);
      log(
        `Scoring: ${symbol} ${p.row.action} @ ${p.row.price} (${p.row.timestamp}) still maturing — ` +
          `earliest exit ~${shortIso(p.signalBoundary + evalHorizon * iMs)} (${minsLeft} min).`
      );
      pending++;
    }
    if (maybeMatured.length === 0) continue;

    const earliest = Math.min(...maybeMatured.map((p) => p.signalBoundary)) - 4 * iMs;
    const candles = closedCandles(await fetchSeriesSince(symbol, interval, earliest));
    const byBoundary = new Map<number, number>(); // grid boundary -> candle index
    candles.forEach((c, i) => byBoundary.set(c.closeTime + 1, i));

    for (const p of maybeMatured) {
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
            `(${p.row.timestamp}) against real market data — row stays open, no outcome is invented.`
        );
        continue;
      }

      // Exit = EVAL_HORIZON closed trading candles later (index-based, like replay).
      const exitIdx = entryIdx + evalHorizon;
      if (exitIdx >= candles.length) {
        const have = candles.length - 1 - entryIdx;
        log(
          `Scoring: ${symbol} ${p.row.action} @ ${p.row.price} — only ${have} of ${evalHorizon} trading candles ` +
            `have printed since the signal (market hours) — still pending.`
        );
        pending++;
        continue;
      }

      const exitClose = candles[exitIdx].close;
      const grossPct =
        p.row.action === 'BUY'
          ? ((exitClose - recordedPrice) / recordedPrice) * 100
          : ((recordedPrice - exitClose) / recordedPrice) * 100;
      const pnlPct = grossPct - feeBps / 100;
      p.row.outcome = pnlPct > 0 ? 'win' : pnlPct < 0 ? 'loss' : 'flat';
      p.row.pnl = pnlPct.toFixed(4);
      scored++;
      const kind = p.row.mode === 'scan-filtered' ? ' [counterfactual — filter declined this signal]' : '';
      log(
        `Scoring: ${symbol} ${p.row.action} @ ${recordedPrice.toFixed(2)} (signal ${shortIso(candles[entryIdx].closeTime)}) -> ` +
          `exit ${exitClose.toFixed(2)} after ${evalHorizon} candles = ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% ` +
          `(${p.row.outcome}) net of ${feeBps} bps.${kind}`
      );

      const tag = setupTagOf(p.row);
      if (tag && p.row.outcome === 'loss' && p.row.mode === 'scan') lessonKeys.add(`${symbol}|${tag}`);
    }
  }

  if (scored > 0) {
    writeLedger(rows);
    log(`Scoring: ${scored} outcome(s) written to ${ledgerPath()} — the forward record now has real results.`);
  }

  // Refresh the one lesson line per tag that just took a real live loss, using
  // ALL recorded outcomes for that symbol+tag so memory blocks on combined evidence.
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
  if (lessonKeys.size > 0) {
    log(`Scoring: ${lessonKeys.size} lesson(s) refreshed in ${learningsPath()} from real live-scan losses.`);
  }

  return { scored, pending, unmatched };
}
