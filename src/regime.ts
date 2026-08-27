import type { Candle } from './types';
import { CONFIG } from './config';

/**
 * Higher-timeframe regime (Trial 02, pre-registered in
 * docs/trial_02_htf_regime_filter.md): the trend is read from the last CLOSED
 * HTF candle at or before the signal time — never the forming one, so the
 * regime can never repaint.
 */

export type Regime = 'up' | 'down' | 'none';

export interface RegimeVerdict {
  regime: Regime;
  reason: string;
}

export function regimeAt(htfCandles: Candle[], atMs: number, maPeriod: number = CONFIG.htfMa): RegimeVerdict {
  let idx = -1;
  for (let i = htfCandles.length - 1; i >= 0; i--) {
    if (htfCandles[i].closeTime <= atMs) {
      idx = i;
      break;
    }
  }
  if (idx < maPeriod - 1) {
    return {
      regime: 'none',
      reason: `Not enough closed ${CONFIG.htfInterval} candles for SMA(${maPeriod}) at this time — no regime, entry not taken (conservative).`,
    };
  }
  let sum = 0;
  for (let i = idx - maPeriod + 1; i <= idx; i++) sum += htfCandles[i].close;
  const ma = sum / maPeriod;
  const close = htfCandles[idx].close;
  if (close > ma) {
    return {
      regime: 'up',
      reason: `${CONFIG.htfInterval} close ${close.toFixed(2)} > SMA${maPeriod} ${ma.toFixed(2)} — uptrend regime.`,
    };
  }
  if (close < ma) {
    return {
      regime: 'down',
      reason: `${CONFIG.htfInterval} close ${close.toFixed(2)} < SMA${maPeriod} ${ma.toFixed(2)} — downtrend regime.`,
    };
  }
  return { regime: 'none', reason: `${CONFIG.htfInterval} close equals SMA${maPeriod} exactly — no regime.` };
}

/** Pre-registered gate: BUY only in an uptrend, SELL only in a downtrend. */
export function regimeAllows(action: 'BUY' | 'SELL', regime: Regime): boolean {
  return (action === 'BUY' && regime === 'up') || (action === 'SELL' && regime === 'down');
}
