import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The dashboard's request guard.
// CONFIG is frozen at import, so the env is set before any src module loads.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-dashboard-'));
process.env.EXECUTION = 'sim';
process.env.INTERVAL = '1d';
process.env.STRATEGY = 'tsmom';
process.env.TSMOM_LOOKBACK = '3';
process.env.EVAL_HORIZON = '2';
process.env.FEE_BPS = '30';
process.env.ALPACA_PAPER_KEY_ID = 'test-key';
process.env.ALPACA_PAPER_SECRET = 'test-secret';



test('dashboard guard: only its own page, on its own host, may POST', async () => {
  const { requestAllowed } = await import('../src/dashboard/guard.ts');
  const own = { host: '127.0.0.1:8787' };
  const post = { ...own, origin: 'http://127.0.0.1:8787', 'content-type': 'application/json', 'x-dashboard': '1' };
  assert.equal(requestAllowed('GET', own, 8787), true);
  assert.equal(requestAllowed('GET', { host: 'evil.example:8787' }, 8787), false, 'DNS rebinding: foreign Host');
  assert.equal(requestAllowed('POST', post, 8787), true);
  assert.equal(requestAllowed('POST', { ...post, origin: 'https://evil.example' }, 8787), false, 'cross-site origin');
  assert.equal(requestAllowed('POST', { ...post, 'content-type': 'text/plain' }, 8787), false, 'preflight-free body');
  const { ['x-dashboard']: _drop, ...noHeader } = post;
  assert.equal(requestAllowed('POST', noHeader, 8787), false, 'missing custom header');
});
