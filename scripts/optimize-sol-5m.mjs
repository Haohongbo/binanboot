import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SYMBOL = 'SOLUSDT'
const INTERVAL = '5m'
const INTERVAL_MS = 300_000
const LEVERAGE = Number(process.env.LEVERAGE ?? 5)
const FEE_RATE = 0.0004
const INITIAL_CAPITAL = 10_000
const POSITION_CAP = Number(process.env.POSITION_CAP ?? 0.25)
const WINDOWS = parseNumberList(process.env.WINDOWS, [30, 60, 90, 180, 365])
const ROUNDS = Math.max(0, Math.floor(Number(process.env.ROUNDS ?? 20000)))
const KLINE_SOURCE = process.env.KLINE_SOURCE ?? 'hybrid'
const LOOKBACK_DAYS = Math.max(Math.max(...WINDOWS) + 10, Math.floor(Number(process.env.LOOKBACK_DAYS ?? 380)))
const TARGET_MAX_DRAWDOWN = Number(process.env.TARGET_MAX_DRAWDOWN ?? 0.2)
const TARGET_MIN_WIN = Number(process.env.TARGET_MIN_WIN ?? 0.7)
const TARGET_MIN_TRADES = Number(process.env.TARGET_MIN_TRADES ?? 20)
const REQUIRED_DIRECTION = process.env.REQUIRED_DIRECTION
const CACHE_DIR = join(tmpdir(), 'binanboot-optimizer-klines')
const FUTURES_REST_BASE = process.env.FUTURES_REST_BASE ?? 'https://fapi.binance.com'
const SPOT_REST_BASE = process.env.SPOT_REST_BASE ?? 'https://data-api.binance.vision'
const ALLOW_SPOT_KLINE_FALLBACK = process.env.ALLOW_SPOT_KLINE_FALLBACK !== '0'
let usedSpotKlineFallback = false

const now = new Date()
const endTime = Number(process.env.END_TIME_MS ?? now.getTime())
const startTime = endTime - LOOKBACK_DAYS * 86_400_000

function parseNumberList(value, fallback) {
  if (!value) return fallback
  const parsed = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
  return parsed.length > 0 ? parsed : fallback
}

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

function dayStamp(time) {
  return new Date(time).toISOString().slice(0, 10)
}

function parseVisionCsv(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((row) => Number.isFinite(Number(row[0])))
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
}

async function downloadBinary(url) {
  try {
    const response = await fetch(url)
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return downloadWithCurl(url, { maxBuffer: 8 * 1024 * 1024, originalError: error })
  }
}

function downloadWithCurl(url, { encoding, maxBuffer, originalError }) {
  const baseArgs = ['-fsSL', '--retry', '3', '--retry-delay', '1', '--retry-all-errors', '--connect-timeout', '10', '--max-time', '60', url]
  const stdio = ['ignore', 'pipe', 'ignore']
  try {
    return execFileSync('curl', baseArgs, { encoding, maxBuffer, stdio })
  } catch {
    try {
      return execFileSync('curl', ['-k', ...baseArgs], { encoding, maxBuffer, stdio })
    } catch {
      throw originalError
    }
  }
}

async function downloadText(url) {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return await response.text()
  } catch (error) {
    return downloadWithCurl(url, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, originalError: error })
  }
}

async function fetchVisionDay(time) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const stamp = dayStamp(time)
  const name = `${SYMBOL}-${INTERVAL}-${stamp}.zip`
  const cachePath = join(CACHE_DIR, name)
  let bytes
  try {
    bytes = readFileSync(cachePath)
  } catch {
    process.stderr.write(`fetch ${stamp}\r`)
    bytes = await downloadBinary(`https://data.binance.vision/data/futures/um/daily/klines/${SYMBOL}/${INTERVAL}/${name}`)
    if (!bytes) return []
    writeFileSync(cachePath, bytes)
    await delay(15)
  }
  const zipPath = join(tmpdir(), `binanboot-${name}`)
  writeFileSync(zipPath, bytes)
  const csv = execFileSync('unzip', ['-p', zipPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return parseVisionCsv(csv)
}

async function fetchKlinesFromVision() {
  const candles = []
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const visionEndTime = Math.min(endTime, todayUtc)
  for (let cursor = Date.UTC(new Date(startTime).getUTCFullYear(), new Date(startTime).getUTCMonth(), new Date(startTime).getUTCDate()); cursor < visionEndTime; cursor += 86_400_000) {
    candles.push(...await fetchVisionDay(cursor))
  }
  const unique = new Map()
  candles
    .filter((candle) => candle.time >= startTime && candle.time <= endTime)
    .forEach((candle) => unique.set(candle.time, candle))
  return [...unique.values()].sort((left, right) => left.time - right.time)
}

async function fetchKlinesFromRest(from = startTime, to = endTime) {
  const candles = []
  let cursor = from
  while (cursor <= to) {
    const query = new URLSearchParams({
      symbol: SYMBOL,
      interval: INTERVAL,
      startTime: String(cursor),
      endTime: String(to),
      limit: '1500',
    })
    let rows
    try {
      rows = JSON.parse(await downloadText(`${FUTURES_REST_BASE}/fapi/v1/klines?${query}`))
    } catch (error) {
      if (!ALLOW_SPOT_KLINE_FALLBACK) throw error
      usedSpotKlineFallback = true
      rows = JSON.parse(await downloadText(`${SPOT_REST_BASE}/api/v3/klines?${query}`))
    }
    if (rows.length === 0) break
    const batch = rows
      .filter((row) => Number(row[6]) <= to)
      .map((row) => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      }))
    candles.push(...batch)
    const lastTime = Number(rows.at(-1)?.[0])
    if (!lastTime) break
    cursor = lastTime + INTERVAL_MS
    if (batch.length < 1500) break
    await delay(25)
  }
  const unique = new Map()
  candles
    .filter((candle) => candle.time >= from && candle.time <= to)
    .forEach((candle) => unique.set(candle.time, candle))
  return [...unique.values()].sort((left, right) => left.time - right.time)
}

