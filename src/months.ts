/** Calendar month key (YYYY-MM, UTC) of a timestamp. */
export function ymOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function daysInMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Months fully covered by a daily return series, given the close time of each
 * day that has a return (sorted ascending). The first month counts only if
 * returns start within `maxGapDays` of its 1st; the last only if it is over
 * (before the current month) and returns reach within `maxGapDays` of its end.
 * Crypto trades every day, so 0; US stocks need ~4 for weekends and holidays.
 *
 * This replaces keys.slice(1, -1), which always dropped the last month. Run
 * on the 1st, that threw away the month that had just finished, so the
 * monitor reported a month late.
 */
export function completeMonths(returnDayCloseTimes: number[], nowMs: number, maxGapDays: number): string[] {
  if (returnDayCloseTimes.length === 0) return [];
  const months = [...new Set(returnDayCloseTimes.map(ymOf))].sort();
  const first = returnDayCloseTimes[0];
  const last = returnDayCloseTimes[returnDayCloseTimes.length - 1];
  const out = [...months];
  if (new Date(first).getUTCDate() - 1 > maxGapDays) out.shift();
  const lastMonth = ymOf(last);
  const lastIncomplete = lastMonth >= ymOf(nowMs) || daysInMonth(last) - new Date(last).getUTCDate() > maxGapDays;
  if (lastIncomplete && out[out.length - 1] === lastMonth) out.pop();
  return out;
}
