# Prompt 02 — TradingView Backtest Procedure

Status: **run 2026-07-15 via the TradingView MCP** — TradingView Desktop launched with the debug port, and the procedure below was executed end-to-end (script injected, saved, added to chart, 6-run IS/OOS × variant matrix). Results + verdict live in [trading_bot_instructions.md §3](../trading_bot_instructions.md); Strategy Tester screenshot at `backtest/ma_cross_9_21_backtest_2026-07-15.png`. The manual steps below remain valid as a fallback.

## A. The strategy being tested

- **Hypothesis:** on BTCUSDT 5m, a fresh 9/21 SMA crossover marks the start of a short-term momentum move that outruns ~10 bps round-trip costs.
- **Exact rules:** BUY when SMA(9) crosses above SMA(21) on a closed candle; SELL/flip short when SMA(9) crosses below SMA(21); optional fixed 12-bar exit to mirror the bot's scoring horizon; 0.05% commission per side (= 10 bps round trip); orders fill at signal-bar close; no pyramiding.
- Script: [backtest/ma_crossover_9_21.pine](../backtest/ma_crossover_9_21.pine) — non-repainting (closed candles, `process_orders_on_close`), costs included, explicit test-window inputs for in-sample/out-of-sample separation.

## B. Manual steps (works today, ~10 minutes)

1. Open [tradingview.com](https://www.tradingview.com) → chart → symbol **BINANCE:BTCUSDT** → **5m** timeframe.
2. Open **Pine Editor** (bottom panel) → delete the placeholder → paste the entire contents of `backtest/ma_crossover_9_21.pine` → **Save** (name: `MA Cross 9/21 paper research`) → **Add to chart**.
3. Open **Strategy Tester** (bottom panel). You should see trades populate.
4. **In-sample run:** gear icon → Inputs → set *Test window start/end* to the older ~70% of your visible 5m history (free plans only load a few months of 5m bars — that's a real limitation, note it in your results). Record the metrics below.
5. **Out-of-sample run:** change ONLY the window to the newest ~30%. Record the same metrics. **Do not tune anything after seeing this run** — if you re-tune, the OOS window is burned and you need a new one (wait for new data).
6. Repeat both runs with *Allow shorts* off (long-only) and with *Also exit after N bars* on — three variants total is plenty; more = parameter fishing.

**Metrics to record for every run** (Strategy Tester → Performance summary):
- Total closed trades (need ≥100 before believing anything; below ~30 is noise)
- Profit factor · Win rate · Avg trade % · Max drawdown % · Net profit %
- Long vs short breakdown (List of trades tab)

**Quality rules (from the prompt — non-negotiable):** no future data, no repainting, costs included, explicit rules, IS/OOS separated, and do not claim profitability the backtest doesn't support.

## C. What to paste back into `trading_bot_instructions.md` §3

```
TradingView backtest (BINANCE:BTCUSDT 5m, run <date>):
  In-sample <range>:  N trades, PF <x>, win rate <x>%, avg trade <x>%, maxDD <x>%
  Out-of-sample <range>: N trades, PF <x>, win rate <x>%, avg trade <x>%, maxDD <x>%
  Variant notes: long-only <better/worse>; 12-bar time exit <better/worse>
  Verdict: <rule set adopted / revised to ... / rejected because ...>
```

Rule of thumb: adopt the rule set only if the **out-of-sample** run has ≥30 trades, profit factor > 1.1, and a max drawdown you'd actually sit through. An OOS profit factor near or below 1.0 after costs means the raw crossover has no edge in that window — expected for fast MA crosses in chop; that's what filters (regime/HTF trend) are for, which is Week 2+ of the research plan.

## D. TradingView MCP (so Claude can run this for you next time)

From your copy-paste kit (tradesdontlie/tradingview-mcp). Machine setup status as of 2026-07-14:

| Piece | Status |
|---|---|
| MCP repo cloned to `~/tradingview-mcp` + `npm install` | see session notes — installed by Claude |
| MCP registered in Claude Code (`claude mcp list` → `tradingview`) | installed by Claude |
| `~/tradingview-mcp/rules.json` (your watchlist/bias/risk config) | created by Claude |
| Permissions pre-approval `mcp__tradingview__*` | added by Claude |
| **TradingView Desktop app** | **required — install if missing** ([tradingview.com/desktop](https://www.tradingview.com/desktop/)) |
| Active TradingView subscription + login in the desktop app | **you** |

To use it: launch TradingView Desktop with the debug port (`/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222`, or ask Claude to run `tv_launch`), start a **fresh** Claude Code session in this folder, then ask: *"Run tv_health_check. If cdp_connected is true, add my strategy from backtest/ma_crossover_9_21.pine to the BINANCE:BTCUSDT 5m chart and run the backtest per docs/tradingview_backtest.md."*
