/**
 * One-time smoke test of the paper execution layer: buy $5 of BTC on the
 * Alpaca PAPER account, measure the real fill vs the live reference price,
 * close it, and report the measured round-trip cost — the project's first
 * instrumented execution-cost datapoint (deep-research open question #1).
 */
import '../src/config';
import { closePaperPosition, getBrokerPositions, slippageBps, submitPaperBuy } from '../src/broker/orders';
import { closedCandles, fetchSeries } from '../src/market';

(async () => {
  const refCandles = closedCandles(await fetchSeries('BTCUSDT', '1m', 3));
  const ref = refCandles[refCandles.length - 1].close;
  console.log(`Reference (Binance 1m close): ${ref}`);

  const existing = await getBrokerPositions();
  if (existing.some((p) => p.symbol.replace('/', '') === 'BTCUSD')) {
    throw new Error('A BTC paper position already exists — aborting so the smoke test cannot touch it.');
  }

  console.log('Submitting $10.00 BTC/USD market BUY on the PAPER account (Alpaca minimum crypto order is $10 notional)…');
  const buy = await submitPaperBuy('BTCUSDT', 10, `smoke-${Date.now()}`);
  const buyFill = Number(buy.filled_avg_price);
  console.log(`BUY filled: qty ${buy.filled_qty} @ ${buyFill} · slippage vs reference ${slippageBps(buyFill, ref).toFixed(1)} bps`);

  const open = await getBrokerPositions();
  const pos = open.find((p) => p.symbol.replace('/', '') === 'BTCUSD');
  console.log(`Position visible on account: ${pos ? `qty ${pos.qty}, value $${Number(pos.market_value).toFixed(2)}` : 'NOT FOUND (!)'}`);

  console.log('Closing the position at market…');
  const sell = await closePaperPosition('BTCUSDT');
  const sellFill = Number(sell.filled_avg_price);
  const mid = (buyFill + sellFill) / 2;
  const rtBps = ((buyFill - sellFill) / mid) * 10_000;
  console.log(`SELL filled: qty ${sell.filled_qty} @ ${sellFill}`);
  console.log(
    `Measured round-trip spread cost: ${rtBps.toFixed(1)} bps (buy ${buyFill} / sell ${sellFill}) — EXCLUDES Alpaca's crypto commission (0.25%/side taker = 50 bps RT at this tier), so all-in ≈ ${(rtBps + 50).toFixed(1)} bps.`
  );
  const after = await getBrokerPositions();
  console.log(`Positions after close: ${after.filter((p) => p.symbol.replace('/', '') === 'BTCUSD').length === 0 ? 'clean (BTC flat)' : 'STILL OPEN (!)'}`);
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
