import type { Candle } from '../../../shared/types'

export function movingAverage(candles: Candle[], period: number): Array<{ time: number; value: number }> {
  return candles
    .map((candle, index) => {
      if (index + 1 < period) return null
      const slice = candles.slice(index + 1 - period, index + 1)
      const value = slice.reduce((sum, item) => sum + item.close, 0) / period
      return { time: Math.floor(candle.time / 1000), value }
    })
    .filter(Boolean) as Array<{ time: number; value: number }>
}

export function ema(values: number[], period: number): number[] {
  const multiplier = 2 / (period + 1)
  return values.reduce<number[]>((result, value, index) => {
    if (index === 0) return [value]
    return [...result, value * multiplier + result[index - 1] * (1 - multiplier)]
  }, [])
}

export function rsi(candles: Candle[], period = 14): number {
  if (candles.length <= period) return 50
  let gains = 0
  let losses = 0
  const slice = candles.slice(-period - 1)
  for (let index = 1; index < slice.length; index += 1) {
    const delta = slice[index].close - slice[index - 1].close
    if (delta >= 0) gains += delta
    else losses += Math.abs(delta)
  }
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

export function bollinger(candles: Candle[], period = 20, multiplier = 2): { upper: number; middle: number; lower: number } {
  const slice = candles.slice(-period)
  if (slice.length === 0) return { upper: 0, middle: 0, lower: 0 }
  const middle = slice.reduce((sum, item) => sum + item.close, 0) / slice.length
  const variance = slice.reduce((sum, item) => sum + Math.pow(item.close - middle, 2), 0) / slice.length
  const deviation = Math.sqrt(variance)
  return {
    upper: middle + multiplier * deviation,
    middle,
    lower: middle - multiplier * deviation,
  }
}

export function macd(candles: Candle[]): { dif: number; dea: number; hist: number } {
  const closes = candles.map((item) => item.close)
  if (closes.length < 26) return { dif: 0, dea: 0, hist: 0 }
  const fast = ema(closes, 12)
  const slow = ema(closes, 26)
  const difSeries = fast.map((value, index) => value - (slow[index] ?? value))
  const deaSeries = ema(difSeries, 9)
  const dif = difSeries[difSeries.length - 1] ?? 0
  const dea = deaSeries[deaSeries.length - 1] ?? 0
  return { dif, dea, hist: (dif - dea) * 2 }
}

export function crossoverSignals(candles: Candle[]): Array<{ time: number; position: 'aboveBar' | 'belowBar'; color: string; shape: 'arrowUp' | 'arrowDown'; text: string }> {
  const ma5 = movingAverage(candles, 5)
  const ma20 = movingAverage(candles, 20)
  const signals = []
  for (let index = 1; index < ma20.length; index += 1) {
    const fastPrev = ma5.find((item) => item.time === ma20[index - 1].time)?.value
    const fastNow = ma5.find((item) => item.time === ma20[index].time)?.value
    if (!fastPrev || !fastNow) continue
    const slowPrev = ma20[index - 1].value
    const slowNow = ma20[index].value
    if (fastPrev <= slowPrev && fastNow > slowNow) {
      signals.push({
        time: ma20[index].time,
        position: 'belowBar' as const,
        color: '#28d7a3',
        shape: 'arrowUp' as const,
        text: 'Buy',
      })
    }
    if (fastPrev >= slowPrev && fastNow < slowNow) {
      signals.push({
        time: ma20[index].time,
        position: 'aboveBar' as const,
        color: '#ff6868',
        shape: 'arrowDown' as const,
        text: 'Sell',
      })
    }
  }
  return signals.slice(-16)
}
