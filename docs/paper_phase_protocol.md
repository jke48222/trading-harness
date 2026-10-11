# Paper phase protocol

Registered 2026-07-15, before the paper phase produced results; amended as listed at the end. These are the operating rules for the autonomous paper book: what runs, what "working" means, and the gates between here and any real money. The real-money decision is Jalen's alone.

## What runs

| Agent (launchd label) | Cadence | Heartbeat | What it does |
|---|---|---|---|
| `com.jalenedusei.trading.tsmom-daily` | hourly | `book`, `watch-flip`, `watch-sol` | **The book:** real orders on the Alpaca paper account across the 56-symbol universe (`SYMBOLS=@book`: 32 cryptos, 24 US stocks and ETFs), running Trial 07's state construction: long while 28-day momentum is positive, sell when it turns. $2,000 per position before volatility scaling, at most 50 positions, $100,000 budget. Then two simulations: the flip-entry watch test (ETH, BNB, ADA, LINK, long only) and SOL both sides. |
| `com.jalenedusei.trading.health` | every 30 min | none | `npm run health`; a macOS notification on any PROBLEM |
| `com.jalenedusei.trading.tsmom-monitor` | 06:00 local on the 1st | none | Recomputes Trial 07's construction into `data/monitor_tsmom.csv` and checks the regime alarm |

The plists live in `ops/launchd/`; `scripts/agents.sh install` renders and loads them. The 5m crossover scanner (`com.jalenedusei.trading.scan`) was retired on 2026-10-11.

Execution safety: orders go only to the hardcoded paper host. Every order settles (filled, partly filled, or canceled after `ORDER_TIMEOUT_SEC`), retrying status checks through broker errors; anything a crash leaves behind is swept at the start of the next book scan. One action per signal candle, no pyramiding, one book scan at a time (a run lock shared by every checkout using the account). A crypto entry skips when the quoted spread exceeds `MAX_SPREAD_BPS`; stock entries price off a fresh IEX quote or the last one-minute close. After a catastrophe stop, a symbol is not bought back until its momentum has turned at least once. New crypto entries only fire in the two hours after the 00:00 UTC close; stock orders wait for the open. Each scan also repairs the ledger from broker fills: it adopts late fills and records exits that filled with no row.

## Daily criteria (what "working" means)

1. The book's heartbeat is under 130 minutes old, or the gap is explained (the Mac was asleep).
2. Every signal was acted on once or skipped with a stated reason. No order was refused by the broker.
3. No bot order is resting at the broker, and every broker position has an open ledger entry.
4. Exits fired on the momentum flip, or were deferred to the next stock open with a log line.
5. No invented data anywhere: a symbol whose data is missing is reported and skipped.

`npm run health` checks 1 to 3 and the exit half of 4. It posts a macOS notification for any of these:

- a book heartbeat over 130 minutes old, except in the 75 minutes after the Mac wakes;
- a book scan whose steps failed, or whose exit manager did not run;
- broker refusals, unconfirmed orders and failed exits;
- positions with no open ledger entry, and bot orders resting over 10 minutes;
- a symbol whose wanted entry failed four scans running;
- the broker unreachable twice in a row, and the regime ALARM.

Everything else, including spread-guard streaks and repairs from broker fills, is a warning: it shows in `npm run health` and the dashboard but does not notify.

## Weekly review

- `npm run health` and `npm run positions`.
- `npm run reconcile`: the ledger should agree with broker fills (the three July setup trips are reported as manual and stay as they are).
- `npm run report`: round trips by sleeve, the gap between the model and the fills, fees.
- `npm run perf`: the account against BTC, SPY and an equal-weight hold of the universe.
- `data/monitor_tsmom.csv`: regime status.

## Regime alarm (Trial 07's forward role)

- **ALARM:** the trailing-12-month portfolio timing excess is below 0. The historical effect is not visible in the last year, so real-money promotion is frozen whatever the other gates say.
- Warning: trailing-6 below 0 while trailing-12 is at or above 0. Note it; no action.

## Promotion gates to the planned $300 real budget

All of these, sustained, before a real-money conversation rests on evidence:

1. **At least 4 consecutive weeks of clean operations** (the daily criteria), with every incident fixed and written up in `docs/incidents.md`. The clock restarted on 2026-10-11 after the resting-order incident.
2. **At least 10 completed real-fill round trips with the model-to-fill gap measured.** Met on 2026-10-11: 108 closed round trips, mean gross gap -0.05% (median -0.17%), entry fills a mean 23 bps above the signal close, exit fills a mean 17 bps above the model's exit close (`npm run report`).
3. **No regime ALARM** at decision time.
4. **An honest evidence review.** Every strategy is on watch (Trial 06); the only support is portfolio-level and historical (Trial 07, with a recent era that is not significant on its own). Trial 08 tests whether that support survives this account's costs. The base rates from three research reports stand: most retail algorithmic traders lose, and at this account size costs are the dominant force.
5. **A final fidelity period:** the last two weeks or more of paper at the real planned scale ($300 total, $100 a position), so the habits being promoted are the ones that transfer.
6. **Jalen amends the paper-only rule** in `trading_bot_instructions.md`, holds the keys, and owns the switch. No prompt, agent or assistant flips it, and the assistant never places a real trade.

For a real account later: a cash account (no pattern-day-trader flag; 28-day holds make settlement a non-issue). Alpaca's $10 crypto minimum means $300 supports exactly three $100 positions.

## Findings that shape operations

- **Alpaca paper does fill resting limits, at the maker rate, but has no queue.** The July 16 probe concluded the opposite from two $10 BTC limits canceled after 12 seconds. The incident's late fills settle it: eight good-til-canceled buys rested from 28 seconds to 44 hours and then filled at exactly their limit, and the three still held paid 0.12% to 0.15% in fees against 0.20% to 0.25% for orders that filled at once. Paper fills a resting limit whenever the market trades to it, with no queue position, so it overstates how often and how well passive orders fill. `ORDER_MODE=maker` stays off until a registered test accounts for that.
- **Ledger storage.** Moving the ledger to SQLite is still deferred; instead every write takes a file lock and repairs go through `npm run reconcile`, which backs the ledger up first.

## Amendments

- **2026-07-15:** budget raised from $300 to the full $100,000 paper account for breadth across 56 symbols (Jalen's call); the $300 scale moved to the fidelity period in gate 5.
- **2026-10-11:** after the resting-order incident (`docs/incidents.md`): orders settle and never rest; reconcile against broker fills; health pages on refused, resting or unattributed orders; per-agent heartbeats; the 5m scanner retired; agent definitions moved into `ops/launchd/`; gate 2 recorded as met; the operations clock in gate 1 restarted. Three registered daily criteria were replaced. "No unhandled `BLOCKED:` errors" became criterion 2 (no broker refusals) plus the health pages above. "Matured trades scored against real candles" now runs in every scan with model v2, which charges each sleeve's measured cost and reads a full lookback for stocks. "Budget guards held: never more than 3 positions or $300 deployed" stopped applying with the July 15 amendment; the guards are the risk controls in `trading_bot_instructions.md`. The finding that Alpaca paper never fills resting limits was wrong and is corrected above. Trial 08 recommends winding down the stock sleeve with `ENTRY_SKIP=@book-stocks`; that is Jalen's call.
