import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAY, iso, mockFetch, row } from './helpers.ts';

// Forward scoring: the state construction's own exit rule, its cost per sleeve, and re-scoring
// of rows scored under older models. CONFIG is frozen at import, so the env is set first.
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
const { stateExitIndex, stateLookbackOf, scoreMaturedScanTrades, rowCostBps } = await import('../src/scoring.ts');

test('stateExitIndex: the first candle after entry with non-positive trailing momentum', () => {
  // L=3. Entry at 4. mom[5]=12/10>0, mom[6]=11/11=0 -> exit at 6.
  const closes = [10, 10, 10, 11, 12, 12, 11, 9];
  assert.equal(stateExitIndex(closes, 4, 3), 6);
  assert.equal(stateExitIndex([1, 2, 3, 4, 5, 6], 3, 3), null, 'still positive: model trade open');
  assert.equal(stateExitIndex([1, 2, 3, 4], 0, 3), 'insufficient', 'too little history before the entry is reported, not skipped');
  assert.equal(stateLookbackOf('tsmom28-1d-state-long'), 28);
  assert.equal(stateLookbackOf('tsmom28-1d-flip-long'), null);
});

test('rowCostBps: real paper rows pay their sleeve cost, simulated rows the run cost', () => {
  assert.equal(rowCostBps(row({ symbol: 'ETHUSDT', mode: 'alpaca-paper' })), 60);
  assert.equal(rowCostBps(row({ symbol: 'SPY', mode: 'alpaca-paper' })), 10);
  assert.equal(rowCostBps(row({ symbol: 'ETHUSDT', mode: 'scan' })), 30);
});

const start = Date.parse('2026-09-01T00:00:00Z');
function klinesFor(closes: number[]): unknown[] {
  return closes.map((c, i) => [start + i * DAY, String(c), String(c), String(c), String(c), '1', start + (i + 1) * DAY - 1]);
}

test('scoring: a state row exits on the momentum flip at its sleeve cost; older scores are re-scored with disclosure', async () => {
  memory.resetMemory();
  // L=3: the state model enters at index 4 and exits at index 6.
  const closes = [10, 10, 10, 11, 12, 12, 11, 9, 9, 9];
  const entryTs = iso(start + 5 * DAY + 3_600_000); // scanned an hour after candle 4 closed
  memory.appendLedgerRow(row({ timestamp: entryTs, symbol: 'ETHUSDT', price: '12.0000', reason: '[tsmom3-1d-state-long] up || broker fill 12.1 qty 1, order bot-ETHUSDT-1' }));
  memory.appendLedgerRow(
    row({ timestamp: iso(start + 5 * DAY + 3_700_000), symbol: 'SOLUSDT', price: '12.0000', reason: '[tsmom3-1d-state-long] up || broker fill 12 qty 1, order bot-SOLUSDT-1', outcome: 'win', pnl: '5.0000' })
  );
  memory.appendLedgerRow(
    row({ timestamp: iso(start + 5 * DAY + 3_800_000), symbol: 'ADAUSDT', price: '12.0000', reason: '[tsmom3-1d-state-long] up || broker fill 12 qty 1, order bot-ADAUSDT-1 || model: state exit 2026-09-07 at 11', outcome: 'loss', pnl: '-8.6333' })
  );
  const m = mockFetch(() => ({ body: klinesFor(closes) }));
  try {
    await scoreMaturedScanTrades(() => {});
  } finally {
    m.restore();
  }
  const [eth, sol, ada] = memory.loadLedger();
  const expected = (((11 - 12) / 12) * 100 - 0.6).toFixed(4);
  assert.equal(eth.outcome, 'loss');
  assert.equal(eth.pnl, expected, '12 -> 11 is -8.33% before the 60 bps crypto cost');
  assert.match(eth.reason, /\|\| model v2: state exit 2026-09-07 at 11, net of 60 bps$/);
  assert.equal(sol.pnl, expected);
  assert.match(sol.reason, /re-scored .* under model v2; the fixed 2-candle horizon had given 5\.0000%\)$/);
  assert.equal(ada.pnl, expected, 'a v1 row is re-scored at the sleeve cost');
  assert.match(ada.reason, /model v2: state exit 2026-09-07 at 11, net of 60 bps \(re-scored .* under model v2; was -8\.6333%\)$/);
});

