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
