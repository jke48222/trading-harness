import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Named symbol universes.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-config-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';

const { expandSymbols, BOOK_CRYPTO, BOOK_STOCKS } = await import('../src/universe.ts');

test('universe presets expand to the 56-symbol book', () => {
  const book = expandSymbols('@book');
  assert.equal(book.length, 56);
  assert.equal(BOOK_CRYPTO.length, 32);
  assert.equal(BOOK_STOCKS.length, 24);
  assert.deepEqual(expandSymbols('@book-crypto, spy ,BTCUSDT').slice(-1), ['SPY'], 'duplicates dropped, case normalized');
  assert.throws(() => expandSymbols('@nope'), /Unknown universe/);
});