async function fetchKlines() {
  if (KLINE_SOURCE === 'rest') return fetchKlinesFromRest()
  const candles = await fetchKlinesFromVision()
  if (KLINE_SOURCE === 'vision') return candles
  if (candles.length > 0) {
    const lastTime = candles.at(-1)?.time ?? startTime
    if (lastTime + INTERVAL_MS < endTime) {
      const tail = await fetchKlinesFromRest(lastTime + INTERVAL_MS, endTime)
      const unique = new Map()
      for (const candle of [...candles, ...tail]) unique.set(candle.time, candle)
      return [...unique.values()].sort((left, right) => left.time - right.time)
    }
    return candles
  }
  return fetchKlinesFromRest()
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
        const quantity = (cash * Math.min(candidate.position, POSITION_CAP) * LEVERAGE) / candle.close
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
  const minPf = Math.min(...metrics.map((item) => item.pf))
  const avgPf = average(metrics.map((item) => item.pf))
  const weightedReturn =
    metrics[0].ret * 0.8 +
    metrics[1].ret * 1.5 +
    metrics[2].ret * 2.2 +
    metrics[3].ret * 3.2
  const avgReturn = average(metrics.map((item) => item.ret))
  const avgWin = average(metrics.map((item) => item.win))
  const avgTrades = average(metrics.map((item) => item.closed))
  const riskAdjustedReturn = weightedReturn / Math.max(0.04, maxDrawdown)
  const score =
    weightedReturn * 2.8 +
    avgReturn * 1.8 +
    minReturn * 3.5 +
    riskAdjustedReturn * 0.28 +
    minWin * 9 +
    avgWin * 4 +
    Math.min(minPf, 3) * 0.6 +
    Math.min(avgPf, 3) * 0.25 +
    Math.log1p(Math.max(0, minTrades)) * 0.45 +
    Math.log1p(avgTrades) * 0.18 -
    maxDrawdown * 12 -
    (maxDrawdown > TARGET_MAX_DRAWDOWN ? (maxDrawdown - TARGET_MAX_DRAWDOWN) * 70 : 0) -
    (maxDrawdown > TARGET_MAX_DRAWDOWN * 1.25 ? (maxDrawdown - TARGET_MAX_DRAWDOWN * 1.25) * 120 : 0) -
    (maxDrawdown > TARGET_MAX_DRAWDOWN * 1.5 ? (maxDrawdown - TARGET_MAX_DRAWDOWN * 1.5) * 180 : 0) -
    (minTrades < TARGET_MIN_TRADES ? (TARGET_MIN_TRADES - minTrades) * 1.4 : 0) -
    (minWin < TARGET_MIN_WIN ? (TARGET_MIN_WIN - minWin) * 34 : 0) -
    (avgWin < TARGET_MIN_WIN + 0.04 ? (TARGET_MIN_WIN + 0.04 - avgWin) * 18 : 0) -
    (minReturn < 0.02 ? (0.02 - minReturn) * 12 : 0) -
    (minReturn < 0 ? Math.abs(minReturn) * 36 : 0)
  return { score, metrics, minReturn, minWin, minTrades, maxDrawdown, minPf, avgPf }
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

function parseExtraCandidates() {
  if (!process.env.EXTRA_CANDIDATE_JSON) return []
  const parsed = JSON.parse(process.env.EXTRA_CANDIDATE_JSON)
  return Array.isArray(parsed) ? parsed : [parsed]
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
  position: 0.8,
}

const currentScriptCandidate = {
  direction: 'long-short',
  longMa120: 0.985,
  longTrend: 1,
  longHtf: -99,
  longHtfMomentum20: 0,
  longMom5: 0.008,
  longMom20: 0,
  longRsiLo: 30,
  longRsiHi: 58,
  longVolume: 0.1,
  longBbLo: -0.6,
  longBbHi: 1.05,
  longLocation: 0.2,
  longFactor: -1,
  longAtr: 0.022,
  longTp: 0.016,
  longSl: 0.05,
  longDd: 0.05,
  longBars: 288,
  longTrail: 0.006,
  longHtfExit: -99,
  shortMa120: 1.02,
  shortTrend: 99,
  shortHtf: -0.5,
  shortHtfMomentum20: -0.012,
  shortMom5: 0.008,
  shortMom20: -0.002,
  shortRsiLo: 5,
  shortRsiHi: 64,
  shortVolume: 0.6,
  shortBbLo: -0.5,
  shortBbHi: 1.2,
  shortLocation: 0.5,
  shortFactor: -0.5,
  shortAtr: 0.026,
  shortTp: 0.012,
  shortSl: 0.045,
  shortDd: 0.05,
  shortBars: 144,
  shortTrail: 0.006,
  shortHtfExit: 99,
  position: 0.18,
}

const maxReturnScriptCandidate = {
  direction: 'long-short',
  longMa120: 1,
  longTrend: 0.997,
  longHtf: 0,
  longHtfMomentum20: -0.006,
  longMom5: 0.008,
  longMom20: 0,
  longRsiLo: 5,
  longRsiHi: 66,
  longVolume: 0.05,
  longBbLo: -1,
  longBbHi: 1.2,
  longLocation: 0.5,
  longFactor: 0,
  longAtr: 0.03,
  longTp: 0.04,
  longSl: 0.02,
  longDd: 0.05,
  longBars: 288,
  longTrail: 0.02,
  longHtfExit: -99,
  shortMa120: 0.98,
  shortTrend: 1.004,
  shortHtf: 99,
  shortHtfMomentum20: 0,
  shortMom5: -0.01,
  shortMom20: 0.002,
  shortRsiLo: 28,
  shortRsiHi: 68,
  shortVolume: 0.1,
  shortBbLo: -0.5,
  shortBbHi: 1.7,
  shortLocation: 0.8,
  shortFactor: 0,
  shortAtr: 0.018,
  shortTp: 0.03,
  shortSl: 0.025,
  shortDd: 0.025,
  shortBars: 48,
  shortTrail: 0.003,
  shortHtfExit: 0,
  position: 0.8,
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
  position: [0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25, 0.3, 0.5, 0.6, 0.7, 0.8],
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
  ].join('\n')
}

