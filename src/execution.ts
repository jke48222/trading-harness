import { LIVE_TRADING_ENABLED } from './config';
import type { PaperOrder } from './types';

/**
 * Paper execution only. This module has no network access and no broker
 * endpoints — it can only pretend, loudly. Broker/MCP integration stays a
 * future adapter until a connection is verified in paper/test mode.
 */
export function simulatePaperOrder(input: {
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  mode: string;
  reason: string;
}): PaperOrder {
  if (LIVE_TRADING_ENABLED as boolean) {
    // Even if someone flips the flag, there is no live code path to call.
    throw new Error('Live trading is not implemented in this project. Paper only.');
  }
  return {
    timestamp: new Date().toISOString(),
    symbol: input.symbol,
    action: input.action,
    price: input.price,
    quantity: input.quantity,
    mode: input.mode,
    reason: input.reason,
  };
}
