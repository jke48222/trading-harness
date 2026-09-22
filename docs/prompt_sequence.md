# The Six-Prompt Sequence — Status Map

From the "Paper Trading Bot Prompts" PDF (Miles High Club). Run in order; each gates the next.
This build executed Prompts 03–06 directly with the PDF's safe defaults. Prompts 01–02 need you (accounts/logins), and their outputs feed back into `trading_bot_instructions.md`.

| # | Prompt | Status | Notes |
|---|---|---|---|
| 01 | Connect MCP to the assistant before build | **Done 2026-07-14** | Alpaca PAPER account verified read-only (account/positions/orders/clock/market data, zero orders touched). MCP server ✔ Connected (`uvx alpaca-mcp-server`, paper mode pinned). `broker:check`/`broker:preview` added. Connection report in session notes + `trading_bot_instructions.md` §5. |
| 02 | Backtest strategy with TradingView | **Ready to run — needs you (~10 min)** | Pine Script v5 strategy at `backtest/ma_crossover_9_21.pine`; exact procedure + metrics template in `docs/tradingview_backtest.md`. TradingView MCP machine setup done by the assistant; needs TradingView Desktop app installed + logged in for MCP mode, or just use the manual browser steps today. Paste results into `trading_bot_instructions.md` §3. |
| 03 | Create the instructions file | **Done** | `trading_bot_instructions.md` written with safe paper defaults; open items marked for your answers. |
| 04 | First build without memory | **Done** | Full TypeScript bot: real Binance public data, 9/21 crossover, risk module, paper execution, `scan` + `replay:raw`. |
| 05 | Add memory system and run comparison | **Done** | `data/ledger.csv`, `data/learnings.md`, `src/memory.ts`, `src/adaptiveFilter.ts`, `replay:memory`, `memory:reset`; raw-vs-memory comparison printed honestly. |
| 06 | Finalize bot for experimentation | **Done** | README, `.env.example`, `.gitignore`, guardrails, full verification run. |

## Prompt 01 — exact prompt to paste when you're ready

```
Help me connect my broker or exchange MCP/API to my assistant before we build the trading bot.
Do not write bot code yet. First guide me through the connection safely.
Start by asking me these questions if the answers are not obvious:
- Which venue: Alpaca, Pionex, Binance, Bybit, another crypto exchange, or another brokerage?
- Trading stocks, crypto, or both?
- Which assistant client?
- Am I using paper/test mode? If not, stop and tell me to create a paper/test setup first.
- Market-data-only permissions first, or paper-trading permissions?
Connection rules: paper/test mode only, no live trading, no order placed, no API keys pasted into chat or source code, no secrets logged, no credentials exposed to frontend code. If an exchange supports sub-accounts or restricted API keys, recommend that restricted paper/test setup first.
Step 1: Identify the correct setup path — official MCP server if available, safest API fallback if not, stop and give setup checklist if MCP tools aren't visible.
Step 2: Verify the connection — account status, balances, open positions, open orders, market data. Do not submit, preview-submit, or cancel an order during this smoke test unless I explicitly ask later.
Step 3: Give me a connection report — venue, client, MCP status, account mode, tools verified, credentials kept out of codebase, next step before building.
If anything is live, unknown, or unsafe, stop and tell me exactly what to fix before continuing.
```

## Prompt 02 — exact prompt to paste when you're ready

```
Help me backtest a trading strategy in TradingView before we build the bot.
Start by asking me for the missing inputs: market/ticker, timeframe, test window, strategy idea and rules, risk rules, fees/slippage, long-only or long/short.
Default strategy if I don't provide one: BTCUSDT, 5m, 9-period fast MA, 21-period slow MA, buy on bullish crossover, sell/exit on bearish crossover, paper/backtest only.
Use TradingView if the TradingView MCP or browser workflow is available.
If a TradingView MCP is available: open or prepare the chart, add the strategy as a backtestable strategy (not just an indicator), run it over the date range, report results clearly.
If a TradingView MCP is not available: do not pretend you ran it. Generate a Pine Script v5 strategy instead and give exact steps to paste it into Pine Editor, add it to the chart, and read the Strategy Tester results.
Backtest quality rules: no future data, no repainting signals, include commission and slippage assumptions, make entry/exit rules explicit, separate in-sample from out-of-sample where possible, do not claim profitability the backtest doesn't support.
Return: the strategy hypothesis, the exact rules tested, Pine Script if needed, full backtest metrics, weaknesses or market conditions where it fails, whether the rule set is good enough for the instructions file, and the final concise rule set for the bot instructions file.
```

## After 01 + 02

Paste both outputs into `trading_bot_instructions.md` (§3 strategy rules, §5 broker rules), then ask the assistant to add the `src/broker/` paper adapter with `broker:check` / `broker:preview` scripts — paper mode only, keys in the MCP client config, never in source.

## The video's operating advice (transcript distillation)

- Bots fail for four reasons: no memory, no defined goals/objectives, trained only on the past with no regard for future conditions, and overcrowded prepackaged strategies with no edge. This build directly attacks #1 and #2; #3 is your discretionary input; #4 is why the bot is yours and configurable.
- Loop: set parameters → execute → learn → repeat, 24/7. The bot is the execution edge; you remain the idea/forecasting edge — use it as an attachment to discretionary trading, not a replacement.
- Homework: paper trade for a week while refining the memory system. Only then risk 1–3% of your max risk tolerance, on a restricted sub-account, and scale slowly.
- When trade volume gets large (high-frequency), move memory from the two files to a cloud database (Supabase / Firebase / Super Memory) so reads stay fast — same idea, bigger ledger.
