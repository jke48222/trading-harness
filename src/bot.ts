import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import { closedCandles, fetchSeries, fetchSeriesSince, intervalToMs, isCryptoSymbol } from './market';
import { latestSignal } from './strategy';
import { checkRisk } from './risk';
import { simulatePaperOrder } from './execution';
import { appendLedgerRow, ensureMemoryFiles, entryFillOf, ledgerPath, loadLedger, openEntryFor, orderIdOf, paperPosition } from './memory';
import { consultMemory } from './adaptiveFilter';
import { scoreMaturedScanTrades } from './scoring';
import { regimeAllows, regimeAt } from './regime';
import { fetchMarketClock } from './stockdata';
import {
  BrokerHttpError,
  type EntryResult,
  cancelStaleBotOrders,
  closePaperPosition,
  getAccount,
  getBrokerPositions,
  getLatestQuote,
  positionMatches,
  slippageBps,
  submitPaperBuy,
  submitPaperBuyLimit,
  submitPaperBuyMaker,
  toOrderSymbol,
} from './broker/orders';
import { buildRiskContext, evaluateEntry, recordEntry, type RiskContext } from './portfolioRisk';
import { acquireRunLock, runLockHolder } from './locks';
import { adoptLateFills, fmtPrice } from './reconcileRun';
import { priceEntry } from './entryPricing';
import type { Candle, Signal } from './types';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Last 1-minute close: the fallback arrival price when the venue has no usable quote. Null if unavailable. */
async function currentMark(symbol: string): Promise<number | null> {
  try {
    const c = closedCandles(await fetchSeries(symbol, '1m', 2));
    return c.length ? c[c.length - 1].close : null;
  } catch {
    return null;
  }
}

/** What one scan did. Written as this run's heartbeat; health turns the bad parts into alerts. */
export interface ScanStats {
  label: string;
  at: string;
  startedAt: string;
  interval: string;
  execution: string;
  symbols: number;
  /** Symbols whose data or logic failed (not broker refusals). */
  failures: string[];
  entries: string[];
  partials: string[];
  /** Entries that settled with nothing filled and were canceled. Retried next scan. */
  unfilled: string[];
  /** Orders the broker never confirmed as final. Swept and adopted next scan. */
  unknown: string[];
  /** Orders the broker refused (HTTP 4xx), e.g. insufficient balance. */
  rejects: string[];
  spreadSkips: string[];
  exits: string[];
  exitFailures: string[];
  /** Broker positions in this run's universe with no open ledger entry. */
  orphans: string[];
  swept: number;
  adopted: number;
}

export function runLabel(): string {
  if (CONFIG.runLabel) return CONFIG.runLabel;
  const state = CONFIG.tsmomState ? '-state' : '';
  return `${CONFIG.strategyName}${state}-${CONFIG.interval}-${CONFIG.executionMode}-${CONFIG.symbolsList.length}sym`;
}

function newStats(): ScanStats {
  const now = new Date().toISOString();
  return {
    label: runLabel(),
    at: now,
    startedAt: now,
    interval: CONFIG.interval,
    execution: CONFIG.executionMode,
    symbols: CONFIG.symbolsList.length,
    failures: [],
    entries: [],
    partials: [],
    unfilled: [],
    unknown: [],
    rejects: [],
    spreadSkips: [],
    exits: [],
    exitFailures: [],
    orphans: [],
    swept: 0,
    adopted: 0,
  };
}

/** data/heartbeat/<label>.json, one file per agent, so a busy agent can't mask a dead one. */
export function heartbeatDir(): string {
  return path.join(CONFIG.dataDir, 'heartbeat');
}

