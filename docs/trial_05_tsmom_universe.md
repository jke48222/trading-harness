# Trial 05 — TSMOM-28 Family on a Wider Universe (pre-registered)

Registered: 2026-07-15 ~17:05 UTC, before any run. Purpose: robustness extension of Trial 04's surviving family onto **fresh assets** (new data, not the burned OOS windows), and the only honest way to accelerate forward-sample accumulation: more symbols, same rules.

## Locked rules — identical to Trial 04, zero new knobs

28-day momentum sign-flip entries on daily closed candles, 28-candle horizon, 30 bps adoption basis. Two variants only, both already members of the surviving family: **A = long-only**, **B = both-sides**. Lookback/horizon/fee are not tunable.

## Symbols (objective liquidity picks, declared before running)

- Crypto (Binance daily): BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, LINKUSDT
- US equities (Alpaca paper daily, IEX): SPY, QQQ, AAPL, NVDA — daily TSMOM holds ~28 days, so PDT does not apply; data span is whatever IEX provides and is reported honestly per symbol.

Budget: 2 variants × 9 symbols × {IS, OOS} = **36 runs**, all disclosed, `REPLAY_WRITE_MEMORY=false`. This is the final extension of the TSMOM-28 family this session; failing cells do not spawn variants.

## Gates (identical to Trial 04) + drift check

Per symbol/variant, judged OOS at 30 bps: ≥30 completed setups (else "insufficient sample"); avg/setup > 0; PF > 1.1; IS/OOS sign agreement. Post-gate honesty check: OOS avg/setup must exceed the unconditional same-horizon drift benchmark (long variants) or be positive against adverse drift (both-sides) — anything at-or-below drift is repackaged beta and is set aside regardless of gates.

## Consequence (locked)

Passing cells join the forward paper scanner (`com.jalenedusei.trading.tsmom-daily`) with their exact passing configuration. Nothing from this trial goes near real money: forward gate remains ≥20–30 live-scored setups per candidate with a net-positive record.

---

## Results (run 2026-07-15; OOS at 30 bps, drift = unconditional 28d long return net of costs)

**Crypto:**

| Cell | n | PF | avg/setup | drift | Verdict |
|---|---|---|---|---|---|
| **BNB long-only** | 46 | 2.91 | +4.42% | +3.12% | **CANDIDATE** (+1.3% above drift) |
| **ADA long-only** | 44 | 1.42 | +5.59% | +0.01% | **CANDIDATE** — but 25% win rate: profit concentrated in few large wins, fragile; forward decides |
| **LINK long-only** | 40 | 1.17 | +1.40% | +0.17% | **CANDIDATE** |
| LINK both-sides | 80 | 1.16 | +1.27% | +0.17% | also passes (robustness signal); long-only config goes forward to keep ledger tags unambiguous — declared practical choice, made before forward data |
| XRP long-only | 39 | 1.84 | +6.35% | **+7.29%** | below drift — beta, set aside |
| XRP both-sides | 78 | 1.69 | +4.24% | +7.29% | below drift — set aside |
| DOGE both-sides | 53 | 1.24 | +1.56% | +2.43% | below drift — set aside |
| ADA both-sides | 88 | 1.099 | +1.39% | +0.01% | fails PF gate by 0.001 — rules applied as written |
| BNB both / DOGE long | 91 / 26 | 0.97 / — | −0.13% / — | — | fail / insufficient sample |

**Stocks (SPY, QQQ, AAPL, NVDA):** every long-only OOS cell positive but under the 30-setup gate (13–24 setups — ~6y of IEX daily data produces too few flips); both-sides cells mostly negative (shorting upward-drifting equities bleeds). **No stock cell passes; no stock enters the forward test.** More history or more symbols would be needed for a judgeable stock sample.

## Verdict

Three new candidates — **BNB, ADA, LINK long-only 28d TSMOM** — join ETH (long-only) and SOL (both-sides) in the forward paper phase. The XRP lesson repeats Trial 04's BTC lesson: gate-passing cells at-or-below drift are repackaged beta, and the drift check caught two more of them. Forward agent updated 2026-07-15 (~17:00 UTC); first entries: ETH @ 1891.87, LINK @ 8.35. A duplicate-signal bug found during reload (hourly scans re-trading the same daily signal candle) was fixed with per-signal-candle dedup and the one duplicate ETH row removed.
