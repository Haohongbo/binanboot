import type { Candle } from './types'

export type ScriptRules = {
  buy: string
  sell: string
  long: string
  closeLong: string
  short: string
  closeShort: string
  position: string
}

export type SignalContext = {
  open: number
  high: number
  low: number
  close: number
  volume: number
  maFast: number
  maSlow: number
  ma20: number
  ma60: number
  ma120: number
  maFastSlope: number
  maSlowSlope: number
  momentum: number
  momentum3: number
  momentum5: number
  momentum12: number
  momentum20: number
  channelHigh: number
  channelLow: number
  channelMid: number
  channelWidth: number
  volatility: number
  volumeRatio: number
  rsi14: number
  macd: number
  macdSignal: number
  macdHist: number
  atr14: number
  atrPct: number
  trueRangePct: number
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidth: number
  bbPctB: number
  bodyPct: number
  upperShadowPct: number
  lowerShadowPct: number
  rangePct: number
  candleReturn: number
  closeLocation: number
  entryPrice: number
  position: number
  signedPosition: number
  positionSide: number
  barsHeld: number
  unrealizedPnlPct: number
  highestSinceEntry: number
  lowestSinceEntry: number
  drawdownSinceEntry: number
  factorScore: number
  htfMaFast: number
  htfMaSlow: number
  htfMa20: number
  htfMa60: number
  htfMomentum5: number
  htfMomentum20: number
  htfRsi14: number
  htfVolumeRatio: number
  htfBbPctB: number
  htfAtrPct: number
  htfTrendScore: number
}

export type SignalPositionState = {
  entryPrice?: number
  position?: number
  entryIndex?: number
  highestSinceEntry?: number
  lowestSinceEntry?: number
}

export function parseScriptRules(script: string | undefined, defaults: ScriptRules): ScriptRules {
  if (!script?.trim()) return defaults
  return script.split(/\r?\n/).reduce((rules, line) => {
    const match = line.match(/^\s*(BUY|SELL|LONG|CLOSE_LONG|CLOSELONG|SHORT|CLOSE_SHORT|CLOSESHORT|POSITION)\s*:\s*(.+?)\s*$/i)
    if (!match) return rules
    const rawKey = match[1].toUpperCase()
    if (rawKey === 'BUY') return { ...rules, buy: match[2], long: match[2] }
    if (rawKey === 'SELL') return { ...rules, sell: match[2], closeLong: match[2] }
    const key = rawKey === 'BUY'
      ? 'buy'
      : rawKey === 'SELL'
        ? 'sell'
        : rawKey === 'LONG'
          ? 'long'
          : rawKey === 'SHORT'
            ? 'short'
            : rawKey === 'CLOSE_LONG' || rawKey === 'CLOSELONG'
              ? 'closeLong'
              : rawKey === 'CLOSE_SHORT' || rawKey === 'CLOSESHORT'
                ? 'closeShort'
                : 'position'
    return { ...rules, [key]: match[2] }
  }, defaults)
}

