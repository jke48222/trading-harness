# Deep Research Prompt 02 — Fast Profitability Under Real Constraints

Paste everything below the line into **Claude Opus 4.8** with web search / research mode enabled (claude.ai Research, or Claude Code `/deep-research`). This is the follow-up to `opus_deep_research_prompt.md` (run 1, report at `deep_research_report.md`). Expect a long run; it must produce a decision-ready report, not a summary.

---

You are conducting deep, evidence-first research for a retail trader with a working automated paper-trading system. Your job is to find what the evidence actually supports — including evidence that parts of my plan don't work — not to cheer me on.

## The brief (my words — treat these as the design constraints to optimize under AND audit)

> "What can we do now to move into the paper money testing phases with different cryptos and stocks and have a positive return on investment? I want fast trading and fast profitability, moving into real money trading next week. I'm not going to spend months of just testing. Anything within this project can be changed."

Optimize under these constraints where evidence allows. Where a constraint is unachievable, do not soften it: quantify exactly why, then give the **nearest achievable alternative** with numbers. "Anything can be changed" includes venue, fee structure, strategy class, timeframes, account type, symbols, and testing methodology — so treat every constraint of my current setup as negotiable if the evidence says changing it helps.

## My context (current state — do not re-derive it)

- TypeScript bot, paper-only, US-based. Data: Binance public klines (crypto), Alpaca paper IEX (stocks). Per-setup scoring engine: enter at signal close, exit N candles later, net of a configurable round-trip cost; pre-registered trials with an append-only disclosure ledger (**112 trials logged to date**).
- Settled by my own trials at 30 bps round-trip: **5m and 1h technical strategies (MA crossovers, Donchian breakouts, with/without regime filters) are all negative** — per-trade edge ≈ 0 pre-cost, so costs decide. This replicated run 1's literature findings.
- Live candidates (daily 28-day time-series momentum, forward paper-testing now): long-only on ETH (OOS PF 1.33–1.67), BNB (2.91), ADA (1.42, outlier-carried), LINK (1.17); both-sides on SOL (1.11). All beat per-window drift benchmarks; samples 38–49 OOS setups each; expected forward cadence ~8–15 entries/month across the portfolio. XRP/DOGE/BTC variants passed raw gates but sat at-or-below drift (repackaged beta) and were set aside.
- Stocks: daily TSMOM cells were positive but 13–24 OOS setups on ~6 years of IEX daily data — below my ≥30-setup gate. No stock candidates yet.
- Account context: Alpaca paper $100k (fake); real capital would start small (assume $1k–$10k order sizes for cost math). No live-trading code exists yet by design.

## Research questions (priority order)

