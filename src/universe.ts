/**
 * Named symbol universes, so the launchd agent, the dashboard and the research
 * scripts read one list instead of each carrying its own copy.
 * Use one in SYMBOLS with an @ prefix: SYMBOLS=@book, or mix: SYMBOLS=@book-crypto,SPY.
 */

/**
 * The 32 cryptos the paper book trades: every Alpaca-tradable USD pair that
 * also has Binance USDT daily history, stablecoins excluded. Chosen by
 * availability on 2026-07-15, not by past returns.
 */
export const BOOK_CRYPTO = [
  'AAVEUSDT', 'ADAUSDT', 'ARBUSDT', 'AVAXUSDT', 'BATUSDT', 'BCHUSDT', 'BONKUSDT', 'BTCUSDT',
  'CRVUSDT', 'DOGEUSDT', 'DOTUSDT', 'ETHUSDT', 'FILUSDT', 'GRTUSDT', 'LDOUSDT', 'LINKUSDT',
  'LTCUSDT', 'ONDOUSDT', 'PAXGUSDT', 'PEPEUSDT', 'POLUSDT', 'RENDERUSDT', 'SHIBUSDT', 'SKYUSDT',
  'SOLUSDT', 'SUSHIUSDT', 'TRUMPUSDT', 'UNIUSDT', 'WIFUSDT', 'XRPUSDT', 'XTZUSDT', 'YFIUSDT',
];

/**
 * The 24 US stocks and ETFs the paper book trades: large, liquid names picked
 * on 2026-07-15. Today's megacaps were picked knowing they became megacaps,
 * so any backtest on this list is hindsight-biased (Trial 08 tests an
 * unselected ETF universe instead).
 */
export const BOOK_STOCKS = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO',
  'AMD', 'NFLX', 'JPM', 'V', 'UNH', 'XOM', 'LLY', 'COST', 'WMT', 'JNJ', 'PG', 'BAC',
];

/** Trial 07's unselected 8-crypto universe (the regime monitor recomputes it monthly). */
export const TRIAL07_CRYPTO = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'];

export const UNIVERSES: Record<string, string[]> = {
  book: [...BOOK_CRYPTO, ...BOOK_STOCKS],
  'book-crypto': BOOK_CRYPTO,
  'book-stocks': BOOK_STOCKS,
  trial07: TRIAL07_CRYPTO,
};

/** Expand a SYMBOLS value: "@book,SPY" -> the book list plus SPY, de-duplicated, order kept. */
export function expandSymbols(spec: string): string[] {
  const out: string[] = [];
  for (const raw of spec.split(',')) {
    const s = raw.trim();
    if (!s) continue;
    if (s.startsWith('@')) {
      const list = UNIVERSES[s.slice(1).toLowerCase()];
      if (!list) throw new Error(`Unknown universe '${s}' in SYMBOLS (known: ${Object.keys(UNIVERSES).map((k) => '@' + k).join(', ')}).`);
      out.push(...list);
    } else {
      out.push(s.toUpperCase());
    }
  }
  return [...new Set(out)];
}
