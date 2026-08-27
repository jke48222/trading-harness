# Trial 02 — HTF Regime Filter (pre-registered)

Registered: 2026-07-15 ~04:15 UTC, **before** implementation or any data run. Amendments after seeing results are not allowed; a new idea = a new pre-registered trial.

## Hypothesis

The raw 9/21 SMA cross on BTCUSDT 5m loses because it trades every cross in chop, paying costs each time (Trial 01: OOS PF 0.52–0.60 across all variants). If entries are only taken **in the direction of the higher-timeframe trend**, the losing counter-trend half of the signals is removed and the surviving setups clear costs.

## Exact rules (locked)

- Base strategy unchanged: 9/21 SMA cross on 5m closed candles, 12-candle scoring horizon locally, `FEE_BPS` round trip.
- Regime source: **1h closed candles only** (the last 1h candle whose close is at or before the signal candle's close — never the forming one).
- Regime definition: UP when the last closed 1h close > SMA(N) of 1h closes; DOWN when below; NONE when equal or insufficient history.
- Gate: **BUY taken only in UP regime; SELL taken only in DOWN regime.** A cross against the regime is not taken (and is logged so the counterfactual can be scored later).
- In the TradingView strategy the filter gates **entries only** — an opposite cross still closes an open position. The Pine HTF series uses the previous *confirmed* HTF bar (`[1]` with `lookahead_off`) — non-repainting; boundary-bar values may differ slightly from the bot's "last closed 1h at signal time" definition. Noted, accepted.

## Variants (2 only — no fishing)

| Variant | HTF | Trend MA |
|---|---|---|
| A | 1h | SMA 50 (~2 days of trend) |
| B | 1h | SMA 200 (~8 days of trend) |

No other parameter may change between baseline and variants.

## Test battery & gates (locked before running)

1. **Local replay**, ~21 days paged 5m data, baseline + A + B, each reported at 30 bps and 10 bps (research: real BTC round trip ≈ 28 bps). Research runs use `REPLAY_WRITE_MEMORY=false` so they don't contaminate forward trade memory. Every run auto-logs to `data/trials.csv`.
2. **TradingView Strategy Tester**, same IS/OOS split as Trial 01 (IS: data start → Jul 8 00:00 UTC; OOS: Jul 8 → now), variants A and B, shorts on, no time exit, 0.05%/side commission.
3. **Adoption gates (identical to Trial 01):** OOS profit factor > 1.1 with ≥ 30 OOS trades and a sit-through-able max drawdown; locally the variant must also beat the same-window baseline and be net-positive at 30 bps.
4. **No tuning after OOS.** If both variants fail: the MA-cross family on BTC 5m is rejected per the research plan — next step is a different strategy class, not variant C.

## Multi-symbol expansion (pre-registered alongside)

- The bot gains a `SYMBOLS` universe (crypto via Binance public data; US stocks via Alpaca paper IEX data, read-only). Universe selection criterion is **objective liquidity** (tightest spreads → lowest real costs), set by the user — the bot does not pick "best stocks," and nothing here is investment advice.
- Every symbol × config evaluation logs its own `trials.csv` row; gates apply per symbol. More symbols = more looks — the disclosure ledger is what keeps that honest.
- Stock-specific realities recorded up front: regular hours only (scans outside 09:30–16:00 ET are skipped with a reason); IEX feed on paper keys; commissions ≈ $0 but spread+slippage are real (FEE_BPS still applies); **PDT rule: a real-money margin account under $25k is limited to 3 day-trades per 5 sessions — a 5m stop-and-reverse strategy is not livable under PDT at small size.** Crypto has no PDT.

---

## Results (run 2026-07-15, per the locked procedure)

**Local replay, BTCUSDT 5m, ~21 days (2026-06-24 → 2026-07-15), per-setup scoring:**

| Config | Setups | Win rate | Avg/setup @30bps | Avg/setup @10bps |
|---|---|---|---|---|
| Baseline (no filter) | 330 | 18.5% @30 / 37.9% @10 | −0.285% | −0.085% |
| A: 1h SMA50 | 151 (179 filtered) | 18.5% / 35.8% | −0.275% | −0.075% |
| B: 1h SMA200 | 162 (168 filtered) | 19.1% / 40.1% | −0.273% | −0.073% |

**TradingView Strategy Tester, BINANCE:BTCUSDT 5m, IS/OOS as locked (shorts on, no time exit, 10 bps):**

| Run | Trades | PF | Win rate | Net |
|---|---|---|---|---|
| A in-sample | 121 | 0.74 | 31.4% | −0.85% |
| **A out-of-sample** | **57** | **0.69** | 29.8% | −0.33% |
| B in-sample | 123 | 0.81 | 31.7% | −0.61% |
| **B out-of-sample** | **58** | **0.45** | 24.1% | −0.69% |

## Verdict: REJECTED (both variants)

- Gate was OOS PF > 1.1 with ≥30 trades; A scored 0.69, B scored 0.45. Locally, neither variant is net-positive at 30 bps and neither meaningfully beats baseline per-setup (−0.27% vs −0.285%).
- The filter removes ~half the trades but the surviving setups lose at nearly the same rate — the crossover's per-trade edge is ~zero pre-cost regardless of regime, so costs dominate either way. B's IS→OOS collapse (0.81 → 0.45) is the canonical in-sample mirage.
- Per the pre-registration: **the MA-cross family on BTC 5m is rejected. Next step is a different strategy class** (see research report Q2 candidates), not a variant C. No parameters were changed after the OOS runs; the strategy stays on the chart with the filter off.
- All 10 runs (6 local + 4 TradingView) are disclosed in `data/trials.csv` (21 trials to date).
