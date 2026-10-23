# Paper phase protocol

Registered 2026-07-15, before the paper phase produced results; amended as listed at the end. These are the operating rules for the autonomous paper book: what runs, what "working" means, and the gates between here and any real money. The real-money decision is Jalen's alone.

## What runs

| Agent (launchd label) | Cadence | Heartbeat | What it does |
|---|---|---|---|
| `com.jalenedusei.trading.tsmom-daily` | hourly | `book`, `watch-flip`, `watch-sol` | **The book:** real orders on the Alpaca paper account across the 56-symbol universe (`SYMBOLS=@book`: 32 cryptos, 24 US stocks and ETFs), running Trial 07's state construction as Trial 09's vote. Since 2026-10-11 it buys when three or four of the 7-, 14-, 28- and 56-day returns are positive and sells at one or none, and the stocks take no new entries (`ENTRY_SKIP=@book-stocks`); since 2026-10-14 neither do LDO, POL and WIF, which Alpaca's paper simulator never fills. $2,000 per position before volatility scaling, at most 50 positions, $100,000 budget. Then two simulations: the flip-entry watch test (ETH, BNB, ADA, LINK, long only) and SOL both sides. |
| `com.jalenedusei.trading.health` | every 30 min | none | `npm run health`; a macOS notification on any PROBLEM |
| `com.jalenedusei.trading.tsmom-monitor` | 06:00 local on days 1 to 5 | none | Recomputes Trial 07's construction into `data/monitor_tsmom.csv` and checks the regime alarm |

The plists live in `ops/launchd/`; `scripts/agents.sh install` renders and loads them. The 5m crossover scanner (`com.jalenedusei.trading.scan`) was retired on 2026-10-11.

Execution safety: orders go only to the hardcoded paper host. Every order settles (filled, partly filled, or canceled after `ORDER_TIMEOUT_SEC`), retrying status checks through broker errors; anything a crash leaves behind is swept at the start of the next book scan. One action per signal candle, no pyramiding, one book scan at a time (a run lock shared by every checkout using the account). A crypto entry skips when the quoted spread exceeds `MAX_SPREAD_BPS`; stock entries price off a fresh IEX quote or the last one-minute close. After a catastrophe stop or a manual close from the dashboard, a symbol is not bought back until its rule has said exit on a close since. New crypto entries only fire in the two hours after the 00:00 UTC close; stock orders wait for the open. Each scan also repairs the ledger from broker fills: it adopts late fills and records exits that filled with no row.

## Daily criteria (what "working" means)

1. The book's heartbeat is under 130 minutes old, or the gap is explained (the Mac was asleep).
2. Every signal was acted on once or skipped with a stated reason. No order was refused by the broker.
3. No bot order is resting at the broker, and every broker position has an open ledger entry.
4. Exits fired on the momentum flip, or were deferred to the next stock open with a log line.
5. No invented data anywhere: a symbol whose data is missing is reported and skipped.

`npm run health` checks 1 to 3 and the exit half of 4. It posts a macOS notification on every run while any of these lasts:

- a book agent with no scan while health ran five times (about 2.5 hours awake; launchd skips both agents during sleep, so sleep alone never counts);
- a book scan whose steps failed or whose exit manager did not run, or two scans in a row that could not reach the broker or market data;
- broker refusals, unconfirmed orders and failed exits;
- positions with no open ledger entry or outside the book's universe, and bot orders resting over 10 minutes;
- a symbol whose wanted entry failed four scans running;
- the broker unreachable on two health checks in a row;
- cash from outside the book (a journal, deposit, withdrawal or transfer), once, on the first run that sees it in the daily history or the activity log;
- negative cash, since crypto buys need cash;
- broker cash that neither the activity log nor the history's cash flows account for, on two health checks in a row;
- a cash read that fails on two health checks in a row.

A regime ALARM is posted once for each month it lasts, and a day with no book scan in the crypto entry window once for that day. Everything else, including spread-guard streaks and repairs from broker fills, is a warning: it shows in `npm run health` and the dashboard but does not notify.

