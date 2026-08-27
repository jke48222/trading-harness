import type { Candle, Signal } from './types';
import { CONFIG } from './config';

/** Simple moving average of the `period` closes ending at endIndex (inclusive). */
export function sma(closes: number[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period || endIndex >= closes.length) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += closes[i];
  return sum / period;
}

/** Dispatch to the configured strategy. Every strategy sees closed candles only. */
export function signalAt(candles: Candle[], index: number): Signal {
  if (CONFIG.strategyName === 'donchian-breakout') return donchianSignalAt(candles, index);
  if (CONFIG.strategyName === 'tsmom') return tsmomSignalAt(candles, index);
  return smaCrossSignalAt(candles, index);
}

/**
 * Trial 04: time-series momentum sign-flip on closed candles (pre-registered
 * in docs/trial_04_tsmom_daily.md). BUY when the trailing L-candle return
 * crosses from non-positive to positive, SELL on the mirror flip (suppressed
 * by LONG_ONLY). Fresh flips only — no signal while the sign is unchanged.
 */
export function tsmomSignalAt(candles: Candle[], index: number): Signal {
  const { tsmomLookback: L, longOnly, interval } = CONFIG;
  const price = candles[index].close;
  const time = candles[index].closeTime;
  if (index < L + 1) {
    return {
      action: 'HOLD',
      setupTag: 'warmup',
      reason: `Not enough closed candles yet for a ${L}-candle momentum lookback.`,
      price,
      time,
    };
  }
  const momNow = price / candles[index - L].close - 1;
  const momPrev = candles[index - 1].close / candles[index - 1 - L].close - 1;
  const tagBase = `tsmom${L}-${interval}`;
  const pct = (x: number): string => (x * 100).toFixed(2) + '%';

  // Trial 07 state construction: long WHENEVER momentum is positive (the
  // broker's no-pyramiding check turns this into "enter once, hold while
  // positive"); exits are handled by the state-exit manager in bot.ts.
  if (CONFIG.tsmomState) {
    if (momNow > 0) {
      return {
        action: 'BUY',
        setupTag: `${tagBase}-state-long`,
        reason: `Trailing ${L}-candle return is positive (${pct(momNow)}) — state construction holds long while momentum is positive.`,
        price,
        time,
      };
    }
    return {
      action: 'HOLD',
      setupTag: 'state-flat',
      reason: `HOLD: trailing ${L}-candle return is ${pct(momNow)} — state construction stays flat while momentum is non-positive.`,
      price,
      time,
    };
  }

  if (momPrev <= 0 && momNow > 0) {
    return {
      action: 'BUY',
      setupTag: `${tagBase}-flip-long`,
      reason: `Trailing ${L}-candle return flipped positive (${pct(momPrev)} -> ${pct(momNow)}) — momentum turned up.`,
      price,
      time,
    };
  }
  if (momPrev >= 0 && momNow < 0 && !longOnly) {
    return {
      action: 'SELL',
      setupTag: `${tagBase}-flip-short`,
      reason: `Trailing ${L}-candle return flipped negative (${pct(momPrev)} -> ${pct(momNow)}) — momentum turned down.`,
      price,
      time,
    };
  }
  return {
    action: 'HOLD',
    setupTag: 'no-flip',
    reason: `HOLD: trailing ${L}-candle return is ${pct(momNow)} with no fresh sign flip on this candle.`,
    price,
    time,
  };
}

/**
 * Trial 03: Donchian-20 breakout on closed candles (pre-registered in
 * docs/trial_03_donchian_breakout.md).
 * BUY when close crosses above the prior N-candle high (fresh cross only),
 * SELL when close crosses below the prior N-candle low. Optional same-TF
 * SMA trend alignment (v2) and long-only mode (v3).
 */
