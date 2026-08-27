import type { RiskVerdict, Signal } from './types';
import { CONFIG } from './config';

/**
 * Approves or rejects a proposed paper order. Every verdict carries a
 * plain-English reason. `currentPosition` is the bot's paper position in
 * base units (BTC for BTCUSDT), derived from the ledger.
 */
export function checkRisk(
  signal: Signal,
  currentPosition: number,
  quantity: number = CONFIG.quantity,
  maxPosition: number = CONFIG.maxPosition
): RiskVerdict {
  if (signal.action === 'HOLD') {
    return { approved: false, finalAction: 'HOLD', reason: signal.reason };
  }
  if (quantity <= 0) {
    return {
      approved: false,
      finalAction: 'SKIP',
      reason: `Configured quantity ${quantity} is not positive — nothing to trade.`,
    };
  }
  if (quantity > maxPosition) {
    return {
      approved: false,
      finalAction: 'SKIP',
      reason: `Order quantity ${quantity} exceeds max position ${maxPosition} — SKIP per risk rules.`,
    };
  }
  if (signal.action === 'BUY' && currentPosition + quantity > maxPosition) {
    return {
      approved: false,
      finalAction: 'SKIP',
      reason: `Buying ${quantity} would push the paper position to ${(currentPosition + quantity).toFixed(8)}, above max position ${maxPosition} — SKIP.`,
    };
  }
  if (signal.action === 'SELL' && currentPosition - quantity < -maxPosition) {
    return {
      approved: false,
      finalAction: 'SKIP',
      reason: `Selling ${quantity} would push the paper position to ${(currentPosition - quantity).toFixed(8)}, beyond max short ${-maxPosition} — SKIP.`,
    };
  }
  return {
    approved: true,
    finalAction: signal.action,
    reason: `Quantity ${quantity} keeps the paper position within max ${maxPosition} — ${signal.action} approved.`,
  };
}
