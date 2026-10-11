# Trading bot instructions

The single source of truth for how this project operates. Anyone changing the bot, person or assistant, reads this first.

## 1. Goal

Find out, with statistics a skeptical referee would accept, whether a small systematic strategy has an edge after retail costs, and run the one construction that has passed as an autonomous paper book until the evidence says otherwise. Real money is out of scope until the promotion gates in `docs/paper_phase_protocol.md` are met and Jalen changes rule 2.1 himself.

## 2. Safety rules

1. **Paper trading only.** Orders can reach only `paper-api.alpaca.markets`, hardcoded in `src/broker/orders.ts`; that host serves no live accounts. No live-trading code path exists, and no prompt may add one. Changing this rule is Jalen's decision alone, made by editing this line.
2. **Keys stay out of chat and source.** Alpaca paper keys live in `.env` (gitignored). They are never printed, logged, committed or sent to the dashboard page.
3. **No order without the risk checks** in section 4, and every decision prints a plain-English reason.
4. **Real data only.** When market data is missing, the bot reports it and skips the symbol. It never invents a candle, a fill or an outcome.
5. **Nothing rests at the broker.** Every order settles before the scan moves on, and anything left over is canceled at the start of the next scan.
6. **The broker's fills are the record of what traded.** When the ledger and the fills disagree, the fills win, and the repair is written into the row's reason.

## 3. Research rules and current evidence

- **Pre-register every test:** hypothesis, exact rules, data window, pass bar and consequences are committed before any statistic is computed. No tuning after looking.
- **Count every look:** every configuration ever tested is a row in `data/trials.csv`. A result is judged against that count.
- **Check for drift:** a long strategy must beat its own average exposure to the market, not just ride it.

| Trial | Result |
|---|---|
| 01 to 03 | Fast technical rules on 5m and 1h crypto (moving-average cross, trend filter, Donchian breakout): all rejected after costs |
| 04, 05 | 28-day time-series momentum, per trade: five candidates |
| 06 | Multiple-testing correction: all five demoted to watch (p 0.22 to 0.42); per-trade significance would need hundreds to thousands of trades each |
| 07 | Portfolio-level test on 8 unselected cryptos: pass, +4.30% a month of timing excess, p = 0.0004; the 2023 to 2026 subsample alone is not significant |
| 08 | Trial 07 at this account's measured costs, on the book's 32 coins, and on US equity ETFs: see `docs/trial_08_cost_and_sleeves.md` |

Details and raw numbers are in `docs/`. Nothing in this project is cleared for real money.

## 4. Strategy and risk (the book)

- **Construction (Trial 07):** at each daily close, a symbol with a positive 28-day return is held; when the return turns zero or negative, it is sold at the next scan (stocks at the next open). Long only. Closed candles only, so signals never repaint. No memory filter: Trial 07 tested the construction without one.
- **Universe:** `SYMBOLS=@book`, 32 cryptos and 24 US stocks and ETFs (`src/universe.ts`).
- **Size:** $2,000 per position, scaled down for volatile symbols (`VOL_TARGET_PCT` 4%/day, floor 25%), at most 50 positions and a $100,000 budget.
- **Risk controls** (`src/portfolioRisk.ts`) are all on by default. New entries halt when the account is down 8% on the UTC day; exits still run. Crypto is capped at 70% of the budget because it moves as one bet. A position down 30% is closed whatever the signal says. No pyramiding.
- **Costs:** scoring charges 30 bps per round trip (`FEE_BPS`). Measured on this account: 0.25% fee per crypto trade side at the entry tier, plus a few bps of slippage against signal closes.

## 5. Broker and execution

- **Venue:** Alpaca paper, verified 2026-07-14: $100,000 paper cash, crypto enabled, no pattern-day-trader flag. Alpaca crypto cannot be shorted, so short signals stay in simulation. The minimum crypto order is $10.
- **Orders** (`src/broker/orders.ts`): a bounded limit priced off the venue's ask (`LIMIT_SLIPPAGE_BPS` 30 above it), skipped when the quoted spread is wider than `MAX_SPREAD_BPS` (100). Each order settles within `ORDER_TIMEOUT_SEC` (30): filled, partly filled and recorded, or canceled. Client order ids carry the symbol and the signal candle.
- **Exits:** the state flip, the catastrophe stop, or a fixed horizon for flip-entry tests. Each exit row records the actual round-trip P&L from fills next to the model's score.
- **Timing:** new crypto entries only in the two hours after the 00:00 UTC close (`ENTRY_WINDOW_MIN` 120). Stock orders wait for the market to open.
- **Reconcile:** `npm run reconcile` rebuilds round trips from fills and lists where the ledger disagrees; `--apply` adopts late fills and corrects misattributed exits, after backing the ledger up.
- **Maker orders** are built (`ORDER_MODE=maker`) but stay off: Alpaca paper never fills a resting limit below the market, so the saving can only be measured with real money.

## 6. Records

- `data/ledger.csv`: every decision, trade and skip, with a reason. Header `timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl`. Writes take a file lock (`data/.ledger.lock`).
- Modes: `scan` (simulated trade), `scan-filtered` (a signal a filter declined, scored as a counterfactual), `alpaca-paper` (a real paper entry, scored by the model), `alpaca-paper-exit` (its exit, with actual P&L), `replay-*` (research replays).
- `data/learnings.md`: one lesson per losing setup tag, from real outcomes only. The memory filter that reads it applies to simulated strategies, not to the book.
- `data/trials.csv`: append-only; `memory:reset` never touches it.
- `data/heartbeat/<label>.json`: what each agent's last scan did. `docs/incidents.md`: anything that went wrong and how it was fixed.

## 7. Operations

- Agents: `scripts/agents.sh install | status | uninstall` (plists in `ops/launchd/`). The hourly book, a 30-minute health check that posts a macOS notification on any problem, and the monthly regime monitor.
- Daily and weekly checks, the regime alarm and the promotion gates: `docs/paper_phase_protocol.md`.
- launchd pauses while the Mac sleeps; health flags a book heartbeat older than 130 minutes.
