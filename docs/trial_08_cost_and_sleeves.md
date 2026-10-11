# Trial 08: Real costs, the book's universe, and the stock sleeve (pre-registered)

Registered 2026-10-11, before any statistic below was computed. The commit that adds this file comes before the commit that adds the script and its results.

## Why this trial

Trial 07 is the only test in this project that passed after correction: daily-sign 28-day time-series momentum (TSMOM-28), long-only, on an unselected 8-crypto universe, +4.30%/mo monthly timing excess, p = 0.0004. The paper book has run that construction since 2026-07-15. Three things about the book are not covered by that evidence:

1. **Costs.** Trial 07 charged 15 bps per unit of position change (30 bps round trip). This account pays more. Alpaca's crypto taker fee at the entry tier is 0.25% per side (the 2026-07-15 smoke test: the position held exactly 0.25% less than the filled quantity). Over the book's first 108 closed round trips (broker fills, 2026-07-15 to 2026-10-11), entries filled a mean 23 bps above the signal close and exits a mean 17 bps above the model's exit close, a net of about 6 bps per round trip. Per side that is 25 + 3 = 28 bps, registered here as **30 bps per unit of position change**.
2. **Universe.** The book trades 32 cryptos (every Alpaca-tradable USD pair with Binance USDT history, stablecoins excluded), not Trial 07's 8.
3. **Stocks.** The book also trades 24 large US stocks and ETFs that no trial has validated. Trial 05 found too few samples on six years of IEX data. Over the paper period the stock sleeve closed 66 round trips with a mean of -1.64% and a realized loss of $1,869.

Execution is faithful: across the 108 trips the model's gross return and the fills' gross return differ by a mean of -0.05% (median -0.17%). So the open question is the strategy, not the plumbing.

## Universes (locked)

| Name | Symbols | Selected how |
|---|---|---|
| T07-8 | BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK (USDT) | Trial 07's unselected set, unchanged |
| BOOK-32 | the 32 `BOOK_CRYPTO` symbols in `src/universe.ts` | availability on 2026-07-15, not returns |
| ETF-15 | SPY, QQQ, IWM, DIA, and all 11 SPDR sector funds: XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY | structure (broad indexes plus the complete sector set), not returns |
| BOOK-24 | the 24 `BOOK_STOCKS` symbols | hand-picked large caps; hindsight-biased, so descriptive only |

## Data (locked)

- Crypto: Binance USDT daily candles from listing, closed candles only, as in Trial 07.
- Stocks and ETFs: Alpaca SIP daily bars, adjustment `all` (splits and dividends), from 2016-01-04. SIP is the consolidated feed; Alpaca serves it for history older than 15 minutes.
- Months: calendar months fully covered by each series (`completeMonths`, 0-day gap allowance for crypto, 4 for US sessions). The last month used is 2026-09.

## Construction (locked)

Signal at the close of day *t*: `s_t = 1` if `close_t / close_{t-28} - 1 > 0`, else 0. Long-only. Lookback counted in candles (trading sessions for stocks).

**Crypto** (the book enters within two hours of the daily close, so execution at the close is the Trial 07 model): `r_{t+1} = s_t · (close_{t+1}/close_t - 1) - c · |s_t - s_{t-1}|`.

