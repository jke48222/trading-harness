# Trial 09: Crypto momentum v2, several lookbacks and a band (pre-registered)

Registered 2026-10-11, before any statistic below was computed. The commit that adds this file comes before the commit that adds the script and its results. Trials 10 and 11 were registered in the same commit.

## Why this trial

The book runs Trial 07's rule on 32 coins: hold a coin while its 28-day return is positive. Trials 07 and 08 support that over 2017 to 2026, but not on recent data alone: from 2023-12 the book's 32 coins averaged +0.906% a month of timing excess, p = 0.30 (Trial 08, D2).

The research memo of 2026-10-11 points at three changes, all from published work rather than from this project's data:

- **Shorter and mixed lookbacks.** Recent crypto momentum is strongest at one to four weeks (Borri, Liu, Tsyvinski & Wu, 2026 working paper). Blends of several lookbacks hold up better than any single one (Baltas & Kosowski; Barbon et al., 2025).
- **A band between entry and exit.** A no-trade zone is the most dependable single cost fix (Novy-Marx & Velikov, 2016). Costs are this book's main drag.
- **Binary, so the book can run it.** The candidate is long or flat, like today's rule, so the book's order logic carries over unchanged.

The candidate is fixed here, before its results are seen: four lookbacks, enter on three positive, exit on one or none.

## Universes (locked)

| Name | Symbols | Role |
|---|---|---|
| BOOK-32 | the 32 `BOOK_CRYPTO` symbols in `src/universe.ts` | decision |
| T07-8 | BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK (USDT) | descriptive |

## Data (locked)

As in Trial 08: Binance USDT daily candles from listing, closed candles only, those that closed before 2026-10-01 00:00 UTC. The last month used is 2026-09. Months are calendar months fully covered by each series (`completeMonths`, no gap allowed), keyed by the candle's close time.

## Rules (locked)

- **v1, the book today:** `s_t = 1` if `close_t / close_{t-28} - 1 > 0`, else 0.
- **v2, the candidate:** `votes_t` is how many of the lookbacks L = 7, 14, 28 and 56 days have `close_t / close_{t-L} - 1 > 0`.
  - From flat, go long when `votes_t >= 3`.
  - From long, go flat when `votes_t <= 1`.
  - Otherwise keep `s_{t-1}`. Flat before the first candle with a 56-day lookback.
- **The same return days for both.** Both rules start on candle 58 (56 + 2), so every symbol covers the same months under each rule. Trial 08 started v1 on candle 30, so v1's numbers here differ slightly from Trial 08's near each coin's listing.
- **Execution at the signal close** (Trial 07's model): `r_{t+1} = s_t · (close_{t+1}/close_t - 1) - c · |s_t - s_{t-1}|`, with c = 30 bps per unit of position change.
- **Benchmark** (Trial 07's): `w̄ · (close_{t+1}/close_t - 1)`, costless.
  - `w̄` is each rule's own mean `s` over the symbol's return days.
  - Monthly excess is the strategy month minus the benchmark month.
  - The portfolio is the equal-weight mean across symbols live that month.

## Hypotheses and decision rule (locked)

The decision window is 2021-01 to 2026-09. Each test's H0 is a mean of 0 or less, with a one-sided percentile-bootstrap p (10,000 resamples, a fresh mulberry32(42) per test).

- **H1:** BOOK-32, v2's mean monthly excess at 30 bps, in the decision window.
- **H2:** BOOK-32, the mean monthly paired difference (v2 excess minus v1 excess) at 30 bps, in the decision window.

Holm-Bonferroni across H1 and H2 at α = 0.05. The Bonferroni-versus-trials-ledger context is reported next to each, as in Trials 07 and 08.

**The switch rule.** This chooses between two pre-specified versions of a construction already in use; it is not a new claim of edge.

- The book moves from v1 to v2 if the mean paired difference at 30 bps is positive in two windows: the decision window, and every complete month both rules cover up to 2026-09.
- Otherwise it stays on v1.
- H2's p is reported as the strength of the evidence and does not gate the switch. H1 does not gate it either: v1's own recent result is not significant.

## Descriptives (reported, not decisions)

- **D1:** T07-8 under v1 and v2, in both windows.
- **D2:** BOOK-32 over every complete month: v1 and v2 means and p.
- **D3:** v1 and v2 at 0, 5, 15, 30 and 50 bps per unit change (decision window, BOOK-32), and v2's break-even cost.
- **D4:** position changes per year and mean exposure `w̄`, v1 against v2, averaged across BOOK-32.
- **D5:** v2's portfolio excess with inverse-volatility weights instead of equal weights. Each symbol is weighted by 1 over the standard deviation of its 60 daily returns before the month starts.

## Consequences (locked)

- **Switch:** the paper book's crypto run moves to v2 for every new decision.
  - Entries on three of four votes, exits on one or none. Same lookbacks, sizing and risk controls.
  - New entry rows get their own setup tag and are scored under v2. Existing rows keep their v1 scores.
  - The re-entry wait after a stop or a manual close ends once v2's exit condition (one vote or none) has held on a close since.
- **No switch:** the book stays on v1.
- No outcome changes a parameter: no other lookbacks, thresholds or universes are tried.

## Disclosure

Four configurations are appended to `data/trials.csv`: v2 on BOOK-32 (H1), v2 minus v1 on BOOK-32 (H2), v2 on T07-8 (D1), and v2 on BOOK-32 with inverse-volatility weights (D5).
