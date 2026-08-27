# Trial 04 — Time-Series Momentum on Daily Candles (pre-registered)

Registered: 2026-07-15 ~16:35 UTC, **before** implementation or any data run. No amendments after seeing results.

## Why this class

The one family with direct published support for crypto at retail-payable frequencies: time-series momentum at ~1–4 week horizons (Liu & Tsyvinski 2021; TSMOM, Moskowitz–Ooi–Pedersen 2012), and the deep-research finding that **daily-frequency rules were the only cost-robust ones** (~55–84 trades vs 500+ intraday; Deprez & Frömmel 2024). Daily signals with month-long holds pay 30 bps a handful of times per year — costs stop being the whole story for the first time in this project.

## Stopping-rule statement (why this trial does NOT loop until green)

The user's directive is to reach positive expectancy. The only honest path is a small, declared number of looks: every additional strategy family tested against the same out-of-sample window raises the probability that a "pass" is luck (with ~9 OOS cells per trial, a few trials of mining would all but guarantee a false positive). **Budget: this is the 4th and final strategy-family trial on this OOS data.** If it fails, the next lever is not another indicator — it is cost engineering (maker fees, venue), longer horizons, or accepting the research's null result. A future trial would need fresh OOS data (i.e., forward time).

## Exact rules (locked)

- Data: daily closed candles from listing (BTC/ETH ≈ Aug 2017, SOL ≈ Aug 2020), Binance public data.
- **v1 (TSMOM flip):** momentum = close today ÷ close 28 days ago − 1. BUY when momentum crosses from ≤0 to >0; SELL when it crosses from ≥0 to <0. Fresh crosses only.
- **v2 (daily trend cross):** BUY when close crosses above SMA100(1d); SELL when it crosses below (implemented as the existing sma-cross engine with fast=1, slow=100).
- **v3:** v1 long-only.
- Scoring: enter at signal close, exit at close **28 daily candles** later, net `FEE_BPS`. **Adoption basis 30 bps**; 10 bps reported as sensitivity (BTC OOS only).
- Lookback 28, SMA 100, horizon 28 are classic literature defaults chosen before any run; not tunable within this trial.

## Windows, symbols, gates (locked — same as Trial 03)

- IS = first 70% of each symbol's span, OOS = last 30%, boundary mechanical; setups must enter and exit inside their window.
- Symbols: BTCUSDT (primary), ETHUSDT, SOLUSDT.
- Battery: 3 × {IS, OOS} × 3 at 30 bps + BTC OOS at 10 bps ×3 = **21 disclosed runs**, `REPLAY_WRITE_MEMORY=false`.
- Gates on OOS at 30 bps: (1) ≥30 completed setups — **daily signals are rare; a cell under 30 is declared "insufficient sample," not judged**; (2) avg/setup > 0; (3) profit factor > 1.1; (4) IS/OOS sign agreement. Passing = candidate → requires TradingView confirmation + forward paper before adoption.

---

## Results (run 2026-07-15; local per-setup engine, OOS at 30 bps)

| Cell | OOS n | OOS PF | OOS avg/setup | Gates |
|---|---|---|---|---|
| BTC v1 (TSMOM both) | 95 | 1.00 | −0.01% | fail |
| BTC v2 (SMA100 cross) | 41 | 1.18 | +0.78% | pass (raw) |
| BTC v3 (TSMOM long-only) | 47 | 1.52 | +2.09% | pass (raw) |
| ETH v1 | 77 | 1.04 | +0.43% | fail (PF) |
| ETH v2 | 41 | 1.00 | 0.00% | fail |
| **ETH v3 (TSMOM long-only)** | **38** | **1.33** | **+2.91%** | **pass** |
| **SOL v1 (TSMOM both)** | **49** | **1.11** | **+0.76%** | **pass (marginal)** |
| SOL v2 | 34 | 1.00 | −0.005% | fail |
| SOL v3 | 24 | — | −3.53% | insufficient sample |

**Drift adjustment (not a locked gate — the honesty check for long bias).** Unconditional 28-day long return over each OOS window, net of 30 bps: BTC +2.03%, ETH +1.08%, SOL −1.44%. Therefore:
- **BTC v3 (+2.09% vs +2.03% drift): the entire result is market drift — no timing skill. Set aside despite passing raw gates.**
- BTC v2 (+0.78%, below long drift): weak; set aside.
- **ETH v3 (+2.91% vs +1.08% drift): ≈ +1.8%/setup of genuine selectivity. Candidate.**
- **SOL v1 (+0.76% while drift was −1.44%): positive in a falling market. Marginal candidate.**

**TradingView confirmation (position-based engine, 0.15%/side = 30 bps, same windows):**
- ETH long-only OOS: 39 trades, **PF 1.67, net +8.3%**, maxDD 4.4% — while buy-and-hold ETH lost over the window. CONFIRMED.
- SOL both-sides OOS: 49 trades, **PF 1.11, net +1.8%**, Sharpe ≈ 0 — while buy-and-hold lost ~64%. Confirmed as marginal.

## Verdict: two CANDIDATES (not validated) — forward phase started

- **ETH 28d TSMOM long-only** and (marginally) **SOL 28d TSMOM both-sides** pass locked gates, beat their drift benchmarks, and replicate on an independent engine. Everything else fails or is drift in disguise.
- Standing caveats, recorded before anyone gets excited: 38–49 OOS setups is a modest sample; monthly-horizon crypto momentum is a known literature effect that has weakened over time; and two candidates emerging from a 21-cell grid still carries selection risk. **That is exactly what the forward paper phase measures.**
- Forward test live as of 2026-07-15: launchd agent `com.jalenedusei.trading.tsmom-daily` (hourly) scans ETH (long-only) and SOL (both) on daily candles at FEE_BPS=30, scoring at the 28-day horizon. First candidate entry: ETH BUY @ 1891.87 on 2026-07-15 (momentum flip −1.08% → +5.51%). Adoption for anything beyond paper still requires the forward sample per the research gates (~300 trades is unreachable at this frequency — the realistic forward gate is: candidate stays net-positive after ≥20–30 forward setups, i.e. months, with the trials ledger open the whole time).