function writeHeartbeat(stats: ScanStats): void {
  try {
    stats.at = new Date().toISOString();
    fs.mkdirSync(heartbeatDir(), { recursive: true });
    const file = path.join(heartbeatDir(), `${stats.label.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(stats, null, 1));
    fs.renameSync(file + '.tmp', file);
  } catch {
    /* non-fatal */
  }
}

/**
 * Exit manager for REAL paper positions. Every position is matched to its
 * open ledger entry by timestamp (never file order); a position with no open
 * entry is an orphan and is left alone for health to raise. Exits fire on the
 * state flip (TSMOM_STATE), the catastrophe stop, or the fixed horizon, and
 * record the ACTUAL round-trip P&L from real fills.
 */
async function manageBrokerExits(stats: ScanStats): Promise<void> {
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
    try {
      const entry = openEntryFor(rows, sym);
      if (!entry) {
        stats.orphans.push(sym);
        log(`Broker: ${sym} position has no open ledger entry — left untouched; \`npm run reconcile\` explains it (the bot won't close a position it can't attribute).`);
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
      if (!exitReason) {
        const series = closedCandles(await fetchSeries(sym, CONFIG.interval, Math.max(CONFIG.evalHorizon * 3, 90)));
        if (CONFIG.tsmomState) {
          // State construction: exit when trailing momentum flips non-positive.
          const L = CONFIG.tsmomLookback;
          const mom = series[series.length - 1].close / series[series.length - 1 - L].close - 1;
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
      const entryFill = entryFillOf(entry) ?? Number(entry.price);
      const actualPct = ((exitFill - entryFill) / entryFill) * 100;
      const tag = entry.reason.match(/^\[([^\]]+)\]/)?.[1] ?? 'unknown';
      appendLedgerRow({
        timestamp: new Date().toISOString(),
        symbol: sym,
        action: 'SELL',
        price: fmtPrice(exitFill),
        quantity: order.filled_qty,
        reason:
          `[actual:${tag}] Exit: ${exitReason}; entry fill ${entryFill} (order ${orderIdOf(entry) ?? 'unknown'}); ` +
          'ACTUAL round-trip P&L from real paper fills, gross of Alpaca fees.',
        mode: 'alpaca-paper-exit',
        outcome: actualPct > 0 ? 'win' : actualPct < 0 ? 'loss' : 'flat',
        pnl: actualPct.toFixed(4),
      });
      stats.exits.push(`${sym} ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(2)}%`);
      log(`Broker: ${sym} ${exitReason} — sold ${order.filled_qty} @ ${exitFill} (entry fill ${entryFill}) = ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(3)}% actual, recorded.`);
    } catch (err) {
      stats.exitFailures.push(`${sym}: ${(err as Error).message.split('\n')[0]}`);
      log(`Broker: ${sym} exit check failed — ${(err as Error).message.split('\n')[0]} (retried next scan).`);
    }
  }
}

/**
 * One full decision cycle over the configured universe:
 * score matured trades -> (book only) sweep stale orders, adopt late fills,
 * manage exits -> for each symbol: market -> signal -> regime -> risk ->
 * memory -> execution -> ledger. Writes a heartbeat even when it fails.
 *
 * Crypto (…USDT) scans 24/7 via Binance public data; stock symbols use the
 * Alpaca PAPER data API (read-only) and are skipped outside regular hours.
 */
