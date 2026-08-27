# Deep Research Report 03 — Q4–Q10 (scoped follow-up)

Run 2026-07-15 via the deep-research workflow (111 agents, 28 sources fetched, 125 claims extracted, 25 adversarially verified 3-vote, **23 confirmed / 2 refuted**). Prompt: `deep_research_prompt_03_q4_q10.md`. Scoped to the questions report 02 left unverified.

> **Coverage honesty (read first).** Verification landed strongly on **Q4 (crypto TSMOM validity)** and **Q8 (Kelly/sizing)**, with partial **Q6 (prop-firm mechanics)**. **Q5 (capped-pilot base rates), Q7 (cash-account/T+1 + stock data), Q9 (LLM-agent results), Q10 (crypto tax / bot ToS)** produced **no verified findings** — search surfaced sources (below) but they did not clear the 25-claim verification budget. Treat their absence as unresearched, not as evidence either way.

---

## Executive summary

The evidence gives the daily long-only crypto-TSMOM family **qualified in-sample support but several specific disconfirmations against live, real-cost deployment**, and is **unanimously adverse to fast, aggressive sizing**. Net verdict from the run's own decision block: **keep forward-paper-testing and apply the multiple-testing correction to the 112 trials before any capital** — a capped live pilot is justified only as a deliberate paid experiment to measure live fills, not as validation of edge.

## Verified findings

### Q4 — Your TSMOM candidates: in-sample real, forward-suspect

