/**
 * The dashboard's whitelisted commands. Each runs one of the bot's own npm
 * scripts with a fixed environment; nothing from the request reaches argv or
 * env except the command's name, which must be an own key of COMMANDS.
 */

/**
 * The hourly book agent's settings, copied from
 * ops/launchd/com.jalenedusei.trading.tsmom-daily.plist so "Scan the book now"
 * runs the same scan the agent runs: the @book universe (src/universe.ts), its
 * heartbeat label, the entry window and the fill cap. test/dashboard.test.ts
 * fails if this drifts from the plist (an ENTRY_SKIP added there, say).
 */
export const BOOK_ENV: Readonly<Record<string, string>> = Object.freeze({
  RUN_LABEL: 'book',
  SYMBOLS: '@book',
  EXECUTION: 'alpaca-paper',
  TSMOM_STATE: 'on',
  LONG_ONLY: 'on',
  STRATEGY: 'tsmom',
  INTERVAL: '1d',
  TSMOM_LOOKBACK: '28',
  EVAL_HORIZON: '28',
  FEE_BPS: '30',
  BUDGET: '100000',
  PER_TRADE_USD: '2000',
  MAX_OPEN_POSITIONS: '50',
  ENTRY_WINDOW_MIN: '120',
  LIMIT_SLIPPAGE_BPS: '30',
});

export interface Command {
  label: string;
  args: string[];
  env: Readonly<Record<string, string>>;
}

export const COMMANDS: Readonly<Record<string, Command>> = Object.freeze({
  'scan-book': {
    label: "Scan the book now (real paper orders, the hourly agent's settings)",
    args: ['run', 'scan'],
    env: BOOK_ENV,
  },
  'score-daily': {
    label: 'Score matured daily trades',
    args: ['run', 'score'],
    env: { STRATEGY: 'tsmom', INTERVAL: '1d', TSMOM_LOOKBACK: '28', EVAL_HORIZON: '28', FEE_BPS: '30' },
  },
  monitor: { label: 'Recompute regime monitor', args: ['run', 'tsmom:monitor'], env: {} },
});

/** An own key of COMMANDS: "constructor" or "__proto__" never reach execFile. */
export function isCommand(name: unknown): name is string {
  return typeof name === 'string' && Object.hasOwn(COMMANDS, name);
}

/**
 * The KEY=VALUE settings of one agent run in a launchd plist's shell command,
 * picked by its RUN_LABEL ("cd __ROOT__ || exit 1; RUN_LABEL=book SYMBOLS=@book ...
 * __NPM__ run scan >> data/tsmom-scan.log 2>&1; RUN_LABEL=watch-flip ..."). Null
 * when no run carries that label.
 */
export function plistRunEnv(plist: string, runLabel: string): Record<string, string> | null {
  const text = plist.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  for (const segment of text.split(/;|<\/?string>/)) {
    const tokens = segment.trim().split(/\s+/);
    if (tokens[0] !== `RUN_LABEL=${runLabel}`) continue;
    const env: Record<string, string> = {};
    for (const t of tokens) {
      const m = t.match(/^([A-Z][A-Z0-9_]*)=(\S*)$/);
      if (!m) break;
      env[m[1]] = m[2];
    }
    return env;
  }
  return null;
}
