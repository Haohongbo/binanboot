import type { Candle } from '../../../shared/types'

export function movingAverage(candles: Candle[], period: number): Array<{ time: number; value: number }> {
  const result: Array<{ time: number; value: number }> = []
  let sum = 0
  for (let index = 0; index < candles.length; index += 1) {
    sum += candles[index].close
    if (index >= period) sum -= candles[index - period].close
    if (index + 1 >= period) {
      result.push({ time: Math.floor(candles[index].time / 1000), value: sum / period })
    }
  }
  return result
}

export function ema(values: number[], period: number): number[] {
  const multiplier = 2 / (period + 1)
  const result: number[] = []
  for (let index = 0; index < values.length; index += 1) {
    result.push(index === 0 ? values[index] : values[index] * multiplier + result[index - 1] * (1 - multiplier))
  }
  return result
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

export function bollingerBands(
  candles: Candle[],
  period = 20,
  multiplier = 2,
): { upper: Array<{ time: number; value: number }>; middle: Array<{ time: number; value: number }>; lower: Array<{ time: number; value: number }> } {
  const upper: Array<{ time: number; value: number }> = []
  const middle: Array<{ time: number; value: number }> = []
  const lower: Array<{ time: number; value: number }> = []
  let sum = 0
  let sumSquares = 0
  for (let index = 0; index < candles.length; index += 1) {
    const close = candles[index].close
    sum += close
    sumSquares += close * close
    if (index >= period) {
      const stale = candles[index - period].close
      sum -= stale
      sumSquares -= stale * stale
    }
    if (index + 1 < period) continue
    const mid = sum / period
    const variance = Math.max(0, sumSquares / period - mid * mid)
    const deviation = Math.sqrt(variance)
    const time = Math.floor(candles[index].time / 1000)
    upper.push({ time, value: mid + multiplier * deviation })
    middle.push({ time, value: mid })
    lower.push({ time, value: mid - multiplier * deviation })
  }
  return { upper, middle, lower }
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
  const fastByTime = new Map(ma5.map((item) => [item.time, item.value]))
  const signals = []
  for (let index = 1; index < ma20.length; index += 1) {
    const fastPrev = fastByTime.get(ma20[index - 1].time)
    const fastNow = fastByTime.get(ma20[index].time)
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