export function donchianSignalAt(candles: Candle[], index: number): Signal {
  const { donchianLen, trendAlign, trendMa, longOnly, interval } = CONFIG;
  const price = candles[index].close;
  const time = candles[index].closeTime;
  const warmup = Math.max(donchianLen + 1, trendAlign ? trendMa : 0);
  if (index < warmup) {
    return {
      action: 'HOLD',
      setupTag: 'warmup',
      reason: `Not enough closed candles yet for a ${donchianLen}-candle channel${trendAlign ? ` plus SMA${trendMa} trend` : ''}.`,
      price,
      time,
    };
  }

  const hiOver = (end: number): number => {
    let h = -Infinity;
    for (let i = end - donchianLen; i < end; i++) h = Math.max(h, candles[i].high);
    return h;
  };
  const loOver = (end: number): number => {
    let l = Infinity;
    for (let i = end - donchianLen; i < end; i++) l = Math.min(l, candles[i].low);
    return l;
  };

  const hiPrev = hiOver(index);
  const loPrev = loOver(index);
  const longBreak = price > hiPrev && candles[index - 1].close <= hiOver(index - 1);
  const shortBreak = price < loPrev && candles[index - 1].close >= loOver(index - 1);
  const tagBase = `donchian${donchianLen}-${interval}`;

  let trendSma: number | null = null;
  if (trendAlign) {
    trendSma = sma(candles.map((c) => c.close), trendMa, index);
    if (trendSma === null) {
      return { action: 'HOLD', setupTag: 'warmup', reason: `Not enough candles for SMA${trendMa}.`, price, time };
    }
  }

  if (longBreak && (!trendAlign || price > (trendSma as number))) {
    return {
      action: 'BUY',
      setupTag: `${tagBase}-breakout-long`,
      reason:
        `Close ${price.toFixed(2)} broke above the prior ${donchianLen}-candle high ${hiPrev.toFixed(2)}` +
        (trendAlign ? ` with price above SMA${trendMa} ${(trendSma as number).toFixed(2)}` : '') +
        ' — fresh upside breakout.',
      price,
      time,
    };
  }
  if (shortBreak && !longOnly && (!trendAlign || price < (trendSma as number))) {
    return {
      action: 'SELL',
      setupTag: `${tagBase}-breakout-short`,
      reason:
        `Close ${price.toFixed(2)} broke below the prior ${donchianLen}-candle low ${loPrev.toFixed(2)}` +
        (trendAlign ? ` with price below SMA${trendMa} ${(trendSma as number).toFixed(2)}` : '') +
        ' — fresh downside breakout.',
      price,
      time,
    };
  }
  const why = longBreak || shortBreak ? 'a breakout occurred but the variant rules (trend/long-only) decline it' : 'no fresh breakout of the prior channel on this candle';
  return { action: 'HOLD', setupTag: 'no-breakout', reason: `HOLD: ${why}.`, price, time };
}

/**
 * 9/21 moving-average crossover on closed candles.
 * BUY when the fast MA crosses above the slow MA, SELL when it crosses below,
 * HOLD when there is no fresh crossover on this candle.
 */
export function smaCrossSignalAt(candles: Candle[], index: number): Signal {
  const closes = candles.map((c) => c.close);
  const { fastPeriod, slowPeriod, interval } = CONFIG;
  const price = candles[index].close;
  const time = candles[index].closeTime;

  const fastNow = sma(closes, fastPeriod, index);
  const slowNow = sma(closes, slowPeriod, index);
  const fastPrev = sma(closes, fastPeriod, index - 1);
  const slowPrev = sma(closes, slowPeriod, index - 1);

  if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) {
    return {
      action: 'HOLD',
      setupTag: 'warmup',
      reason: `Not enough candles yet to compute the ${slowPeriod}-period MA on this and the previous candle.`,
      price,
      time,
    };
  }

  const tagBase = `${fastPeriod}/${slowPeriod}-${interval}`;
  if (fastPrev <= slowPrev && fastNow > slowNow) {
    return {
      action: 'BUY',
      setupTag: `bullish-cross-${tagBase}`,
      reason: `Fast ${fastPeriod}MA (${fastNow.toFixed(2)}) crossed above slow ${slowPeriod}MA (${slowNow.toFixed(2)}) — momentum turning up.`,
      price,
      time,
    };
  }
  if (fastPrev >= slowPrev && fastNow < slowNow) {
    return {
      action: 'SELL',
      setupTag: `bearish-cross-${tagBase}`,
      reason: `Fast ${fastPeriod}MA (${fastNow.toFixed(2)}) crossed below slow ${slowPeriod}MA (${slowNow.toFixed(2)}) — momentum turning down.`,
      price,
      time,
    };
  }

  const side = fastNow > slowNow ? 'above' : 'below';
  return {
    action: 'HOLD',
    setupTag: 'no-cross',
    reason: `No fresh crossover: fast MA is ${side} slow MA and was already ${side} on the previous candle.`,
    price,
    time,
  };
}

export function latestSignal(candles: Candle[]): Signal {
  return signalAt(candles, candles.length - 1);
}