export async function runScan(): Promise<void> {
  const { interval, symbolsList } = CONFIG;
  if (CONFIG.tsmomState && (CONFIG.executionMode !== 'alpaca-paper' || !CONFIG.longOnly)) {
    throw new Error('TSMOM_STATE=on requires EXECUTION=alpaca-paper and LONG_ONLY=on (position state lives at the broker).');
  }
  const broker = CONFIG.executionMode === 'alpaca-paper';
  // Two book scans at once (the hourly agent and a dashboard click) could
  // both pass the per-candle dedup before either writes its row.
  const release = broker ? acquireRunLock('book') : null;
  if (broker && !release) {
    log(`Another book scan (pid ${runLockHolder('book')?.pid ?? '?'}) is running — this one exits without trading.`);
    return;
  }
  const stats = newStats();
  try {
    log(
      `Scanner started for ${symbolsList.length} symbols on ${interval} [${stats.label}] ` +
        `(paper only — orders can reach only the Alpaca paper host${CONFIG.tsmomState ? '; STATE construction (Trial 07)' : ''}${CONFIG.regimeFilter ? `; regime filter ON: ${CONFIG.htfInterval} SMA${CONFIG.htfMa}` : ''})`
    );

    // Score earlier paper trades whose horizon has passed, so the forward
    // record (and the memory system) runs on real outcomes.
    await scoreMaturedScanTrades(log);

    let riskCtx: RiskContext | null = null;
    if (broker) {
      // Nothing should be resting at the broker between scans; anything that is
      // was left by a crash or an unconfirmed cancel.
      const swept = await cancelStaleBotOrders();
      stats.swept = swept.length;
      if (swept.length > 0) log(`Broker: canceled ${swept.length} stale bot order(s): ${swept.map((o) => o.client_order_id).join(', ')}.`);
      try {
        stats.adopted = await adoptLateFills(log, 14, new Set(symbolsList));
      } catch (err) {
        stats.failures.push(`adoption: ${(err as Error).message.split('\n')[0]}`);
        log(`Broker: late-fill adoption failed — ${(err as Error).message.split('\n')[0]}`);
      }
      await manageBrokerExits(stats);
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

    for (const symbol of symbolsList) {
      try {
        await scanSymbol(symbol, stockMarketOpen, riskCtx, stats);
      } catch (err) {
        const msg = (err as Error).message.split('\n')[0];
        if (err instanceof BrokerHttpError && err.path === '/v2/orders') {
          stats.rejects.push(`${symbol}: HTTP ${err.status} ${err.body.slice(0, 160)}`);
          log(`${symbol}: ORDER REJECTED by the broker — HTTP ${err.status} ${err.body.slice(0, 200)}`);
        } else {
          stats.failures.push(`${symbol}: ${msg}`);
          log(`${symbol}: BLOCKED — ${msg}`);
          log(`${symbol}: the bot never fakes a result for a symbol it cannot read; continuing with the rest of the universe.`);
        }
      }
    }
  } catch (err) {
    stats.failures.push(`scan: ${(err as Error).message.split('\n')[0]}`);
    throw err;
  } finally {
    writeHeartbeat(stats);
    release?.();
    const bad = stats.failures.length + stats.rejects.length + stats.unknown.length + stats.exitFailures.length + stats.orphans.length;
    if (bad > 0) process.exitCode = 1;
  }
}

async function scanSymbol(symbol: string, stockMarketOpen: boolean | null, riskCtx: RiskContext | null, stats: ScanStats): Promise<void> {
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
  log(`${symbol}: loaded ${candles.length} real closed candles · last close ${fmtPrice(last.close)} at ${new Date(last.closeTime).toISOString()}`);

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
  if (CONFIG.tsmomState) {
    // Trial 07 tested the state construction with no memory filter; adding one
    // live would change the strategy the evidence is about.
    log(`${symbol}: memory — not applied to the state construction (Trial 07 rules have no memory filter).`);
  } else {
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
  }

  // REAL PAPER EXECUTION (Alpaca paper host, hardcoded; approved 2026-07-15).
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
      await enterPosition(symbol, crypto, sig, candles, signalBoundary, riskCtx, stats);
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

/**
 * Place a real paper BUY and record exactly what happened. The limit is set
 * off the venue's ask (not another exchange's last trade), entries skip when
 * the quoted spread alone would eat the edge, and the order always settles:
 * filled, partly filled, or canceled. Only a fill writes a ledger row.
 */
async function enterPosition(
  symbol: string,
  crypto: boolean,
  sig: Signal,
  candles: Candle[],
  signalBoundary: number,
  riskCtx: RiskContext,
  stats: ScanStats
): Promise<void> {
  const orderKey = toOrderSymbol(symbol).replace('/', '');

  // Entry-timing window: cluster NEW crypto entries near the daily close (the
  // price the signal was computed on), TZ-independently. Exits are never
  // windowed. No row is written when deferring, so a later scan retries.
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

  const quote = await getLatestQuote(symbol);
  // Only ask for the 1m close when the quote can't be used (stocks after hours, a missing book).
  let pricing = priceEntry({ crypto, quote, mark: null, nowMs: Date.now(), maxSpreadBps: CONFIG.maxSpreadBps });
  if (pricing.kind === 'price' && pricing.arrival == null) {
    pricing = priceEntry({ crypto, quote, mark: await currentMark(symbol), nowMs: Date.now(), maxSpreadBps: CONFIG.maxSpreadBps });
  }
  if (pricing.kind === 'skip') {
    stats.spreadSkips.push(`${symbol} ${quote ? quote.spreadBps.toFixed(0) + 'bps' : ''}`.trim());
    log(`${symbol}: entry skipped — ${pricing.reason}; crossing it costs more than a normal day's edge. Retried next scan.`);
    return;
  }
  const { arrival, touch } = pricing; // arrival: slippage reference; touch: what a marketable buy pays
  if (CONFIG.limitSlippageBps > 0 && touch == null) {
    stats.failures.push(`${symbol}: no price to bound the limit order`);
    log(`${symbol}: entry skipped — no quote and no 1-minute close to bound the limit order; retried next scan.`);
    return;
  }
  // A fresh suffix per attempt: a canceled order's id can't be reused, and the
  // per-candle dedup plus the book lock already stop double entries.
  const clientId = `bot-${symbol}-${signalBoundary}-m${Math.floor(Date.now() / 60_000)}`;

  let res: EntryResult;
  if (CONFIG.orderMode === 'maker' && arrival) {
    // Passive limit at or below the bid → rests as maker (lower fee). An
    // unfilled order is canceled and retried next scan at no cost.
    const off = 1 - CONFIG.makerOffsetBps / 10_000;
    // Only the crypto book is the venue's own; an IEX stock bid can be a junk $0.01.
    const limitPrice = crypto && quote ? Math.min(quote.bid, quote.mid * off) : arrival * off;
    res = await submitPaperBuyMaker(symbol, decision.notional, limitPrice, clientId, CONFIG.makerWaitSec);
  } else if (CONFIG.limitSlippageBps > 0 && touch) {
    res = await submitPaperBuyLimit(symbol, decision.notional, touch * (1 + CONFIG.limitSlippageBps / 10_000), clientId);
  } else {
    res = await submitPaperBuy(symbol, decision.notional, clientId);
  }

  if (res.state === 'unfilled') {
    stats.unfilled.push(symbol);
    log(`${symbol}: order ${clientId} did not fill within ${CONFIG.orderTimeoutSec}s and was canceled — nothing rests at the broker; the next scan retries.`);
    return;
  }
  if (res.state === 'unknown') {
    stats.unknown.push(`${symbol} (${res.order.status})`);
    log(`${symbol}: order ${clientId} is still '${res.order.status}' after a cancel request — not recorded; the next scan sweeps it and adopts any fill.`);
    return;
  }

  const fillPrice = res.fillPrice as number;
  const slipExec = arrival ? slippageBps(fillPrice, arrival) : null;
  const slipSignal = slippageBps(fillPrice, sig.price);
  const bps = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(1);
  const notional = res.filledQty * fillPrice;
  recordEntry(riskCtx, symbol, orderKey, notional);
  const partialNote = res.state === 'partial' ? ' (partial fill; the rest was canceled)' : '';
  const ref = pricing.source;
  appendLedgerRow({
    timestamp: new Date().toISOString(),
    symbol,
    action: 'BUY',
    price: fmtPrice(sig.price),
    quantity: String(res.filledQty),
    reason:
      `[${sig.setupTag}] ${sig.reason} || broker fill ${fillPrice} qty ${res.filledQty}${partialNote}, ` +
      `slippage ${slipExec != null ? bps(slipExec) : 'n/a'} bps vs ${ref}, ` +
      `signal-drift ${bps(slipSignal)} bps vs signal close, order ${clientId}`,
    mode: 'alpaca-paper',
    outcome: 'open',
    pnl: '',
  });
  (res.state === 'partial' ? stats.partials : stats.entries).push(symbol);
  log(
    `${symbol}: REAL PAPER ORDER ${res.state} — $${notional.toFixed(2)} @ ${fillPrice}${partialNote}, ` +
      `exec slippage ${slipExec != null ? bps(slipExec) : 'n/a'} bps vs ${pricing.source}, signal-drift ${bps(slipSignal)} bps.`
  );
  log(`${symbol}: final decision BUY (alpaca-paper) — logged to ${ledgerPath()}.`);
}
