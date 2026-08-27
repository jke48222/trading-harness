# Deep Research Report — Systematic Retail Trading

**Produced:** 2026-07-14, via a 105-agent research workflow (5 search angles → 23 primary sources fetched → 112 falsifiable claims extracted → 25 claims put through 3-vote adversarial verification → **25 confirmed 3–0, 0 refuted** → merged into 13 findings). Run was interrupted once by session limits and resumed from cache; final pass completed with zero agent errors.

**Read this first:** the verified evidence is *bluntly negative* on this bot's core premise, and the verification bar means every number below was checked verbatim against the primary paper by multiple independent skeptic agents. Coverage is deep on Q1 (MA-crossover evidence) and Q3 (backtest methodology), partial on Q7–Q8, and **empty on Q2, Q4–Q6, Q9–Q10** — those sections need a follow-up run (see "Coverage gaps" below). Nothing here is personalized financial advice; it is evidence and engineering guidance.

---

## Executive summary — what should change in what you build

1. **The prior that a 9/21 SMA crossover on BTC is a genuine edge is very low.** Across 75,360 technical rules on Bitstamp BTC-USD (2013–2022, costs included, data-mining controls), only ~1.7% outperformed buy-and-hold in-sample on mean excess return; selected portfolios beat buy-and-hold out-of-sample **only on risk-adjusted terms** (Sharpe 1.24 vs 0.66) — absolute-return outperformance was not statistically significant. *(High confidence — peer-reviewed, verified 3–0.)*
2. **Your 10 bps round-trip cost assumption is ~3× too optimistic.** Measured all-in historical costs for the outperforming rule portfolios were ~28 bps round trip, and the entire edge died on a cost increase of under 0.05 %-points. Intraday frequencies were the most cost-fragile. **Set `FEE_BPS=25–30` in the bot before trusting any replay again.** *(High confidence.)*
3. **No verified study tested 5-minute bars at all.** The finest frequency in the cost study was 10-minute. Every 5m expectancy statement anywhere is an extrapolation — including yours. *(High confidence caveat.)*
4. **Trend regimes do not rescue BTC crossovers.** Two independent peer-reviewed studies: essentially all of the rules' documented value on BTC came from *limiting bear-market drawdowns*, not from capturing bull trends (rules slightly trailed buy-and-hold in 2016–17 and 2020–21 runs); bubble periods improved rule odds for ETH/XRP/LTC but **not** BTC. *(High confidence.)*
5. **In-sample winners went negative out-of-sample on BTC specifically.** ~15,000 rules with full data-snooping controls showed significant in-sample profitability through 2017 → the best rules produced *negative* Sharpe in H1-2018, while the same procedure stayed positive for LTC/ETH/XRP. Even in trending 2024, a tuned EMA crossover trailed buy-and-hold after fees (medium confidence, preprint, 8 trades). *(High/medium confidence.)*
6. **Crossing-MA systems are the literature's canonical overfitting example.** ≥5 tunable parameters; as few as **7 independent trials** can manufacture a spurious in-sample Sharpe > 1.0 with expected out-of-sample Sharpe of zero; expected max Sharpe across 1,000 zero-skill trials is ≈3.25. A solo coder iterating on SMA parameters trivially manufactures impressive, worthless backtests. *(High confidence.)*
7. **A backtest without a disclosed trial count is worthless** — verbatim position of Bailey & López de Prado (JPM 2014). Engineering consequence: **log every configuration you ever try, not just trades.** *(High confidence.)*
8. **Your planned validation workflow is the canonical false-discovery generator.** One TradingView backtest + one week of paper trading = a single hold-out, which cannot detect overfitting, has high variance, and is advised against below ~1,000 observations; revise-and-retest loops make the test data part of the training data; there is no true out-of-sample on history you've already seen — **only fresh forward (paper/live) data counts.** One week is far too short to judge anything. *(High confidence.)*
9. **Multiple-testing haircuts hit marginal results hardest.** Sharpe < 0.4 should be discounted by more than 50% — often to zero; required minimum returns roughly **double** under multiple-testing adjustment (e.g., 4.4%→7.4%/yr in the Harvey-Liu monthly-equity calibration). Marginal is exactly what a 5m crossover will produce. *(High confidence; exact numbers calibrated to equities, direction robust.)*
10. **Walk-forward — the default in retail backtesters — was the *worst* overfitting preventer** in the one controlled comparison (CPCV best, lowest probability of backtest overfitting); a single sequential backtest is weaker still. *(Medium confidence — single synthetic study, same research school as the metrics.)*

