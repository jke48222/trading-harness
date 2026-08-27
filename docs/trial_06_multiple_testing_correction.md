# Trial 06 — Multiple-Testing Correction on the 5 Live Candidates (pre-registered)

Registered: 2026-07-15 ~18:05 UTC, **before** any statistic below was computed. This trial adds **no new looks at market data** — it re-analyzes the already-registered OOS setups of the 5 forward candidates to answer the question both deep-research runs converged on: *after correcting for the ~112-trial search that produced them, are any of the candidate results statistically distinguishable from luck?* (Bailey/López de Prado: >45 configs on ~5 years nearly guarantees a spurious in-sample winner; Kelly literature: sizing off uncorrected edges is the input that produces ruin.)

## Data (fixed)

Per-setup OOS returns for the five registered candidates, recomputed via the bot's own `computeSetups` engine (exact same scoring: entry at signal close, exit 28 daily candles later, net 30 bps), same registered windows:

| Candidate | Config | OOS window start |
|---|---|---|
| ETH long-only | tsmom 28/28 | 2023-11-12T02:24Z |
| BNB long-only | tsmom 28/28 | 2023-12-06T09:36Z |
| ADA long-only | tsmom 28/28 | 2024-01-24T00:00Z |
| LINK long-only | tsmom 28/28 | 2024-04-15T04:48Z |
| SOL both-sides | tsmom 28/28 | 2024-10-04T02:24Z |

Daily candles mean today's re-fetch reproduces the same closed-candle series as the registered runs (last close 2026-07-14).

## Primary statistic (locked)

Per candidate: **drift-adjusted excess per setup** — the skill claim, not the beta claim.
- `g` = mean unconditional 28-day gross return over the candidate's OOS window (computed from the same daily series).
- Long benchmark `b_L = g − 0.30`; short benchmark `b_S = −g − 0.30` (percent, net of the 30 bps adoption basis).
- Excess per setup = net setup PnL − benchmark of its leg.
- **H0: E[excess] ≤ 0**, one-sided. p-value by percentile bootstrap of the mean, **10,000 resamples, deterministic seed (mulberry32(42))** — bootstrap because these distributions are skewed/outlier-carried (ADA especially), so a t-test would flatter them. Raw (non-drift-adjusted) p reported alongside for transparency, but the drift-adjusted test is the verdict-bearing one.

## Corrections (locked, two tiers — truth lies between them)

- **Tier 1 (optimistic bound): Benjamini-Hochberg FDR at q = 0.10 within the 5-candidate family.** Ignores the wider search; passing only this is NOT search-proof.
- **Tier 2 (conservative bound): Bonferroni against the full disclosed search** — pass if p ≤ 0.05 / N_configs, where N_configs = unique tested configurations in `data/trials.csv` (key: strategy + symbol + params with window/fee views collapsed; re-runs of the same hypothesis are not new hypotheses). N_rows also reported.

## Verdicts (locked consequences)

- **Pass Tier 2** → "corrected-significant candidate" (still requires the forward gate before any pilot).
- **Pass Tier 1 only** → "indeterminate — forward data decides." Publish the required forward sample size.
- **Fail Tier 1** → demoted from candidate to **watch**: forward paper test continues (it is free information) but the config is **pilot-ineligible** until forward data independently clears the gate.

## Forward-sample requirement (locked formula)

The forward paper test is a **single pre-registered confirmatory hypothesis per candidate** — it is *not* part of the 112-look search, so it carries plain α, not Bonferroni. Publish per candidate: `n_req = ⌈((z_α + z_0.80) · σ̂ / μ̂)²⌉` for one-sided α = 0.05 and 0.01 (80% power, observed drift-adjusted μ̂, σ̂). This converts "how long must we test?" from vibes into a number.

## SOL short-leg amendment (research finding vs our own data — resolved here)