1. **The family does work in-sample.** Best daily long-only crypto TSMOM (28-day lookback / 5-day hold) earned annualized **Sharpe 1.51 net of 15 bps** over Jan 2014–Aug 2023 (Han/Kang/Ryu, SSRN 4675565); Liu & Tsyvinski (NBER w24877) found strong in-sample Bitcoin momentum 2011–2018. *(high, 3-0)* — **but** it assumes 15 bps (your retail floor is 30–160), was selected in-sample from a 1–56 day grid, and earned most of its return **before 2022**.
2. **Realistic accounting erases much of it.** Once transaction costs **plus daily mark-to-market/liquidation** are modeled, many momentum portfolios with statistically significant mean returns earn **insignificant or negative** profits — a naive mean t-test is systematically optimistic. *(high, 3-0)*
3. **Strongly bull-regime-dependent and long-biased.** Crypto momentum is "almost non-existent when the market is bearish," and **adding a short leg only erodes the mean return without reducing risk** — a direct strike against the both-sides **SOL** candidate. *(high, 3-0)* (Caveat: this evidence is drawn largely from small/illiquid coins in a net-bull sample; a like-for-like large-cap short test wasn't found — see open questions.)
4. **Your ~28-day horizon is where momentum is weakest, and ETH shows reversal.** Bitcoin's weekly predictive coefficient falls from 1%-significant at 1–3 weeks to only 10%-significant at 4 weeks; **ETH specifically has a negative 5-day coefficient (reversal, not continuation).** *(medium; 3-0 on ETH reversal, 2-1 on 28-day-weakest)*
5. **The famous crypto-momentum numbers are cross-sectional, and they decayed.** The big in-sample figures come from weekly winners-minus-losers strategies, not your time-series family — and large-cap **cross-sectional momentum fell to insignificance after mid-2020** (positive only 2016–Jul 2020). *(high, 3-0)*
6. **Crypto momentum's risk profile differs from equities** (no extended momentum crashes), so equity-derived haircuts (McLean-Pontiff 26%/58%) may **mis-specify** crypto risk — cuts both ways. *(medium, 3-0)*

### Q8 — Sizing: the literature is unanimous and adverse to going fast/big

7. **Kelly is hypersensitive to edge-estimation error** — errors in the mean are ~20× more important than covariance errors (up to 100:3:1 for aggressive log/Kelly). Sizing off profit factors from **112 uncorrected, likely-overfit trials** rests on exactly the input Kelly punishes most. *(high, 3-0)*
8. **Full Kelly is catastrophic even with a genuine edge.** 700 bets at a real 14% edge can turn $1,000 into **$18 (−98%)**; triple-Kelly reaches **certain ruin** by 40,000 trades. A real edge does not guarantee survival. *(high, 3-0)*
9. **Fractional (¼–½) Kelly is the evidence-based choice.** Half-Kelly cut max drawdown ~48%→~25% while CAGR fell only 3.27%→2.72%; **quarter-Kelly never went negative across 3,000 simulations**; professionals deliberately bet far below the formula (10% where full Kelly said 97.5%). *(high, 3-0)*
10. **Kelly's long-run guarantee needs far more trades than you have** — 100 and 1,000 trades are "too few," ~10,000 is the first plausible working scenario. With **38–49 OOS setups per candidate the asymptotic guarantee simply does not apply.** *(high, 3-0)*
11. **Fat tails + correlation break Kelly exactly when it matters.** The normal-based formula over-sizes when your **5 candidates (pairwise ~0.6–0.9) fail together** — i.e. the portfolio is far fewer independent bets than it looks. *(high, 3-0)*

### Q6 — Prop firms (partial)

12. **Topstep-class evaluations run on a SIMULATOR and DO permit bots** (Topstep launched an API in April 2026; anti-automation rules target sim-exploitation, not automation per se). So a prop **"pass" is a simulated, not live-fill, result** — the real constraint is sim-gaming. *(medium, 3-0)* (Pass rates, payout reliability, scam base rate — unresolved.)

## Two claims REFUTED (do not reintroduce)
- **"Crypto momentum returns follow a power law → variance/Sharpe undefined"** — refuted (1-2). Do NOT claim Sharpe is undefined. *But* the related verified fact stands: a single observation contributed **~37% of compounded cross-sectional return** (Grobys et al. 2025) — outlier/tail fragility is real, the power-law framing just wasn't.
- **"Topstep bans all automation"** — refuted (1-2); contradicted by Finding 12.

## The run's decision block (evidence-based process guidance)
Favors **(b) keep forward-paper-testing + apply the multiple-testing correction first.** Concrete pre-registerable gates:
1. Apply **Bonferroni / Benjamini-Hochberg / deflated-Sharpe** across the 112 trials; require each candidate PF to stay **> ~1.2 with corrected significance**.
2. Accumulate **≥30 forward OOS setups per candidate** before any scaling.
3. **Drop the both-sides SOL short leg** — the short adds negative expected value (Finding 3).
4. If a capped pilot runs anyway: size at **≤ quarter-Kelly** computed on the **~1–2 independent bets** implied by 0.6–0.9 correlation, with a hard-stopped tuition cap.
5. **Pivot** if corrected PFs fall to ~1.0, or forward PF underperforms backtest by more than the ~26–58% haircut band.

## Open questions (unresolved by verified evidence)
- The **crypto-specific** forward haircut on OOS PF 1.2–2.9 (equity 26%/58% may mis-specify). **Decisively: after correcting the 112 trials, do ANY of the 5 candidate PFs survive?** Not computed in this run — this is the code task.
- Does the "short leg erodes returns" result hold for a **single large-cap like SOL**, or is it a small-cap artifact?
- Q6 base rates (pass/payout/scam), and whether prop is a rational fast route or a fee mill.
- Q5/Q7/Q9/Q10 entirely open.

## [SEARCH-SURFACED, UNVERIFIED] — leads for the open questions
- **Q7 stock data:** `stooq.com/db/` — free bulk 20+ year daily US equity history (check licensing); FINRA + Fidelity cash-account/good-faith-violation pages for T+1 mechanics.
- **Q9 LLM agents:** arXiv 2502.15800, 2504.10789, 2606.08285, 2510.05533 — 2025–26 LLM-trading experiments/failure modes (unverified).
- **Q10 crypto tax:** IRS 1099-DA instructions + final broker digital-asset reporting regs (2025–26); Coinbase Advanced Trade API terms.
These weren't verified — check the primaries before relying on them. A third scoped run (Q5/Q7/Q9/Q10) would close them.

## Primary sources (verification-passing)
Han/Kang/Ryu SSRN 4675565; Liu & Tsyvinski NBER w24877; Springer JAM 11408-025-00474-9 & ScienceDirect S1544612325011377 (crypto momentum decay) — Q4. Aldous "Good & Bad Kelly" (Berkeley); MacLean/Thorp/Ziemba Kelly-Ziemba chapter; Frontiers FAMS 2020.577050 — Q8. Topstep help-center prohibited-strategies + payout-policy — Q6.
