# Incidents

## 2026-07-17 to 2026-10-11: resting orders blocked the crypto book

Found 2026-10-11 during a status check. Fixed and deployed the same day.

### What happened

From July 17, a crypto entry that did not fill within 20 seconds was left open at Alpaca as a good-til-canceled limit buy. Thirty-five piled up (13 LDO, 12 ONDO, 9 POL, 1 WIF) and reserved $63,787.51 of cash. With that cash held back, Alpaca refused crypto buys with "insufficient balance" on 48 days from July 27, across 26 symbols. Stock entries were unaffected.

Seven of the timed-out orders filled later with no ledger row, from 28 seconds to 44 hours after submission (DOT, GRT, CRV, XTZ, PAXG, SHIB, BONK). Four of those positions sat unmanaged: no momentum exit and no catastrophe stop, because the exit manager only acts on positions it can attribute. PAXG had been held since July 23, SHIB since July 27, GRT since August 24 and BONK since August 25. The other three were later sold, and their exits were priced against an earlier trip's entry fill:

| Symbol | Recorded | From broker fills |
|---|---|---|
| DOT, closed 2026-10-07 | +37.88% | +4.85% |
| XTZ, closed 2026-07-31 | -10.83% | -1.23% |
| CRV, closed 2026-08-01 | -4.47% | -2.49% |

The health check had listed the four orphans as warnings since July 23. Warnings do not raise the macOS alert, and it never looked at open orders or broker refusals, so nothing alerted.

Effect on results: from late July the crypto sleeve was not the Trial 07 construction it was meant to test. Coins with positive momentum often could not be bought. The paper P&L for that period understates how many crypto positions the strategy called for.

### Root causes

1. `submitPaperBuyLimit` placed a good-til-canceled limit, waited 20 seconds, and threw without canceling.
2. The cleanup that cancels leftover orders ran only in maker mode, which was off.
3. The limit was set 30 bps above a Binance one-minute close. On coins whose Alpaca spread is wider than about 60 bps (LDO, ONDO, POL and others), it sat below the ask and could not fill. (Corrected 2026-10-14: that explains a missed first fill, not weeks of them. Alpaca's paper simulator does not fill LDO, POL or WIF at any price, and filled ONDO only once, in October; see the next incident.)
4. `toFixed(6)` rounded sub-cent limits: BONK at 0.0000034 became 0.000003, 12% below the market, which is why BONK and SHIB filled a day or more later.
5. The exit manager took the newest BUY row in file order, so a missing row made it price an exit off the previous trip.
6. Health treated an orphan position as a warning.

### Fix

- Every order settles: it waits for a final state, cancels at `ORDER_TIMEOUT_SEC` (30), and records a partial fill as a position. Each book scan sweeps stale bot orders, adopts any late fill from the broker's history, and takes a run lock.
- Limits come from the venue's own ask; a crypto entry skips when the quoted spread is over `MAX_SPREAD_BPS` (100), and a stock entry falls back to the last one-minute close when the IEX quote is stale or wide. Crypto limits keep nine decimals at every price and round up.
- Positions are attributed by timestamp to the open entry with no exit after it.
- `npm run reconcile` rebuilds round trips from broker fills and compares them with the ledger. Run with `--apply` on 2026-10-11, it adopted the seven late fills and corrected the three exits above, each with a note in the row's reason. The ledger was backed up first.
- Health pages on refused or unconfirmed orders, bot orders resting over 10 minutes, positions with no open entry, failed exits and a stale book agent.

The 35 orders were canceled on 2026-10-11 at 03:22 UTC (the broker's canceled_at); none had filled in the meantime. The first book scan on the new code managed all four former orphans. PAXG's momentum was negative, so it exited at +0.61%; BONK, GRT and SHIB were held.

Three trips from the July 15 and 16 setup work stay as they are and are reported by reconcile as manual: a $10 BTC smoke test, and an LTC position that a test order closed and a manual buy restored.

## 2026-10-12 to 2026-10-14: the paper simulator never fills LDO, POL or WIF

Found 2026-10-14 during a status check. Fixed and deployed the same day.

### What happened

After the switch to Trial 09's vote on 2026-10-11, 15 crypto entries were due at the next window. Twelve filled on 2026-10-12. LDO, POL and WIF did not: in every window scan the bot sent a buy limit 30 bps above Alpaca's ask, waited 30 seconds and canceled it, as designed. After the fourth miss in a row, health paged "entries the strategy wanted keep failing" on every run from about 00:30 UTC on 2026-10-14, and it would have kept paging for as long as the vote on those coins stayed long.

Every order settled and was logged, and none was refused or left resting. The pages still count: since 2026-10-11 the health pages are part of the daily criteria, so the clock in gate 1 restarted on 2026-10-14. The cost is to the experiment: the book could not hold three coins its rule was long on, about $5,000 at the sizes the bot asked for.

### Evidence

Every buy this account has placed on these pairs since July 15, from the broker's order history:

| Pair | Orders | Filled |
|---|---|---|
| LDO/USD | 20 (2 market, 18 limit) | 0 |
| POL/USD | 16 (2 market, 14 limit) | 0 |
| WIF/USD | 6 (all limit) | 0 |
| ONDO/USD | 14 (1 market, 13 limit) | 1, on 2026-10-12 |

- Every limit since 2026-10-11 was priced 30 bps above Alpaca's own ask when it was sent.
- The 35 limits sent from July 17 to October 5 rested until 2026-10-11, up to 86 days. Binance's daily lows later fell 3.3% to 32.7% below every one of them. POL's July 17 limit of 0.0823 was still open on July 29, when the bot's new POL limit was about 12% lower.
- July's market orders were canceled unfilled after 37 to 84 minutes.
- Thin trading is not the reason. In the 30 days to 2026-10-13, Alpaca's crypto venue printed 153 LDO trades, 119 POL and 186 WIF. YFI printed 73, XTZ 164, SKY 199 and SUSHI 224, and their limits filled (1 of 1, 3 of 3, 1 of 1 and 2 of 2). ONDO printed 486 trades worth $277,505.
- The four pairs' asset records match pairs that fill: active, tradable, fractionable, with the same 1e-9 price and quantity increments.
- Alpaca's [paper trading rules](https://docs.alpaca.markets/us/docs/paper-trading) say a buy limit fills once its price is at or above the best ask, matched against the current NBBO. These orders met that rule.

### Root cause

Alpaca's paper simulator does not fill these pairs. Why can't be seen from outside; it is not the bot's pricing, the spread, how often the coins trade, or their asset settings. ONDO behaved the same way until its one fill on 2026-10-12.

This also corrects root cause 3 of the July incident. All 35 orders that piled up then were on these four coins, and none of them filled after prices fell through their limits.

### Fix

- The book opens no new positions in LDOUSDT, POLUSDT or WIFUSDT: `ENTRY_SKIP=@book-stocks,LDOUSDT,POLUSDT,WIFUSDT` in the agent definition and the dashboard's scan command. They stay in the universe, so a position in them would still exit on the rule.
- A symbol whose entries are off now clears its missed-entry count. It used to carry the count forward, so the skip alone would not have stopped the page.
- The skip covers paper only. Before any real-money period, check whether a live account fills these pairs; nothing here tested one.
- Deploying it takes `scripts/agents.sh install` run from the live folder, as for a rule change, because health checks only the rule's settings against the agent definition. A running dashboard needs a restart to pick up its copy.
- ONDO stays in the book, since its most recent order filled. If the simulator won't fill its sell, the exit will fail and health will page. If its later entries fail four scans running, health will page as it did here, and the same skip applies.
