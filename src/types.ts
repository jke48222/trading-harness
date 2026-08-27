export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export type Action = 'BUY' | 'SELL' | 'HOLD' | 'SKIP';

export interface Signal {
  action: 'BUY' | 'SELL' | 'HOLD';
  /** Stable identifier for this kind of setup, e.g. "bullish-cross-9/21-5m". Used to match memory. */
  setupTag: string;
  /** Plain-English explanation — every decision must carry one. */
  reason: string;
  /** Close of the signal candle. */
  price: number;
  /** closeTime of the signal candle (ms epoch). */
  time: number;
}

export interface RiskVerdict {
  approved: boolean;
  finalAction: Action;
  reason: string;
}

export interface MemoryVerdict {
  blocked: boolean;
  reason: string;
  priorWins: number;
  priorLosses: number;
  priorPnlPct: number;
}

export interface PaperOrder {
  timestamp: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  mode: string;
  reason: string;
}

/** One row of data/ledger.csv. All fields stored as strings, exactly as written. */
export interface LedgerRow {
  timestamp: string;
  symbol: string;
  action: string;
  price: string;
  quantity: string;
  reason: string;
  mode: string;
  outcome: string;
  pnl: string;
}

export interface ReplaySetup {
  index: number;
  time: number;
  action: 'BUY' | 'SELL';
  setupTag: string;
  entryPrice: number;
  /** Close after the evaluation horizon; null when the window ends before the horizon. */
  exitPrice: number | null;
  /** Net of the configured round-trip fee assumption; null when incomplete. */
  pnlPct: number | null;
  outcome: 'win' | 'loss' | 'flat' | 'incomplete';
  reason: string;
}
