import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAY, iso, mockFetch, row } from './helpers.ts';

// Forward scoring: the state construction's own exit rule, and re-scoring of old fixed-horizon rows.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scoring-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const memory = await import('../src/memory.ts');
const { stateExitIndex, stateLookbackOf, scoreMaturedScanTrades } = await import('../src/scoring.ts');

test('stateExitIndex: the first candle after entry with non-positive trailing momentum', () => {
  // L=3. Entry at 4. mom[5]=12/10>0, mom[6]=11/11=0 -> exit at 6.
  const closes = [10, 10, 10, 11, 12, 12, 11, 9];
  assert.equal(stateExitIndex(closes, 4, 3), 6);
  assert.equal(stateExitIndex([1, 2, 3, 4, 5, 6], 3, 3), null, 'still positive: model trade open');
  assert.equal(stateLookbackOf('tsmom28-1d-state-long'), 28);
  assert.equal(stateLookbackOf('tsmom28-1d-flip-long'), null);
});

test('scoring: a state row exits on the momentum flip, and an old fixed-horizon score is re-scored with disclosure', async () => {
  memory.resetMemory();
  // Daily candles: closes chosen so the L=3 state model enters at index 4 and exits at index 6.
  const start = Date.parse('2026-09-01T00:00:00Z');
  const closes = [10, 10, 10, 11, 12, 12, 11, 9, 9, 9];
  const klines = closes.map((c, i) => [start + i * DAY, String(c), String(c), String(c), String(c), '1', start + (i + 1) * DAY - 1]);
  const entryTs = iso(start + 5 * DAY + 3_600_000); // scan an hour after candle 4 closed
  memory.appendLedgerRow(row({ timestamp: entryTs, symbol: 'ETHUSDT', price: '12.0000', reason: '[tsmom3-1d-state-long] up || broker fill 12.1 qty 1, order bot-ETHUSDT-1' }));
  memory.appendLedgerRow(
    row({ timestamp: iso(start + 5 * DAY + 3_700_000), symbol: 'SOLUSDT', price: '12.0000', reason: '[tsmom3-1d-state-long] up || broker fill 12 qty 1, order bot-SOLUSDT-1', outcome: 'win', pnl: '5.0000' })
  );
  const m = mockFetch(() => ({ body: klines }));
  try {
    await scoreMaturedScanTrades(() => {});
  } finally {
    m.restore();
  }
  const [eth, sol] = memory.loadLedger();
  assert.equal(eth.outcome, 'loss', '12 -> 11 is -8.33% before the 30 bps fee');
  assert.equal(eth.pnl, (((11 - 12) / 12) * 100 - 0.3).toFixed(4));
  assert.match(eth.reason, /\|\| model: state exit 2026-09-07 at 11$/);
  assert.equal(sol.outcome, 'loss');
  assert.match(sol.reason, /re-scored .*fixed 2-candle horizon had given 5\.0000%/);
});
