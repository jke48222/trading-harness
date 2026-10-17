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

## 2026-10-14, still open: a -$66,905.32 cash journal the bot did not make

Found 2026-10-17 during a status check. Detection and returns net of outside cash were written the same day. The Alpaca side is open.

### What happened

Alpaca's records show a cash journal (JNLC) of -$66,905.32 on the paper account (number ending ZWTK), booked in the 11:00 UTC hour of 2026-10-13. It reached the live account on the morning of 2026-10-14, UTC. The book scan at 06:13 UTC still saw the account up 0.06% on the day, the status check puts the drop between about 06:40 and 11:12 UTC, and equity went from $105,677 to $38,233 between two health runs.

The bot did not make it. Its only writes to Alpaca are orders (POST and DELETE on /v2/orders) and position closes (DELETE on /v2/positions), and the Trading API has no endpoint that creates a journal.

Nothing noticed it for three days. Health compared positions and orders with the ledger but never looked at cash, and its one sign was a warning, which does not notify: "Crypto buying power is $0".

### Evidence

From GET requests on 2026-10-17:

- `GET /v2/account/portfolio/history` with `cashflow_types=ALL` lists two JNLC amounts: +$100,000.00 in the 2026-07-15 daily point (the funding) and -$66,905.32 in the 2026-10-14 point. At one-hour resolution with `intraday_reporting=continuous`, the journal sits in the 2026-10-13 11:00 UTC bucket, where equity steps from $104,964.88 to $37,658.89.
- `GET /v2/account/activities` does not list it. Of the 1,306 activities since the account opened, the only JNLC is the +$100,000 funding of 2026-07-14.
- Cash rebuilt from those activities (the funding, 771 fills, 445 crypto fees and 89 regulatory fees) is +$50,325.06. Broker cash is -$16,595.09. The gap of $66,920.15 is the journal plus $14.83, about the 0.25% fee ($14.75) on $5,899.03 of crypto sold at 00:10 UTC that day, which the log had not posted yet.
- In the daily history, equity went from $103,601.89 (2026-10-13 point) to $38,742.05 (2026-10-14 point). The journal is -$66,905.32 of that -$64,859.84 move, so the book itself made +$2,045.48.

### Effect on the book

- The daily-loss kill switch fired at 15:20 UTC on 2026-10-14, with the account down 65.54% on the day, and halted new entries for the rest of that UTC day. Exits kept running. It reset on 2026-10-15 against the lower equity.
- Cash has been negative since, and crypto buying power is $0. Crypto buys need cash, so the book can't open a crypto position: Alpaca will refuse its next crypto entry, and health will page that as a broker refusal. Exits still work.
- The journal took cash, not positions. At 21:10 UTC on 2026-10-17 the account held $52,644 of positions on $36,049 of equity, against about 64% of equity before the journal, so each percent the positions move is now about 1.5% on the account.
- The record. On the old code, `npm run perf` over the history to 2026-10-17 reports a return of -63.03%, a max drawdown of -66.13%, a worst day of -62.60% on 2026-10-14, volatility of 124.48% a year and a Sharpe of -1.93, and the dashboard draws the journal as a cliff. Net of the journal, the same history gives +1.74%, -6.78% (2026-10-06 to 2026-10-15), -6.61% on 2026-10-15, 23.80% and 0.40.

### Root cause

Not known. The journal is Alpaca's, and nothing on this side explains it. Resolution is open: ask Alpaca support what the journal is and whether they will reverse it.

### Fix

- Health reads the daily history with every cash flow by type, and the activity log. A journal, deposit, withdrawal or transfer after the funding pages once, on the first run that sees it in either record; `health_state.json` keeps the flows already paged on, and the same flow showing up later in the other record is not news again. Fees, dividends and interest are the book's own results and never page.
- Health rebuilds cash from the activity log and compares it with broker cash, counting any flow the history shows and the log leaves out. A gap over $50, plus room for crypto sell fees the log has not posted yet, warns, and pages if the next run, after reading the whole log again, finds it too. The log is otherwise read in full once a week (14 pages on 2026-10-17) and from a few days back in between.
- Negative cash pages every run, and so does a cash read that fails twice in a row: a failed log read still leaves the history's flows to page on.
- `npm run perf` and the dashboard measure returns time-weighted, net of cash from outside the book, so a journal is neither a gain nor a loss. A flow is taken to land at mid-day, since the daily history shows the day but not the hour. The curve's values run straight through it, and the journal is marked as an event with the book's own result that day. The 2026-09-09 outlier is still excluded; outliers are now judged net of flows, so a journal reversed the next day can't pass for a bad print. A flow of 20% of equity or more that Alpaca books a point away from the equity's step counts where the equity moved, since a day off would put two false returns of about its size in the curve.
- A reversal (+$66,905.32) gets the same treatment: health pages once when it lands, and perf leaves it out of returns.
- Run read-only against the account on 2026-10-17, the new check reports two problems: the -$66,905.32 JNLC, with the gap to the activity log, and negative cash.

### Still open

- Alpaca's answer. Until cash is positive, health pages on it every 30 minutes and the book can't open crypto positions.
- The daily-loss kill switch, and the dashboard's daily P&L tile, measure equity against the day's start, so they can't tell a journal from a loss. The switch halted entries on 2026-10-14 on the journal alone. Neither nets flows out yet.