**Net verdict:** treat the current bot as a *learning instrument and execution scaffold* (which it is good at), not as a strategy candidate. The documented value of MA rules on BTC is drawdown protection vs holding — a risk overlay, not an alpha source. Raise costs to 25–30 bps, add a trials ledger, pre-register variants, judge only on fresh forward data with the kill criteria below, and expect the raw crossover to fail them — that outcome would *agree* with the peer-reviewed literature, and reaching it cleanly is the skill this project is building.

---

## Verified findings in full

### A. Does the strategy work? (Q1, parts of Q7/Q8)

**F1 — Simple technical rules almost never beat buy-and-hold on BTC after costs** *(high, 3–0, 2 merged claims)*
75,360 rules across 6 classes on Bitstamp BTC-USD 2013–2022 (daily/60/30/10-min bars; Bitstamp fees + half bid-ask spread; FDR-10% data-mining controls): on average only 1.68% of rules outperformed buy-and-hold in-sample on mean excess return (2.95% on Sharpe). FDR-selected portfolios beat buy-and-hold out-of-sample (2014–2021) **only risk-adjusted** (Sharpe 1.24 vs 0.66); total log return 4.19–4.55 vs 4.15 — not significant. Earlier studies claiming absolute alpha (Corbet 2019, Grobys 2020, Detzel 2021) omitted costs.
Sources: [Deprez & Frömmel 2024, Int. Rev. of Economics & Finance](https://www.sciencedirect.com/science/article/abs/pii/S1059056024003010) · [UGent record](https://biblio.ugent.be/publication/01HY3C3S169G1N6QNYR55NZMFB)

**F2 — Costs decide the conclusion; 10 bps is ~3× optimistic** *(high, 3–0, 2 merged)*
Outperforming portfolios paid ≈28 bps round trip (0.20%/0.10% era fees + half of an average 0.134% spread ≈ 0.14%/trade) and lost the entire edge on a <0.05 %-point cost increase. Intraday portfolios (10/30/60-min; ~500–1,144 OOS trades) were far more cost-fragile than daily (~55–84 trades). **5-minute bars were never tested.** Independently (69 MA/breakout rules, 2016–2021), adding costs *flipped* beat-buy-and-hold likelihoods asymmetrically by coin — cost modeling can reverse conclusions.
Sources: Deprez & Frömmel 2024 · [Svogun & Bazán-Palomino 2022, JIFMIM](https://www.sciencedirect.com/science/article/abs/pii/S1042443122000816)

**F3 — Regime dependence runs the unhelpful direction for BTC** *(high, 3–0, 2 merged)*
All measured OOS outperformance on BTC came from limiting drawdowns in downturns (max drawdown −1.40/−0.49 log vs −1.80 buy-and-hold); rules matched or slightly trailed buy-and-hold in the 2016–17 and 2020–21 bulls. Bubble/trend periods raised beat-B&H odds for ETH, XRP, LTC — **not BTC or BCH**. Two independent peer-reviewed papers agree. (Caveat: downturn sub-period outperformance individually not significant after data-mining correction; samples end 2021.)
Sources: Deprez & Frömmel 2024 · Svogun & Bazán-Palomino 2022

**F4 — In-sample significance did not transfer OOS on BTC** *(high, 3–0, 2 merged)*
~14,919 rules incl. MAs, daily data through 2017, stationary-bootstrap + Bonferroni/Holm/BH/BY controls: significant in-sample → **negative** OOS annualized return/Sharpe/Sortino on both BTC series in H1-2018 (CoinDesk Sharpe −0.05, Bitstamp −0.06), while LTC (+1.36), ETH (+1.19), XRP (+0.74) stayed positive under the identical procedure. Authors attribute the BTC null to rising market efficiency (McLean & Pontiff-style post-publication decay).
Sources: [Hudson & Urquhart 2019, Annals of Operations Research](https://link.springer.com/article/10.1007/s10479-019-03357-1) · [full text](https://d-nb.info/1202710646/34)

**F5 — Even in trending 2024, a tuned EMA crossover trailed buy-and-hold** *(medium — preprint, 8 OOS trades, daily not 5m)*
6/95 EMA tuned on 2021–Jan 2024, OOS Apr–Dec 2024 on daily Binance BTC: 26.07% vs 42.51% pre-cost; 25.27% vs 42.31% after 0.1%/trade. Only an LSTM beat buy-and-hold after fees in that study.
Source: [arXiv 2511.00665](https://arxiv.org/html/2511.00665v1)

### B. Backtesting methodology that prevents self-deception (Q3)

**F6 — Undisclosed trial counts make a backtest unassessable** *(high, 3–0)*
"A backtest where the researcher has not controlled for the extent of the search involved in his or her finding is worthless, regardless of how excellent the reported performance might be." → **Log every configuration tried.**
Source: [Bailey & López de Prado 2014, "The Deflated Sharpe Ratio," JPM](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)

**F7 — Parameter search mechanically manufactures false positives** *(high, 3–0, 3 merged)*
Expected max Sharpe across N zero-skill trials grows with N (≈3.25 at N=1,000); zero-signal returns yield "highly profitable" in-sample backtests within a few hundred iterations; **7 independent trials** suffice for a spurious 2-year in-sample Sharpe > 1.0 with expected OOS Sharpe 0. (Correlated SMA tweaks count for less than one independent trial each — but grid searches run dozens-plus.)
Sources: Deflated Sharpe (JPM 2014) · [PBO paper, J. Computational Finance 2017 (SSRN 2326253)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253) · [Harvey & Liu, "Backtesting" (SSRN 2345489)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2345489)

**F8 — A single hold-out (your TradingView-then-1-week-paper plan) cannot detect overfitting** *(high, 3–0, 3 merged)*
Hold-out treats the result as a single trial; used repeatedly, false positives become expected (~20 uses at 95%); high variance; advised against under ~1,000 observations. One week of paper trading is a fortiori underpowered. Corroborated outside finance (Dwork et al., *Science* 2015 — adaptive reuse of a hold-out overfits it). Note: the PBO paper's motivating example is *crossing moving averages*.
Sources: Deflated Sharpe · PBO paper

**F9 — Crossover systems are the canonical overfitting example** *(high, 3–0)*
≥5 tunable parameters (two lengths, entry/exit thresholds, stop) → combinatorially large search space → any selected variant is likely a false positive absent multiple-testing controls.
Source: PBO paper

**F10 — Revise-and-retest invalidates the out-of-sample test entirely** *(high, 3–0, 2 merged)*
"Not truly OOS"; repeated adjustment makes test data "indirectly part of the training data"; because you've lived the history, "there is no true OOS that uses historical data" — only fresh forward data. Harvey & Liu's protocol: lenient in-sample screen + OOS validation + multiple-testing adjustment on the full data; take the intersection of survivors.
Sources: Harvey & Liu 2015 · [Palomar, *Portfolio Optimization* (Cambridge 2025), §8.3](https://portfoliooptimizationbook.com/book/8.3-dangers-backtesting.html)

**F11 — Multiple-testing haircuts are nonlinear and crush marginal results** *(high, 3–0, 3 merged)*
Sharpe 2.5 over 5y daily FAILS the 95% deflated-Sharpe test at N=100 disclosed trials (DSR 0.9004); Sharpe 0.75 over 20y monthly haircuts to 0.32 after 200 trials (~60% cut); flat 50% haircuts are wrong — **SR < 0.4 should be discounted by >50%, often to zero**; SR > 1.0 at most ~25%. All numbers independently recomputed by verifiers.
Sources: Deflated Sharpe · Harvey & Liu

**F12 — Minimum profitability hurdles roughly double under multiple testing** *(high, 3–0)*
Harvey-Liu Exhibit 4 (240 monthly obs, 10% vol, 5% significance, 300 prior tests): required return 0.365%→0.616%/month (4.4%→7.4%/yr, ~1.7× under BHY; ~1.9× under Bonferroni/Holm). Direction portable; exact numbers calibrated to monthly equities.
Source: Harvey & Liu

**F13 — CPCV beat walk-forward at preventing overfitting; walk-forward was worst** *(medium — single synthetic study, school-affinity bias, abstract-level verification)*
Combinatorial Purged Cross-Validation had the lowest probability of backtest overfitting and best deflated-Sharpe stat; walk-forward showed the weakest false-discovery prevention. A single sequential backtest is strictly weaker than walk-forward.
Sources: [Arian, Norouzi Mobarekeh & Seco 2024, Knowledge-Based Systems](https://www.sciencedirect.com/science/article/abs/pii/S0950705124011110) · [SSRN 4686376](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4686376)

---

## What this means for *this* bot — concrete engineering changes

1. **`FEE_BPS`: 10 → 25–30** (F2). Every replay to date has been ~3× too cheap. Expect win rates and expectancy to drop when you fix this — that's the honest baseline.
2. **Add a trials ledger** (F6, F7, F10): a `data/trials.csv` logging every configuration ever tested (params, window, date run, headline metrics). The deflated-Sharpe logic needs the trial count N; without it your results are formally unassessable. Pre-register each variant *before* running it.
3. **Reframe the memory system's job** (F8): the two-file memory is a good *execution/journal* discipline, but the ≥2-losses skip rule is itself a parameter being fit on tiny samples (your first live comparison already showed it skipping winners). Do not tune it iteratively against the same window.
4. **Only forward data is out-of-sample** (F10): the 500-candle replay window you've already studied is training data now. Treat scheduled `scan` runs going forward as the only OOS stream.
5. **One week of paper trading is not a gate** (F8, F12): plan for 4–6+ weeks and a minimum trade count (below) before any keep/kill/graduate decision. Your original "≥1 week then 1–3% real" plan is underpowered per the verified literature.
6. **If the raw crossover fails, that's the literature confirming itself** (F1–F5). The documented value of MA rules on BTC is *drawdown limitation vs holding* — if you hold BTC, a crossover-gated exposure overlay is the evidence-aligned use, not standalone intraday alpha.

## Kill criteria (pre-register these before the next test)

Evidence-anchored where possible; items marked ⚙ are engineering judgment consistent with the findings, not verbatim from a source.

- **Trial accounting (F6):** every variant tested gets a row in the trials ledger; N (total trials to date) is reported next to every result. No undisclosed retries.
- **Minimum sample before judging (F8):** ⚙ ≥300 completed setups on the configuration under test, and ≥4 weeks of *forward* paper data — whichever is later. (Hold-out advice: don't trust hold-outs under ~1,000 observations; 300 trades ≈ the floor where a profit factor is even directional.)
- **Cost floor (F2):** all evaluation at `FEE_BPS≥25`. A strategy that only works below 25 bps is classified dead by default on a Binance-class venue at retail size.
- **Kill** ⚙: after the minimum sample, net expectancy ≤ 0 or profit factor < 1.10 → kill the variant. Log the kill in the trials ledger; do not re-tune the same parameter family more than once (F7: each retry inflates N and the required hurdle).
- **Marginal zone** ⚙ (F11): PF 1.10–1.25 or implied annualized Sharpe < 0.4 → treat as zero-evidence (the >50%-to-zero haircut band). One pre-registered filter variant may be tested; if still marginal, kill.
- **Keep / graduate** ⚙ (F11, F12): PF ≥ 1.25 with ≥300 forward trades, positive expectancy at 30 bps, max drawdown you'd genuinely sit through, and the result must survive a doubled hurdle (F12): would you still take it if the edge were half? Only then consider 1–3% of risk capital — sized so a 100% loss of that tranche is tolerable.

## Revised 4-week paper plan

- **Now (day 0):** set `FEE_BPS=30`; re-run `replay:raw` once to restate the honest baseline; add the trials ledger; pre-register (write down before running) the exact variants for the month: ① raw 9/21 long+short (already running), ② long-only, ③ 12-bar time exit, ④ one higher-timeframe trend filter (e.g., 1h 50-EMA side). **No other variants this month.**
- **Weeks 1–2:** run scheduled `scan` (e.g., every 5m via cron/launchd) to accumulate *forward* decisions for variant ①. Run the TradingView backtest (Prompt 02 procedure) once per pre-registered variant on its fixed IS window — record everything in the trials ledger, tune nothing.
- **Weeks 3–4:** keep accumulating forward data; at week 4, apply the kill criteria to whatever has ≥ the minimum sample (likely only ①). Variants that were only backtested stay "candidates," not "validated."
- **Graduation decision (end of week 4+):** almost certainly *not yet* by these criteria — that is the expected, honest outcome. Real-money consideration requires the Keep bar above on forward data. The alternative path if ① dies: pivot research to the unanswered questions below (strategy classes with better evidence, e.g., funding-rate/basis income) before writing more strategy code.

## Coverage gaps and open questions (needs a follow-up run)

Nothing survived verification on: **Q2** (strategy-class rankings), **Q4** (position sizing/Kelly/stops), **Q5** (venue fees/API limits/paper-vs-live fills — sources were fetched, incl. Alpaca paper-trading docs and fee schedules, but claims went unverified under budget), **Q6** (LLM-agent trading experiments), **Q9** (PDT/wash-sale/US venue legality — FINRA/Bybit/Hyperliquid sources fetched but unverified), **Q10** (curated source list). The memory/lessons design has **no verified evidence base either way**. Open questions the next run should target: realistic 2025–26 all-in BTCUSDT perp costs at retail size; quantified regime-filter efficacy; 2024–26 LLM-trading results incl. failure modes; trader-level base rates and the translation of Harvey-Liu hurdles to 5m trade counts. Re-run with: `/deep-research` scoped to Q2+Q4+Q5, and a second pass for Q6+Q8+Q9+Q10.

## Appendix

**Verification stats:** 5 angles · 23 sources fetched · 112 claims extracted · 25 verified (budget-limited) · 25 confirmed 3–0 · 0 refuted · 13 merged findings · 105 agents · ~5.9M subagent tokens.

**Primary sources that produced confirmed findings:** Deprez & Frömmel 2024 (IREF) · Hudson & Urquhart 2019 (AOR) · Svogun & Bazán-Palomino 2022 (JIFMIM) · Bailey & López de Prado 2014 (JPM, Deflated Sharpe) · Bailey, Borwein, López de Prado & Zhu 2017 (JCF, PBO) · Harvey & Liu 2015 (JPM, Backtesting) · Arian et al. 2024 (KBS, CPCV) · Palomar 2025 (Cambridge UP) · arXiv 2511.00665 (2025 preprint). Fetched but unverified this run: Alpaca paper-trading & crypto-fee docs, FINRA notice 26-10, Bybit restricted-countries page, nof1.ai, four LLM-trading arXiv papers, ESMA CFD-restriction release, Barber-Odean-lineage SSRN papers.

**Caveats (verbatim highlights from the synthesis):** samples end 2021–22 (pre-ETF microstructure) except one 2024 preprint; buy-and-hold is a demanding benchmark in bulls (a rule can be absolutely profitable yet "fail"); Harvey-Liu numbers are calibrated to monthly equity factors — directions robust, exact numbers not portable to 5m crypto; DSR/haircut methods assume ~independent trials (correlated grid points count for less); CPCV ranking rests on one synthetic study; one demo link (LBNL tool) now 403s.
