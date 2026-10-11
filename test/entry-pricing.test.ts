import { test } from 'node:test';
import assert from 'node:assert/strict';

// Entry pricing is pure; no CONFIG is involved.
const { priceEntry } = await import('../src/entryPricing.ts');
const { makeQuote } = await import('../src/broker/orders.ts');

const now = Date.parse('2026-10-12T14:10:00Z');
const at = (msAgo: number): string => new Date(now - msAgo).toISOString();

test('crypto: a spread over the limit skips the entry (PAXG at 117 bps)', () => {
  const quote = makeQuote(4159.575, 4208.7, at(60_000));
  const r = priceEntry({ crypto: true, quote, mark: 4180, nowMs: now, maxSpreadBps: 100 });
  assert.equal(r.kind, 'skip');
});

test('crypto: the limit is priced off the ask even when the quote has not changed for minutes', () => {
  const quote = makeQuote(0.4231, 0.425139, at(10 * 60_000));
  const r = priceEntry({ crypto: true, quote, mark: 0.42, nowMs: now, maxSpreadBps: 100 });
  assert.equal(r.kind, 'price');
  if (r.kind === 'price') {
    assert.equal(r.touch, 0.425139, 'the ask, not the Binance mark that sat below it');
    assert.equal(r.arrival, quote?.mid);
  }
});

test('stocks: a junk after-hours IEX quote never blocks an entry; the 1m close prices it', () => {
  const junk = makeQuote(0.01, 335.99, at(30_000));
  const r = priceEntry({ crypto: false, quote: junk, mark: 336.2, nowMs: now, maxSpreadBps: 100 });
  assert.deepEqual(r.kind === 'price' && [r.arrival, r.touch], [336.2, 336.2]);
});

test('stocks: a stale IEX quote falls back to the mark; a fresh tight one is used', () => {
  const stale = makeQuote(778.52, 778.62, at(48 * 3_600_000));
  const r1 = priceEntry({ crypto: false, quote: stale, mark: 780, nowMs: now, maxSpreadBps: 100 });
  assert.equal(r1.kind === 'price' && r1.touch, 780);
  const fresh = makeQuote(778.52, 778.62, at(5_000));
  const r2 = priceEntry({ crypto: false, quote: fresh, mark: 780, nowMs: now, maxSpreadBps: 100 });
  assert.equal(r2.kind === 'price' && r2.touch, 778.62);
});

test('no quote and no mark: priced with nothing, so the caller can refuse a bounded limit', () => {
  const r = priceEntry({ crypto: true, quote: null, mark: null, nowMs: now, maxSpreadBps: 100 });
  assert.deepEqual(r.kind === 'price' && [r.arrival, r.touch], [null, null]);
});
