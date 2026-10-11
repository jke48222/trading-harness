# trading-harness

[![CI](https://github.com/jke48222/trading-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jke48222/trading-harness/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/github/license/jke48222/trading-harness)](LICENSE) ![TypeScript](https://img.shields.io/github/languages/top/jke48222/trading-harness) ![Orders: Alpaca paper only](https://img.shields.io/badge/orders-Alpaca%20paper%20only-0284c7)

A research harness for testing whether a small trading bot has a real edge, and an autonomous paper book that trades the one strategy that passed.

<sub>Paper money only. Orders can reach only Alpaca's paper host, which serves no live accounts. Not investment advice.</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/dashboard-dark.png">
  <img src="docs/media/dashboard.png" alt="The local dashboard on 2026-10-11: health all clear for the book and both watch agents, $105,444 equity with $7,658 of open gains and $54,193 deployed of the $100,000 budget, and the account's +5.31% return since July 15 next to BTC's +27.05%">
</picture>

## What is it?

Each strategy test here is registered before it runs: the rules, the data window and the pass bar are committed first, every configuration tried is logged to [`data/trials.csv`](data/trials.csv) (118 rows covering 57 distinct configurations), and a pass has to survive a correction for that count. Three fast technical rules were rejected outright, five per-trade candidates failed the correction, and one portfolio construction passed (Trial 07). Trial 08 confirmed it at this account's real costs and found no support for the same rule on US stocks. Since July 2026 a set of launchd agents has traded it on a $100,000 Alpaca paper account, with every fill reconciled against the ledger.

## Results

| Trial | Question | Result |
|---|---|---|
| 01 | 9/21 moving-average cross, BTCUSDT 5m | Rejected: out-of-sample profit factor 0.52 |
| [02](docs/trial_02_htf_regime_filter.md) | The same cross with a 1h trend filter | Rejected: profit factor 0.69 and 0.45 |
| [03](docs/trial_03_donchian_breakout.md) | Donchian-20 breakout, 1h | Rejected: 18 of 18 runs negative at 30 bps |
| [04](docs/trial_04_tsmom_daily.md) | 28-day time-series momentum (TSMOM), daily, per trade | 2 candidates |
| [05](docs/trial_05_tsmom_universe.md) | TSMOM on 9 more symbols | 3 more candidates; 2 set aside as market drift |
| [06](docs/trial_06_multiple_testing_correction.md) | Multiple-testing correction of 04 and 05 | All 5 candidates fail: p 0.22 to 0.42 |
| [07](docs/trial_07_portfolio_reanalysis.md) | TSMOM as an equal-weight portfolio of 8 unselected cryptos | **Pass:** +4.30% a month over its own average exposure, p = 0.0004; the 2023 to 2026 subsample alone is not significant |
| [08](docs/trial_08_cost_and_sleeves.md) | Trial 07 at this account's real costs, on the book's 32 coins, and on US equity ETFs | Crypto holds: +3.74% a month on Trial 07's coins and +2.99% on the book's 32, p = 0.0011 each. Stocks fail: -0.23% a month, negative before costs |

Trial 08 is why this README recommends winding down the book's stock sleeve. Over ten years, 28-day momentum timing lost to its own average exposure on all 15 unselected US equity ETFs, before costs, and the paper book's stocks lost $1,869 over 66 round trips. The crypto result survived this account's real costs with room to spare: it breaks even at 162 to 193 bps per position change, and the account pays about 30. Two cautions stand. The 2023 to 2026 era alone is not significant, and a Bonferroni correction for all 57 configurations ever tried would give 0.063.

### The paper book

From 2026-07-15 to 2026-10-10 the paper account returned +5.3%, with a -4.0% maximum drawdown. Over the same days BTC returned +27.0%, SPY +3.8%, and the book's 56 symbols held in equal weights +23.6%. In a broad crypto rally, holding everything beat a strategy that historically sits in each coin about half the time, and the book was also short of crypto for most of the period because resting orders blocked its entries ([incident](docs/incidents.md)).

The execution itself is faithful. Across 108 closed round trips, fills differed from the model's gross return by a mean of -0.09% a trip (median -0.18%). Realized results split by sleeve: stocks lost $1,869 over 66 trips, crypto was near flat at -$31 over 42, and open crypto positions held about $6,500 of unrealized gains on October 11. `npm run report` and `npm run perf` reproduce these numbers.

## Get started

You need Node 20.6 or later. Market data for crypto is public; stock data, paper trading and the reports need [Alpaca paper keys](https://app.alpaca.markets/paper/dashboard/overview).

1. **Install:** `git clone https://github.com/jke48222/trading-harness && cd trading-harness && npm ci`
2. **Test:** `npm test` runs 93 tests with the broker and market data mocked.
3. **Replay a strategy on public data:** `npm run replay:raw`. Pick one with `STRATEGY`, `SYMBOL` and `INTERVAL`; every run is appended to `data/trials.csv`.
4. **Connect a paper account:** `cp .env.example .env` and set `ALPACA_PAPER_KEY_ID` and `ALPACA_PAPER_SECRET`. Then `npm run broker:check` reads the account without placing anything.
5. **Run the book:** `scripts/agents.sh install` loads the hourly book agent, the 30-minute health check and the monthly regime monitor on macOS. `scripts/agents.sh status` shows them; `uninstall` removes them.

## Commands

| Command | What it does |
|---|---|
| `npm run scan` | One decision cycle over `SYMBOLS`: score matured trades, manage exits, look for entries |
| `npm run report` | The book from broker fills: round trips by sleeve, model against actual, fees, per symbol |
| `npm run perf` | Account return, drawdown and volatility against BTC, SPY and an equal-weight hold of the universe |
| `npm run reconcile` | Rebuild round trips from broker fills and list where the ledger disagrees; `-- --apply` repairs what the fills prove |
| `npm run health` | Agents, open orders, positions and the regime monitor; exits 1 on any problem |
| `npm run positions` | Open paper positions and budget use |
| `npm run tsmom:monitor` | Recompute Trial 07's construction month by month and check the registered alarm |
| `npm run dashboard` | Local console at http://127.0.0.1:8787 |
| `npm run replay:raw` / `replay:memory` | Replay a strategy over recent history, without and with the memory filter |
| `npm run typecheck` / `npm test` | TypeScript check and the test suite |

## How it works

```
Binance / Alpaca bars ──> signal (closed candles only) ──> risk gates ──> order ──> settle ──> ledger
                                                                                     │
Alpaca fills ─────────────────────────────────────────> round trips ──> reconcile ───┘
```

- **Signals** use closed candles only, so they never repaint. The book runs Trial 07's state construction: hold a symbol while its 28-day return is positive, sell when it turns.
- **Risk gates** ([`src/portfolioRisk.ts`](src/portfolioRisk.ts)): an 8% daily-loss halt on new entries, volatility-scaled size, a 70% cap on crypto (it moves as one bet), a 30% catastrophe stop, and no pyramiding.
- **Orders** ([`src/broker/orders.ts`](src/broker/orders.ts)) are priced off the venue's own quote and rounded up to Alpaca's increment. A crypto entry is skipped when the spread is over 100 bps. Every order settles, filled, partly filled or canceled after 30 seconds, and a scan sweeps anything a crash left behind.
- **The ledger** (`data/ledger.csv`) records every decision with a plain-English reason. Writes take a file lock, so two agents can't drop each other's rows.
- **Broker truth** ([`src/broker/fills.ts`](src/broker/fills.ts)): round trips are rebuilt from Alpaca's fills, which are the record of what traded. `reconcile` compares them with the ledger.
- **Health** reads a heartbeat from each agent and posts a macOS notification on refused or stuck orders, unattributed positions, failed exits or a silent agent.

The operating rules and the gates before any real money are in [`docs/paper_phase_protocol.md`](docs/paper_phase_protocol.md).

## Limits and known issues

- **Paper fills are not real fills.** Alpaca's paper engine fills marketable orders at once and fills a resting limit whenever the market trades to it, with no queue, so it flatters passive orders. Maker-fee savings can't be judged from paper fills.
- **The book's sizing differs from the test.** Trial 07 tested equal weights; the book scales size down for volatile coins. That is a risk control, and its effect on returns is untested.
- **Crypto was under-deployed from July 27 to October 11.** Resting orders held back cash and blocked crypto entries on 48 days ([incident write-up](docs/incidents.md)). Results from that period understate the crypto positions the strategy called for.
- **launchd pauses while the Mac sleeps**, so the book misses scans until it wakes. Crypto entries only open in the two hours after the 00:00 UTC close.
- **Stock orders go in at the first scan after the open**, up to an hour after 9:30 ET.
- **Trial 07's recent era is not significant on its own** (2023-12 onward, p = 0.23). The monthly monitor watches for the registered alarm: a negative trailing-12-month excess.

## Project layout

```
src/            bot, strategy, risk, scoring, reports, health, dashboard server
src/broker/     Alpaca paper adapter (orders, fills, reconcile)
scripts/        trial analyses, the regime monitor, scripts/agents.sh
docs/           trial pre-registrations and results, protocol, incidents
data/           ledger.csv, trials.csv, learnings.md, monitor output
ops/launchd/    the agents' plist templates
test/           node:test suites
```

## Credits and license

The first build followed the "Paper Trading Bot Prompts" guide from Miles High Club ([details](docs/prompt_sequence.md)). MIT, see [LICENSE](LICENSE). Not affiliated with Alpaca, Binance or TradingView.
