/**
 * The state construction's rule, as a vote across lookbacks with a band
 * between entry and exit (Trial 09). Trial 07's rule is the one-lookback case:
 * lookbacks [28], enter at 1 vote, exit at 0.
 *
 * Every decision that depends on the rule reads it from here: entries
 * (strategy.ts), exits and the re-entry wait after a stop (bot.ts,
 * portfolioRisk.ts), scoring (scoring.ts, from each row's tag) and the tag
 * reconcile gives an adopted fill. No config import, so tests can build rules
 * freely.
 */

export interface VoteRule {
  /** Lookbacks in candles (trading sessions for stocks). */
  lookbacks: number[];
  /** From flat, go long when at least this many lookbacks are positive. */
  enter: number;
  /** From long, go flat when this many or fewer are positive. */
  exit: number;
}

/**
 * How many lookbacks have close_i / close_{i-L} - 1 > 0. The caller ensures
 * i >= the longest lookback. A missing or unreadable close throws: counted as
 * "not positive" it would read as an exit and sell the position.
 */
export function votesAt(closes: number[], i: number, lookbacks: number[]): number {
  if (!(closes[i] > 0)) throw new Error(`unreadable close (${closes[i]}) at candle ${i}`);
  let votes = 0;
  for (const L of lookbacks) {
    const past = closes[i - L];
    if (!(past > 0)) throw new Error(`unreadable close (${past}) at candle ${i - L}`);
    if (closes[i] / past - 1 > 0) votes++;
  }
  return votes;
}

/**
 * The rule's own position at candle `index`, run over the closes it has
 * (flat until the longest lookback exists): from flat, long at the entry
 * count; from long, flat at the exit count. `since` is the candle where the
 * current long began, or null when flat. The book buys whenever this is long
 * and it holds nothing, so an entry it missed (no cash, a closed window, the
 * Mac asleep) is made at the next chance, as Trial 09's backtest assumes.
 */
export function ruleStateAt(closes: number[], index: number, rule: VoteRule): { long: boolean; since: number | null } {
  let long = false;
  let since: number | null = null;
  for (let i = maxLookback(rule); i <= index; i++) {
    const votes = votesAt(closes, i, rule.lookbacks);
    if (!long && votes >= rule.enter) {
      long = true;
      since = i;
    } else if (long && votes <= rule.exit) {
      long = false;
      since = null;
    }
  }
  return { long, since };
}

/** Which rule wrote a state exit's reason: 'single' (Trial 07), 'vote', or null for any other exit. */
export function exitRuleKind(reason: string): 'single' | 'vote' | null {
  if (/lookbacks positive, at or below the exit count of \d+ — state exit/.test(reason)) return 'vote';
  if (/momentum flipped non-positive .*— state exit/.test(reason)) return 'single';
  return null;
}

export function maxLookback(rule: VoteRule): number {
  return Math.max(...rule.lookbacks);
}

/** Trial 07's rule: one lookback, enter at 1, exit at 0. Its tags keep their original form. */
export function isSingleLookback(rule: VoteRule): boolean {
  return rule.lookbacks.length === 1 && rule.enter === 1 && rule.exit === 0;
}

/** The tag stem: "tsmom28-1d" for Trial 07's rule, "tsmom7/14/28/56-in3out1-1d" for a vote. */
export function ruleTagBase(rule: VoteRule, interval: string): string {
  if (isSingleLookback(rule)) return `tsmom${rule.lookbacks[0]}-${interval}`;
  return `tsmom${rule.lookbacks.join('/')}-in${rule.enter}out${rule.exit}-${interval}`;
}

/** The setup tag of a state entry under this rule. */
export function stateTag(rule: VoteRule, interval: string): string {
  return `${ruleTagBase(rule, interval)}-state-long`;
}

/** The rule a state tag was entered under, or null for any other tag. */
export function ruleOfStateTag(tag: string | null): VoteRule | null {
  const m = tag?.match(/^tsmom(\d+(?:\/\d+)*)(?:-in(\d+)out(\d+))?-\w+-state-long$/);
  if (!m) return null;
  const lookbacks = m[1].split('/').map(Number);
  if (m[2] === undefined) return lookbacks.length === 1 ? { lookbacks, enter: 1, exit: 0 } : null;
  return { lookbacks, enter: Number(m[2]), exit: Number(m[3]) };
}

/** Why a configured rule can't run, or null when it can. */
export function ruleProblem(rule: VoteRule): string | null {
  const n = rule.lookbacks.length;
  if (n === 0) return 'the rule needs at least one lookback';
  if (rule.lookbacks.some((L) => !Number.isInteger(L) || L < 2)) return 'every lookback must be a whole number of at least 2';
  if (new Set(rule.lookbacks).size !== n) return 'lookbacks must be distinct';
  if (!Number.isInteger(rule.enter) || rule.enter < 1 || rule.enter > n) return `the entry vote count must be 1 to ${n}`;
  if (!Number.isInteger(rule.exit) || rule.exit < 0 || rule.exit >= rule.enter) return 'the exit vote count must be at least 0 and below the entry count';
  return null;
}

/** The rule in words, for log lines and ledger reasons. */
export function describeRule(rule: VoteRule): string {
  if (isSingleLookback(rule)) return `the trailing ${rule.lookbacks[0]}-candle return`;
  return `votes over ${rule.lookbacks.join('/')} candles (enter at ${rule.enter}, exit at ${rule.exit} or fewer)`;
}
