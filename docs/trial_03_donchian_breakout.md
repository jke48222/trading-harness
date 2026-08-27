# Trial 03 — Donchian Breakout Trend-Following on 1h (pre-registered)

Registered: 2026-07-15 ~16:20 UTC, **before** implementation or any data run. No amendments after seeing results; a new idea = a new pre-registered trial.

## Why this class (evidence base, stated honestly)

Trials 01–02 killed the 5m MA-cross family: its per-trade edge is ~zero pre-cost, so round-trip costs decide everything. The deep-research report's strongest cost finding (Deprez & Frömmel 2024; Svogun & Bazán-Palomino 2022) is that **daily-frequency rule portfolios were far more cost-robust than intraday** (~55–84 trades vs 500–1,100; conclusions flipped by <5 bps of extra cost). The honest inference is not "breakouts work" — it's "whatever is tested next must trade far less often." This trial moves to 1h bars with a 1-day holding horizon (~12× fewer cost events than 5m) using the most classic untuned breakout rule available (Donchian 20). Evidence for this exact rule on crypto is directional, not proven — that is what the test is for.

## Exact rules (locked)

- Data: 1h closed candles, ~9,600 (≈400 days), Binance public data.
- **LONG setup:** close crosses above the highest high of the prior 20 closed 1h candles (fresh cross only: previous candle's close was at or below its own prior-20 high).
- **SHORT setup:** mirror — close crosses below the lowest low of the prior 20 candles.
- Scoring model (same engine as all trials): enter at signal-candle close, exit at close **24 candles (1 day)** later, net of `FEE_BPS`. Per-setup study, non-compounding.
- **Adoption cost basis: 30 bps** round trip (research: real ≈28). 10 bps reported as sensitivity only.

## Variants (3, locked — no variant D)

| Variant | Rules |
|---|---|
| v1 | Raw breakout, both directions |
| v2 | Trend-aligned: long only when close > SMA200(1h), short only when below |
| v3 | Long-only raw (crypto short-side is weak in the literature) |

Donchian length 20, horizon 24, SMA 200 are classic defaults, chosen before any run and not tunable within this trial.

## Windows, symbols, and disclosure (locked)

- **IS = first 70% of the loaded span; OOS = last 30%.** Boundary computed mechanically from the data span. A setup counts only if it **enters and exits inside its window** (boundary-crossers are excluded as incomplete).
- Symbols: **BTCUSDT (primary), ETHUSDT, SOLUSDT (secondary)** — same locked rules, adoption judged per symbol. Stocks are deferred to a future trial: Alpaca IEX 1h bars include thin extended-hours prints that corrupt Donchian channels; they need RTH filtering built first. Noted, not skipped silently.
- Battery = 3 variants × {IS, OOS} × 3 symbols at 30 bps (18 runs) + BTC OOS sensitivity at 10 bps (3 runs) = **21 disclosed runs**, all with `REPLAY_WRITE_MEMORY=false`.

## Adoption gates (locked; judged on OOS at 30 bps)

1. ≥ 30 completed OOS setups;
2. OOS average PnL per setup > 0;
3. OOS profit factor > 1.1;
4. IS and OOS agree in sign (no in-sample mirage).

A variant that passes on a symbol becomes a **candidate**, not validated: it then requires (a) a TradingView confirmation backtest and (b) forward paper accumulation before any adoption into the live scanner. If every variant fails on every symbol, the class is rejected on this data and the next pre-registered trial moves to a different class (leading candidate: daily/weekly time-series momentum, the most cost-robust family in the report).

---

## Results (run 2026-07-15, ~400 days of 1h data per symbol, IS/OOS boundary 2026-03-17T16:36Z)

Avg PnL per setup at the locked 30 bps basis (OOS setup counts in parentheses — all ≥ 75):

| Variant | BTC IS / OOS | ETH IS / OOS | SOL IS / OOS |
|---|---|---|---|
| v1 raw | −0.35% / −0.20% (185) | −0.08% / −0.57% (166) | −0.12% / −0.47% (181) |
| v2 trend-aligned | −0.36% / −0.11% (139) | −0.05% / −0.55% (120) | −0.35% / −0.42% (135) |
| v3 long-only | −0.57% / −0.28% (84) | −0.13% / −0.56% (75) | −0.04% / −0.40% (85) |

**Every one of the 18 scored runs is negative at 30 bps.** No gate is met anywhere (gates 2 and 3 fail in all 9 OOS cells).

Fee sensitivity (BTC OOS at 10 bps, reporting only — not an adoption basis): v1 −0.003%, **v2 +0.087%** (139 setups, 52.5% win), v3 −0.076%. The v2 cell is the only positive number in the 21-run grid, appears only at the optimistic fee assumption, and its own IS window is negative (sign-flip → fails gate 4 regardless). Recorded as what it is: a reminder that this strategy family's economics are entirely a bet on execution costs, not a candidate.

Harness note: 9 additional rows in `trials.csv` timestamped just before this battery are accidental duplicate runs of the default 5m sma-cross config (a zsh env-passing bug in the run harness, since fixed). They are left in the ledger because every look stays disclosed; they also wrote ~2 days of ordinary replay rows/lessons to trade memory before `REPLAY_WRITE_MEMORY=false` took effect on the corrected runs.

## Verdict: REJECTED (all variants, all symbols)

Donchian-20 breakout with a 1-day horizon has negative expectancy after realistic costs on 400 days of BTC, ETH, and SOL 1h data. Per the pre-registration, the next trial moves to the **daily/weekly time-series momentum** family — with the explicit caveat that at daily frequency, ~400 days cannot produce 30 OOS setups, so Trial 04 must first define a data span (multi-year daily candles) that makes its own sample-size gate satisfiable. Three trials in, the running scoreboard says what the literature says: fast technical rules on liquid crypto do not clear retail execution costs.
