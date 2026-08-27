import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { closedCandles, fetchSeries, fetchSeriesSince, intervalToMs, isCryptoSymbol } from './market';
import { latestSignal } from './strategy';
import { checkRisk } from './risk';
import { simulatePaperOrder } from './execution';
import { appendLedgerRow, ensureMemoryFiles, ledgerPath, loadLedger, paperPosition } from './memory';
import { consultMemory } from './adaptiveFilter';
import { scoreMaturedScanTrades } from './scoring';
import { regimeAllows, regimeAt } from './regime';
import { fetchMarketClock } from './stockdata';
import {
  type BrokerOrder,
  cancelStaleBotOrders,
  closePaperPosition,
  getAccount,
  getBrokerPositions,
  positionMatches,
  slippageBps,
  submitPaperBuy,
  submitPaperBuyLimit,
  submitPaperBuyMaker,
  toOrderSymbol,
} from './broker/orders';
import { buildRiskContext, evaluateEntry, recordEntry, type RiskContext } from './portfolioRisk';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Cheap and micro-priced coins need significant digits, not fixed decimals, for scoring's price verification to stay tight. */
function fmtPrice(p: number): string {
  return p >= 10 ? p.toFixed(2) : p.toPrecision(6);
}

/** A fresh intraday mark (last 1-minute close) — the decision-time reference for honest slippage. Null if unavailable. */
async function currentMark(symbol: string): Promise<number | null> {
  try {
    const c = closedCandles(await fetchSeries(symbol, '1m', 2));
    return c.length ? c[c.length - 1].close : null;
  } catch {
    return null;
  }
}

