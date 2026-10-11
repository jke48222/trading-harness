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

---

## Results (computed 2026-10-11, after registration)

`npx tsx scripts/trial09_crypto_momentum_v2.ts`, evaluated as of 2026-10-01 00:00 UTC (months through 2026-09). No crypto days were missing; Binance's 2018-02-08 halt candle was kept, as in Trials 07 and 08.

| Test | What | Months | Mean monthly | t | Bootstrap p | Holm |
|---|---|---|---|---|---|---|
| H1 | v2's excess, BOOK-32, 30 bps | 2021-01 to 2026-09 (69) | +3.274% (sd 12.99%) | 2.09 | 0.0101 | **pass** (adjusted 0.0202) |
| H2 | v2 minus v1, BOOK-32, 30 bps | 2021-01 to 2026-09 (69) | +0.374% (sd 3.04%) | 1.02 | 0.1485 | fail |

**The switch rule.** v2 minus v1 is +0.374% a month in the decision window and +0.543% a month over every month both rules cover (2017-11 to 2026-09, 107 months, p = 0.065). Both are positive, so **the book switches to v2**.

Context, not the rule: against the 61 configurations disclosed at the time, a Bonferroni correction gives 0.62 for H1. Like Trial 08's crypto results, it would not survive a correction for every look this project has taken.

### Descriptives

- **D1, T07-8:**
  - Decision window: v1 +3.996% a month (p 0.014), v2 +4.271% (p 0.009), v2 minus v1 +0.275% (p 0.26).
  - Every month: v1 +3.715%, v2 +4.199%, v2 minus v1 +0.484% (p 0.12).
- **D2, BOOK-32 over every month:** v1 +2.875% a month (p 0.0019), v2 +3.418% (p 0.0004).
- **D3, cost:**
  - v2's lead over v1 in the decision window grows with the cost per change: +0.125% a month at 0 bps, +0.167% at 5, +0.250% at 15, +0.374% at 30 and +0.538% at 50.
  - v2 breaks even at 240 bps per unit change.
- **D4, trading:** v2 changes a position 20.2 times a coin per year against v1's 29.6, a third fewer. Mean exposure is about the same (0.44 against 0.45).
- **D5, inverse-volatility weights:** +2.500% a month in the decision window (p 0.010) and +2.987% over every month (p 0.0005). The mean is lower than with equal weights, and so is the volatility.

### Verdict

**The book moves to v2.** Its advantage comes mostly from trading less: before costs it leads v1 by about a tenth of a percent a month, and the lead grows with each basis point of cost. That v2 beats v1 is not established (p = 0.15). This was a choice between two pre-specified versions under a rule fixed in advance, not a claim of new edge.

v2 does show a significant edge on the book's coins from 2021 on (H1). Trial 08's subsample from 2023-12 alone was not significant, so the recent era still deserves caution.

### Note added after the run

How the book runs the switch, settled after a review of the implementation, before deployment:

- **The book holds what the vote holds.** It buys a coin whenever the vote's own state is long, computed over the coin's last 119 daily candles, and holds nothing. Requiring three votes on the day of entry would let an entry the book missed (no cash, the crypto window asleep) stay missed for as long as the coin sat at two votes. On 2026-10-11 the vote was long in 29 of the 32 coins and the book held 14 of them.
- **Positions opened under the 28-day rule.** Crypto positions exit under the vote from the switch on, as the consequence says. Their trips are left out of the model-against-fill figures, because their model score follows the 28-day rule and their exit the vote. The stocks being wound down keep the 28-day exit they were opened with, the momentum rule Trial 08's consequence named; no trial tested the vote on stocks.
- **Survivorship.** BOOK-32 is the list of coins Alpaca offered in 2026, so H1 (p = 0.010) carries survivor bias, as Trial 08's H2 did. The paired H2 and the switch rule compare two rules on the same coins and are less exposed.
- **D5's weights** used daily returns from the first return day on, needing 20 or more, not "its 60 daily returns before the month" from listing. D5's full window therefore starts in 2017-12 rather than 2017-11. It is a descriptive and decides nothing.

