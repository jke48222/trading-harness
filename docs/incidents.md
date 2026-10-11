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
3. The limit was set 30 bps above a Binance one-minute close. On coins whose Alpaca spread is wider than about 60 bps (LDO, ONDO, POL and others), it sat below the ask and could not fill.
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
