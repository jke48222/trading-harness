import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

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
process.env.ENTRY_SKIP = '@book-stocks';

const { expandSymbols, BOOK_CRYPTO, BOOK_STOCKS } = await import('../src/universe.ts');

test('universe presets expand to the 56-symbol book', () => {
  const book = expandSymbols('@book');
  assert.equal(book.length, 56);
  assert.equal(BOOK_CRYPTO.length, 32);
  assert.equal(BOOK_STOCKS.length, 24);
  assert.deepEqual(expandSymbols('@book-crypto, spy ,BTCUSDT').slice(-1), ['SPY'], 'duplicates dropped, case normalized');
  assert.throws(() => expandSymbols('@nope'), /Unknown universe/);
});

test('ENTRY_SKIP winds a sleeve down: listed symbols take no entries but stay in the universe', async () => {
  const { CONFIG } = await import('../src/config.ts');
  assert.equal(CONFIG.entrySkip.size, 24);
  assert.ok(CONFIG.entrySkip.has('AAPL'));
  assert.ok(!CONFIG.entrySkip.has('BTCUSDT'));
});

/** Load src/config.ts in a fresh process whose working folder holds `envFile`, and return what it resolved. */
function configIn(envFile: string, extraEnv: Record<string, string | undefined>): { dataDir: string; trialsFile: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-dotenv-'));
  fs.writeFileSync(path.join(dir, '.env'), envFile);
  const configUrl = new URL('../src/config.ts', import.meta.url).href;
  const script = `const { CONFIG } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ dataDir: CONFIG.dataDir, trialsFile: CONFIG.trialsFile, key: process.env.ALPACA_PAPER_KEY_ID ?? '' }));`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...extraEnv })) {
    if (v !== undefined && !['DATA_DIR', 'TRIALS_FILE', 'ALPACA_PAPER_KEY_ID', 'NODE_TEST_CONTEXT'].includes(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(extraEnv)) if (v !== undefined) env[k] = v;
  // tsx resolved from this repo: the child runs in a folder with no node_modules.
  const out = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop() as string);
}

test('.env sets DATA_DIR and TRIALS_FILE (with ~ for home), and a test run never reads it', () => {
  const envFile = 'DATA_DIR=~/bot-live-data\nTRIALS_FILE=data/trials.csv\nALPACA_PAPER_KEY_ID=real-paper-key\n';
  const live = configIn(envFile, {});
  assert.equal(live.dataDir, path.join(os.homedir(), 'bot-live-data'));
  assert.equal(live.trialsFile, 'data/trials.csv');
  assert.equal(live.key, 'real-paper-key');
  const underTest = configIn(envFile, { NODE_TEST_CONTEXT: 'child-v8' });
  assert.deepEqual(underTest, { dataDir: 'data', trialsFile: '', key: '' }, 'the developer\'s keys and live folder stay out of tests');
});

test('the trials ledger follows TRIALS_FILE, else DATA_DIR', async () => {
  const { trialsPath } = await import('../src/trials.ts');
  assert.equal(trialsPath(), path.join(process.env.DATA_DIR as string, 'trials.csv'));
});
