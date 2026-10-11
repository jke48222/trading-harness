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