## Weekly review

- `npm run health` and `npm run positions`.
- `npm run reconcile`: the ledger should agree with broker fills (the three July setup trips are reported as manual and stay as they are).
- `npm run report`: round trips by sleeve, the gap between the model and the fills, fees.
- `npm run perf`: the account's time-weighted return, net of cash from outside the book, against BTC, SPY and an equal-weight hold of the universe.
- `data/monitor_tsmom.csv`: regime status.

## Regime alarm (Trial 07's forward role)

- **ALARM:** the trailing-12-month portfolio timing excess is below 0. The historical effect is not visible in the last year, so real-money promotion is frozen whatever the other gates say.
- Warning: trailing-6 below 0 while trailing-12 is at or above 0. Note it; no action.

## Promotion gates to the planned $300 real budget

All of these, sustained, before a real-money conversation rests on evidence:

1. **At least 4 consecutive weeks of clean operations** (the daily criteria), with every incident fixed and written up in `docs/incidents.md`. The clock restarted on 2026-10-11 after the resting-order incident, on 2026-10-14 after the unfillable-pairs incident, and on 2026-10-23, the day the cash-journal incident closed.
2. **At least 10 completed real-fill round trips with the model-to-fill gap measured.** Met on 2026-10-11: 108 closed round trips, mean gross gap -0.09% (median -0.18%), entry fills a mean 23 bps above the signal close, exit fills a mean 12 bps above the model's exit close (`npm run report`, model v2).
3. **No regime ALARM** at decision time.
4. **An honest evidence review.** Every strategy is on watch (Trial 06); the only support is portfolio-level and historical (Trial 07, with a recent era that is not significant on its own). Trial 08 found that it survives this account's costs on crypto (H1 and H2 pass) and that stocks have none (H3 fails). Trial 09's vote passed on 2021-2026 data (p 0.010) and Trial 10 found no support for trend timing on asset-class ETFs. Against every configuration ever tried (68), the crypto passes would not survive a Bonferroni correction (Trial 08 at 0.075, Trial 09 at 0.69). The base rates from three research reports stand: most retail algorithmic traders lose, and at this account size costs are the dominant force.
5. **A final fidelity period:** the last two weeks or more of paper at the real planned scale ($300 total, $100 a position), so the habits being promoted are the ones that transfer.
6. **Jalen amends the paper-only rule** in `trading_bot_instructions.md`, holds the keys, and owns the switch. No prompt, agent or assistant flips it, and the assistant never places a real trade.

For a real account later: a cash account (no pattern-day-trader flag; 28-day holds make settlement a non-issue). Alpaca's $10 crypto minimum means $300 supports exactly three $100 positions.

## Findings that shape operations

- **Alpaca paper does fill resting limits, at the maker rate, but has no queue.** The July 16 probe concluded the opposite from two $10 BTC limits canceled after 12 seconds. The incident's late fills settle it: eight good-til-canceled buys rested from 28 seconds to 44 hours and then filled at exactly their limit, and the three still held paid 0.12% to 0.15% in fees against 0.20% to 0.25% for orders that filled at once. On most pairs, paper fills a resting limit once the market reaches it, with no queue position, so it overstates how often and how well passive orders fill. `ORDER_MODE=maker` stays off until a registered test accounts for that.
- **Alpaca paper never fills LDO/USD, POL/USD or WIF/USD.** From July 15 to October 14 it filled none of 42 orders on them: market orders, limits above the ask, and limits that rested up to 86 days while prices fell through them. Coins that trade as thinly on Alpaca fill, and the asset records match. ONDO failed 13 times, then filled once on October 12. The book skips the three (`docs/incidents.md`). Every other pair it has sent orders to has filled.
- **Ledger storage.** Moving the ledger to SQLite is still deferred; instead every write takes a file lock and repairs go through `npm run reconcile`, which backs the ledger up first.

## Amendments