1. **The execution-cost floor — the question everything else hangs on.** My fast strategies died at a 30 bps round-trip assumption. For a US retail account trading $100–$10k clips in 2026: what is the real, achievable all-in round trip (fees + spread + slippage) per venue — Coinbase Advanced, Kraken/Kraken Pro, Binance.US (current status), Bybit/OKX/Hyperliquid (US-legality explicitly), Alpaca crypto (their spread, since commissions are "free")? Maker vs taker tiers, stablecoin-pair quirks, and **maker-fill reality on short-timeframe signals** (adverse selection: how often does a limit entry on a 5m signal actually fill, and what's the cost of the misses?). Output: a venue × achievable-bps table with assumptions, and the bps threshold at which my rejected fast strategies would have flipped positive (my data: 5m sma-cross avg −0.085%/setup at 10 bps, −0.285% at 30 bps; 1h Donchian −0.07%/−0.27%).
2. **Fast strategy families with documented, retail-achievable positive NET expectancy.** Funding-rate/basis capture (delta-neutral), cross-exchange and triangular arb, passive market-making on maker rebates, short-horizon stat-arb/pairs, event/news trading. For each: strongest published or credibly audited evidence of net-positive retail results (2023–2026), realistic return distribution, capital and infrastructure floor, failure modes (exchange risk, liquidation, inventory risk, latency), US-legal venue availability, and time-to-competence for a solo coder. Answer bluntly: **is there any evidence-backed path to "fast trading, fast profitability" for a solo US retail coder, and what does its realistic monthly PnL look like at $1k–$10k?**
3. **The fastest statistically defensible validation protocol.** I will not spend months idle — so what is the minimum-calendar-time test that still means something? Cover: cross-sectional pooling (many symbols, same rule = more independent samples per week), bootstrap and Monte Carlo resampling of per-setup returns, deflated Sharpe ratio, White's Reality Check/SPA with my disclosed trial count (112), and walk-forward. Then apply it to MY candidates: given OOS PF 1.17–2.91 on n=38–49, and ~8–15 pooled forward setups/month, compute how many forward setups (and therefore how many weeks) are needed to distinguish PF 1.2 from PF 1.0 at reasonable confidence. Output: a concrete protocol with numeric gates I can pre-register this week.
4. **External validity of my daily-TSMOM candidates.** Published performance of crypto time-series momentum at ~1-month horizons through 2024–2026: post-publication decay, crowding, regime dependence. What forward haircut should I expect on OOS PF 1.2–2.9? Is the family trustworthy enough to justify a capped live pilot before full validation, or is decay evidence strong enough that even the pilot should wait?
5. **Bounded-risk designs for "real money soon."** If a trader insists on live exposure within ~a week, what does evidence-based practice say about **capped pilots**: fixed tuition budget (e.g., $200–$500 max loss, hard-stopped), micro-sizing, pre-registered kill criteria, escalation gates tied to forward results. How do professional desks stage strategies from paper → pilot → scale, and what fraction of pilots die? Quantify what a capped pilot buys in information (live slippage measurement, execution bugs, psychology) vs what it costs. This is the honest version of my "next week" constraint — design it, don't preach about it.
6. **Funded-trader / prop evaluations as capped-downside access to size (2026).** Futures props (Topstep-class) and any legitimate crypto props: evaluation costs, realistic pass rates, payout reliability, US eligibility, and **whether automated/bot trading is permitted**. Is "trade someone else's capital with a known-max-loss evaluation fee" a rational answer to wanting real money quickly? Include the scam base rate and how to distinguish legitimate firms.
7. **Stocks without PDT pain and without months of waiting.** Cash-account mechanics (no PDT flag; T+1 settlement cycling limits), realistic strategy families for daily/overnight horizons with published evidence (overnight anomaly, post-earnings drift, seasonal/index effects), and — critically — **deeper daily data**: free or cheap sources with 20+ years of clean US equity daily history (my IEX feed gave only ~6 years, leaving 13–24 OOS setups — name specific sources and their licensing) so stock trials can meet a 30-setup OOS gate.
8. **Position sizing and risk-of-ruin with my actual numbers.** Kelly and fractional-Kelly from per-setup stats like mine (PF 1.17–2.91, win rates 33–63%, avg wins/losses per the table above); risk-of-ruin tables at ¼-, ½-, and full-Kelly; max-daily-loss and portfolio caps when 5 candidates are highly correlated (crypto pairwise correlations ~0.6–0.9 — treat the portfolio as fewer independent bets than it looks). Output: formulas plus a filled-in table using my candidate stats.
9. **LLM-agent trading, 2024–2026 update** (gap from run 1): credible experiments, audited results if any exist, failure modes, and what division of labor the evidence now supports between LLM and deterministic code.
10. **US practicalities + source refresh.** 2026 status: crypto tax treatment and any wash-sale extension, PDT thresholds and cash-account workarounds, bot/automation permissions per venue ToS (Coinbase, Kraken, Alpaca), anything regulating retail automated order flow. Then the 10 highest-quality sources (2023–2026 preferred) on retail algo economics, each with one line on what it's uniquely good for and its bias.

## Method requirements

- Prefer primary sources: peer-reviewed papers, SSRN, exchange/broker official fee schedules and ToS, regulator publications, audited datasets. Blogs only with methodology; influencer content is unverified by default.
- Every quantitative claim: inline citation, year, market, sample period, costs-included yes/no.
- Label findings **Strong / Mixed / Weak-anecdotal**. Actively hunt disconfirming evidence for anything I'd like to be true — especially "fast trading can be profitable at retail" and "my TSMOM candidates are real."
- Where evidence contradicts my constraints, quantify the gap — don't average conflicting sources silently, and don't editorialize beyond the numbers.
- Recency matters: 2023–2026 for fees, venue access, LLM results, tax/regulation; classic literature for fundamentals.

## Output format

1. **Executive summary (≤1 page):** the ~10 findings that should most change what I do this week, each with a confidence label.
2. **Constraint audit (the brief, line by line):** for each of *fast trading / fast profitability / real money next week / no months of testing* — what the evidence supports, what it refutes with numbers, and the nearest achievable alternative.
3. **Per-question sections (Q1–Q10)** with citations and confidence labels.
4. **A pre-registerable 4-week action plan** compatible with my trials discipline (every test declared before running, logged to `data/trials.csv`): cost-floor experiments, the compressed validation protocol applied to my 5 live candidates, the stock-data upgrade, and — if the evidence supports one — a capped live-pilot design with exact dollar caps, kill criteria, and escalation gates.
5. **Appendix:** full source list with quality notes.

Do not give personalized financial advice. Do give evidence, base rates, and engineering guidance a technical reader can act on.
