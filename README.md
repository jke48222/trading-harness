# Paper Trading Bot

A TypeScript paper-trading bot that runs a 9/21 moving-average crossover on real BTCUSDT market data, remembers every trade and skip in a two-file memory system, and refuses to repeat setups it has genuinely lost on.

**It cannot place real orders.** There is no broker endpoint, no API-key requirement, and no live code path anywhere in `src/`. Execution is simulation only.

## What it does

- **Brain:** deterministic strategy code (built and iterated with Claude); **data:** Binance public klines (no key needed); **memory:** `data/ledger.csv` + `data/learnings.md`.
- Strategy: BUY when the 9-period MA crosses above the 21-period MA, SELL when it crosses below, HOLD otherwise — closed candles only, so signals never repaint.
- Risk: configurable order quantity and max position; anything that would exceed limits becomes SKIP with the reason logged.
- Memory: before any BUY/SELL the bot checks whether this symbol has really lost on this setup before (≥ 2 recorded losses, net negative, with a learnings warning) and skips known bad trades.

## Install

Requires Node.js ≥ 18.

```bash
npm install
```

## Commands

```bash
npm run scan            # one live decision cycle on real data — score matured trades → market → signal → risk → memory → paper order
npm run score           # score open scan trades whose 12-candle horizon has passed (real candles, real outcomes)
npm run replay:raw      # honest baseline over ~500 recent candles, memory IGNORED; writes real outcomes into memory
npm run replay:memory   # same window with memory consulted; prints raw-vs-memory comparison side by side
npm run memory:reset    # wipe ledger.csv and learnings.md back to empty (no seeded history; trials.csv is never wiped)
npm run broker:check    # read-only smoke test of the Alpaca PAPER account (GETs only, no orders)
npm run broker:preview  # DRY RUN: print the order the bot WOULD place for the current signal — nothing is sent
```

Recommended first run: `replay:raw` (seeds memory from real history) → `replay:memory` (see what memory would have changed) → `scan` on a schedule while paper testing.

The broker adapter ([src/broker/alpaca.ts](src/broker/alpaca.ts)) was added after the Alpaca paper connection was verified (Prompt 01, 2026-07-14). It is **read-only by construction**: the paper host is hardcoded, only GET requests exist, and `broker:preview` builds its payload locally without calling the trading API. Keys come from `.env` (`ALPACA_PAPER_KEY_ID`/`ALPACA_PAPER_SECRET`, gitignored).

## Configuration

Defaults live in [src/config.ts](src/config.ts); override via environment variables or a `.env` file (`cp .env.example .env`):

| Variable | Default | Meaning |
|---|---|---|
| `SYMBOL` / `INTERVAL` | `BTCUSDT` / `5m` | market and timeframe |
| `FAST_MA` / `SLOW_MA` | `9` / `21` | crossover periods |
| `QUANTITY` / `MAX_POSITION` | `0.001` / `0.003` | paper order size and position cap (base units) |
| `REPLAY_CANDLES` / `EVAL_HORIZON` | `500` / `12` | replay window and holding period (candles) |
| `FEE_BPS` | `10` | round-trip fee+slippage assumed in replay scoring |
| `MEMORY_MIN_LOSSES` | `2` | real losses required before memory may block a setup |

One-off experiments: `SYMBOL=ETHUSDT INTERVAL=15m npm run replay:raw`

## Memory files

- `data/ledger.csv` — every paper/replay trade and skip: `timestamp,symbol,action,price,quantity,reason,mode,outcome,pnl`
- `data/learnings.md` — one plain-English lesson per setup tag, written **only** from real losing outcomes
- `data/trials.csv` — append-only disclosure of **every configuration ever backtested** with its metrics (deep-research finding F6: a backtest without a disclosed trial count is formally worthless). Written by every replay run; `memory:reset` never touches it.

Ledger and learnings are created on first use and by `memory:reset`. The scan position is derived from executed `scan` rows in the ledger; `memory:reset` flattens it.

## Forward paper trading on a schedule

Scan trades are logged `open`, then `npm run score` (run automatically at the start of every scan) fills in real win/loss outcomes once the 12-candle horizon has passed — verified against real Binance candles, never guessed. Scored scan losses refresh `learnings.md`, so memory learns from live decisions too.

A launchd agent runs `npm run scan` every 5 minutes and appends to `data/scan.log`:

```
launchctl print gui/$(id -u)/com.jalenedusei.trading.scan   # status
launchctl bootout gui/$(id -u)/com.jalenedusei.trading.scan # stop it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jalenedusei.trading.scan.plist  # start it again
```

launchd never overlaps runs, so ledger writes stay serialized.

## How execution works (and stays safe)

`src/execution.ts` simulates fills locally and loudly labels them PAPER. Guardrails against accidental live orders:

1. No broker/exchange SDK or order endpoint exists in the project.
2. No API keys are read by any code path today; `.env` credentials are reserved for a future adapter and `.env` is gitignored.
3. `LIVE_TRADING_ENABLED` is hardcoded `false` and even flipping it only trips a safety throw — there is nothing live to call.
4. If market data is unavailable, the bot prints `BLOCKED:` with the cause and exits — it never fakes candles or results.

**Optional paper MCP/API mode (future):** only after you verify a broker/exchange MCP in paper mode (restricted or sub-account keys, read-only smoke test, no order placed) may a `src/broker/` adapter be added, together with `broker:check`/`broker:preview` scripts. Keys go in the MCP client config or a secrets store — never in source, never in chat.

## Experimenting with a new strategy or symbol

1. Change env vars (symbol/interval/MA periods) or edit `src/strategy.ts` for new indicators — keep the `Signal` shape and a distinct `setupTag` per setup type.
2. Backtest the idea first (TradingView; see `docs/prompt_sequence.md` Prompt 02), then `npm run replay:raw` to get the honest local baseline.
3. `npm run replay:memory` to see what memory changes; keep paper trading (`npm run scan` on a schedule) for at least a week.
4. Only consider real money after paper results are stable — and then start with 1–3% of your maximum risk tolerance, on a restricted sub-account.

## Limitations (honest ones)

- The replay is a setup-quality study (fixed 12-candle exit, 10 bps costs), not a compounding portfolio simulation with stops/targets.
- ~500 candles of 5m data ≈ 41 hours — an in-sample snapshot, not a validated edge. Regime changes will change results.
- A 9/21 crossover on 5m is a teaching strategy, not an edge claim. Validate before trusting it with anything.
- Two-file memory is right for this stage; if you become high-frequency, migrate the ledger to a database (Supabase/Firebase) as the video suggests.
