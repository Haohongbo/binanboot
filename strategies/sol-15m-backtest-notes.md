# SOL 15m Script Notes

Target market: SOLUSDT perpetual futures, 15m candles.

Calibration window used locally:
- 2025-05-11 to 2026-05-11
- 35,120 candles including 80 warmup candles
- Fee rate: 0.0004
- Initial capital: 100,000 USDT

Selected script result:
- Total return: 22.03%
- Win rate: 70.34%
- Profit factor: 1.21
- Trades: 654 order records, 327 closed trades
- Max drawdown: 15.40%

Important limitation:
The current backtest engine is long-only, uses one position at a time, and caps custom script sizing at 0.8. On this SOL one-year window, buy-and-hold was about -42.7%, and my local search did not find a non-lookahead script that honestly reached both 60%+ win rate and 60%+ total return under those constraints.

Closest high-return variant found:
- Total return: 59.40%
- Win rate: 50.67%
- Trades: 300 order records, 150 closed trades
- Max drawdown: 10.89%
