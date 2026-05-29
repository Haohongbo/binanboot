const SYMBOL = 'SOLUSDT'
const INTERVAL = '5m'
const INTERVAL_MS = 300_000
const LEVERAGE = 1
const FEE_RATE = 0.0004
const INITIAL_CAPITAL = 10_000
const WINDOWS = [30, 60, 90, 180]

const endTime = Date.UTC(2026, 4, 21, 0, 0, 0)
const startTime = endTime - 190 * 86_400_000

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function rollingAverage(values, period) {
  const result = []
  let sum = 0
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index]
    if (index >= period) sum -= values[index - period]
    result.push(sum / Math.min(index + 1, period))
  }
  return result
}

function emaSeries(values, period) {
  const multiplier = 2 / (period + 1)
  const result = []
  for (let index = 0; index < values.length; index += 1) {
    result.push(index === 0 ? values[index] : values[index] * multiplier + result[index - 1] * (1 - multiplier))
  }
  return result
}

function momentumAt(candles, index, period) {
  const base = candles[Math.max(0, index - period)]?.close ?? candles[index].close
  return base > 0 ? candles[index].close / base - 1 : 0
}

async function fetchKlines() {
  const candles = []
  let cursor = startTime
  while (cursor <= endTime) {
    const query = new URLSearchParams({
      symbol: SYMBOL,
      interval: INTERVAL,
      startTime: String(cursor),
      endTime: String(endTime),
      limit: '1500',
    })
    const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?${query}`)
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const rows = await response.json()
    if (rows.length === 0) break
    const batch = rows.map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    candles.push(...batch)
    const lastTime = batch.at(-1)?.time
    if (!lastTime) break
    cursor = lastTime + INTERVAL_MS
    if (batch.length < 1500) break
    await delay(25)
  }
  const unique = new Map()
  candles
    .filter((candle) => candle.time >= startTime && candle.time <= endTime)
    .forEach((candle) => unique.set(candle.time, candle))
  return [...unique.values()].sort((left, right) => left.time - right.time)
}

function buildSeries(candles) {
  const closes = candles.map((candle) => candle.close)
  const volumes = candles.map((candle) => candle.volume)
  const series = {
    closes,
    maFast: rollingAverage(closes, 7),
    maSlow: rollingAverage(closes, 22),
    ma20: rollingAverage(closes, 20),
    ma60: rollingAverage(closes, 60),
    ma120: rollingAverage(closes, 120),
    volatility: [],
    volumeRatio: [],
    rsi14: [],
    macd: [],
    macdSignal: [],
    atr14: [],
    trueRange: [],
    bbPctB: [],
    closeLocation: [],
    bodyPct: [],
    factorScore: [],
    momentum3: [],
    momentum5: [],
    momentum10: [],
    momentum20: [],
  }

  const bbUpper = []
  const bbLower = []
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const previousClose = candles[index - 1]?.close ?? candle.close
    const trueRange = Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
    series.trueRange.push(trueRange)

    const returns = []
    for (let itemIndex = Math.max(1, index - 30); itemIndex <= index; itemIndex += 1) {
      const base = candles[itemIndex - 1].close
      returns.push(base > 0 ? candles[itemIndex].close / base - 1 : 0)
    }
    const avgReturn = average(returns)
    series.volatility.push(Math.sqrt(average(returns.map((item) => (item - avgReturn) ** 2))))

    let gains = 0
    let losses = 0
    for (let itemIndex = Math.max(1, index - 13); itemIndex <= index; itemIndex += 1) {
      const delta = candles[itemIndex].close - candles[itemIndex - 1].close
      if (delta >= 0) gains += delta
      else losses += Math.abs(delta)
    }
    series.rsi14.push(index < 14 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses))

    const atrFrom = Math.max(0, index - 13)
    series.atr14.push(average(series.trueRange.slice(atrFrom, index + 1)))

    const bbFrom = Math.max(0, index - 19)
    const bbCloses = closes.slice(bbFrom, index + 1)
    const middle = average(bbCloses)
    const deviation = Math.sqrt(average(bbCloses.map((item) => (item - middle) ** 2)))
    bbUpper.push(middle + 2 * deviation)
    bbLower.push(middle - 2 * deviation)
    const bandRange = bbUpper[index] - bbLower[index]
    series.bbPctB.push(bandRange > 0 ? (candle.close - bbLower[index]) / bandRange : 0.5)

    const range = Math.max(candle.high - candle.low, 0)
    series.closeLocation.push(range > 0 ? (candle.close - candle.low) / range : 0.5)
    series.bodyPct.push(candle.close > 0 ? Math.abs(candle.close - candle.open) / candle.close : 0)

    series.momentum3.push(momentumAt(candles, index, 3))
    series.momentum5.push(momentumAt(candles, index, 5))
    series.momentum10.push(momentumAt(candles, index, 10))
    series.momentum20.push(momentumAt(candles, index, 20))
  }

  const volumeBase = rollingAverage(volumes, 31)
  series.volumeRatio = volumes.map((volume, index) => (volumeBase[index] > 0 ? volume / volumeBase[index] : 1))
  const emaFast = emaSeries(closes, 12)
  const emaSlow = emaSeries(closes, 26)
  series.macd = emaFast.map((value, index) => (index < 25 ? 0 : value - emaSlow[index]))
  const macdSignalRaw = emaSeries(series.macd, 9)
  series.macdSignal = macdSignalRaw.map((value, index) => (index < 25 ? 0 : value))

  for (let index = 0; index < candles.length; index += 1) {
    const momentum = series.momentum10[index]
    const volatility = series.volatility[index]
    const volumeRatio = series.volumeRatio[index]
    series.factorScore.push(
      (series.maFast[index] > series.maSlow[index] ? 1 : -0.5) +
      (momentum > 0.01 ? 0.75 : momentum < -0.01 ? -0.75 : 0) +
      (volatility > 0 && volatility < 0.05 ? 0.35 : -0.2) +
      (volumeRatio > 1.08 ? 0.25 : 0) +
      (candles[index].close > series.ma60[index] ? 0.25 : -0.25),
    )
  }

  return series
}

function buildHtfSeries(candles) {
  const htfMs = 15 * 60_000
  const buckets = new Map()
  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / htfMs) * htfMs
    const existing = buckets.get(bucketTime)
    if (!existing) {
      buckets.set(bucketTime, { ...candle, time: bucketTime })
    } else {
      existing.high = Math.max(existing.high, candle.high)
      existing.low = Math.min(existing.low, candle.low)
      existing.close = candle.close
      existing.volume += candle.volume
    }
  }
  const bars = [...buckets.values()].sort((left, right) => left.time - right.time)
  const closes = bars.map((bar) => bar.close)
  const volumes = bars.map((bar) => bar.volume)
  const maFast = rollingAverage(closes, 5)
  const maSlow = rollingAverage(closes, 14)
  const ma60 = rollingAverage(closes, 60)
  const rsi14 = []
  for (let index = 0; index < bars.length; index += 1) {
    let gains = 0
    let losses = 0
    for (let itemIndex = Math.max(1, index - 13); itemIndex <= index; itemIndex += 1) {
      const delta = bars[itemIndex].close - bars[itemIndex - 1].close
      if (delta >= 0) gains += delta
      else losses += Math.abs(delta)
    }
    rsi14.push(index < 14 ? 50 : losses === 0 ? 100 : 100 - 100 / (1 + gains / losses))
  }
  const volumeBase = rollingAverage(volumes, 31)
  const volumeRatio = volumes.map((volume, index) => (volumeBase[index] > 0 ? volume / volumeBase[index] : 1))
  const momentum5 = bars.map((_, index) => momentumAt(bars, index, 5))
  const momentum20 = bars.map((_, index) => momentumAt(bars, index, 20))
  const trendScore = bars.map((bar, index) => (
    (maFast[index] > maSlow[index] ? 1 : -1) +
    (momentum5[index] > 0.018 ? 0.7 : momentum5[index] < -0.018 ? -0.7 : 0) +
    (momentum20[index] > 0.01 ? 0.45 : momentum20[index] < -0.01 ? -0.45 : 0) +
    (rsi14[index] > 58 ? 0.35 : rsi14[index] < 42 ? -0.35 : 0) +
    (volumeRatio[index] > 1.05 ? 0.2 : 0) +
    (bar.close > ma60[index] ? 0.15 : -0.15)
  ))

  const availableIndex = []
  let htfIndex = -1
  for (let index = 0; index < candles.length; index += 1) {
    const availableCloseTime = candles[index].time + INTERVAL_MS
    while (htfIndex + 1 < bars.length && bars[htfIndex + 1].time + htfMs <= availableCloseTime) htfIndex += 1
    availableIndex.push(htfIndex)
  }

  return {
    trendScore: availableIndex.map((index) => (index >= 0 ? trendScore[index] : 0)),
    maFast: availableIndex.map((index) => (index >= 0 ? maFast[index] : 0)),
    maSlow: availableIndex.map((index) => (index >= 0 ? maSlow[index] : 0)),
    momentum20: availableIndex.map((index) => (index >= 0 ? momentum20[index] : 0)),
    rsi14: availableIndex.map((index) => (index >= 0 ? rsi14[index] : 50)),
  }
}

function closeLong(index, trade, candidate, s, h) {
  const pnl = s.closes[index] / trade.entryPrice - 1
  const drawdown = trade.highest > 0 ? Math.max(0, (trade.highest - s.closes[index]) / trade.highest) : 0
  return (
    pnl > candidate.longTp ||
    pnl < -candidate.longSl ||
    drawdown > candidate.longDd ||
    index - trade.entryIndex > candidate.longBars ||
    h.trendScore[index] < candidate.longHtfExit ||
    ((s.closes[index] < s.ma20[index] || s.maFast[index] < s.maSlow[index] || s.macd[index] < s.macdSignal[index]) && pnl > candidate.longTrail)
  )
}

function closeShort(index, trade, candidate, s, h) {
  const pnl = trade.entryPrice / s.closes[index] - 1
  const drawdown = trade.lowest > 0 ? Math.max(0, (s.closes[index] - trade.lowest) / trade.lowest) : 0
  return (
    pnl > candidate.shortTp ||
    pnl < -candidate.shortSl ||
    drawdown > candidate.shortDd ||
    index - trade.entryIndex > candidate.shortBars ||
    h.trendScore[index] > candidate.shortHtfExit ||
    ((s.closes[index] > s.ma20[index] || s.maFast[index] > s.maSlow[index] || s.macd[index] > s.macdSignal[index]) && pnl > candidate.shortTrail)
  )
}

function shouldLong(index, candidate, s, h) {
  if (candidate.direction === 'short-only') return false
  const close = s.closes[index]
  return (
    close > s.ma120[index] * candidate.longMa120 &&
    s.ma20[index] > s.ma60[index] * candidate.longTrend &&
    h.trendScore[index] > candidate.longHtf &&
    h.momentum20[index] > candidate.longHtfMomentum20 &&
    s.momentum5[index] > candidate.longMom5 &&
    s.momentum20[index] > candidate.longMom20 &&
    s.rsi14[index] > candidate.longRsiLo &&
    s.rsi14[index] < candidate.longRsiHi &&
    s.volumeRatio[index] > candidate.longVolume &&
    s.bbPctB[index] > candidate.longBbLo &&
    s.bbPctB[index] < candidate.longBbHi &&
    s.closeLocation[index] > candidate.longLocation &&
    s.factorScore[index] > candidate.longFactor &&
    s.atr14[index] / close < candidate.longAtr
  )
}

function shouldShort(index, candidate, s, h) {
  if (candidate.direction === 'long-only') return false
  const close = s.closes[index]
  return (
    close < s.ma120[index] * candidate.shortMa120 &&
    s.ma20[index] < s.ma60[index] * candidate.shortTrend &&
    h.trendScore[index] < candidate.shortHtf &&
    h.momentum20[index] < candidate.shortHtfMomentum20 &&
    s.momentum5[index] < candidate.shortMom5 &&
    s.momentum20[index] < candidate.shortMom20 &&
    s.rsi14[index] > candidate.shortRsiLo &&
    s.rsi14[index] < candidate.shortRsiHi &&
    s.volumeRatio[index] > candidate.shortVolume &&
    s.bbPctB[index] > candidate.shortBbLo &&
    s.bbPctB[index] < candidate.shortBbHi &&
    s.closeLocation[index] < candidate.shortLocation &&
    s.factorScore[index] < candidate.shortFactor &&
    s.atr14[index] / close < candidate.shortAtr
  )
}

function backtestWindow(candles, s, h, candidate, from, to) {
  let startIndex = candles.findIndex((candle) => candle.time >= from)
  if (startIndex < 0) startIndex = 0
  let endIndex = -1
  for (let index = startIndex; index < candles.length; index += 1) {
    if (candles[index].time <= to) endIndex = index
    else break
  }

  let cash = INITIAL_CAPITAL
  let position = 0
  let peak = INITIAL_CAPITAL
  let maxDrawdown = 0
  let wins = 0
  let closed = 0
  let grossProfit = 0
  let grossLoss = 0
  let trade = null

  for (let index = Math.max(160, startIndex); index <= endIndex; index += 1) {
    const candle = candles[index]
    if (trade) {
      trade.highest = Math.max(trade.highest, candle.high)
      trade.lowest = Math.min(trade.lowest, candle.low)
    }

    if (position === 0) {
      const long = shouldLong(index, candidate, s, h)
      const short = shouldShort(index, candidate, s, h)
      if (long || short) {
        const side = short && !long ? -1 : 1
        const quantity = (cash * candidate.position * LEVERAGE) / candle.close
        cash -= quantity * candle.close * FEE_RATE
        position = side * quantity
        trade = {
          entryPrice: candle.close,
          entryIndex: index,
          highest: candle.high,
          lowest: candle.low,
        }
      }
    } else {
      const shouldExit = position > 0
        ? closeLong(index, trade, candidate, s, h)
        : closeShort(index, trade, candidate, s, h)
      if (shouldExit) {
        const quantity = Math.abs(position)
        const fee = quantity * candle.close * FEE_RATE
        const pnl = position * (candle.close - trade.entryPrice) - fee
        cash += pnl
        if (pnl > 0) {
          wins += 1
          grossProfit += pnl
        } else {
          grossLoss += Math.abs(pnl)
        }
        closed += 1
        position = 0
        trade = null
      }
    }

    const equity = cash + (position !== 0 ? position * (candle.close - trade.entryPrice) : 0)
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }

  if (position !== 0 && trade && endIndex >= 0) {
    const candle = candles[endIndex]
    const quantity = Math.abs(position)
    const fee = quantity * candle.close * FEE_RATE
    const pnl = position * (candle.close - trade.entryPrice) - fee
    cash += pnl
    if (pnl > 0) {
      wins += 1
      grossProfit += pnl
    } else {
      grossLoss += Math.abs(pnl)
    }
    closed += 1
  }

  return {
    ret: (cash - INITIAL_CAPITAL) / INITIAL_CAPITAL,
    win: closed > 0 ? wins / closed : 0,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0,
    mdd: maxDrawdown,
    closed,
  }
}

function evaluate(candles, s, h, candidate) {
  const metrics = WINDOWS.map((days) => ({
    days,
    ...backtestWindow(candles, s, h, candidate, endTime - days * 86_400_000, endTime),
  }))
  const minReturn = Math.min(...metrics.map((item) => item.ret))
  const minWin = Math.min(...metrics.map((item) => item.win))
  const minTrades = Math.min(...metrics.map((item) => item.closed))
  const maxDrawdown = Math.max(...metrics.map((item) => item.mdd))
  const weightedReturn =
    metrics[0].ret * 0.8 +
    metrics[1].ret * 1.5 +
    metrics[2].ret * 2.2 +
    metrics[3].ret * 3.2
  const avgReturn = average(metrics.map((item) => item.ret))
  const avgWin = average(metrics.map((item) => item.win))
  const avgTrades = average(metrics.map((item) => item.closed))
  const score =
    weightedReturn * 6 +
    avgReturn * 1.5 +
    minReturn * 1.5 +
    minWin * 1.6 +
    avgWin * 1.1 +
    Math.log1p(Math.max(0, minTrades)) * 0.26 +
    Math.log1p(avgTrades) * 0.12 -
    maxDrawdown * 4.5 -
    (maxDrawdown > 0.12 ? (maxDrawdown - 0.12) * 8 : 0) -
    (minTrades < 12 ? (12 - minTrades) * 0.8 : 0) -
    (minWin < 0.7 ? (0.7 - minWin) * 14 : 0) -
    (avgWin < 0.7 ? (0.7 - avgWin) * 8 : 0) -
    (minReturn < 0.03 ? (0.03 - minReturn) * 12 : 0)
  return { score, metrics, minReturn, minWin, minTrades, maxDrawdown }
}

let seed = 20260521
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

function pick(values) {
  return values[Math.floor(random() * values.length)]
}

function candidateFrom(base, ranges, mutationRate = 0.55) {
  const candidate = { ...base }
  for (const [key, values] of Object.entries(ranges)) {
    if (random() < mutationRate) candidate[key] = pick(values)
  }
  return candidate
}

const baseCandidate = {
  direction: 'long-short',
  longMa120: 0.985,
  longTrend: 1,
  longHtf: -99,
  longHtfMomentum20: -99,
  longMom5: 0.008,
  longMom20: 0.01,
  longRsiLo: 5,
  longRsiHi: 62,
  longVolume: 0.1,
  longBbLo: -1,
  longBbHi: 1.2,
  longLocation: 0.15,
  longFactor: 0,
  longAtr: 0.02,
  longTp: 0.004,
  longSl: 0.05,
  longDd: 0.035,
  longBars: 768,
  longTrail: 0.02,
  longHtfExit: -99,
  shortMa120: 0.9,
  shortTrend: 99,
  shortHtf: 99,
  shortHtfMomentum20: 99,
  shortMom5: 0.008,
  shortMom20: -0.004,
  shortRsiLo: 8,
  shortRsiHi: 68,
  shortVolume: 0.1,
  shortBbLo: -0.5,
  shortBbHi: 1.7,
  shortLocation: 0.5,
  shortFactor: 1,
  shortAtr: 0.025,
  shortTp: 0.008,
  shortSl: 0.04,
  shortDd: 0.03,
  shortBars: 12,
  shortTrail: 0.006,
  shortHtfExit: 99,
  position: 1,
}

const ranges = {
  direction: ['long-short', 'long-only', 'short-only'],
  longMa120: [0.965, 0.975, 0.985, 0.995, 1.0],
  longTrend: [0.994, 0.997, 1.0, 1.003],
  longHtf: [-99, -0.4, -0.15, 0, 0.25, 0.5],
  longHtfMomentum20: [-99, -0.006, 0, 0.006, 0.012],
  longMom5: [-0.002, 0, 0.003, 0.006, 0.008, 0.01],
  longMom20: [-0.004, 0, 0.004, 0.008, 0.01],
  longRsiLo: [5, 20, 30, 35, 40],
  longRsiHi: [58, 62, 66, 70, 76],
  longVolume: [0.05, 0.08, 0.1, 0.2, 0.5],
  longBbLo: [-1, -0.6, -0.2, 0],
  longBbHi: [0.45, 0.65, 0.85, 1.05, 1.2],
  longLocation: [0.05, 0.12, 0.2, 0.35, 0.5],
  longFactor: [-1, -0.5, 0, 0.5],
  longAtr: [0.018, 0.022, 0.026, 0.03],
  longTp: [0.004, 0.008, 0.012, 0.016, 0.02, 0.03, 0.04],
  longSl: [0.02, 0.03, 0.04, 0.05, 0.07],
  longDd: [0.018, 0.025, 0.035, 0.05],
  longBars: [48, 96, 288, 768, 1440, 2160],
  longTrail: [0.002, 0.006, 0.012, 0.02, 0.03, 0.05],
  longHtfExit: [-99, -0.5, -0.2, 0, 0.25],
  shortMa120: [0.88, 0.9, 0.94, 0.98, 1.0, 1.02],
  shortTrend: [0.994, 0.998, 1.0, 1.004, 99],
  shortHtf: [-0.5, -0.2, 0, 0.25, 99],
  shortHtfMomentum20: [-0.012, -0.006, 0, 0.006, 99],
  shortMom5: [-0.01, -0.006, -0.002, 0.004, 0.008],
  shortMom20: [-0.012, -0.006, -0.002, 0.002],
  shortRsiLo: [5, 18, 28, 35, 42],
  shortRsiHi: [52, 58, 64, 68, 74],
  shortVolume: [0.05, 0.08, 0.1, 0.25, 0.6],
  shortBbLo: [-0.5, -0.2, 0.2, 0.4],
  shortBbHi: [0.9, 1.2, 1.5, 1.7, 2],
  shortLocation: [0.35, 0.5, 0.65, 0.8],
  shortFactor: [-0.5, 0, 0.5, 1, 1.5],
  shortAtr: [0.018, 0.022, 0.026, 0.03],
  shortTp: [0.004, 0.008, 0.012, 0.016, 0.02, 0.03],
  shortSl: [0.018, 0.025, 0.035, 0.045, 0.06],
  shortDd: [0.018, 0.025, 0.035, 0.05],
  shortBars: [8, 12, 18, 24, 48, 96, 144],
  shortTrail: [0, 0.003, 0.006, 0.012, 0.02, 0.03],
  shortHtfExit: [-0.25, 0, 0.2, 0.5, 99],
  position: [0.7, 0.8, 0.9, 1],
}

function scriptFromCandidate(candidate) {
  const longRule = candidate.direction === 'short-only'
    ? 'false'
    : `close > ma120 * ${candidate.longMa120} && ma20 > ma60 * ${candidate.longTrend} && htfTrendScore > ${candidate.longHtf} && htfMomentum20 > ${candidate.longHtfMomentum20} && momentum5 > ${candidate.longMom5} && momentum20 > ${candidate.longMom20} && rsi14 > ${candidate.longRsiLo} && rsi14 < ${candidate.longRsiHi} && volumeRatio > ${candidate.longVolume} && bbPctB > ${candidate.longBbLo} && bbPctB < ${candidate.longBbHi} && closeLocation > ${candidate.longLocation} && factorScore > ${candidate.longFactor} && atrPct < ${candidate.longAtr}`
  const closeLongRule = candidate.direction === 'short-only'
    ? 'false'
    : `unrealizedPnlPct > ${candidate.longTp} || unrealizedPnlPct < -${candidate.longSl} || drawdownSinceEntry > ${candidate.longDd} || barsHeld > ${candidate.longBars} || htfTrendScore < ${candidate.longHtfExit} || ((close < ma20 || maFast < maSlow || macd < macdSignal) && unrealizedPnlPct > ${candidate.longTrail})`
  const shortRule = candidate.direction === 'long-only'
    ? 'false'
    : `close < ma120 * ${candidate.shortMa120} && ma20 < ma60 * ${candidate.shortTrend} && htfTrendScore < ${candidate.shortHtf} && htfMomentum20 < ${candidate.shortHtfMomentum20} && momentum5 < ${candidate.shortMom5} && momentum20 < ${candidate.shortMom20} && rsi14 > ${candidate.shortRsiLo} && rsi14 < ${candidate.shortRsiHi} && volumeRatio > ${candidate.shortVolume} && bbPctB > ${candidate.shortBbLo} && bbPctB < ${candidate.shortBbHi} && closeLocation < ${candidate.shortLocation} && factorScore < ${candidate.shortFactor} && atrPct < ${candidate.shortAtr}`
  const closeShortRule = candidate.direction === 'long-only'
    ? 'false'
    : `unrealizedPnlPct > ${candidate.shortTp} || unrealizedPnlPct < -${candidate.shortSl} || drawdownSinceEntry > ${candidate.shortDd} || barsHeld > ${candidate.shortBars} || htfTrendScore > ${candidate.shortHtfExit} || ((close > ma20 || maFast > maSlow || macd > macdSignal) && unrealizedPnlPct > ${candidate.shortTrail})`
  return [
    `LONG: ${longRule}`,
    `CLOSE_LONG: ${closeLongRule}`,
    `SHORT: ${shortRule}`,
    `CLOSE_SHORT: ${closeShortRule}`,
    `POSITION: ${candidate.position}`,
  ].join('\\n')
}

const candles = await fetchKlines()
const series = buildSeries(candles)
const htfSeries = buildHtfSeries(candles)
console.log(`candles=${candles.length} from=${new Date(candles[0].time).toISOString()} to=${new Date(candles.at(-1).time).toISOString()}`)

let best = []
function addResult(candidate) {
  const result = evaluate(candles, series, htfSeries, candidate)
  best.push({ candidate, ...result })
  best.sort((left, right) => right.score - left.score)
  best = best.slice(0, 20)
}

addResult(baseCandidate)
addResult({ ...baseCandidate, direction: 'long-only' })
addResult({ ...baseCandidate, direction: 'short-only' })
for (let round = 0; round < 16000; round += 1) {
  const anchor = best[Math.floor(random() * Math.min(best.length, 5))]?.candidate ?? baseCandidate
  addResult(candidateFrom(anchor, ranges, round < 2000 ? 0.8 : 0.45))
}

for (const [index, item] of best.slice(0, 8).entries()) {
  console.log(`#${index + 1}`, JSON.stringify({
    score: Number(item.score.toFixed(4)),
    minReturn: Number(item.minReturn.toFixed(4)),
    minWin: Number(item.minWin.toFixed(4)),
    minTrades: item.minTrades,
    maxDrawdown: Number(item.maxDrawdown.toFixed(4)),
    metrics: item.metrics.map((metric) => ({
      days: metric.days,
      ret: Number(metric.ret.toFixed(4)),
      win: Number(metric.win.toFixed(4)),
      closed: metric.closed,
      mdd: Number(metric.mdd.toFixed(4)),
      pf: Number(metric.pf.toFixed(2)),
    })),
    candidate: item.candidate,
  }, null, 2))
}

console.log('BEST_SCRIPT')
console.log(scriptFromCandidate(best[0].candidate))
