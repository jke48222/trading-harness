# Trial 07 — Portfolio-Level Reanalysis of the TSMOM-28 Family (pre-registered)

Registered: 2026-07-15 ~18:30 UTC, **before** any statistic below was computed. Motivation: Trial 06 showed per-setup granularity cannot distinguish a small real edge from zero edge in practical time (per-setup sd 12–59% vs means 1–6%). The published literature achieves significance at the **portfolio-return** level over multi-year windows. This is the family's final test — the consequences below are binding.

## Why this is not variant-fishing

- **Zero new free parameters.** Lookback 28 and long-only were locked in Trial 04's pre-registration from literature defaults. The portfolio construction below is the canonical TSMOM form (daily sign-based exposure), not a tuned variant.
- **No symbol selection.** The primary test uses the **unselected universe**: every crypto ever tested in Trials 04–05 — BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK — including the three set aside as beta and the marginal ones. Survivors-only would bake selection bias back in. (Stocks excluded: ~6y IEX depth and a different market; the family claim under test is *crypto* TSMOM.)
- **One primary number.** Exactly one hypothesis decides the trial (below). Everything else is descriptive.

## Construction (locked)

Per symbol, from listing (daily closes, full history — the unselected-universe design is what makes full-sample use honest; window subsamples are descriptive only):
- Momentum at close *t*: `mom_t = close_t / close_{t−28} − 1`.
- Position decided at close *t*, applied to the return from *t* to *t+1*: **long-only, pos = 1 if mom > 0 else 0** (uniform family rule for all 8 symbols; SOL both-sides is a secondary descriptive, not the primary).
- Daily strategy return: `r_strat = pos_{t−1} · r_asset,t − 0.0015 · |pos_{t−1} − pos_{t−2}|` — **15 bps per unit of position change** (= the 30 bps round-trip adoption basis).
- **Timing benchmark** (the drift-check carried to portfolio level): `r_bench,t = w̄ · r_asset,t` where `w̄` = the strategy's mean exposure over that symbol's full window — i.e., a constant-exposure position of the same average size, costless. Timing skill = beating your own average exposure, not just riding drift.
- Monthly aggregation (calendar UTC, compounded); partial first/last months dropped. **Excess month = strategy month − benchmark month.**
- **Portfolio = equal-weight mean of per-symbol monthly excess across symbols live that month.**

## Primary hypothesis and test (locked)

**H0: E[portfolio monthly timing excess] ≤ 0.** One-sided. p-value by percentile bootstrap of the mean, 10,000 resamples, seed mulberry32(42). **Decision threshold α = 0.05.**

Multiple-testing context, stated plainly: this is a single pre-registered confirmatory hypothesis, so it carries plain α; but it is also the family's ~53rd disclosed look, so the Bonferroni-vs-N context (p × N_configs) is reported alongside for honesty, without being the decision rule.

## Descriptives (reported, non-decisional)

Per-symbol monthly excess and raw Sharpe; portfolio raw return and Sharpe vs equal-weight buy-and-hold; the selected-5 portfolio (to expose selection inflation); both-sides variant; OOS-window-only subsample; average exposure w̄ and annual turnover per symbol.

## Consequences (locked)

- **Pass (p ≤ 0.05):** the family is upgraded to *portfolio-level significant*. The forward gate is redesigned around **monthly portfolio returns** (12 observations/year — a feasible accumulation rate, unlike 491+ per-setup); a required-months number is published from the observed mean/sd. Candidates remain watch/pilot-ineligible until the forward monthly gate clears.
- **Fail (p > 0.05):** the **TSMOM-28 family is rejected outright**, joining Trials 01–03. No variant C, no new lookback, no re-aggregation. The watch agents may keep logging, but strategy research on this family ends; remaining project directions are cost-engineering, a different pre-registered family on fresh data, or accepting the null.

---

## Results (computed 2026-07-15 ~18:40 UTC, after registration)

**Per-symbol (long-only canonical construction, 15 bps per position change):**

| Symbol | Months | w̄ | Turns/yr | Mean excess %/mo | Ann excess Sharpe |
|---|---|---|---|---|---|
| BTC | 105 | 0.54 | 31 | +2.30 | 0.81 |
| ETH | 105 | 0.51 | 31 | +2.01 | 0.55 |
| SOL | 69 | 0.49 | 26 | +7.98 | 1.11 |
| BNB | 102 | 0.56 | 32 | +3.19 | 0.45 |
| XRP | 96 | 0.44 | 28 | +3.01 | 0.41 |
| DOGE | 82 | 0.46 | 26 | +11.51 | 0.68 |
| ADA | 97 | 0.43 | 27 | +5.26 | 0.66 |
| LINK | 88 | 0.52 | 31 | +2.46 | 0.43 |

**PRIMARY: equal-weight all-8 long-only portfolio, 105 months (2017-10 → 2026-06):**
- Mean timing excess **+4.30%/month**, sd 15.1%, **t = 2.91, bootstrap p = 0.0004** → **PASS** at the locked α = 0.05.
- Bonferroni context (not the decision rule): p × 53 configs = **0.021** — it survives even the conservative full-search adjustment.
- Annualized timing-excess Sharpe **0.98**. Raw portfolio Sharpe 1.04 vs equal-weight buy-and-hold 0.89 (similar raw return at ~half the average exposure).
- Selection-inflation check: the selected-5 portfolio shows *lower* excess (+3.76%/mo) than the unselected 8 — the pass is not a survivor artifact.

## Verdict: PASS — with one caveat reported at equal volume

**The TSMOM-28 family is portfolio-level significant on the unselected universe.** The per-setup nulls of Trial 06 and this pass are consistent: the edge is real at portfolio aggregation but far too small per-setup to detect at that granularity.

**The caveat: the OOS-era subsample (months ≥ 2023-12, n=31) is NOT significant on its own — mean +1.76%/mo, p = 0.23.** The full-sample significance draws heavily on the 2017–2021 era (DOGE +11.5%/mo, SOL +8.0%/mo excess), exactly the pre-2022 concentration and bull-regime dependence the verified literature (deep-research 03) warned about. The recent 2.6 years are directionally positive but statistically silent.

**Consequences applied as locked:**
- Family status: **portfolio-level significant** (first corrected-significant result in the project).
- Forward gate redesigned around monthly portfolio returns; required months at the observed effect size: **~77 monthly observations** (α=0.05, 80% power) — i.e., forward *re-proof* is infeasible on any practical horizon; the forward series' realistic role is regime monitoring (detecting that the historical effect has died), not confirmation.
- **All candidates remain WATCH / pilot-ineligible** per Trials 06–07 rules as written. Any future capital decision would rest on the historical full-sample evidence plus forward monitoring — and on rules the user must consciously amend, not on this trial alone.
