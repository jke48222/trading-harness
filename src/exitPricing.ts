import { type BrokerOrder, fetchOrdersSince } from './broker/orders';
import { ordersToFills } from './broker/fills';

/** What the broker's fills say about a trip that `order` just closed. */
export interface TripCash {
  /** VWAP of every sell of the symbol since the entry (a close that partly filled earlier counts too). */
  exitPrice: number;
  exitQty: number;
  /** Cash paid for the buys since the entry; 0 when the history is unavailable. */
  buyCost: number;
}

/**
 * Read the trip's fills from the broker: every sell and buy of the symbol
 * since a few minutes before the entry row. Falls back to the closing order's
 * own fill, with no buy cost, when the history can't be read.
 */
export async function tripCashSince(botSymbol: string, entryTimestamp: string, order: BrokerOrder): Promise<TripCash> {
  const fallback: TripCash = { exitPrice: Number(order.filled_avg_price), exitQty: Number(order.filled_qty), buyCost: 0 };
  try {
    // An entry row is written seconds after its fill; five minutes covers a slow settle.
    const since = new Date(Date.parse(entryTimestamp) - 5 * 60_000).toISOString();
    const fills = ordersToFills(await fetchOrdersSince(since)).filter((f) => f.botSymbol === botSymbol);
    const sells = fills.filter((f) => f.side === 'sell');
    const q = sells.reduce((a, f) => a + f.qty, 0);
    if (!(q > 0)) return fallback;
    return {
      exitPrice: sells.reduce((a, f) => a + f.qty * f.price, 0) / q,
      exitQty: q,
      buyCost: fills.filter((f) => f.side === 'buy').reduce((a, f) => a + f.qty * f.price, 0),
    };
  } catch {
    return fallback;
  }
}

/**
 * A round trip's return in %. Crypto is priced per unit: Alpaca takes the buy
 * fee in coin, so the sold quantity is a little smaller than the bought one,
 * and cash in vs cash out would fold that fee in. Stocks pay no commission,
 * so cash out over cash in is the honest measure, and it survives a split:
 * after a 10-for-1 split the per-share prices fall 90% but the cash does not.
 * Without the broker's buy cost, the per-share return is the fallback.
 */
export function tripReturnPct(crypto: boolean, entryFill: number, cash: TripCash): number {
  if (!crypto && cash.buyCost > 0 && cash.exitQty > 0) return ((cash.exitPrice * cash.exitQty) / cash.buyCost - 1) * 100;
  return (cash.exitPrice / entryFill - 1) * 100;
}
