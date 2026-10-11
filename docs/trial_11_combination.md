# Trial 11: The mix of crypto momentum, cross-asset trend and an index core (registered, descriptive)

Registered 2026-10-11, before any statistic below was computed, in the same commit as Trials 09 and 10. It has no hypothesis test and decides nothing; the mixes and measures are fixed here so the results can't be chosen after the fact.

## Why this trial

The research memo of 2026-10-11 found that combining strategies that don't move together is the most dependable way to raise a portfolio's return per unit of risk. Coins move together (average correlation about 0.6), so the book's 32 coins act like fewer than two independent bets. This trial measures what the crypto book and a cross-asset trend sleeve would have done together, and next to a plain stock index.

## Inputs (locked)

- **Crypto sleeve:** BOOK-32 under the rule Trial 09's switch rule selects, at 30 bps. Its monthly strategy return is the equal-weight mean across the symbols live that month, computed as in Trial 09.
- **Trend sleeve:** XA-11 long/flat at 5 bps (Trial 10's rule), as the equal-weight monthly strategy return.
- **Index core:** SPY bought and held, monthly total return (adjustment `all`).
- **Window:** the months all three cover, to 2026-09.

## Mixes (locked)

All rebalanced monthly:

- **M1:** crypto alone.
- **M2:** trend alone.
- **M3:** SPY alone.
- **M4:** crypto 50%, trend 50%.
- **M5:** crypto and trend at equal risk. Weights are proportional to 1 over each sleeve's standard deviation over the prior 12 months, starting in the 13th month of the window.
- **M6:** one third each in crypto, trend and SPY.

## Measures (descriptive)

- Annualized mean, volatility and Sharpe ratio. The Sharpe is measured against zero, since the paper account's cash earns nothing.
- Worst month and maximum drawdown of the compounded monthly series.
- The correlation matrix of the three inputs.
- Each mix's mean return in SPY's 12 worst months.

## Consequences

None. If Trial 10 passes, its own consequences size the trend sleeve; nothing here changes that. No outcome changes a parameter.

## Disclosure

Three configurations are appended to `data/trials.csv`: M4, M5 and M6. M1 to M3 are already disclosed rules or buy-and-hold.

---

## Results (computed 2026-10-11, after registration)

`npx tsx scripts/trial11_combination.ts`, evaluated as of 2026-10-01 00:00 UTC.

- **Crypto sleeve:** BOOK-32 under v2, which is what Trial 09's switch rule chose.
- **Window:** 2017-11 to 2026-09 (107 months).
- **Correlations:** crypto with trend 0.24, crypto with SPY 0.30, trend with SPY 0.54.

| Mix | Months | Annual mean | Volatility | Sharpe | Worst month | Max drawdown | Mean in SPY's 12 worst months |
|---|---|---|---|---|---|---|---|
| M1 crypto | 107 | +71.2% | 73.9% | 0.96 | -26.9% | -51.9% | -3.2% |
| M2 trend | 107 | +3.4% | 5.0% | 0.68 | -4.2% | -8.6% | -1.0% |
| M3 SPY | 107 | +15.1% | 16.2% | 0.93 | -12.6% | -23.9% | -7.5% |
| M4 crypto 50 / trend 50 | 107 | +37.3% | 37.7% | 0.99 | -12.9% | -28.1% | -2.1% |
| M5 crypto/trend at equal risk (from 2018-11) | 95 | +10.7% | 9.8% | 1.10 | -4.4% | -9.7% | -0.9% |
| M6 one third each | 107 | +29.9% | 27.3% | 1.09 | -8.4% | -23.3% | -3.9% |

Over M5's own 95 months, the other mixes' Sharpe ratios are 0.93 (crypto), 0.77 (trend), 0.97 (SPY), 0.97 (M4) and 1.09 (M6).

### What it shows

- **Mixing lifts the Sharpe ratio a little and cuts drawdowns a lot.** The crypto sleeve alone fell 52% at its worst. Mixed with the trend sleeve at equal risk, the worst fall was under 10%, at a Sharpe of 1.10 against crypto's 0.93 over the same 95 months.
- **The trend sleeve's help comes from holding its assets, not from timing them.** Trial 10 found its timing worth nothing, so the same diversification is available by holding the funds, which is investing rather than trading.
- **The crypto sleeve is the risk.** At 74% volatility and a 52% worst drawdown, how much of the account it uses decides the account's risk far more than anything else here.
