# Trial 01: 9/21 moving-average cross, BTCUSDT 5m

Run 2026-07-15. This trial has no registration document. Its rules came from the first-build guide (`docs/prompt_sequence.md`) and its pass bar from the backtest procedure in `docs/tradingview_backtest.md`. Like Trials 02 to 07, it first entered git together with its results, in the initial commit of 2026-08-27, so the order of rules and results can't be checked from the history. The results below were moved here unchanged from section 3 of `trading_bot_instructions.md` on 2026-10-11.

## What was tested

- 9- and 21-period simple moving averages of closes, on closed candles only. BUY when the fast average crosses above the slow one, SELL when it crosses back below.
- BINANCE:BTCUSDT 5m in TradingView's Strategy Tester (`backtest/ma_crossover_9_21.pine`), filled at the signal bar's close, with 0.05% commission a side (10 bps a round trip).
- The tester held about 23 days of 5m history, 2026-06-21 to 2026-07-15: one market regime, not months.
- Pass bar: an out-of-sample run with at least 30 trades, a profit factor above 1.1, and a drawdown worth sitting through.

## Results

| Window | Trades | Profit factor | Win rate | Avg trade | Max drawdown | Net |
|---|---|---|---|---|---|---|
| In-sample, 2026-06-21 to 07-08 | 251 | 0.67 | 29.9% | -0.09% | 2.7% | -2.12% |
| Out-of-sample, 2026-07-08 to 07-15 | 112 | 0.52 | 23.2% | -0.10% | 1.4% | -1.08% |

- Long only lost less but still lost: out-of-sample profit factor 0.60, net -0.47%.
- A 12-bar time exit did worse: profit factor 0.48, net -1.00%. The win rate rises, but the winners get cut short.
- Out-of-sample commissions ($1,115) about equal the whole out-of-sample loss ($1,082). Before costs the cross is close to break-even chop, and at a realistic 30 bps it does worse.
- The local replay agreed (`npm run replay:raw`, 2026-07-15): 22 setups, 18.2% wins, -0.26% a setup at 30 bps.

The replays and all seven Strategy Tester runs are lines 2 to 12 of `data/trials.csv`. Screenshot: `backtest/ma_cross_9_21_backtest_2026-07-15.png`.

## Verdict

Rejected: every variant missed the bar. Instead of tuning the cross, Trial 02 tested the follow-up the research plan called for, a higher-timeframe trend filter, and rejected the family.
