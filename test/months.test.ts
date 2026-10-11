import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAY } from './helpers.ts';

// Calendar-month coverage for the monthly monitor and Trial 07.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-months-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const { completeMonths } = await import('../src/months.ts');

test('completeMonths: on the 1st the month that just ended counts (the monitor bug)', () => {
  const days = (fromIso: string, n: number): number[] => Array.from({ length: n }, (_, i) => Date.parse(fromIso) + i * DAY + DAY - 1);
  const augSep = days('2026-08-01T00:00:00Z', 61); // Aug 1 .. Sep 30
  assert.deepEqual(completeMonths(augSep, Date.parse('2026-10-01T02:00:00Z'), 0), ['2026-08', '2026-09']);
  assert.deepEqual(completeMonths(augSep, Date.parse('2026-09-30T12:00:00Z'), 0), ['2026-08'], 'September is still in progress');
  assert.deepEqual(completeMonths(days('2026-08-14T00:00:00Z', 48), Date.parse('2026-10-05T00:00:00Z'), 0), ['2026-09'], 'listing mid-August: August is partial');
  const stockDays = days('2026-08-03T00:00:00Z', 26); // Aug 3 .. Aug 28 (a Friday), weekends included for simplicity
  assert.deepEqual(completeMonths(stockDays, Date.parse('2026-09-02T00:00:00Z'), 4), ['2026-08'], 'stocks allow weekend gaps');
});
