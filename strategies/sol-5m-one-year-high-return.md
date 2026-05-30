# SOL 5m Multi-Window Balanced Return

Local optimization window:
- 2025-11-20 00:00 UTC to 2026-05-29 00:00 UTC
- 54,721 candles
- Binance futures SOLUSDT 5m, with 15m higher-timeframe features
- Position ratio: 0.8, fee rate: 0.0004, leverage: 1x

Notes:
- 30d: 2.72% return, 60.00% win, 10 closed, 3.75% max DD
- 60d: 9.92% return, 70.00% win, 20 closed, 6.61% max DD
- 90d: 42.00% return, 76.32% win, 38 closed, 6.61% max DD
- 180d: 86.72% return, 67.52% win, 117 closed, 7.17% max DD

Same-window comparison against the previous script, using the same 0.8 effective position cap:
- 30d closed trades improved from 8 to 10.
- 180d return improved from 70.32% to 86.72%.
- 180d win rate improved from 64.63% to 67.52%.
- 180d max drawdown improved from 9.04% to 7.17%.
