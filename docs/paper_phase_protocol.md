# Paper Phase Protocol (pre-registered 2026-07-15)

The operating rules for the autonomous paper-trading phase: what runs, how it is judged, and the gates between here and the planned **$300 real budget**. Written before the phase produces results, per house discipline.

## What runs (the machine)

| Agent | Cadence | What it does |
|---|---|---|
| `com.jalenedusei.trading.scan` | every 5 min | 5m sma-cross universe (BTC/ETH/SOL/SPY/QQQ), **simulation only** — the family is rejected; its remaining value is exercising the pipeline and measuring the memory system's counterfactuals |
| `com.jalenedusei.trading.tsmom-daily` | hourly | **The book (amended 2026-07-15 per user: full $100k for breadth discovery):** REAL paper orders across the 56-symbol universe (32 Alpaca-tradable cryptos ∩ Binance data + 24 top-liquidity stocks/ETFs), running the **state construction that passed Trial 07** — long whenever 28d momentum is positive, exit when it flips; $2,000/position, max 50 positions, $100k cap. Also runs the registered flip-entry watch tests (ETH/BNB/ADA/LINK) and SOL both-sides in simulation, unchanged. |
| `com.jalenedusei.trading.tsmom-monitor` | monthly (1st) | Recomputes the Trial 07 portfolio construction → `data/monitor_tsmom.csv` |

Execution safety: orders go only to the hardcoded paper host; no pyramiding, one action per signal candle, exits automatic (state-flip for the book, horizon for flip-entry rows). Every fill logs slippage vs signal close (for daily state entries this includes intraday drift since the signal candle — systematic and measured, not a bug); every exit logs actual P&L next to the model score. `npm run report` shows the per-symbol book with sample sizes — **per-symbol "best" rankings are noise until a symbol has dozens of completed trips (the Trial 06 lesson applies to forward data too).**

## Daily operational criteria (what "working" means)

1. Agents fired on schedule, or the gap is explained (Mac sleep — tolerated for daily, noted for 5m).
2. Every signal was acted on exactly once (dedup) or skipped with a stated reason.
3. Matured trades scored against real candles; broker exits fired at horizon (or deferred to market open with a log line).
4. No unhandled `BLOCKED:` errors; no invented data anywhere.
5. Budget guards held: never >3 positions or >$300 deployed.

## Weekly review checklist

- `npm run positions` — open positions vs budget.
- `tail data/tsmom-scan.log data/scan.log` — errors, gaps, refused duplicates.
- Ledger integrity: every `alpaca-paper` entry eventually gets a model score AND an `alpaca-paper-exit` actual; compare the pair (model vs actual gap = measured execution cost).
- Slippage stats: average fill slippage vs signal close (crypto ~spread; stocks include overnight gap — expected, measured, not a bug).
- `data/monitor_tsmom.csv` — regime status.

## Pre-registered regime alarm (Trial 07's forward role)

- **ALARM:** trailing-12-month portfolio timing excess < 0 → the historical effect is not visible in the last year; the family's evidentiary basis is failing forward. Consequence: real-money promotion is frozen regardless of other gates.
- Warning: trailing-6 < 0 with trailing-12 ≥ 0 → note it, no action.

## Promotion gates to the real $300 (process guidance — the decision itself is the user's)

All of the following, sustained, before the $300 conversation is evidence-based rather than hope-based:
1. **≥4 consecutive weeks of clean operations** (daily criteria met; incidents fixed and documented).
2. **≥10 completed real-fill round trips** with the model-vs-actual gap quantified (execution cost budget known, not assumed).
3. **Regime monitor: no ALARM** at decision time.
4. **Evidence status reviewed honestly:** as of registration, every strategy is *watch* (Trial 06) with portfolio-level historical support only (Trial 07, OOS-era statistically silent). The base rates from three research runs stand: most retail algo traders lose; costs are the dominant force at this account size.
5. **A final fidelity period before any real deployment:** the last 2+ weeks of paper run at the actual planned real scale (e.g., $300 total, $100/position) so the habits being promoted are the ones that transfer — the $100k breadth phase discovers, the fidelity phase rehearses.
6. **The user consciously amends §2** (paper-only) in `trading_bot_instructions.md`, holds the keys, and owns the switch. No prompt, agent, or assistant flips it — and Claude never executes real trades.

## Reliability & deferred decisions (recorded 2026-07-15)

- **Risk controls active** (see instructions): daily-loss halt, vol sizing, crypto-cluster cap, catastrophe stop. The launchd agents inherit these via config defaults — no plist change needed.
- **Deadman's switch:** `com.jalenedusei.trading.health` runs `npm run health` every 30 min and posts a macOS notification on any PROBLEM (stale heartbeat = Mac asleep / agent dead, regime ALARM, unreconciled broker position).
- **DEFERRED — SQLite migration of the ledger.** Justified but NOT done: three agents write `data/ledger.csv` hourly and 11 real positions reference it by row; migrating a live-written file risks the one irreplaceable asset (the real forward record). Instead the write path was made atomic (temp+rename). Do the DB migration only during a deliberate maintenance stop with all agents unloaded.
- **Cost/timing levers (built + tested 2026-07-15):** `ENTRY_WINDOW_MIN=120` and `LIMIT_SLIPPAGE_BPS=30` are LIVE on the daily agent — entries now cluster within 120 min after the 00:00 UTC daily close (fills near the signal price) via a bounded marketable limit capped at +30 bps.
- **KEY EMPIRICAL FINDING — maker orders can't be validated on paper.** `ORDER_MODE=maker` (passive limit below the mark) is fully built and tested, but **the Alpaca paper simulator does not fill a resting below-mark limit** (verified: a 5-bps-below and an at-mark $10 BTC limit both went unfilled/canceled; a +20-bps marketable limit filled instantly). So maker-fee capture (~the real cost win) is a **real-money-only** optimization — enabling maker mode on paper would halt entries. It stays OFF on the paper agent, ready for live. Graceful non-fill (cancel + retry, no ledger row) and stale-order cleanup are verified. The paper-appropriate improvement is the bounded marketable limit (fills + caps bad fills), which is what's enabled.

Also recorded for the real-money day: the real account should be a **cash account** (no PDT flag; 28-day holds make T+1 settlement cycling a non-issue), and Alpaca's $10 minimum notional means $300 supports the $100×3 structure exactly.
