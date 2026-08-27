import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG } from './config';
import type { BrokerAccount, BrokerPosition } from './broker/orders';
import type { Candle } from './types';

/**
 * Portfolio-level risk controls — the brakes the project was missing.
 * Pure, testable functions plus a tiny JSON state file for day-start equity.
 * Nothing here can place or cancel an order; it only decides sizing and whether
 * a NEW entry is allowed. Exits are never blocked (you must always be able to
 * reduce risk).
 */

interface RiskState {
  utcDay: string;
  dayStartEquity: number;
}

function statePath(): string {
  return path.join(CONFIG.dataDir, 'risk_state.json');
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The equity the account started the current UTC day with. Initializes (and
 * rolls over) on the first call of a new day. `nowMs` is injectable for tests.
 */
export function dayStartEquity(currentEquity: number, nowMs: number = Date.now()): number {
  const day = utcDay(nowMs);
  let state: RiskState | null = null;
  try {
    state = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as RiskState;
  } catch {
    /* first run */
  }
  if (!state || state.utcDay !== day || !Number.isFinite(state.dayStartEquity)) {
    state = { utcDay: day, dayStartEquity: currentEquity };
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  }
  return state.dayStartEquity;
}

export interface DailyLoss {
  halted: boolean;
  dayStart: number;
  pnlPct: number;
  reason: string;
}

/** Daily-loss kill switch: halt new entries once the account is down > MAX_DAILY_LOSS_PCT on the day. */
export function dailyLossHalt(account: BrokerAccount, nowMs: number = Date.now()): DailyLoss {
  const equity = Number(account.equity);
  const start = dayStartEquity(equity, nowMs);
  const pnlPct = start > 0 ? ((equity - start) / start) * 100 : 0;
  const halted = pnlPct <= -CONFIG.maxDailyLossPct;
  return {
    halted,
    dayStart: start,
    pnlPct,
    reason: halted
      ? `Daily-loss kill switch ACTIVE: account down ${pnlPct.toFixed(2)}% today (limit ${CONFIG.maxDailyLossPct}%). New entries halted; exits still run.`
      : `Daily P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (halt at -${CONFIG.maxDailyLossPct}%).`,
  };
}

/** Realized daily volatility (%) from the last `window` closes. */
export function realizedVolPct(candles: Candle[], window = 20): number {
  const closes = candles.slice(-window - 1).map((c) => c.close);
  if (closes.length < 3) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, r) => a + (r - m) * (r - m), 0) / (rets.length - 1);
  return Math.sqrt(v) * 100;
}

/**
 * Volatility-scaled notional: a 4%/day coin and a 40%/day coin should risk
 * similar dollars. Scales perTradeUsd by clamp(volTarget/realizedVol, floor, 1)
 * — never above perTradeUsd (budget discipline), never below the floor (or the
 * Alpaca $10 minimum, whichever is larger in effect).
 */
export function volScaledNotional(candles: Candle[]): { notional: number; vol: number; frac: number } {
  const vol = realizedVolPct(candles);
  if (!Number.isFinite(vol) || vol <= 0) return { notional: CONFIG.perTradeUsd, vol: NaN, frac: 1 };
  const frac = Math.min(1, Math.max(CONFIG.volSizeFloor, CONFIG.volTargetPct / vol));
  return { notional: Math.round(CONFIG.perTradeUsd * frac * 100) / 100, vol, frac };
}

export function isCrypto(symbol: string): boolean {
  return symbol.endsWith('USDT') || (symbol.endsWith('USD') && symbol.length > 4);
}

/** Running risk context for one scan: snapshot at start, tallies incremented as entries fill. */
export interface RiskContext {
  entriesHalted: boolean;
  haltReason: string;
  dailyPnlPct: number;
  deployed: number;
  cryptoDeployed: number;
  openCount: number;
  openSymbols: Set<string>; // broker-normalized (no slash)
}

export function buildRiskContext(account: BrokerAccount, positions: BrokerPosition[], nowMs: number = Date.now()): RiskContext {
  const halt = dailyLossHalt(account, nowMs);
  let deployed = 0;
  let cryptoDeployed = 0;
  const openSymbols = new Set<string>();
  for (const p of positions) {
    const v = Math.abs(Number(p.market_value));
    deployed += v;
    if (isCrypto(p.symbol)) cryptoDeployed += v;
    openSymbols.add(p.symbol.replace('/', ''));
  }
  return {
    entriesHalted: halt.halted,
    haltReason: halt.reason,
    dailyPnlPct: halt.pnlPct,
    deployed,
    cryptoDeployed,
    openCount: positions.length,
    openSymbols,
  };
}

export interface EntryDecision {
  allowed: boolean;
  notional: number;
  reason: string;
}

/** Every gate a NEW entry must clear, in one place. `candles` sizes the position; ctx carries running tallies. */
export function evaluateEntry(botSymbol: string, orderSymbolNoSlash: string, candles: Candle[], ctx: RiskContext): EntryDecision {
  const deny = (reason: string): EntryDecision => ({ allowed: false, notional: 0, reason });
  if (ctx.entriesHalted) return deny(ctx.haltReason);
  if (ctx.openSymbols.has(orderSymbolNoSlash)) return deny('position already open — no pyramiding.');
  if (ctx.openCount >= CONFIG.maxOpenPositions) return deny(`${ctx.openCount}/${CONFIG.maxOpenPositions} position slots full.`);

  const { notional, vol, frac } = volScaledNotional(candles);
  if (notional < 10) return deny(`vol-scaled notional $${notional.toFixed(2)} below the $10 Alpaca minimum.`);
  if (ctx.deployed + notional > CONFIG.budgetUsd) return deny(`would exceed the $${CONFIG.budgetUsd.toLocaleString()} budget ($${ctx.deployed.toFixed(0)} deployed).`);
  if (isCrypto(botSymbol)) {
    const cap = (CONFIG.cryptoClusterCapPct / 100) * CONFIG.budgetUsd;
    if (ctx.cryptoDeployed + notional > cap) {
      return deny(`crypto cluster cap: $${ctx.cryptoDeployed.toFixed(0)} + $${notional.toFixed(0)} would exceed ${CONFIG.cryptoClusterCapPct}% of budget ($${cap.toFixed(0)}) — crypto is correlated, so it's capped as one bet.`);
    }
  }
  const volNote = Number.isFinite(vol) ? ` (vol ${vol.toFixed(1)}%/day → ${(frac * 100).toFixed(0)}% size)` : '';
  return { allowed: true, notional, reason: `entry approved: $${notional.toFixed(2)}${volNote}.` };
}

/** Record a fill into the running context so later symbols in the same scan see it. */
export function recordEntry(ctx: RiskContext, botSymbol: string, orderSymbolNoSlash: string, notional: number): void {
  ctx.deployed += notional;
  if (isCrypto(botSymbol)) ctx.cryptoDeployed += notional;
  ctx.openCount += 1;
  ctx.openSymbols.add(orderSymbolNoSlash);
}
