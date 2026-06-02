# SOL 5m 5x Annual-Risk Long-Short Strategy

Target market: SOLUSDT perpetual futures, 5m candles.

Selected profile:
- 5x leverage
- 0.0004 fee rate
- 18% margin allocation through `POSITION: 0.18`
- Long-short trend/momentum filter with tighter one-year drawdown control
- Binance USD-M Futures Vision history used for final stable backtest

Final calibration window:
- 2025-05-18 21:10 UTC to 2026-06-01 23:55 UTC
- 109,186 futures 5m candles
- 30/60/90/180/365 day rolling-window evaluation

Selected result:
- 30d: 9.46% return, 73.91% win, 23 closed trades, 5.17% max DD, 2.00 PF
- 60d: 11.84% return, 76.47% win, 34 closed trades, 5.17% max DD, 1.93 PF
- 90d: 28.76% return, 75.00% win, 72 closed trades, 5.17% max DD, 2.22 PF
- 180d: 57.93% return, 75.00% win, 224 closed trades, 17.14% max DD, 1.47 PF
- 365d: 137.77% return, 75.38% win, 532 closed trades, 19.30% max DD, 1.34 PF

Latest hybrid-tail check:
- 2025-05-18 21:10 UTC to 2026-06-02 21:00 UTC
- 109,439 5m candles, Binance futures REST tail connected without spot fallback
- 365d: 146.42% return, 75.51% win, 535 closed trades, 19.30% max DD, 1.36 PF

Comparison against the aggressive one-year script shown in the app backtest:
- Aggressive version: about 198.69% one-year return, 57.86% win, 52.44% max DD.
- Selected version: lower raw return, but raises win rate to 75.38% and reduces max DD to 19.30%.
- A stricter low-DD search found about 44.79% one-year return, 80.09% win, and 13.79% max DD, so the selected profile is the higher-return side of the risk-balanced set.

Operational note:
This strategy is not a guarantee of future performance. It is selected as a better one-year balance for 5x leverage under the stated return/win-rate/drawdown tradeoff. For live use, pair it with daily loss limits, loss-streak pausing, and walk-forward re-optimization instead of increasing leverage to chase the older return curve.