function writeHeartbeat(scanned: number, failures: number): void {
  try {
    fs.writeFileSync(
      path.join(CONFIG.dataDir, 'heartbeat.json'),
      JSON.stringify({ at: new Date().toISOString(), interval: CONFIG.interval, execution: CONFIG.executionMode, symbols: scanned, failures })
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Horizon-expiry exit manager for REAL paper positions: any broker position
 * whose entry signal candle is >= EVAL_HORIZON candles old is closed at
 * market, and the ACTUAL round-trip P&L (from real fills, gross of Alpaca
 * fees) is recorded next to the model-scored entry row.
 */
async function manageBrokerExits(): Promise<void> {
  const positions = await getBrokerPositions();
  if (positions.length === 0) {
    log('Broker: no open paper positions.');
    return;
  }
  const iMs = intervalToMs(CONFIG.interval);
  const rows = loadLedger();
  let stockOpen: boolean | null = null;
  for (const pos of positions) {
    const sym = CONFIG.symbolsList.find((s) => positionMatches(pos.symbol, s));
    if (!sym) continue; // another agent's universe — not ours to touch
    const entry = [...rows].reverse().find((r) => r.mode === 'alpaca-paper' && r.symbol === sym && r.action === 'BUY');
    if (!entry) {
      log(`Broker: ${sym} position has no ledger entry row — left untouched (reconcile by hand; the bot won't close a position it can't attribute).`);
      continue;
    }
    const entryBoundary = Math.floor(Date.parse(entry.timestamp) / iMs) * iMs;

    // Catastrophe stop-loss: force-exit a position down more than the limit,
    // regardless of the strategy signal. Wide by default so it never fights the
    // momentum exit — it only catches a disaster (gap, depeg, bad regime).
    const unrealizedPct = (Number(pos.unrealized_pl) / (Number(pos.market_value) - Number(pos.unrealized_pl))) * 100;
    let exitReason: string | null = null;
    if (CONFIG.maxPositionLossPct > 0 && unrealizedPct <= -CONFIG.maxPositionLossPct) {
      exitReason = `CATASTROPHE STOP: position down ${unrealizedPct.toFixed(1)}% (limit ${CONFIG.maxPositionLossPct}%)`;
    }

    // Age in CLOSED TRADING CANDLES since entry (exact for stocks and crypto —
    // matches the model's index-based horizon; calendar math would drift for
    // stocks, where 28 trading candles span ~40 calendar days).
    const series = exitReason ? [] : closedCandles(await fetchSeries(sym, CONFIG.interval, Math.max(CONFIG.evalHorizon * 3, 90)));
    if (exitReason) {
      // stop fired — skip the strategy-signal checks below
    } else if (CONFIG.tsmomState) {
      // State construction: exit when trailing momentum flips non-positive.
      const L = CONFIG.tsmomLookback;
      const last = series[series.length - 1];
      const mom = last.close / series[series.length - 1 - L].close - 1;
      if (mom > 0) {
        log(`Broker: ${sym} momentum ${(mom * 100).toFixed(2)}% still positive (unrealized ${Number(pos.unrealized_pl).toFixed(2)} USD) — holding.`);
        continue;
      }
      exitReason = `momentum flipped non-positive (${(mom * 100).toFixed(2)}%) — state exit`;
    } else {
      const ageCandles = series.filter((c) => c.closeTime > entryBoundary).length;
      if (ageCandles < CONFIG.evalHorizon) {
        log(`Broker: ${sym} held ${ageCandles}/${CONFIG.evalHorizon} candles (unrealized ${Number(pos.unrealized_pl).toFixed(2)} USD) — holding.`);
        continue;
      }
      exitReason = `horizon exit after ${ageCandles} candles`;
    }
    if (!isCryptoSymbol(sym)) {
      if (stockOpen === null) stockOpen = (await fetchMarketClock()).is_open;
      if (!stockOpen) {
        log(`Broker: ${sym} exit condition met but the stock market is closed — exit will fire at the next open.`);
        continue;
      }
    }
    const order = await closePaperPosition(sym);
    const exitFill = Number(order.filled_avg_price);
    const entryFillMatch = entry.reason.match(/broker fill ([0-9.]+)/);
    const entryFill = entryFillMatch ? Number(entryFillMatch[1]) : Number(entry.price);
    const actualPct = ((exitFill - entryFill) / entryFill) * 100;
    const tagMatch = entry.reason.match(/^\[([^\]]+)\]/);
    const tag = tagMatch ? tagMatch[1] : 'unknown';
    appendLedgerRow({
      timestamp: new Date().toISOString(),
      symbol: sym,
      action: 'SELL',
      price: fmtPrice(exitFill),
      quantity: order.filled_qty,
      reason: `[actual:${tag}] Exit: ${exitReason}; entry fill ${entryFill}; ACTUAL round-trip P&L from real paper fills, gross of Alpaca fees (~50 bps RT taker at this tier).`,
      mode: 'alpaca-paper-exit',
      outcome: actualPct > 0 ? 'win' : actualPct < 0 ? 'loss' : 'flat',
      pnl: actualPct.toFixed(4),
    });
    log(`Broker: ${sym} ${exitReason} — sold ${order.filled_qty} @ ${exitFill} (entry fill ${entryFill}) = ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(3)}% actual, recorded.`);
  }
}

/**
 * One full decision cycle over the configured universe:
 * score matured trades -> for each symbol: market -> signal -> regime ->
 * risk -> memory -> (simulated) execution -> ledger.
 *
 * Crypto (…USDT) scans 24/7 via Binance public data; stock symbols use the
 * Alpaca PAPER data API (read-only) and are skipped outside regular hours.
 */
export async function runScan(): Promise<void> {
  const { interval, symbolsList } = CONFIG;
  if (CONFIG.tsmomState && (CONFIG.executionMode !== 'alpaca-paper' || !CONFIG.longOnly)) {
    throw new Error('TSMOM_STATE=on requires EXECUTION=alpaca-paper and LONG_ONLY=on (position state lives at the broker).');
  }
  log(
    `Scanner started for ${symbolsList.length} symbols on ${interval} ` +
      `(paper mode — no live order path exists in this project${CONFIG.tsmomState ? '; STATE construction (Trial 07)' : ''}${CONFIG.regimeFilter ? `; regime filter ON: ${CONFIG.htfInterval} SMA${CONFIG.htfMa}` : ''})`
  );

  // Score earlier paper trades whose horizon has passed, so the forward
  // record (and the memory system) runs on real outcomes.
  await scoreMaturedScanTrades(log);

  // Manage real paper positions (exits, stops) before looking for new entries.
  let riskCtx: RiskContext | null = null;
  if (CONFIG.executionMode === 'alpaca-paper') {
    // Cancel any of our own orders left resting from a previous scan (maker
    // orders that never filled), so none go stale or double-fill.
    if (CONFIG.orderMode === 'maker') {
      const canceled = await cancelStaleBotOrders();
      if (canceled > 0) log(`Broker: canceled ${canceled} stale unfilled maker order(s) from a prior scan.`);
    }
    await manageBrokerExits();
    // Build the risk context ONCE per scan from a fresh post-exit snapshot;
    // symbols share it and increment its tallies as entries fill (one set of
    // account/positions calls instead of one per symbol).
    const [account, positions] = await Promise.all([getAccount(), getBrokerPositions()]);
    riskCtx = buildRiskContext(account, positions);
    log(`Risk: ${riskCtx.haltReason} · ${riskCtx.openCount} open · $${riskCtx.deployed.toFixed(0)} deployed ($${riskCtx.cryptoDeployed.toFixed(0)} crypto).`);
    if (riskCtx.entriesHalted) log('Risk: NEW ENTRIES HALTED this scan (exits and stops still ran).');
  }

  let stockMarketOpen: boolean | null = null;
  if (symbolsList.some((s) => !isCryptoSymbol(s))) {
    const clock = await fetchMarketClock();
    stockMarketOpen = clock.is_open;
    if (!clock.is_open) {
      log(
        CONFIG.interval === '1d'
          ? `US stock market is closed — daily signals are still evaluated; any orders defer to the next open (${clock.next_open}).`
          : `US stock market is closed — stock symbols will be skipped this cycle (next open ${clock.next_open}).`
      );
    }
  }

  let failures = 0;
  for (const symbol of symbolsList) {
    try {
      await scanSymbol(symbol, stockMarketOpen, riskCtx);
    } catch (err) {
      failures++;
      log(`${symbol}: BLOCKED — ${(err as Error).message}`);
      log(`${symbol}: the bot never fakes a result for a symbol it cannot read; continuing with the rest of the universe.`);
    }
  }
  writeHeartbeat(symbolsList.length, failures);
  if (failures > 0) process.exitCode = 1;
}

async function scanSymbol(symbol: string, stockMarketOpen: boolean | null, riskCtx: RiskContext | null): Promise<void> {
  const { interval, scanCandles } = CONFIG;
  const crypto = isCryptoSymbol(symbol);
  const quantity = crypto ? CONFIG.quantity : CONFIG.stockQuantity;
  const maxPosition = crypto ? CONFIG.maxPosition : CONFIG.stockMaxPosition;

  // Intraday stock scans need an open market; DAILY signals form at the close,
  // so a daily-interval scan is valid (and correct) while the market is closed.
  if (!crypto && stockMarketOpen === false && CONFIG.interval !== '1d') {
    log(`${symbol}: skipped — stocks trade regular hours only (crypto scans continue 24/7).`);
    return;
  }

  const candles = closedCandles(await fetchSeries(symbol, interval, scanCandles));
  const last = candles[candles.length - 1];
  log(
    `${symbol}: loaded ${candles.length} real closed candles · last close ${last.close.toFixed(2)} at ${new Date(last.closeTime).toISOString()}`
  );

  const sig = latestSignal(candles);
  log(`${symbol}: signal ${sig.action} — ${sig.reason}`);
  if (sig.action === 'HOLD') {
    log(`${symbol}: final decision HOLD — no paper order was sent.`);
    return;
  }

  // One decision per signal candle: scans run far more often than candles
  // close (e.g. hourly scans of daily candles), and the same fresh signal must
  // not be traded again on every re-scan.
  const iMs = intervalToMs(interval);
  const signalBoundary = Math.floor((sig.time + 1) / iMs) * iMs;
  const alreadyActed = loadLedger().some((r) => {
    if (r.symbol !== symbol) return false;
    if (r.mode !== 'scan' && r.mode !== 'scan-filtered' && r.mode !== 'alpaca-paper') return false;
    if (!r.reason.includes(`[${sig.setupTag}]`)) return false;
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) && Math.floor(t / iMs) * iMs === signalBoundary;
  });
  if (alreadyActed) {
    log(`${symbol}: this ${sig.setupTag} signal candle was already acted on in an earlier scan — no duplicate order.`);
    return;
  }

  // Trial 02 regime gate: entries only with the higher-timeframe trend.
  // Declined signals are logged as counterfactuals so the filter is testable.
  if (CONFIG.regimeFilter) {
    const htfStart = Date.now() - (CONFIG.htfMa + 5) * intervalToMs(CONFIG.htfInterval);
    const htf = closedCandles(await fetchSeriesSince(symbol, CONFIG.htfInterval, htfStart));
    const verdict = regimeAt(htf, sig.time);
    if (!regimeAllows(sig.action, verdict.regime)) {
      ensureMemoryFiles();
      appendLedgerRow({
        timestamp: new Date().toISOString(),
        symbol,
        action: sig.action,
        price: sig.price.toFixed(2),
        quantity: '0',
        reason: `[${sig.setupTag}] Regime filter declined this entry: ${verdict.reason}`,
        mode: 'scan-filtered',
        outcome: 'open',
        pnl: '',
      });
      log(`${symbol}: regime filter declined ${sig.action} — ${verdict.reason}`);
      log(`${symbol}: final decision HOLD (filtered) — counterfactual logged to ${ledgerPath()} for honest scoring.`);
      return;
    }
    log(`${symbol}: regime allows ${sig.action} — ${verdict.reason}`);
  }

  // Base-unit risk sizing applies to the local simulator; the broker path
  // below uses portfolio-level guards (budget, position count) instead.
  if (CONFIG.executionMode !== 'alpaca-paper') {
    const position = paperPosition(symbol);
    const risk = checkRisk(sig, position, quantity, maxPosition);
    log(`${symbol}: risk — current paper position ${position} · ${risk.reason}`);
    if (!risk.approved) {
      if (risk.finalAction === 'SKIP') {
        ensureMemoryFiles();
        appendLedgerRow({
          timestamp: new Date().toISOString(),
          symbol,
          action: 'SKIP',
          price: fmtPrice(sig.price),
          quantity: '0',
          reason: `[${sig.setupTag}] ${risk.reason}`,
          mode: 'scan',
          outcome: 'skipped',
          pnl: '',
        });
        log(`${symbol}: SKIP recorded in ${ledgerPath()}.`);
      }
      log(`${symbol}: final decision ${risk.finalAction} — no paper order was sent.`);
      return;
    }
  }

  ensureMemoryFiles();
  const mem = consultMemory(symbol, sig.setupTag);
  log(`${symbol}: memory — ${mem.reason}`);
  if (mem.blocked) {
    // Logged as a scoreable counterfactual (mode scan-filtered) so the forward
    // record can measure whether memory's skips actually helped.
    appendLedgerRow({
      timestamp: new Date().toISOString(),
      symbol,
      action: sig.action,
      price: sig.price.toFixed(2),
      quantity: '0',
      reason: `[${sig.setupTag}] Memory blocked this entry (counterfactual): ${mem.reason}`,
      mode: 'scan-filtered',
      outcome: 'open',
      pnl: '',
    });
    log(`${symbol}: final decision SKIP — memory blocked a known bad setup; counterfactual logged to ${ledgerPath()} for honest scoring.`);
    return;
  }

  // REAL PAPER EXECUTION (Alpaca paper host, hardcoded; §5 approval 2026-07-15).
  if (CONFIG.executionMode === 'alpaca-paper') {
    if (sig.action === 'SELL') {
      log(`${symbol}: SELL entry cannot execute on Alpaca crypto (no shorting) — recording as simulation instead.`);
    } else if (!crypto && stockMarketOpen === false) {
      // No ledger row is written, so the signal stays actionable: the next
      // scan with the market open places the order (slippage vs the signal
      // close will show the overnight gap — honest and measured).
      log(`${symbol}: BUY signal noted but the stock market is closed — the order will be placed at the next open.`);
      return;
    } else {
      if (!riskCtx) throw new Error('risk context missing for a broker entry (internal).');
      const orderKey = toOrderSymbol(symbol).replace('/', '');

      // Entry-timing window: cluster NEW crypto entries near the daily close
      // (the price the signal was computed on), TZ-independently. Exits are
      // never windowed. No ledger row is written when deferring, so the next
      // scan retries — and once inside the window it enters.
      if (CONFIG.entryWindowMin > 0 && crypto) {
        const lastClose = Math.floor(Date.now() / 86_400_000) * 86_400_000; // last 00:00 UTC
        const minsSinceClose = (Date.now() - lastClose) / 60_000;
        if (minsSinceClose > CONFIG.entryWindowMin) {
          log(`${symbol}: outside the ${CONFIG.entryWindowMin}-min post-close entry window (${minsSinceClose.toFixed(0)} min in) — deferring to near the next daily close for a fill nearer the signal price.`);
          return;
        }
      }

      const decision = evaluateEntry(symbol, orderKey, candles, riskCtx);
      if (!decision.allowed) {
        log(`${symbol}: entry skipped — ${decision.reason}`);
        return;
      }
      // Decision-time mark = a fresh intraday price. Slippage vs THIS is honest
      // execution quality; slippage vs the (possibly day-old) signal close is
      // reported separately as signal drift, so the two are never conflated.
      const decisionRef = await currentMark(symbol);
      const clientId = `bot-${symbol}-${signalBoundary}`;
      let filled: BrokerOrder;
      if (CONFIG.orderMode === 'maker' && decisionRef) {
        // Passive limit below the mark → rests as maker (lower fee). Non-fill
        // returns null; we retry next scan at no cost.
        const limitPrice = decisionRef * (1 - CONFIG.makerOffsetBps / 10_000);
        const res = await submitPaperBuyMaker(symbol, decision.notional, limitPrice, clientId, CONFIG.makerWaitSec);
        if (!res) {
          log(`${symbol}: maker limit @ ${fmtPrice(limitPrice)} did not fill in ${CONFIG.makerWaitSec}s — canceled, will retry next scan (no cost, no row).`);
          return;
        }
        filled = res;
      } else {
        filled =
          CONFIG.limitSlippageBps > 0 && decisionRef
            ? await submitPaperBuyLimit(symbol, decision.notional, decisionRef * (1 + CONFIG.limitSlippageBps / 10_000), clientId)
            : await submitPaperBuy(symbol, decision.notional, clientId);
      }
      const fillPrice = Number(filled.filled_avg_price);
      const slipExec = decisionRef ? slippageBps(fillPrice, decisionRef) : null;
      const slipSignal = slippageBps(fillPrice, sig.price);
      const bps = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(1);
      recordEntry(riskCtx, symbol, orderKey, decision.notional);
      appendLedgerRow({
        timestamp: new Date().toISOString(),
        symbol,
        action: 'BUY',
        price: fmtPrice(sig.price),
        quantity: filled.filled_qty,
        reason:
          `[${sig.setupTag}] ${sig.reason} || broker fill ${fillPrice} qty ${filled.filled_qty}, ` +
          `slippage ${slipExec != null ? bps(slipExec) : 'n/a'} bps vs decision mark${decisionRef ? ` ${fmtPrice(decisionRef)}` : ''}, ` +
          `signal-drift ${bps(slipSignal)} bps vs signal close, order ${clientId}`,
        mode: 'alpaca-paper',
        outcome: 'open',
        pnl: '',
      });
      log(
        `${symbol}: REAL PAPER ORDER filled — $${decision.notional.toFixed(2)} @ ${fillPrice}, ` +
          `exec slippage ${slipExec != null ? bps(slipExec) : 'n/a'} bps vs decision mark, signal-drift ${bps(slipSignal)} bps.`
      );
      log(`${symbol}: final decision BUY (alpaca-paper) — logged to ${ledgerPath()}.`);
      return;
    }
  }

  const order = simulatePaperOrder({
    symbol,
    action: sig.action,
    price: sig.price,
    quantity,
    mode: 'scan',
    reason: `[${sig.setupTag}] ${sig.reason}`,
  });
  appendLedgerRow({
    timestamp: order.timestamp,
    symbol,
    action: sig.action,
    price: sig.price.toFixed(2),
    quantity: String(quantity),
    reason: `[${sig.setupTag}] ${sig.reason}`,
    mode: 'scan',
    outcome: 'open',
    pnl: '',
  });
  log(`${symbol}: execution — PAPER ${sig.action} ${quantity} @ ${sig.price.toFixed(2)} simulated; no real order was sent.`);
  log(`${symbol}: final decision ${sig.action} (paper) — logged to ${ledgerPath()}.`);
}
