# Deep Research Report 02 — Fast Profitability Under Real Constraints

Run 2026-07-15 via the deep-research workflow (104 agents, 22 primary/secondary sources fetched, 97 claims extracted, 25 adversarially verified 3-vote, **21 confirmed / 4 refuted**). Prompt: `deep_research_prompt_02_fast_profitability.md`. This is the honest follow-up to `deep_research_report.md` (run 1).

> **Scope honesty (read first).** The adversarial verification budget covered **Q1 (cost floor), Q2 (fast-strategy families), Q3 (validation math)** — the parts of the brief that could be settled with primary sources. **Q4–Q10 (TSMOM decay, capped pilots, prop firms, stock data, Kelly sizing, LLM agents, tax/regulation) did NOT get verified claims** in the final synthesis; search agents surfaced sources for them but they did not pass through the 25-claim verification gate. Those are marked **[SEARCH-SURFACED, UNVERIFIED]** below and must be treated as leads, not findings.

---

## Executive summary

The evidence **decisively refutes the two premises the brief most wants to be true**: that a US retail account can hit a 30 bps round-trip cost floor, and that fast or passive-execution strategies can be made net-profitable at $1k–$10k. It **confirms** that the project's validation discipline is not yet strong enough — 112 trials on ~5–6 years of data is mathematically past the overfitting threshold, so a formal multiple-testing correction is now mandatory before any candidate is trusted with real money.

## Verified findings (3-vote adversarial, confirmed)

### 1. The 30 bps cost floor is unachievable at $1k–$10k. *(confidence: high, 3-0 / 2-1)*
Real 2026 entry-tier US fee schedules:
- **Kraken Pro** standard spot entry tier: **0.40% maker / 0.80% taker = 80 / 160 bps round-trip** — 2.7×–5.3× the 30 bps assumption. Fees don't drop near 30 bps until $100K+ monthly volume.
- **Alpaca crypto** entry tier ($0–100K): **0.15% / 0.25% = 30 bps maker/maker, ~40 bps mixed, 50 bps taker/taker.** Alpaca crypto is **NOT commission-free** (only its *stock* trading is) — this kills any "zero-fee, spread-only" plan.
- **Exchange fees ALONE meet or exceed 30 bps before any spread or slippage**, and are 3×–5× the ~10 bps break-even where the rejected fast strategies would have flipped positive.
- Sources: Kraken official fee schedule (primary, July 9 2026), Alpaca official crypto fee docs (primary).

