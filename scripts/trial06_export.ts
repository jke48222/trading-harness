/**
 * Trial 06 helper: export per-setup OOS returns for ONE candidate config
 * (env-driven, exactly like the bot) as JSON on stdout. Uses the bot's own
 * computeSetups so scoring is identical to the registered runs.
 *
 * Usage: STRATEGY=tsmom TSMOM_LOOKBACK=28 EVAL_HORIZON=28 FEE_BPS=30 \
 *        LONG_ONLY=on REPLAY_WINDOW_START=... SYMBOL=ETHUSDT REPLAY_CANDLES=9600 INTERVAL=1d \
 *        npx tsx scripts/trial06_export.ts
 */
import { CONFIG } from '../src/config';
import { closedCandles, fetchSeriesSince, intervalToMs } from '../src/market';
import { computeSetups } from '../src/replay';

(async () => {
  const { symbol, interval, replayCandles } = CONFIG;
  const candles = closedCandles(
    await fetchSeriesSince(symbol, interval, Date.now() - replayCandles * intervalToMs(interval))
  );
  const { setups } = computeSetups(candles);
  const out = {
    symbol,
    interval,
    strategy: CONFIG.strategyName,
    lookback: CONFIG.tsmomLookback,
    horizon: CONFIG.evalHorizon,
    feeBps: CONFIG.feeBps,
    longOnly: CONFIG.longOnly,
    windowStart: CONFIG.replayWindowStart,
    windowEnd: CONFIG.replayWindowEnd || new Date(candles[candles.length - 1].closeTime).toISOString(),
    setups: setups
      .filter((s) => s.outcome !== 'incomplete' && s.pnlPct !== null)
      .map((s) => ({ t: new Date(s.time).toISOString(), action: s.action, pnl: s.pnlPct })),
  };
  console.log(JSON.stringify(out));
})().catch((err) => {
  console.error(`BLOCKED: ${(err as Error).message}`);
  process.exit(1);
});