Deep-research 03 (verified 3-0) found crypto-momentum short legs erode returns without cutting risk and recommended dropping SOL's short leg. **Our own Trial 04 ledger contradicts the literal action:** SOL long-only OOS was *negative* on an insufficient sample (n=24, −3.53%/setup) while both-sides passed (n=49, +0.76%) — in SOL's down-drifting OOS window (drift −1.44%/28d), the shorts were the leg that carried the pass. The research's own open-questions list flags that its short-leg evidence came from small caps in bull samples and that no like-for-like large-cap test exists. Resolution, locked now:
1. The **pre-registered both-sides forward test keeps running unchanged** (paper data is free; changing a registered experiment mid-flight is tampering).
2. Forward evaluation is **per-leg** (setup tags already separate `-flip-long` / `-flip-short`).
3. The **SOL short leg is pilot-ineligible** regardless of pooled results, unless it *independently* clears the forward gate — this implements the research finding where it has teeth (capital eligibility) without destroying the data that can answer the open question.

---

## Results (computed 2026-07-15 ~18:15 UTC, after registration)

Trials ledger at analysis time: **112 rows, 52 unique configurations** → Tier 2 Bonferroni threshold p ≤ 0.00096.

| Candidate | n | mean raw % | drift bench % | **mean excess %** | sd % | skew | t | p raw | **p excess** | BH q=.10 | Bonf N=52 | n_req @.05 | n_req @.01 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ETH long-only | 38 | +2.91 | +1.08 | +1.83 | 26.2 | 0.3 | 0.43 | 0.244 | **0.330** | fail | fail | 1,270 | 2,062 |
| BNB long-only | 46 | +4.42 | +3.12 | +1.31 | 11.6 | 0.6 | 0.76 | 0.004 | **0.222** | fail | fail | 491 | 797 |
| ADA long-only | 44 | +5.59 | +0.01 | +5.58 | 58.7 | 2.6 | 0.63 | 0.280 | **0.280** | fail | fail | 686 | 1,113 |
| LINK long-only | 40 | +1.40 | +0.17 | +1.23 | 27.2 | 2.1 | 0.29 | 0.398 | **0.415** | fail | fail | 3,026 | 4,911 |
| SOL both-sides | 49 | +0.76 | −1.44 | +1.03 | 18.4 | 0.0 | 0.39 | 0.386 | **0.342** | fail | fail | 1,971 | 3,199 |

## Verdict (pre-registered consequences applied)

**All five candidates fail Tier 1 (BH within-family) — every one is demoted from "candidate" to WATCH and is pilot-ineligible.** No corrected-significant candidates exist in this project as of this trial.

Reading the numbers honestly:
- **The positive means are real numbers but statistically indistinguishable from luck.** Per-setup noise (sd 12–59%) dwarfs the means (1–6%); t-stats 0.29–0.76. BNB's eye-catching raw p = 0.004 is the beta test — against its own bull-window drift, p = 0.22.
- **The required forward samples make per-setup validation infeasible at this signal frequency.** Best case (BNB) needs 491 forward setups at α = 0.05; at ~2–3 setups/month/symbol that is decades. The pooled portfolio (~8–15/month) cannot rescue an individual symbol's claim.
- **This retroactively vindicates every gate held so far:** capital deployed last week on these "passing" cells would have been deployed on statistical noise. It also means our evidence is equally consistent with "small real edge" and "zero edge" — the per-setup design cannot tell them apart in practical time.
- **Methodological implication (a legitimate future Trial 07, pre-registered before running):** the literature achieves significance at the *portfolio* level (e.g., monthly strategy returns over 9+ years, Sharpe-based tests), not per-setup. A portfolio-return reanalysis of the same data is the one honest test remaining for this family — different aggregation, same discipline. It was NOT run here because it was not pre-registered here.

Forward paper agents keep running (free information; gross failure would still be caught), but nothing in this project is currently eligible for real capital by its own rules.