test('scoring: a stock state row fetches enough sessions to test the very next session (the lookback-window bug)', async () => {
  memory.resetMemory();
  const L = 28;
  // Weekday-only bars stamped 04:00 UTC, as Alpaca stamps daily bars.
  const lastDay = Math.floor(Date.now() / DAY) * DAY - 2 * DAY;
  const days: number[] = [];
  for (let d = lastDay - 200 * DAY; d <= lastDay; d += DAY) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d);
  }
  const closes = days.map((_, i) => 100 + 0.2 * i); // momentum positive everywhere...
  let E = days.length - 16;
  closes[E + 1] = closes[E + 1 - L] - 0.5; // ...except the session right after the entry
  const bars = days.map((d, i) => ({ t: new Date(d + 4 * 3_600_000).toISOString(), o: closes[i], h: closes[i], l: closes[i], c: closes[i], v: 1 }));
  const rowTs = iso(days[E + 1] + 14 * 3_600_000); // entered at the next session, 14:00 UTC
  memory.appendLedgerRow(row({ timestamp: rowTs, symbol: 'SPY', price: closes[E].toFixed(2), reason: `[tsmom${L}-1d-state-long] up || broker fill 1 qty 1, order bot-SPY-1` }));
  // CONFIG.tsmomLookback is 3 in this file, but scoring reads L from the row's tag.
  const m = mockFetch((url) => {
    const startParam = decodeURIComponent(url.match(/start=([^&]+)/)?.[1] ?? '');
    return { body: { bars: bars.filter((b) => Date.parse(b.t) >= Date.parse(startParam)), next_page_token: null } };
  });
  try {
    await scoreMaturedScanTrades(() => {});
  } finally {
    m.restore();
  }
  const [spy] = memory.loadLedger();
  const exitDay = new Date(days[E + 1]).toISOString().slice(0, 10);
  assert.match(spy.reason, new RegExp(`model v2: state exit ${exitDay} at ${closes[E + 1]}, net of 10 bps$`), 'exit on the next session, dated by session');
  assert.equal(spy.pnl, (((closes[E + 1] - Number(closes[E].toFixed(2))) / Number(closes[E].toFixed(2))) * 100 - 0.1).toFixed(4));
});

test('scoring: an update another scorer already applied is not applied twice', async () => {
  memory.resetMemory();
  const closes = [10, 10, 10, 11, 12, 12, 11, 9, 9, 9];
  memory.appendLedgerRow(row({ timestamp: iso(start + 5 * DAY + 3_600_000), symbol: 'ETHUSDT', price: '12.0000', reason: '[tsmom3-1d-state-long] up || broker fill 12.1 qty 1, order bot-ETHUSDT-1' }));
  let raced = false;
  const m = mockFetch(() => {
    if (!raced) {
      raced = true; // while this scorer fetches candles, another one finishes the row
      memory.updateLedger((rows) => {
        rows[0].outcome = 'loss';
        rows[0].pnl = '-1.0000';
        rows[0].reason += ' || model v2: state exit 2026-09-07 at 11, net of 60 bps';
      });
    }
    return { body: klinesFor(closes) };
  });
  try {
    await scoreMaturedScanTrades(() => {});
  } finally {
    m.restore();
  }
  const [eth] = memory.loadLedger();
  assert.equal((eth.reason.match(/model v2/g) ?? []).length, 1, 'one marker, not two');
  assert.equal(eth.pnl, '-1.0000', 'the other scorer\'s result stands');
});