export function evalScriptExpression(expression: string, context: SignalContext): number | boolean {
  const allowed = /^[\d\s()+\-*/%.<>=!&|?:_a-zA-Z]+$/
  if (!allowed.test(expression) || /(?:constructor|prototype|global|process|require|import|Function|eval|window|document|\[|\]|;|,|`|'|")/.test(expression)) {
    throw new Error(`自定义策略表达式包含不支持的字符或关键字：${expression}`)
  }
  const names = Object.keys(context)
  const literals = new Set(['true', 'false'])
  if (!expression.match(/^[\d\s()+\-*/%.<>=!&|?:]+$/)) {
    const tokens = expression.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
    const unknown = tokens.find((token) => !names.includes(token) && !literals.has(token))
    if (unknown) throw new Error(`自定义策略使用了未知变量：${unknown}`)
  }
  const values = names.map((name) => context[name as keyof SignalContext])
  return Function(...names, `"use strict"; return (${expression});`)(...values) as number | boolean
}

export function averageClose(candles: Candle[]): number {
  return candles.reduce((sum, candle) => sum + candle.close, 0) / Math.max(1, candles.length)
}

export function averageVolume(candles: Candle[]): number {
  return candles.reduce((sum, candle) => sum + candle.volume, 0) / Math.max(1, candles.length)
}

export function highestHigh(candles: Candle[]): number {
  return Math.max(...candles.map((candle) => candle.high))
}

export function lowestLow(candles: Candle[]): number {
  return Math.min(...candles.map((candle) => candle.low))
}

function momentumAt(candles: Candle[], index: number, period: number): number {
  const candle = candles[index]
  const base = candles[Math.max(0, index - period)]?.close ?? candle.close
  return base > 0 ? candle.close / base - 1 : 0
}

function rollingAverage(values: number[], period: number): number[] {
  const result: number[] = []
  let sum = 0
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]
    if (index >= period) sum -= values[index - period]
    result.push(sum / Math.min(index + 1, period))
  }
  return result
}

function emaSeries(values: number[], period: number): number[] {
  const multiplier = 2 / (period + 1)
  const result: number[] = []
  for (let index = 0; index < values.length; index += 1) {
    result.push(index === 0 ? values[index] : values[index] * multiplier + result[index - 1] * (1 - multiplier))
  }
  return result
}

function inferIntervalMs(candles: Candle[], fallback = 300_000): number {
  const diffs: number[] = []
  for (let index = 1; index < Math.min(candles.length, 40); index += 1) {
    const diff = candles[index].time - candles[index - 1].time
    if (diff > 0) diffs.push(diff)
  }
  if (diffs.length === 0) return fallback
  diffs.sort((left, right) => left - right)
  return diffs[Math.floor(diffs.length / 2)] || fallback
}

function resampleCandles(candles: Candle[], intervalMs: number): Candle[] {
  if (candles.length === 0) return []
  const buckets = new Map<number, Candle>()
  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / intervalMs) * intervalMs
    const existing = buckets.get(bucketTime)
    if (!existing) {
      buckets.set(bucketTime, { ...candle, time: bucketTime })
      continue
    }
    existing.high = Math.max(existing.high, candle.high)
    existing.low = Math.min(existing.low, candle.low)
    existing.close = candle.close
    existing.volume += candle.volume
  }
  return [...buckets.values()].sort((left, right) => left.time - right.time)
}

type SignalSeries = {
  maFast: number[]
  maSlow: number[]
  ma20: number[]
  ma60: number[]
  ma120: number[]
  channelHigh: number[]
  channelLow: number[]
  channelMid: number[]
  volatility: number[]
  volumeRatio: number[]
  rsi14: number[]
  macd: number[]
  macdSignal: number[]
  macdHist: number[]
  atr14: number[]
  trueRange: number[]
  bbUpper: number[]
  bbMiddle: number[]
  bbLower: number[]
}

type HigherTimeframeSeries = {
  maFast: number[]
  maSlow: number[]
  ma20: number[]
  ma60: number[]
  momentum5: number[]
  momentum20: number[]
  rsi14: number[]
  volumeRatio: number[]
  bbPctB: number[]
  atrPct: number[]
  trendScore: number[]
}

const signalSeriesCache = new WeakMap<Candle[], SignalSeries>()
const higherTimeframeSeriesCache = new WeakMap<Candle[], HigherTimeframeSeries>()

function getSignalSeries(candles: Candle[]): SignalSeries {
  const cached = signalSeriesCache.get(candles)
  if (cached) return cached

  const closes = candles.map((candle) => candle.close)
  const volumes = candles.map((candle) => candle.volume)
  const maFast = rollingAverage(closes, 7)
  const maSlow = rollingAverage(closes, 22)
  const ma20 = rollingAverage(closes, 20)
  const ma60 = rollingAverage(closes, 60)
  const ma120 = rollingAverage(closes, 120)
  const trueRange: number[] = []
  const channelHigh: number[] = []
  const channelLow: number[] = []
  const channelMid: number[] = []
  const volatility: number[] = []
  const rsi14: number[] = []
  const atr14: number[] = []
  const bbUpper: number[] = []
  const bbMiddle: number[] = []
  const bbLower: number[] = []

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const previousClose = candles[index - 1]?.close ?? candle.close
    trueRange.push(Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose)))

    const channelWindow = candles.slice(Math.max(0, index - 20), index)
    channelHigh.push(channelWindow.length > 0 ? highestHigh(channelWindow) : candle.high)
    channelLow.push(channelWindow.length > 0 ? lowestLow(channelWindow) : candle.low)
    channelMid.push(channelWindow.length > 0 ? averageClose(channelWindow) : candle.close)

    const factorFrom = Math.max(0, index - 30)
    const returns: number[] = []
    for (let itemIndex = Math.max(1, factorFrom); itemIndex <= index; itemIndex += 1) {
      const base = candles[itemIndex - 1].close
      returns.push(base > 0 ? candles[itemIndex].close / base - 1 : 0)
    }
    const avgReturn = returns.reduce((sum, item) => sum + item, 0) / Math.max(1, returns.length)
    const variance = returns.reduce((sum, item) => sum + Math.pow(item - avgReturn, 2), 0) / Math.max(1, returns.length)
    volatility.push(Math.sqrt(variance))

    let gains = 0
    let losses = 0
    for (let itemIndex = Math.max(1, index - 13); itemIndex <= index; itemIndex += 1) {
      const delta = candles[itemIndex].close - candles[itemIndex - 1].close
      if (delta >= 0) gains += delta
      else losses += Math.abs(delta)
    }
    rsi14.push(index < 14 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses))

    const atrFrom = Math.max(0, index - 13)
    const atrSum = trueRange.slice(atrFrom, index + 1).reduce((sum, item) => sum + item, 0)
    atr14.push(atrSum / Math.max(1, index - atrFrom + 1))

    const bbFrom = Math.max(0, index - 19)
    const bbCloses = closes.slice(bbFrom, index + 1)
    const middle = bbCloses.reduce((sum, item) => sum + item, 0) / Math.max(1, bbCloses.length)
    const bbVariance = bbCloses.reduce((sum, item) => sum + Math.pow(item - middle, 2), 0) / Math.max(1, bbCloses.length)
    const deviation = Math.sqrt(bbVariance)
    bbMiddle.push(middle)
    bbUpper.push(middle + 2 * deviation)
    bbLower.push(middle - 2 * deviation)
  }

  const volumeBase = rollingAverage(volumes, 31)
  const volumeRatio = volumes.map((volume, index) => (volumeBase[index] > 0 ? volume / volumeBase[index] : 1))
  const emaFast = emaSeries(closes, 12)
  const emaSlow = emaSeries(closes, 26)
  const macd = emaFast.map((value, index) => (index < 25 ? 0 : value - emaSlow[index]))
  const macdSignalRaw = emaSeries(macd, 9)
  const macdSignal = macdSignalRaw.map((value, index) => (index < 25 ? 0 : value))
  const macdHist = macd.map((value, index) => value - macdSignal[index])

  const series: SignalSeries = {
    maFast,
    maSlow,
    ma20,
    ma60,
    ma120,
    channelHigh,
    channelLow,
    channelMid,
    volatility,
    volumeRatio,
    rsi14,
    macd,
    macdSignal,
    macdHist,
    atr14,
    trueRange,
    bbUpper,
    bbMiddle,
    bbLower,
  }
  signalSeriesCache.set(candles, series)
  return series
}

function getHigherTimeframeSeries(candles: Candle[]): HigherTimeframeSeries {
  const cached = higherTimeframeSeriesCache.get(candles)
  if (cached) return cached

  const baseIntervalMs = inferIntervalMs(candles)
  const resampledCandles = resampleCandles(candles, 15 * 60_000)
  if (resampledCandles.length === 0) {
    const empty: HigherTimeframeSeries = {
      maFast: [],
      maSlow: [],
      ma20: [],
      ma60: [],
      momentum5: [],
      momentum20: [],
      rsi14: [],
      volumeRatio: [],
      bbPctB: [],
      atrPct: [],
      trendScore: [],
    }
    higherTimeframeSeriesCache.set(candles, empty)
    return empty
  }

  const closes = resampledCandles.map((candle) => candle.close)
  const volumes = resampledCandles.map((candle) => candle.volume)
  const maFast = rollingAverage(closes, 5)
  const maSlow = rollingAverage(closes, 14)
  const ma20 = rollingAverage(closes, 20)
  const ma60 = rollingAverage(closes, 60)
  const trueRange: number[] = []
  const rsi14: number[] = []
  const atr14: number[] = []
  const bbUpper: number[] = []
  const bbMiddle: number[] = []
  const bbLower: number[] = []

  for (let index = 0; index < resampledCandles.length; index += 1) {
    const candle = resampledCandles[index]
    const previousClose = resampledCandles[index - 1]?.close ?? candle.close
    trueRange.push(Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose)))

    let gains = 0
    let losses = 0
    for (let itemIndex = Math.max(1, index - 13); itemIndex <= index; itemIndex += 1) {
      const delta = resampledCandles[itemIndex].close - resampledCandles[itemIndex - 1].close
      if (delta >= 0) gains += delta
      else losses += Math.abs(delta)
    }
    rsi14.push(index < 14 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses))

    const atrFrom = Math.max(0, index - 13)
    const atrSum = trueRange.slice(atrFrom, index + 1).reduce((sum, item) => sum + item, 0)
    atr14.push(atrSum / Math.max(1, index - atrFrom + 1))

    const bbFrom = Math.max(0, index - 19)
    const bbCloses = closes.slice(bbFrom, index + 1)
    const middle = bbCloses.reduce((sum, item) => sum + item, 0) / Math.max(1, bbCloses.length)
    const bbVariance = bbCloses.reduce((sum, item) => sum + Math.pow(item - middle, 2), 0) / Math.max(1, bbCloses.length)
    const deviation = Math.sqrt(bbVariance)
    bbMiddle.push(middle)
    bbUpper.push(middle + 2 * deviation)
    bbLower.push(middle - 2 * deviation)
  }

  const volumeBase = rollingAverage(volumes, 31)
  const volumeRatio = volumes.map((volume, index) => (volumeBase[index] > 0 ? volume / volumeBase[index] : 1))
  const momentum5 = closes.map((_, index) => momentumAt(resampledCandles, index, 5))
  const momentum20 = closes.map((_, index) => momentumAt(resampledCandles, index, 20))

  const htfTrendScore = closes.map((close, index) => {
    const bandRange = bbUpper[index] - bbLower[index]
    return (
      (maFast[index] > maSlow[index] ? 1 : -1) +
      (momentum5[index] > 0.018 ? 0.7 : momentum5[index] < -0.018 ? -0.7 : 0) +
      (momentum20[index] > 0.01 ? 0.45 : momentum20[index] < -0.01 ? -0.45 : 0) +
      (rsi14[index] > 58 ? 0.35 : rsi14[index] < 42 ? -0.35 : 0) +
      (volumeRatio[index] > 1.05 ? 0.2 : 0) +
      (bandRange > 0 ? ((close - bbMiddle[index]) / bandRange > 0.55 ? 0.1 : -0.1) : 0)
    )
  })

  const availableIndex: number[] = []
  let htfIndex = -1
  for (let index = 0; index < candles.length; index += 1) {
    const availableCloseTime = candles[index].time + baseIntervalMs
    while (htfIndex + 1 < resampledCandles.length && resampledCandles[htfIndex + 1].time + 15 * 60_000 <= availableCloseTime) {
      htfIndex += 1
    }
    availableIndex.push(htfIndex)
  }

  const series: HigherTimeframeSeries = {
    maFast: availableIndex.map((index) => (index >= 0 ? maFast[index] : 0)),
    maSlow: availableIndex.map((index) => (index >= 0 ? maSlow[index] : 0)),
    ma20: availableIndex.map((index) => (index >= 0 ? ma20[index] : 0)),
    ma60: availableIndex.map((index) => (index >= 0 ? ma60[index] : 0)),
    momentum5: availableIndex.map((index) => (index >= 0 ? momentum5[index] : 0)),
    momentum20: availableIndex.map((index) => (index >= 0 ? momentum20[index] : 0)),
    rsi14: availableIndex.map((index) => (index >= 0 ? rsi14[index] : 50)),
    volumeRatio: availableIndex.map((index) => (index >= 0 ? volumeRatio[index] : 1)),
    bbPctB: availableIndex.map((index) => {
      if (index < 0) return 0.5
      const bandRange = bbUpper[index] - bbLower[index]
      return bandRange > 0 ? (closes[index] - bbLower[index]) / bandRange : 0.5
    }),
    atrPct: availableIndex.map((index) => (index >= 0 ? (closes[index] > 0 ? atr14[index] / closes[index] : 0) : 0)),
    trendScore: availableIndex.map((index) => (index >= 0 ? htfTrendScore[index] : 0)),
  }
  higherTimeframeSeriesCache.set(candles, series)
  return series
}

export function buildSignalContext(candles: Candle[], index: number, state: SignalPositionState = {}): SignalContext {
  const candle = candles[index]
  const series = getSignalSeries(candles)
  const htfSeries = getHigherTimeframeSeries(candles)
  const previousClose = candles[index - 1]?.close ?? candle.open
  const maFast = series.maFast[index]
  const maSlow = series.maSlow[index]
  const ma20 = series.ma20[index]
  const ma60 = series.ma60[index]
  const ma120 = series.ma120[index]
  const previousMaFast = index > 0 ? series.maFast[index - 1] : maFast
  const previousMaSlow = index > 0 ? series.maSlow[index - 1] : maSlow
  const channelHigh = series.channelHigh[index]
  const channelLow = series.channelLow[index]
  const channelMid = series.channelMid[index]
  const currentRange = Math.max(candle.high - candle.low, 0)
  const currentBody = Math.abs(candle.close - candle.open)
  const upperShadow = candle.high - Math.max(candle.open, candle.close)
  const lowerShadow = Math.min(candle.open, candle.close) - candle.low
  const atr14 = series.atr14[index]
  const trueRange = series.trueRange[index]
  const bbUpper = series.bbUpper[index]
  const bbMiddle = series.bbMiddle[index]
  const bbLower = series.bbLower[index]
  const bandRange = bbUpper - bbLower
  const entryPrice = state.entryPrice ?? 0
  const signedPosition = state.position ?? 0
  const position = Math.abs(signedPosition)
  const positionSide = signedPosition > 0 ? 1 : signedPosition < 0 ? -1 : 0
  const isInPosition = position > 0
  const hasEntryPrice = entryPrice > 0
  const entryIndex = state.entryIndex
  const barsHeld = isInPosition && entryIndex !== undefined ? Math.max(0, index - entryIndex) : 0
  const highestSinceEntry =
    isInPosition && state.highestSinceEntry
      ? Math.max(state.highestSinceEntry, candle.high)
      : isInPosition && entryIndex !== undefined
        ? highestHigh(candles.slice(Math.max(0, entryIndex), index + 1))
        : isInPosition && hasEntryPrice
          ? Math.max(entryPrice, candle.high)
          : 0
  const lowestSinceEntry =
    isInPosition && state.lowestSinceEntry
      ? Math.min(state.lowestSinceEntry, candle.low)
      : isInPosition && entryIndex !== undefined
        ? lowestLow(candles.slice(Math.max(0, entryIndex), index + 1))
        : isInPosition && hasEntryPrice
          ? Math.min(entryPrice, candle.low)
          : 0
  const unrealizedPnlPct = isInPosition && hasEntryPrice ? positionSide * (candle.close / entryPrice - 1) : 0
  const drawdownSinceEntry =
    isInPosition && positionSide >= 0 && highestSinceEntry > 0
      ? Math.max(0, (highestSinceEntry - candle.close) / highestSinceEntry)
      : isInPosition && positionSide < 0 && lowestSinceEntry > 0
        ? Math.max(0, (candle.close - lowestSinceEntry) / lowestSinceEntry)
        : 0
  const volatility = series.volatility[index]
  const volumeRatio = series.volumeRatio[index]
  const momentum = momentumAt(candles, index, 10)
  const momentum20 = momentumAt(candles, index, 20)
  const macd = series.macd[index]
  const macdSignal = series.macdSignal[index]
  const macdHist = series.macdHist[index]
  const factorScore =
    (maFast > maSlow ? 1 : -0.5) +
    (momentum > 0.01 ? 0.75 : momentum < -0.01 ? -0.75 : 0) +
    (volatility > 0 && volatility < 0.05 ? 0.35 : -0.2) +
    (volumeRatio > 1.08 ? 0.25 : 0) +
    (candle.close > ma60 ? 0.25 : -0.25)

  return {
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    maFast,
    maSlow,
    ma20,
    ma60,
    ma120,
    maFastSlope: previousMaFast > 0 ? maFast / previousMaFast - 1 : 0,
    maSlowSlope: previousMaSlow > 0 ? maSlow / previousMaSlow - 1 : 0,
    momentum,
    momentum3: momentumAt(candles, index, 3),
    momentum5: momentumAt(candles, index, 5),
    momentum12: momentumAt(candles, index, 12),
    momentum20,
    channelHigh,
    channelLow,
    channelMid,
    channelWidth: channelMid > 0 ? Math.max(0.012, (channelHigh - channelLow) / channelMid) : 0.012,
    volatility,
    volumeRatio,
    rsi14: series.rsi14[index],
    macd,
    macdSignal,
    macdHist,
    atr14,
    atrPct: candle.close > 0 ? atr14 / candle.close : 0,
    trueRangePct: candle.close > 0 ? trueRange / candle.close : 0,
    bbUpper,
    bbMiddle,
    bbLower,
    bbWidth: bbMiddle > 0 ? bandRange / bbMiddle : 0,
    bbPctB: bandRange > 0 ? (candle.close - bbLower) / bandRange : 0.5,
    bodyPct: candle.close > 0 ? currentBody / candle.close : 0,
    upperShadowPct: candle.close > 0 ? upperShadow / candle.close : 0,
    lowerShadowPct: candle.close > 0 ? lowerShadow / candle.close : 0,
    rangePct: candle.close > 0 ? currentRange / candle.close : 0,
    candleReturn: previousClose > 0 ? candle.close / previousClose - 1 : 0,
    closeLocation: currentRange > 0 ? (candle.close - candle.low) / currentRange : 0.5,
    entryPrice,
    position,
    signedPosition,
    positionSide,
    barsHeld,
    unrealizedPnlPct,
    highestSinceEntry,
    lowestSinceEntry,
    drawdownSinceEntry,
    factorScore,
    htfMaFast: htfSeries.maFast[index] ?? 0,
    htfMaSlow: htfSeries.maSlow[index] ?? 0,
    htfMa20: htfSeries.ma20[index] ?? 0,
    htfMa60: htfSeries.ma60[index] ?? 0,
    htfMomentum5: htfSeries.momentum5[index] ?? 0,
    htfMomentum20: htfSeries.momentum20[index] ?? 0,
    htfRsi14: htfSeries.rsi14[index] ?? 50,
    htfVolumeRatio: htfSeries.volumeRatio[index] ?? 1,
    htfBbPctB: htfSeries.bbPctB[index] ?? 0.5,
    htfAtrPct: htfSeries.atrPct[index] ?? 0,
    htfTrendScore: htfSeries.trendScore[index] ?? 0,
  }
}
