import type { Quote } from './broker/orders';

export type EntryPricing =
  | { kind: 'skip'; reason: string }
  | { kind: 'price'; arrival: number | null; touch: number | null; source: string };

/**
 * Where an entry's limit and its slippage reference come from.
 *
 * Crypto: Alpaca's crypto book is the market the order trades on, so its
 * quote is authoritative. A spread wider than `maxSpreadBps` means crossing
 * it costs more than a typical day's edge, so the entry is skipped. A quote
 * that has not changed for a while is still the live book on a thin pair.
 *
 * Stocks: the quote is IEX's book, one venue among many. After hours it can
 * show a $0.01 bid, and even in session it can be wider than the market. So
 * an IEX quote is used only when fresh and tight; otherwise the last 1-minute
 * close is the reference, and the stock spread never blocks an entry.
 */
export function priceEntry(input: {
  crypto: boolean;
  quote: Quote | null;
  mark: number | null;
  nowMs: number;
  maxSpreadBps: number;
  maxStockQuoteAgeMs?: number;
}): EntryPricing {
  const { crypto, quote, mark, nowMs, maxSpreadBps } = input;
  const tooWide = (q: Quote): boolean => maxSpreadBps > 0 && q.spreadBps > maxSpreadBps;
  if (crypto) {
    if (quote && tooWide(quote)) {
      return { kind: 'skip', reason: `quoted spread ${quote.spreadBps.toFixed(0)} bps (bid ${quote.bid} / ask ${quote.ask}) is wider than MAX_SPREAD_BPS ${maxSpreadBps}` };
    }
    if (quote) return { kind: 'price', arrival: quote.mid, touch: quote.ask, source: `arrival mid ${quote.mid} (spread ${quote.spreadBps.toFixed(1)} bps)` };
  } else if (quote) {
    const ageMs = nowMs - Date.parse(quote.at);
    const fresh = Number.isFinite(ageMs) && ageMs <= (input.maxStockQuoteAgeMs ?? 120_000);
    if (fresh && !tooWide(quote)) {
      return { kind: 'price', arrival: quote.mid, touch: quote.ask, source: `arrival mid ${quote.mid} (IEX spread ${quote.spreadBps.toFixed(1)} bps)` };
    }
  }
  if (mark != null && mark > 0) return { kind: 'price', arrival: mark, touch: mark, source: `arrival mark ${mark} (last 1m close)` };
  return { kind: 'price', arrival: null, touch: null, source: 'no arrival price' };
}
