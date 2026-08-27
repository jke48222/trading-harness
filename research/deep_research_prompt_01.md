# Deep Research Prompt — Systematic Retail Trading

Paste everything below the line into **Claude Opus 4.8** with web search / research mode enabled (claude.ai Research, or Claude Code with WebSearch). Expect a long run; it is designed to produce a decision-ready report, not a summary.

---

You are conducting deep, evidence-first research for a retail trader building an automated trading system. Your job is to find what the evidence actually supports — including evidence that what I'm building doesn't work — not to cheer me on.

## My context (use it to focus everything)

- I run a **TypeScript paper-trading bot**: BTCUSDT, 5m candles, 9/21 SMA crossover, long and short setups scored over a 12-candle (~1 hour) horizon, 10 bps round-trip cost assumption.
- It has a **memory system**: every trade and skip is logged to a ledger; plain-English lessons block setups with ≥2 real recorded losses.
- Planned next steps: TradingView backtesting, then a broker/exchange MCP in paper mode (Alpaca for stocks; Binance/Bybit-class exchange for crypto). Real money only after ≥1 week of stable paper results, then only 1–3% of max risk tolerance.
- I'm US-based, beginner-to-intermediate at systematic trading, comfortable with code. I want evidence and engineering guidance, not personalized financial advice.

## Research questions (priority order)

1. **MA crossovers specifically.** What does published evidence (academic + credible practitioner backtests) say about moving-average crossover strategies: in which regimes they work (trending) vs bleed (chop), on which timeframes and assets, and what realistic expectancy looks like *after* costs on 5m crypto? Which filters measurably improve them — regime filters (ADX, realized-vol percentile, MA slope), higher-timeframe trend alignment, volume confirmation, time-of-day? Quantify improvements where sources allow.
2. **Strategy classes for retail automation, ranked by evidence.** Momentum/trend-following, mean reversion, breakout, crypto funding-rate & basis arbitrage, pairs/stat-arb, passive market making, volatility strategies. For each: evidence quality, typical costs sensitivity, capacity, crowding/decay risk, and suitability for a solo retail coder. Which are realistic at retail size and which are quant-firm-only?
3. **Backtesting methodology that prevents self-deception.** Overfitting controls: walk-forward analysis, out-of-sample splits, purged/embargoed cross-validation, deflated Sharpe ratio, White's Reality Check / SPA tests, parameter-sensitivity analysis. Look-ahead and survivorship traps. Realistic slippage/fee models for crypto perps and US equities at retail size. Minimum trade counts / sample sizes before a result means anything. Give a concrete checklist I can apply to every backtest.
4. **Risk and position sizing.** Fixed-fractional vs fractional Kelly vs volatility targeting: evidence and failure modes. Max-drawdown control, per-trade vs portfolio risk, and what the evidence says about stop-losses (when they help vs hurt, by strategy class and timeframe).
5. **Execution realities.** Maker/taker fees and tiers, spreads and slippage at retail size, order types that matter, API rate limits and outage behavior on major venues (Binance, Bybit, Hyperliquid, Coinbase, Alpaca). How paper fills differ from live fills (especially Alpaca paper vs live) and how much backtest→live degradation to expect.
6. **LLM-agent trading specifically (2024–2026).** Published experiments and credible write-ups of LLM-in-the-loop trading: results, failure modes (hallucination, non-determinism, prompt drift, silent rule-breaking). What division of labor does the evidence support — LLM for research/strategy iteration/code, deterministic code for signals and execution? What memory/feedback-loop designs actually improve agent decisions vs naive re-prompting? Include failures, not just demos.
7. **Regime detection a retail coder can implement.** Simple, computable regime filters (trend vs range vs high-vol) with evidence they improve crossover-style systems; how quickly regimes shift on crypto 5m–1h timeframes.
8. **Base rates and honest expectations.** What fraction of retail day/algo traders are profitable over 1+ years (brokerage datasets, regulator studies, academic work — e.g., Barber & Odean lineage, the Brazilian day-trader study, FX/CFD broker disclosures)? Typical alpha decay after publication/crowding. What weekly PnL claims from trading-bot influencers should be assumed to be (survivorship, selective reporting) unless audited?
9. **US practicalities.** Pattern day trader rule thresholds and how they'd bite an Alpaca account; wash-sale rules and current (2026) crypto tax treatment including any wash-sale extension to crypto; broker/exchange legality and geo-restrictions for US retail (Binance.US vs Binance, Bybit access, Hyperliquid status); anything that regulates automated retail order flow on US brokerages.
10. **Curated source list.** The 10–20 highest-quality resources for systematic retail trading — papers, books, blogs, open-source repos, datasets — each with one line on what it's uniquely good for and its bias.

## Method requirements

- Search broadly, then verify: prefer primary sources (peer-reviewed papers, SSRN, exchange/broker official docs, regulator publications, audited datasets) over blogs; prefer blogs with methodology over influencer content. When the only source for a claim is marketing or YouTube, say so and treat it as unverified.
- For **every quantitative claim**: inline citation, publication year, market and sample period, and whether costs were included.
- Label each finding: **Strong evidence / Mixed / Weak-anecdotal.** Actively seek disconfirming evidence, especially for conclusions I'd *like* to be true (e.g., "5m MA crossovers can be profitable").
- Where the evidence contradicts my current setup, say it bluntly and quantify the gap.
- Recency: prioritize 2023–2026 sources for crypto structure, fees, LLM-agent results, and US regulation; classic literature is fine for fundamentals.
- Resolve conflicts between sources explicitly — don't average them silently.

## Output format

1. **Executive summary (≤1 page):** the ~10 findings that should most change what I build next, each with a confidence label.
2. **Per-question sections** (Q1–Q10) with citations and confidence labels throughout.
3. **Kill criteria:** measurable thresholds for my paper-trading experiments — minimum trade count before judging, profit factor / expectancy / drawdown levels at which I keep, revise, or kill a strategy, and the statistical reasoning behind them.
4. **A 4-week paper-trading research plan** for my specific bot: what to test in what order (filters, timeframes, exits), what to log, and what results would justify graduating to 1–3% real capital vs going back to the drawing board.
5. **Appendix:** full source list with quality notes.

Do not give personalized financial advice. Do give evidence, base rates, and engineering guidance a technical reader can act on.
