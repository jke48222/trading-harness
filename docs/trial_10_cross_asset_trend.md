# Trial 10: Trend across asset classes, through ETFs (pre-registered)

Registered 2026-10-11, before any statistic below was computed, in the same commit as Trials 09 and 11. That commit comes before the one that adds the script and its results.

## Why this trial

Trial 08 found no support for 28-day momentum on 15 US stock ETFs. They all move with the stock market, so timing them is close to one bet. The trend-following evidence is about something else: spreading trend bets across bonds, currencies, commodities and stocks that don't move together (Moskowitz, Ooi & Pedersen, 2012; Hurst, Ooi & Pedersen, 2017). The research memo of 2026-10-11 ranks that first among strategies a retail account can reach.

This tests the version the paper account can trade today: long or flat in ETFs, orders at the next open, no futures and no shorting.

## Universe XA-11 (locked)

One fund per asset class, plus two Treasury maturities and inflation-protected bonds, all listed before 2016. Chosen by asset class, not by returns.

| Asset class | ETF |
|---|---|
| US stocks | SPY |
| Developed-market stocks outside the US | EFA |
| Emerging-market stocks | EEM |
| US real estate | VNQ |
| Long-term Treasuries | TLT |
| Intermediate Treasuries | IEF |
| Inflation-protected Treasuries | TIP |
| Investment-grade corporate bonds | LQD |
| Gold | GLD |
| Broad commodities | DBC |
| US dollar | UUP |

## Data (locked)

- **Source:** Alpaca SIP daily bars, adjustment `all` (splits and dividends), from 2016-01-04, sessions dated 2026-09-30 or earlier, as in Trial 08.
- **Months:** keyed by session date; `completeMonths` allows a four-day gap.
- **Coverage, checked before registration:** every fund has 2,708 sessions from 2016-01-04 to 2026-10-09. Only dates and counts were read.

## Rule (locked)

- `votes_t` is how many of the lookbacks L = 21, 63 and 252 sessions have `close_t / close_{t-L} - 1 > 0`.
- `s_t = 1` if `votes_t >= 2`, else 0. Long or flat, decided at each close.
- The first return day is session 254 (252 + 2).
- **Execution at the next session's open** (Trial 08's table), with c = 5 bps per unit of position change.
- **Benchmark** (Trial 08's): `w̄ · (close_{t+1}/close_t - 1)`, costless. Monthly excess; the portfolio is the equal-weight mean across the 11.

## Hypothesis and decision (locked)

- **H1:** XA-11's mean monthly excess is above 0, over every complete month to 2026-09.
  - One-sided percentile-bootstrap p, 10,000 resamples, mulberry32(42).
  - α = 0.05. It is one test, so no Holm adjustment.
  - The Bonferroni-versus-trials-ledger context is reported.
- **Pass:** a trend sleeve joins the paper book (consequences below).
- **Fail:** no sleeve.

## Descriptives (reported, not decisions)

- **D1, long/short:** `s_t = +1` when `votes_t >= 2`, `-1` when `votes_t <= 1`.
  - Day t+1's return is `(1 + s_{t-1} · (open_{t+1}/close_t - 1)) · (1 + s_t · (close_{t+1}/open_{t+1} - 1)) - 1 - c · |s_t - s_{t-1}|`.
  - Monthly excess against its own `w̄` benchmark.
- **D2, per fund:** mean excess, `w̄` and position changes per year.
- **D3, Faber's 10-month rule:**
  - At each month's last session, hold for the next month if the close is above the mean of the last 10 month-end closes.
  - Trade at the next session's open, 5 bps.
  - Excess against its own `w̄`.
- **D4, correlation with crypto:** the correlation between XA-11's monthly strategy return (equal-weight, net) and the crypto book's (BOOK-32 under v1, 30 bps), over common months.
- **D5, managed-futures funds:** DBMF and KMLM monthly total return (adjustment `all`) from their first complete months. Mean, standard deviation, and correlation with XA-11's monthly strategy return over common months.
- **D6, inverse-volatility weights:** XA-11's portfolio excess, with each fund weighted by 1 over the standard deviation of its 60 daily returns before the month starts.

## Consequences (locked)

- **Pass:** a trend run joins the hourly agent and trades XA-11 on the paper account under this rule.
  - Long or flat, with orders at the next open.
  - $2,700 per fund, about $30,000 at full exposure: the share the stock sleeve held.
  - Signals use dividend-adjusted prices, as this test does.
  - The book's other risk controls apply unchanged, and the crypto book's budget and its 70% crypto cap don't change.
- **Fail:** no trend sleeve. The budget the stock sleeve held stays in cash.
- No outcome changes a parameter.

## Disclosure

Four configurations are appended to `data/trials.csv`: XA-11 long/flat (H1), long/short (D1), Faber's rule (D3) and inverse-volatility weights (D6). DBMF and KMLM (D5) are outside funds used as a yardstick, not configurations of this harness.

---

## Results (computed 2026-10-11, after registration)

`npx tsx scripts/trial10_cross_asset_trend.ts`, evaluated as of 2026-10-01 00:00 UTC (sessions through 2026-09-30). All 11 funds share one session calendar, with no break longer than a holiday weekend.

| Test | What | Months | Mean monthly excess | t | Bootstrap p | Result |
|---|---|---|---|---|---|---|
| H1 | XA-11 long/flat, 5 bps, next open | 2017-01 to 2026-09 (117) | -0.094% (sd 1.08%) | -0.94 | 0.830 | **fail** |

As traded, the sleeve returned +0.299% a month, against +0.559% for holding all 11 in equal weights. Context: the Bonferroni correction against the configurations disclosed at the time gives 1.0.

### Descriptives

- **D1, long/short:** -0.204% a month (p 0.85).
- **D2, per fund:** 10 of 11 lost to their own average exposure. TLT was worst at -0.357% a month; GLD was the only positive one, at +0.022%. A position changes 9 (SPY) to 22 (TLT) times a year.
- **D3, Faber's 10-month rule:** +0.007% a month (p 0.48), from 2016-11.
- **D4:** XA-11's monthly returns correlate 0.22 with the crypto book's.
- **D5, managed-futures funds, as held:** DBMF returned +0.716% a month (sd 3.41%) from 2019-06, and KMLM +0.726% (sd 3.73%) from 2020-12. Their correlations with XA-11 were 0.25 and -0.09.
- **D6, inverse-volatility weights:** -0.074% a month (p 0.83).

### Verdict

**No trend sleeve.** Over 2017 to 2026, trend timing on these 11 funds did not beat holding them, long/flat or long/short, by any of the three rules tested. That extends Trial 08's stock-only result to bonds, gold, commodities and the dollar.

The managed-futures funds did better as held. They trade futures across many more markets, with shorts and borrowed exposure; this test can't speak for them, and the paper account can't trade futures. The decade tested overlaps the trend literature's flat 2010s (Babu et al., 2020); this is one window. Under the locked consequence, the budget the stock sleeve held stays in cash.