- **2026-07-15:** budget raised from $300 to the full $100,000 paper account for breadth across 56 symbols (Jalen's call); the $300 scale moved to the fidelity period in gate 5.
- **2026-10-11:** after the resting-order incident (`docs/incidents.md`): orders settle and never rest; reconcile against broker fills; health pages on refused, resting or unattributed orders; per-agent heartbeats; the 5m scanner retired; agent definitions moved into `ops/launchd/`; gate 2 recorded as met; the operations clock in gate 1 restarted. Three registered daily criteria were replaced. "No unhandled `BLOCKED:` errors" became criterion 2 (no broker refusals) plus the health pages above. "Matured trades scored against real candles" now runs in every scan with model v2, which charges each sleeve's measured cost and reads a full lookback for stocks. "Budget guards held: never more than 3 positions or $300 deployed" stopped applying with the July 15 amendment; the guards are the risk controls in `trading_bot_instructions.md`. The finding that Alpaca paper never fills resting limits was wrong and is corrected above. Trial 08 recommends winding down the stock sleeve with `ENTRY_SKIP=@book-stocks`; that is Jalen's call.
- **2026-10-11, after the second review:** health counts a silent book in its own runs instead of wall-clock minutes, so a sleeping Mac no longer pages and a dead agent can't hide behind a recent wake. The regime ALARM and the crypto-window check notify once instead of every 30 minutes. Offline scans and positions outside the book's universe now page. A manual close from the dashboard starts the same re-entry cooldown as a catastrophe stop.
- **2026-10-11, Jalen's calls after the review:** the book opens no new stock positions (`ENTRY_SKIP=@book-stocks`, Trial 08's locked consequence); the stocks it holds exit on the momentum rule. The live ledger, heartbeats and logs moved out of the checkout into `DATA_DIR`; `data/` keeps the trials ledger and a snapshot.
- **2026-10-11, Trials 09 to 11:** the book switched to Trial 09's vote under its locked switch rule.
  - It buys whenever the vote's own state is long, so an entry it missed is made at the next window.
  - Crypto positions opened under the 28-day rule exit under the vote. Their trips are left out of the model-against-fill figures in `npm run report`, `npm run perf` and the dashboard.
  - The stocks being wound down keep the 28-day exit they were opened with. Rows keep the rule their tag names for scoring.
  - Trial 10 failed, so there is no trend sleeve.
  - The regime monitor still tracks Trial 07's 28-day construction, the one its alarm was registered on.
  - The book's rule is baked into the installed agent, so a change to it takes `scripts/agents.sh install` and a dashboard restart. Health raises a problem when the book's heartbeat names a different rule from the checkout's agent definition.
  - To roll the rule back, remove the three `TSMOM_*` vote settings from the agent definition and the dashboard command and reinstall. Checking out an older commit would not do it: older code can't read the vote's tags and would score those rows wrong.
- **2026-10-14:** the book opens no new positions in LDOUSDT, POLUSDT or WIFUSDT, which Alpaca's paper simulator has never filled (`docs/incidents.md`). The skip covers paper only and is revisited before any real-money period. A symbol whose entries are off now clears its missed-entry count, so health stops paging on it. The incident's pages count against the daily criteria, so the clock in gate 1 restarted on 2026-10-14. Deploying the skip takes `scripts/agents.sh install` and a dashboard restart, as for a rule change.
- **2026-10-17:** a -$66,905.32 cash journal that the bot did not make left cash negative from 2026-10-14 (`docs/incidents.md`). Health now pages once on each flow of cash from outside the book, every run on negative cash, and on broker cash the records can't account for; `npm run perf` and the dashboard measure returns net of outside cash. The incident is open on Alpaca's side. While cash is negative, health pages every run and the book can't open crypto positions, so no day counts toward gate 1 until the incident closes, and the clock restarts that day.
- **2026-10-23:** Alpaca reversed the cash journal: +$66,905.32 in its history on 2026-10-21, in the account on 2026-10-22, again missing from its activity log (`docs/incidents.md`). The incident closed, and the clock in gate 1 restarted on 2026-10-23. Alpaca's paper engine accepted crypto buys while cash was negative, so the book could still open crypto positions, which corrects the amendment of 2026-10-17.