**Stocks** (the book trades at the next session's open, so that is modeled):

| s_{t-1} | s_t | return on day t+1 |
|---|---|---|
| 1 | 1 | close_{t+1} / close_t - 1 |
| 0 | 1 | close_{t+1} / open_{t+1} - 1 - c |
| 1 | 0 | open_{t+1} / close_t - 1 - c |
| 0 | 0 | 0 |

Stock months are assigned by session date.

**Benchmark** (the Trial 07 drift check): `w̄ · (close_{t+1}/close_t - 1)`, costless, where `w̄` is the symbol's mean `s` over its window. Monthly excess = strategy month - benchmark month, compounded within the month. Portfolio excess = equal-weight mean across symbols live that month.

**Costs:** c = 0.0030 for crypto (30 bps per unit change), c = 0.0005 for stocks (5 bps: commission-free, ETF spreads near 1 bp).

## Hypotheses and decision rule (locked)

Each test: H0 is a mean portfolio monthly excess of 0 or less. One-sided p by percentile bootstrap of the mean, 10,000 resamples, seed mulberry32(42), as in Trial 07.

- **H1:** T07-8 at 30 bps.
- **H2:** BOOK-32 at 30 bps.
- **H3:** ETF-15 at 5 bps, next-open execution.

Family-wise control: **Holm-Bonferroni across H1 to H3 at α = 0.05.** The Bonferroni-versus-trials-ledger context (p times the count of disclosed configurations) is reported next to each, as in Trial 07, without being the rule.

## Descriptives (reported, not decisions)

- D1: T07-8 at 15 bps (should reproduce Trial 07) and at 50 bps.
- D2: OOS-era subsample (months from 2023-12) for H1 to H3.
- D3: BOOK-24 with the H3 construction and cost. Hindsight-selected, so it shows what the hand-picked list looks like, nothing more.
- D4: per-symbol mean excess, mean exposure w̄ and position changes per year.
- D5: break-even cost per unit change (the c at which mean excess is 0) for H1 to H3.

## Consequences (locked)

These are recommendations. Changing the paper book's construction is Jalen's call.

- **H1 fails:** Trial 07's result does not survive the fees this account pays. Crypto stays watch-only at Alpaca's entry-tier fees, and any real-money discussion for crypto waits for a cheaper venue or tier to be measured on this account.
- **H1 passes, H2 fails:** the book's 32 coins reach beyond the evidence. Recommend restricting the crypto sleeve to T07-8 ∩ Alpaca-tradable (BTC, ETH, SOL, XRP, DOGE, ADA, LINK; BNB is not on Alpaca).
- **H3 fails:** no portfolio-level support for 28-day momentum on US equities. Recommend removing the stock sleeve from the paper book.
- **H3 passes:** recommend replacing the 24 hand-picked names with ETF-15.
- No outcome changes a parameter. No new lookbacks, no cost-fitted variants, no re-aggregation.

## Disclosure

H1, H2, H3 and D3 are appended to `data/trials.csv` as four configurations, with D1, D2 and D5 in their notes.

---

## Results (computed 2026-10-11, after registration)

`npx tsx scripts/trial08_cost_and_sleeves.ts`, evaluated as of 2026-10-01 00:00 UTC (months through 2026-09). Data were complete: no missing crypto days, no stock gap longer than a holiday weekend.

| Test | Universe, cost, fills | Months | Mean monthly excess | t | Bootstrap p | Holm |
|---|---|---|---|---|---|---|
| H1 | T07-8, 30 bps, at the close | 2017-10 to 2026-09 (108) | +3.735% (sd 14.88%) | 2.61 | 0.0011 | **pass** (adjusted 0.0033) |
| H2 | BOOK-32, 30 bps, at the close | 2017-10 to 2026-09 (108) | +2.991% (sd 11.25%) | 2.76 | 0.0011 | **pass** (adjusted 0.0033) |
| H3 | ETF-15, 5 bps, next open | 2016-03 to 2026-09 (127) | -0.226% (sd 1.70%) | -1.50 | 0.934 | **fail** |

Context, not the rule: against all 57 configurations disclosed in `data/trials.csv`, a Bonferroni correction gives 0.063 for H1 and H2. They pass the registered test but would not survive a correction for every look this project has taken. Trial 07 did (0.021).

### Descriptives

- **D1, cost sensitivity on T07-8:** +4.091%/mo at 15 bps (p 0.0006), +3.264%/mo at 50 bps (p 0.0045). Trial 07 as published: +4.299%/mo over 105 months to 2026-06.
- **D2, from 2023-12 (34 months):** H1 +1.112%/mo (p 0.33), H2 +0.906%/mo (p 0.30), H3 -0.267%/mo (p 0.90). As in Trial 07, the recent era alone shows nothing significant.
- **D3, the book's 24 stocks:** -0.217%/mo (p 0.94). Only TSLA (+1.11), AMD (+1.00) and META (+0.24) are positive.
- **D4, per symbol:** all 8 T07-8 symbols are positive, DOGE highest at +10.63%/mo and ETH lowest at +1.43. 24 of the book's 32 coins are positive. The 8 negative ones are SKY, TRUMP, YFI, LTC, PAXG, RENDER, WIF and ONDO; SKY, ONDO and TRUMP have under 20 months of data. All 15 ETFs are negative, from XLY at -0.01 to XLI at -0.46. A position changes 26 to 32 times a year in Trial 07's 8 coins, 19 (POL) to 45 (SKY) across the book's 32, and 16 to 22 in an ETF.
- **D5, break-even cost per unit change:** 193 bps for H1 and 162 bps for H2, against the 30 paid. H3 has none, because its excess is negative at zero cost.

### Verdict

**Crypto holds at real costs.** Trial 07's result survives the fees this account pays, on its 8 coins and on the book's 32, with a wide margin on cost. Two limits stand: the 2023 to 2026 era alone is not significant, and a correction for every look the project has taken would not pass.

**Stocks have no support.** Equal-weighted, the 15 unselected ETFs lost to their own average exposure even before costs (D5), and at 5 bps every one of them lost (D4). The hand-picked 24 did no better. The paper book agrees: its 66 stock round trips averaged -1.64% and lost $1,869 realized.

**Recommendation (the locked consequence; changing the book is Jalen's call):** remove the stock sleeve. `ENTRY_SKIP=@book-stocks` stops new stock entries and lets the exit manager close the open stock positions on the momentum rule, so nothing is orphaned or force-sold.

### Note added after the run

Model v2 (2026-10-11, after this trial was registered) re-scored the book's rows with a full lookback for stocks. The registration's execution figures move a little: the gap between model and fills is now a mean of -0.09% (median -0.18%), and exit fills average 12 bps above the model's exit close instead of 17.

Those figures pool all 108 trips, and 66 of them are stocks, whose fills against the signal close mostly measure the move from that close to the next morning's fill. On the 42 crypto trips alone, entries filled a mean 7 bps below the signal close and exits a mean 9 bps below the model's exit close (`npm run report`). That is about 1 bp of slippage per side on top of the 25 bps fee, roughly 26 bps per side against the 30 registered. At the medians, slippage is about 12 bps per side (entries 12 above the signal close, exits 13 below the model's exit), which would put the cost near 37 bps per side; with break-even at 162 bps (D5), the verdict holds either way.

### Implementation notes

- Evaluated at a fixed date (2026-10-01 00:00 UTC) so a re-run reproduces these numbers.
- As in Trial 07's code: w̄ is averaged over every return day, the first return day is candle 30, and each p uses a fresh mulberry32(42).
- Binance's 2018-02-08 daily candle closed at 00:28 UTC during an exchange halt for BTC, ETH, BNB and LTC. It is kept as an ordinary day, as Trial 07 did.
- Crypto months are keyed by candle close time, stock months by session date.
- In `data/trials.csv`, `fee_bps` for these four rows is the cost per unit change (30 or 5). Trial 07's row put 30 there for the round trip at 15 per change.
- These four rows carry the mean monthly excess in `total_pnl_pct`; Trial 07's row carried the same statistic in `avg_pnl_pct`. The ledger is append-only, so both stay as written.