const candles = await fetchKlines()
const series = buildSeries(candles)
const htfSeries = buildHtfSeries(candles)
console.log(`candles=${candles.length} from=${new Date(candles[0].time).toISOString()} to=${new Date(candles.at(-1).time).toISOString()} leverage=${LEVERAGE}x positionCap=${POSITION_CAP} source=${KLINE_SOURCE}${usedSpotKlineFallback ? '+spot-tail-fallback' : ''}`)

const currentResult = evaluate(candles, series, htfSeries, currentScriptCandidate)
console.log('CURRENT_SCRIPT', JSON.stringify({
  score: Number(currentResult.score.toFixed(4)),
  minReturn: Number(currentResult.minReturn.toFixed(4)),
  minWin: Number(currentResult.minWin.toFixed(4)),
  minTrades: currentResult.minTrades,
  maxDrawdown: Number(currentResult.maxDrawdown.toFixed(4)),
  metrics: currentResult.metrics.map((metric) => ({
    days: metric.days,
    ret: Number(metric.ret.toFixed(4)),
    win: Number(metric.win.toFixed(4)),
    closed: metric.closed,
    mdd: Number(metric.mdd.toFixed(4)),
    pf: Number(metric.pf.toFixed(2)),
  })),
}, null, 2))

let best = []
let bestConstrained = []

function meetsTargets(result) {
  return (
    result.minReturn > 0 &&
    result.minWin >= TARGET_MIN_WIN &&
    result.minTrades >= TARGET_MIN_TRADES &&
    result.maxDrawdown <= TARGET_MAX_DRAWDOWN
  )
}

function addResult(candidate) {
  if (REQUIRED_DIRECTION) candidate = { ...candidate, direction: REQUIRED_DIRECTION }
  const result = evaluate(candles, series, htfSeries, candidate)
  best.push({ candidate, ...result })
  best.sort((left, right) => right.score - left.score)
  best = best.slice(0, 20)
  if (meetsTargets(result)) {
    bestConstrained.push({ candidate, ...result })
    bestConstrained.sort((left, right) => right.score - left.score)
    bestConstrained = bestConstrained.slice(0, 20)
  }
}

addResult(baseCandidate)
addResult(currentScriptCandidate)
addResult(maxReturnScriptCandidate)
addResult({ ...baseCandidate, direction: 'long-only' })
addResult({ ...baseCandidate, direction: 'short-only' })
for (const candidate of parseExtraCandidates()) {
  addResult({ ...baseCandidate, ...candidate })
}
for (let round = 0; round < ROUNDS; round += 1) {
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
if (bestConstrained[0]) {
  console.log('BEST_CONSTRAINED_SCRIPT')
  console.log(scriptFromCandidate(bestConstrained[0].candidate))
}
