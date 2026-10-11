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
- **Count every look:** every configuration ever tested is a row in `data/trials.csv`. A trial passes or fails on the rule it registered, and each result is reported next to a Bonferroni correction for that count.
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
- **Costs:** the book's rows are scored at a round-trip cost per sleeve. Crypto uses 60 bps (`FEE_BPS_CRYPTO`); its 42 round trips so far measure about 52: a 0.25% taker fee per side at the entry tier plus about 1 bp of mean slippage per side (`npm run report`). Stocks use 10 bps (`FEE_BPS_STOCKS`), an allowance rather than a measurement: there is no commission, and stock entries have filled a mean 1.8 bps above the price at order time across 80 entries. Replays and simulations use `FEE_BPS` (30).
- **After a catastrophe stop or a manual close** from the dashboard, the symbol is not bought back until its momentum has been non-positive on at least one close. Otherwise the still-positive signal would re-buy it at the next scan.

## 5. Broker and execution

- **Venue:** Alpaca paper, verified 2026-07-14: $100,000 paper cash, crypto enabled, no pattern-day-trader flag. Alpaca crypto cannot be shorted, so short signals stay in simulation. The minimum crypto order is $10.
- **Orders** (`src/broker/orders.ts`): a bounded limit priced off the venue's ask (`LIMIT_SLIPPAGE_BPS` 30 above it), rounded up to Alpaca's increment. A crypto entry skips when the quoted spread is wider than `MAX_SPREAD_BPS` (100); a stock entry uses a fresh, tight IEX quote or else the last one-minute close. Each order settles within `ORDER_TIMEOUT_SEC` (30): filled, partly filled and recorded, or canceled, with status checks retried through broker errors. Client order ids carry the symbol, the signal candle and the attempt.
- **Exits:** the state flip, the catastrophe stop, or a fixed horizon for flip-entry tests. Each exit row records the actual round-trip P&L from fills next to the model's score.
- **Timing:** new crypto entries only in the two hours after the 00:00 UTC close (`ENTRY_WINDOW_MIN` 120). Stock orders wait for the market to open.
- **Reconcile:** every book scan adopts late fills and records exits that filled with no row, from the broker's history. `npm run reconcile` lists any remaining disagreement; `--apply` also corrects misattributed exits, after backing the ledger up.
- **Maker orders** are built (`ORDER_MODE=maker`) but stay off. Alpaca paper does fill resting limits at the maker rate, but with no queue, so paper overstates how well passive orders fill (`docs/paper_phase_protocol.md`).

## 6. Records

- `data/ledger.csv`: every decision, trade and skip, with a reason. Header `timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl`. Writes take a file lock on `data/.ledger.lock`: a kernel lock on macOS, which a crashed holder releases at once, and a lock file elsewhere.
- Modes: `scan` (simulated trade), `scan-filtered` (a signal a filter declined, scored as a counterfactual), `alpaca-paper` (a real paper entry, scored by the model), `alpaca-paper-exit` (its exit, with actual P&L), `replay-*` (research replays).
- `data/learnings.md`: one lesson per losing setup tag, from real outcomes only. The memory filter that reads it applies to simulated strategies, not to the book.
- Model scores on the book's rows carry a note (`|| model v2: state exit DATE at PRICE, net of COST bps`). Rows scored under the older models were re-scored once on 2026-10-11 and keep their old figure in the reason.
- `data/trials.csv`: append-only; `memory:reset` never touches it.
- `data/heartbeat/<label>.json`: what each agent's last scan did. `docs/incidents.md`: anything that went wrong and how it was fixed.

## 7. Operations

- Agents: `scripts/agents.sh install | status | uninstall` (plists in `ops/launchd/`). The hourly book, a 30-minute health check that posts a macOS notification on any problem, and the monthly regime monitor. `install` and `uninstall` wait for a running book scan to finish.
- Health exits 0 when clear and 2 when it found a problem and posted the notification. Exit 1 means it crashed or could not post, and the launchd job then posts its own fallback notice. A regime ALARM and a night with no crypto-window scan are posted once each, not every half hour.
- launchd pauses while the Mac sleeps, so health measures a silent book in its own runs: five health runs with no book scan (about 2.5 awake hours) is a problem, and sleep alone never is. The hourly job holds off idle sleep while it runs (`caffeinate -i`). A scan that wakes with no network (a Power Nap dark wake) writes an offline heartbeat and does nothing; two in a row is a problem.
- Daily and weekly checks, the regime alarm and the promotion gates: `docs/paper_phase_protocol.md`.