### 2. The "post limit orders to earn the spread" escape hatch is closed. *(high, 3-0 / 2-1)*
Passive maker orders don't rescue a cost-killed strategy, because **the fills you get are systematically the adverse ones**:
- Live Binance BTC-perp experiment (232,897 maker orders, 2024): negative correlation between fill likelihood and post-fill return; average maker fill carries **−0.8 bp adverse selection (−0.3 bp even after a rebate retail usually can't get)**.
- Naive passive market-making: **annualized Sharpe −109**, ~60% loss over ~3 days.
- CME futures (ES/NQ/CL/ZN): **66%–89% of all limit-order fills were adverse.**
- A real **+1 bp taker edge was fully erased by per-leg taker fees** — an independent replication of your own "edge ≈ 0 pre-cost, costs decide" finding.
- Naive limit-fill backtest simulators under-count adverse fills and inflate short-horizon results (bias worsens at higher frequency) — so a maker-based "cost fix" would look good in backtest and fail live.

### 3. Fast arbitrage is not a retail profit path. *(high, 3-0)*
- **Funding-rate / basis (delta-neutral):** only **40% of even the TOP opportunities** net positive after costs (26 exchanges, 749 symbols, Jan 2026).
- **Triangular arb:** on Binance BTC/LTC/USD over one week (30.9M snapshots), 4,879 gross opportunities → **18 survived retail fees, netting $12–$18 total for the entire week** on ~$4,070 clips. The paper's own word: "negligible."
- **Cross-exchange:** headline 8.67%–15.69% BTC spreads are **gross price dispersion, not capturable profit** — larger precisely on the non-US, non-trustworthy venues you can't legally/safely reach; they measure the frictions that *prevent* arbitrage (Makarov & Schoar confirm costs can't explain the spread size — it's capital controls and counterparty risk).

### 4. 112 trials on ~5–6 years is past the overfitting threshold. *(high, 3-0 / 2-1)*
- Bailey / López de Prado math: with only 5 years of data, **trying more than ~45 configurations nearly guarantees an in-sample Sharpe of 1 with a true out-of-sample Sharpe of ZERO.** Even N=10 zero-edge configs yields an expected best in-sample Sharpe of 1.57.
- Disclosing N (which the trials ledger does) is a *necessary* condition for assessing overfitting — but disclosure alone isn't correction.
- **Actionable:** a pre-registered **deflated Sharpe ratio** or **Benjamini-Hochberg FDR** correction against N=112 is required before trusting any candidate. The raw OOS PF 1.17–2.91 numbers are not yet corrected for how many looks produced them.

## Four claims REFUTED (0-3) — do not reintroduce
Two overstated the funding-rate paper ("95% forced exits", "costs are THE binding constraint"); two over-read an SSRN savings-plan paper ("1 bp market-maker ceiling", "predictable-retail-flow penalty"). The verifiers killed all four.

## [SEARCH-SURFACED, UNVERIFIED] — leads for Q4–Q10, not findings
These appeared in search results but did **not** pass verification — treat as pointers to primary sources to check, not as established facts:
- **Q4 forward haircut:** McLean & Pontiff (2016), *Journal of Finance*, 97 anomalies — returns ~**26% lower out-of-sample, ~58% lower post-publication.** If it holds for crypto TSMOM, an OOS PF near 1.1–1.3 could decay to breakeven; the PF 2.9 candidates have more cushion. **Verify before relying on it.**
- **Q6 prop firms:** aggregated ~300k prop accounts — **~14% pass a challenge, ~7% ever reach a payout, average payout ~4% of funded amount.** High scam base rate. Unverified.
- Q5/Q7/Q8/Q9/Q10: no confirmed claims; the run did not resolve capped-pilot design, stock data sources, Kelly tables, LLM-agent evidence, or 2026 tax/regulation. A follow-up run scoped to just these is the way to close them.

## What this means for the brief (line by line)
- **"Fast trading"** → Refuted as a profit path at retail cost levels. Every fast family audited loses after real fees. Confidence: high.
- **"Fast profitability"** → No evidence-backed fast path found for a solo US retail coder at $1k–$10k. The cost floor (Finding 1) and adverse selection (Finding 2) are structural, not tuning problems.
- **"Real money next week"** → The verified material doesn't support it; the honest bounded-risk version (capped pilot) is exactly the Q5 question the run left unverified. Not a green light.
- **"No months of testing"** → Finding 4 says the opposite of what's wanted: the existing 112 looks *increase* the validation burden, they don't shorten it. A multiple-testing correction is now the gate.

## Open questions the run explicitly could not answer
1. Your **actual** all-in round-trip on *your* 5m/1h timeframe and venue (the literature proves the floor is unreachable and passive fills are adverse, but nobody measured *your* directional-entry fill quality — needs your own instrumented experiment).
2. The real forward haircut on the daily-TSMOM candidates (Q4 unverified).
3. Which specific correction (deflated Sharpe vs BH-FDR vs White's Reality Check) and what numeric gate to pre-register against N=112.
4. Whether *any* remaining fast family (short-horizon stat-arb, event/news) has audited net-positive retail evidence — unanswered, treat as unsupported until shown.

## Primary sources (verification-passing)
- Kraken official fee schedule; Alpaca official crypto fee docs (Q1).
- "The Market Maker's Dilemma" (Oxford, live Binance BTC-perp); "Market Simulation under Adverse Selection" (CME futures); "Explainable Patterns in Cryptocurrency Microstructure" (Univ. Warsaw) (Q2).
- MDPI Mathematics funding-rate two-tier study (2026); Muck/Schmidl/Wolf triangular-arb (Finance Research Letters 2025); John/Li/Liu 80-exchange pricing (SSRN 2024) + Makarov & Schoar (JFE 2020) (Q2).
- Bailey/Borwein/López de Prado/Zhu "Pseudo-Mathematics and Financial Charlatanism" (Notices of the AMS 2014); Sermpinis et al. Discrete-FDR on MSCI indices (2021) (Q3).
