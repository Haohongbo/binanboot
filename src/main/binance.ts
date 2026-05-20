import crypto from 'node:crypto'
import { net } from 'electron'
import type {
  AccountAsset,
  AccountPosition,
  BinanceEnvironment,
  Candle,
  CandleInterval,
  DepthLevel,
  FuturesAccountSnapshot,
  MarketSnapshot,
  MarketTicker,
  OrderRecord,
  PlaceOrderInput,
  PositionSide,
  TradeTick,
} from '../shared/types'

const BINANCE_FAPI_REST: Record<BinanceEnvironment, string> = {
  live: 'https://fapi.binance.com',
  testnet: 'https://testnet.binancefuture.com',
}

const RECV_WINDOW_MS = 60_000
const TIME_SYNC_TTL_MS = 60_000
const SIGNED_REQUEST_MAX_ATTEMPTS = 4

export interface Credentials {
  apiKey: string
  apiSecret: string
  environment?: BinanceEnvironment
}

export interface SymbolTradeRules {
  symbol: string
  quantityPrecision: number
  pricePrecision: number
  minQty: number
  stepSize: number
  minNotional: number
}

export interface LeverageResult {
  symbol: string
  leverage: number
  maxNotionalValue: number
}

export interface PositionLeverage {
  symbol: string
  leverage: number
  positionSide?: PositionSide
  marginType?: 'cross' | 'isolated'
}

const intervalMs: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

class BinanceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: number,
    readonly retryAfter?: string | null,
  ) {
    const suffix = retryAfter ? `，建议等待 ${retryAfter}s 后重试` : ''
    super(`Binance API ${status}${suffix}: ${message}`)
    this.name = 'BinanceApiError'
  }
}

const restBanUntilByEnvironment = new Map<BinanceEnvironment, number>()

function parseBanUntil(message: string): number | undefined {
  const match = message.match(/banned until\s+(\d{12,})/i)
  const until = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(until) && until > Date.now() ? until : undefined
}

function retryAfterSeconds(until: number): string {
  return String(Math.max(1, Math.ceil((until - Date.now()) / 1000)))
}

export function isBinanceRateLimitBan(error: unknown): boolean {
  if (error instanceof BinanceApiError) return error.status === 418 || error.code === -1003
  const message = String(error)
  return message.includes('Binance API 418') || message.includes('-1003') || /too many requests/i.test(message)
}

type TimeSyncState = {
  offsetMs: number
  syncedAt: number
  inFlight?: Promise<number>
}

const timeSyncByEnvironment = new Map<BinanceEnvironment, TimeSyncState>()

function timeSyncState(environment: BinanceEnvironment): TimeSyncState {
  let state = timeSyncByEnvironment.get(environment)
  if (!state) {
    state = { offsetMs: 0, syncedAt: 0 }
    timeSyncByEnvironment.set(environment, state)
  }
  return state
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function signQuery(query: URLSearchParams, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query.toString()).digest('hex')
}

function restBase(environment: BinanceEnvironment = 'live'): string {
  return BINANCE_FAPI_REST[environment]
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJson<T>(
  path: string,
  query?: URLSearchParams,
  init?: RequestInit,
  environment: BinanceEnvironment = 'live',
  retries = 1,
): Promise<T> {
  const bannedUntil = restBanUntilByEnvironment.get(environment) ?? 0
  if (bannedUntil > Date.now()) {
    throw new BinanceApiError(
      418,
      `-1003: Binance REST 请求已因 IP 限频封禁暂停，本地将在 ${new Date(bannedUntil).toLocaleString('zh-CN')} 后恢复请求。请使用 WebSocket 实时行情，避免继续触发封禁。`,
      -1003,
      retryAfterSeconds(bannedUntil),
    )
  }
  const url = new URL(path, restBase(environment))
  if (query) {
    query.forEach((value, key) => url.searchParams.append(key, value))
  }
  let response: Response
  try {
    response = await net.fetch(url.toString(), init)
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? String(error.cause) : String(error)
    throw new Error(
      `无法连接 Binance ${environment === 'testnet' ? '测试网' : '实盘'}接口：${cause}。这是网络/TLS 层异常，请检查网络代理、DNS、防火墙或当前地区对 Binance Futures API 的访问限制。`,
    )
  }
  const method = init?.method ?? 'GET'
  if (!response.ok && method === 'GET' && retries > 0 && [408, 429, 502, 503, 504].includes(response.status)) {
    const retryAfter = Number(response.headers.get('retry-after'))
    await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 450)
    return requestJson<T>(path, query, init, environment, retries - 1)
  }
  if (!response.ok) {
    const text = await response.text()
    const retryAfter = response.headers.get('retry-after')
    let message = text.slice(0, 240)
    let apiCode: number | undefined
    try {
      const parsed = JSON.parse(text) as { code?: number; msg?: string }
      if (typeof parsed.code === 'number') apiCode = parsed.code
      if (parsed.msg) message = `${parsed.code ?? response.status}: ${parsed.msg}`
    } catch {
      // Keep the raw response preview.
    }
    const bannedUntil = response.status === 418 || apiCode === -1003 ? parseBanUntil(message) ?? parseBanUntil(text) : undefined
    if (bannedUntil) {
      restBanUntilByEnvironment.set(environment, bannedUntil)
      throw new BinanceApiError(response.status, message, apiCode, retryAfter ?? retryAfterSeconds(bannedUntil))
    }
    throw new BinanceApiError(response.status, message, apiCode, retryAfter)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

async function syncBinanceTime(environment: BinanceEnvironment, force = false): Promise<number> {
  const state = timeSyncState(environment)
  const now = Date.now()
  if (!force && state.syncedAt > 0 && now - state.syncedAt < TIME_SYNC_TTL_MS) return state.offsetMs
  if (state.inFlight && !force) return state.inFlight

  const started = Date.now()
  let syncRequest: Promise<number>
  syncRequest = requestJson<{ serverTime: number }>('/fapi/v1/time', undefined, undefined, environment, 0)
    .then((server) => {
      const finished = Date.now()
      const localMidpoint = started + Math.round((finished - started) / 2)
      state.offsetMs = server.serverTime - localMidpoint
      state.syncedAt = finished
      return state.offsetMs
    })
    .finally(() => {
      if (state.inFlight === syncRequest) state.inFlight = undefined
    })
  state.inFlight = syncRequest
  return syncRequest
}

async function signedTimestamp(environment: BinanceEnvironment, forceSync = false): Promise<number> {
  try {
    return Date.now() + await syncBinanceTime(environment, forceSync)
  } catch {
    const state = timeSyncState(environment)
    return Date.now() + (state.syncedAt > 0 ? state.offsetMs : 0)
  }
}

function isTimestampWindowError(error: unknown): boolean {
  if (error instanceof BinanceApiError) return error.code === -1021
  return String(error).includes('-1021') && String(error).includes('Timestamp')
}

async function signedRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  credentials: Credentials,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const environment = credentials.environment ?? 'live'
  let lastTimestampError: unknown
  for (let attempt = 0; attempt < SIGNED_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const query = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) query.set(key, String(value))
    })
    query.set('timestamp', String(await signedTimestamp(environment, attempt > 0)))
    if (!query.has('recvWindow')) query.set('recvWindow', String(RECV_WINDOW_MS))
    query.set('signature', signQuery(query, credentials.apiSecret))

    try {
      return await requestJson<T>(path, query, {
        method,
        headers: {
          'X-MBX-APIKEY': credentials.apiKey,
        },
      }, environment, method === 'GET' ? 1 : 0)
    } catch (error) {
      if (isTimestampWindowError(error) && attempt < SIGNED_REQUEST_MAX_ATTEMPTS - 1) {
        lastTimestampError = error
        await syncBinanceTime(environment, true).catch(() => undefined)
        await delay(120 * (attempt + 1))
        continue
      }
      throw error
    }
  }
  const message = lastTimestampError ? String(lastTimestampError).replace(/^Error:\s*/, '') : '时间同步重试未成功。'
  throw new Error(`Binance 签名请求失败：${message} 请检查系统时间是否已自动同步，并稍后重试。`)
}

export async function pingBinance(environment: BinanceEnvironment = 'live'): Promise<{ latencyMs: number; serverTime: number }> {
  const started = performance.now()
  const server = await requestJson<{ serverTime: number }>('/fapi/v1/time', undefined, undefined, environment)
  const finished = performance.now()
  const state = timeSyncState(environment)
  const localMidpoint = Date.now() - Math.round((finished - started) / 2)
  state.offsetMs = server.serverTime - localMidpoint
  state.syncedAt = Date.now()
  return { latencyMs: Math.round(finished - started), serverTime: server.serverTime }
}

export async function getTicker(symbol: string): Promise<MarketTicker> {
  const started = performance.now()
  const item = await requestJson<{
    symbol: string
    lastPrice: string
    priceChangePercent: string
    quoteVolume: string
  }>('/fapi/v1/ticker/24hr', new URLSearchParams({ symbol }))

  return {
    symbol: item.symbol,
    lastPrice: toNumber(item.lastPrice),
    priceChangePercent: toNumber(item.priceChangePercent),
    quoteVolume: toNumber(item.quoteVolume),
    latencyMs: Math.round(performance.now() - started),
  }
}

export async function getTickers(symbols: string[]): Promise<MarketTicker[]> {
  const uniqueSymbols = [...new Set(symbols)].filter(Boolean)
  if (uniqueSymbols.length === 0) return []
  const started = performance.now()
  try {
    const rows = await requestJson<Array<{
      symbol: string
      lastPrice: string
      priceChangePercent: string
      quoteVolume: string
    }>>('/fapi/v1/ticker/24hr', new URLSearchParams({ symbols: JSON.stringify(uniqueSymbols) }))
    const latencyMs = Math.round(performance.now() - started)
    return rows.map((item) => ({
      symbol: item.symbol,
      lastPrice: toNumber(item.lastPrice),
      priceChangePercent: toNumber(item.priceChangePercent),
      quoteVolume: toNumber(item.quoteVolume),
      latencyMs,
    }))
  } catch {
    return Promise.all(uniqueSymbols.map((symbol) => getTicker(symbol)))
  }
}

export async function getKlines(
  symbol: string,
  interval: CandleInterval,
  limit = 180,
  environment: BinanceEnvironment = 'live',
): Promise<Candle[]> {
  const rows = await requestJson<unknown[][]>(
    '/fapi/v1/klines',
    new URLSearchParams({ symbol, interval, limit: String(limit) }),
    undefined,
    environment,
  )
  return rows.map((row) => ({
    time: toNumber(row[0]),
    open: toNumber(row[1]),
    high: toNumber(row[2]),
    low: toNumber(row[3]),
    close: toNumber(row[4]),
    volume: toNumber(row[5]),
  }))
}

const symbolRulesCache = new Map<string, SymbolTradeRules>()

export async function getSymbolTradeRules(
  symbol: string,
  environment: BinanceEnvironment = 'live',
): Promise<SymbolTradeRules> {
  const cacheKey = `${environment}:${symbol}`
  const cached = symbolRulesCache.get(cacheKey)
  if (cached) return cached

  const info = await requestJson<{
    symbols?: Array<{
      symbol?: string
      quantityPrecision?: number
      pricePrecision?: number
      filters?: Array<{ filterType?: string; minQty?: string; stepSize?: string; notional?: string; minNotional?: string }>
    }>
  }>('/fapi/v1/exchangeInfo', undefined, undefined, environment)

  const item = info.symbols?.find((entry) => entry.symbol === symbol)
  const lotSize = item?.filters?.find((filter) => filter.filterType === 'LOT_SIZE')
  const marketLotSize = item?.filters?.find((filter) => filter.filterType === 'MARKET_LOT_SIZE')
  const minNotional = item?.filters?.find((filter) => filter.filterType === 'MIN_NOTIONAL')
  const rules: SymbolTradeRules = {
    symbol,
    quantityPrecision: item?.quantityPrecision ?? 3,
    pricePrecision: item?.pricePrecision ?? 2,
    minQty: toNumber(marketLotSize?.minQty, toNumber(lotSize?.minQty, 0)),
    stepSize: toNumber(marketLotSize?.stepSize, toNumber(lotSize?.stepSize, 0.001)),
    minNotional: toNumber(minNotional?.notional, toNumber(minNotional?.minNotional, 5)),
  }
  symbolRulesCache.set(cacheKey, rules)
  return rules
}

export async function setSymbolLeverage(
  credentials: Credentials,
  symbol: string,
  leverage: number,
): Promise<LeverageResult> {
  const targetLeverage = Math.max(1, Math.min(125, Math.floor(leverage)))
  const result = await signedRequest<{
    symbol?: string
    leverage?: number
    maxNotionalValue?: string
  }>('POST', '/fapi/v1/leverage', credentials, {
    symbol,
    leverage: targetLeverage,
  })
  return {
    symbol: result.symbol ?? symbol,
    leverage: Number.isFinite(result.leverage) ? Number(result.leverage) : targetLeverage,
    maxNotionalValue: toNumber(result.maxNotionalValue),
  }
}

export async function getSymbolPositionLeverage(credentials: Credentials, symbol: string): Promise<PositionLeverage> {
  const rows = await signedRequest<Array<{
    symbol?: string
    leverage?: string
    positionSide?: PositionSide
    marginType?: 'cross' | 'isolated'
    positionAmt?: string
    notional?: string
  }>>('GET', '/fapi/v2/positionRisk', credentials, { symbol })
  const candidates = rows
    .filter((row) => row.symbol === symbol)
    .map((row) => ({
      symbol,
      leverage: toNumber(row.leverage),
      positionSide: row.positionSide,
      marginType: row.marginType,
      exposure: Math.abs(toNumber(row.notional, toNumber(row.positionAmt))),
    }))
    .filter((row) => row.leverage > 0)
    .sort((left, right) => right.exposure - left.exposure)
  const best = candidates[0]
  if (!best) throw new Error(`未从 Binance 持仓风险接口读取到 ${symbol} 的有效杠杆。`)
  return {
    symbol,
    leverage: best.leverage,
    positionSide: best.positionSide,
    marginType: best.marginType,
  }
}

export async function getHistoricalKlines(
  symbol: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
  environment: BinanceEnvironment = 'live',
): Promise<Candle[]> {
  if (endTime <= startTime) throw new Error('回测结束时间必须晚于开始时间')
  const candles: Candle[] = []
  const limit = 1500
  let cursor = startTime

  while (cursor <= endTime) {
    const rows = await requestJson<unknown[][]>(
      '/fapi/v1/klines',
      new URLSearchParams({
        symbol,
        interval,
        startTime: String(cursor),
        endTime: String(endTime),
        limit: String(limit),
      }),
      undefined,
      environment,
    )
    if (rows.length === 0) break

    const batch = rows.map((row) => ({
      time: toNumber(row[0]),
      open: toNumber(row[1]),
      high: toNumber(row[2]),
      low: toNumber(row[3]),
      close: toNumber(row[4]),
      volume: toNumber(row[5]),
    }))
    candles.push(...batch)

    const lastTime = batch[batch.length - 1]?.time
    if (!lastTime || lastTime < cursor) break
    cursor = lastTime + intervalMs[interval]
    if (batch.length < limit) break
    await delay(120)
  }

  const unique = new Map<number, Candle>()
  candles
    .filter((candle) => candle.time >= startTime && candle.time <= endTime)
    .forEach((candle) => unique.set(candle.time, candle))
  return [...unique.values()].sort((left, right) => left.time - right.time)
}

export async function getDepth(symbol: string, limit = 20): Promise<{ bids: DepthLevel[]; asks: DepthLevel[] }> {
  const depth = await requestJson<{ bids: string[][]; asks: string[][] }>(
    '/fapi/v1/depth',
    new URLSearchParams({ symbol, limit: String(limit) }),
  )
  return {
    bids: depth.bids.map(([price, quantity]) => ({ price: toNumber(price), quantity: toNumber(quantity) })),
    asks: depth.asks.map(([price, quantity]) => ({ price: toNumber(price), quantity: toNumber(quantity) })),
  }
}

export async function getRecentTrades(symbol: string, limit = 30): Promise<TradeTick[]> {
  const rows = await requestJson<Array<{ id: number; price: string; qty: string; time: number; isBuyerMaker: boolean }>>(
    '/fapi/v1/trades',
    new URLSearchParams({ symbol, limit: String(limit) }),
  )
  return rows
    .map((row) => ({
      id: row.id,
      symbol,
      time: row.time,
      price: toNumber(row.price),
      quantity: toNumber(row.qty),
      side: row.isBuyerMaker ? ('SELL' as const) : ('BUY' as const),
    }))
    .sort((left, right) => right.time - left.time || right.id - left.id)
}

export async function getMarketSnapshot(symbol: string, interval: CandleInterval): Promise<MarketSnapshot> {
  const [ticker, candles, depth, trades, time] = await Promise.all([
    getTicker(symbol),
    getKlines(symbol, interval),
    getDepth(symbol),
    getRecentTrades(symbol),
    pingBinance(),
  ])

  const latestTrade = trades[0]
  const displayTicker = latestTrade
    ? {
        ...ticker,
        lastPrice: latestTrade.price,
        latencyMs: Math.max(0, Date.now() - latestTrade.time),
      }
    : ticker

  return {
    symbol,
    interval,
    ticker: displayTicker,
    candles,
    bids: depth.bids,
    asks: depth.asks,
    quoteMidPrice: depth.bids[0] && depth.asks[0] ? (depth.bids[0].price + depth.asks[0].price) / 2 : undefined,
    trades,
    serverTime: time.serverTime,
    source: 'binance',
  }
}

async function getPositionMode(credentials: Credentials): Promise<boolean> {
  try {
    const result = await signedRequest<{ dualSidePosition?: boolean }>('GET', '/fapi/v1/positionSide/dual', credentials)
    return Boolean(result.dualSidePosition)
  } catch {
    return false
  }
}

function resolvePositionSide(input: PlaceOrderInput, dualSidePosition: boolean): PositionSide | undefined {
  if (!dualSidePosition) return undefined
  if (input.positionSide && input.positionSide !== 'BOTH') return input.positionSide
  if (input.reduceOnly) return 'LONG'
  return input.side === 'BUY' ? 'LONG' : 'SHORT'
}

export async function testCredentials(
  credentials: Credentials,
  verifyTradePermission = false,
): Promise<{
  latencyMs: number
  canRead: boolean
  canTrade: boolean
}> {
  const started = performance.now()
  await signedRequest<unknown>('GET', '/fapi/v3/balance', credentials)
  let canTrade = false
  if (verifyTradePermission) {
    try {
      const dualSidePosition = await getPositionMode(credentials)
      await signedRequest<unknown>('POST', '/fapi/v1/order/test', credentials, {
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.001,
        ...(dualSidePosition ? { positionSide: 'LONG' } : {}),
        newClientOrderId: `perm_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      })
      canTrade = true
    } catch {
      canTrade = false
    }
  }
  return {
    latencyMs: Math.round(performance.now() - started),
    canRead: true,
    canTrade,
  }
}

type FuturesAccountRaw = {
  totalWalletBalance?: string
  totalMarginBalance?: string
  totalUnrealizedProfit?: string
  totalCrossWalletBalance?: string
  totalCrossUnPnl?: string
  availableBalance?: string
  maxWithdrawAmount?: string
  assets?: Array<{
    asset?: string
    walletBalance?: string
    marginBalance?: string
    availableBalance?: string
    maxWithdrawAmount?: string
    unrealizedProfit?: string
  }>
  positions?: Array<{
    symbol?: string
    positionSide?: AccountPosition['positionSide']
    positionAmt?: string
    entryPrice?: string
    markPrice?: string
    breakEvenPrice?: string
    unrealizedProfit?: string
    unRealizedProfit?: string
    leverage?: string
    notional?: string
    isolatedMargin?: string
    isolated?: boolean
    updateTime?: number
  }>
}

function mapAccount(raw: FuturesAccountRaw): FuturesAccountSnapshot {
  const assetsTotal = (raw.assets ?? []).reduce((sum, asset) => sum + Math.max(0, toNumber(asset.walletBalance)), 0)
  const totalWalletBalance = toNumber(raw.totalWalletBalance, assetsTotal)
  const allocationBase = totalWalletBalance > 0 ? totalWalletBalance : assetsTotal
  const assets: AccountAsset[] = (raw.assets ?? [])
    .map((asset) => {
      const walletBalance = toNumber(asset.walletBalance)
      const availableBalance = toNumber(asset.availableBalance, toNumber(asset.maxWithdrawAmount, walletBalance))
      return {
        asset: asset.asset ?? '--',
        walletBalance,
        availableBalance,
        frozenBalance: Math.max(0, walletBalance - availableBalance),
        unrealizedPnl: toNumber(asset.unrealizedProfit),
        allocation: allocationBase > 0 ? (Math.max(0, walletBalance) / allocationBase) * 100 : 0,
      }
    })
    .filter((asset) => asset.asset !== '--' && (asset.walletBalance !== 0 || asset.availableBalance !== 0 || asset.unrealizedPnl !== 0))

  const positions: AccountPosition[] = (raw.positions ?? [])
    .map((position) => {
      const amount = toNumber(position.positionAmt)
      const rawMarkPrice = toNumber(position.markPrice)
      const notional = toNumber(position.notional, amount * rawMarkPrice)
      const impliedPrice = amount !== 0 && notional !== 0 ? Math.abs(notional / amount) : 0
      const rawEntryPrice = toNumber(position.entryPrice)
      const entryPrice = rawEntryPrice > 0 ? rawEntryPrice : toNumber(position.breakEvenPrice, impliedPrice)
      const markPrice = rawMarkPrice > 0 ? rawMarkPrice : impliedPrice || entryPrice
      const marginType: AccountPosition['marginType'] = position.isolated ? 'isolated' : 'cross'
      return {
        symbol: position.symbol ?? '--',
        positionSide: position.positionSide ?? 'BOTH',
        positionAmount: amount,
        entryPrice,
        markPrice,
        unrealizedPnl: toNumber(position.unRealizedProfit, toNumber(position.unrealizedProfit)),
        leverage: toNumber(position.leverage, 1),
        notional,
        isolatedMargin: toNumber(position.isolatedMargin),
        marginType,
        updateTime: position.updateTime ?? Date.now(),
      }
    })
    .filter((position) => position.symbol !== '--' && (position.positionAmount !== 0 || position.notional !== 0 || position.unrealizedPnl !== 0))

  return {
    summary: {
      totalWalletBalance,
      totalMarginBalance: toNumber(raw.totalMarginBalance, totalWalletBalance),
      totalUnrealizedProfit: toNumber(raw.totalUnrealizedProfit),
      totalCrossWalletBalance: toNumber(raw.totalCrossWalletBalance),
      totalCrossUnPnl: toNumber(raw.totalCrossUnPnl),
      availableBalance: toNumber(raw.availableBalance),
      maxWithdrawAmount: toNumber(raw.maxWithdrawAmount),
    },
    assets,
    positions,
  }
}

export async function getFuturesAccount(credentials: Credentials): Promise<FuturesAccountSnapshot> {
  const raw = await signedRequest<FuturesAccountRaw>('GET', '/fapi/v3/account', credentials)
  return mapAccount(raw)
}

export async function placeFuturesOrder(credentials: Credentials, input: PlaceOrderInput): Promise<OrderRecord> {
  if (input.quantity <= 0) throw new Error('下单数量必须大于 0')
  if (input.type === 'LIMIT' && (!input.price || input.price <= 0)) throw new Error('限价单必须填写有效价格')
  const dualSidePosition = await getPositionMode(credentials)
  const positionSide = resolvePositionSide(input, dualSidePosition)
  const params: Record<string, string | number | boolean | undefined> = {
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    quantity: input.quantity,
    newClientOrderId: input.idempotencyKey,
    positionSide,
    reduceOnly: dualSidePosition ? undefined : input.reduceOnly,
    newOrderRespType: input.type === 'MARKET' ? 'RESULT' : undefined,
  }
  if (input.type === 'LIMIT') {
    params.price = input.price
    params.timeInForce = 'GTC'
  }

  const result = await signedRequest<{
    orderId: number
    updateTime?: number
    price?: string
    avgPrice?: string
    origQty?: string
    status?: OrderRecord['status']
  }>('POST', '/fapi/v1/order', credentials, params)

  return {
    id: String(result.orderId),
    time: result.updateTime ?? Date.now(),
    symbol: input.symbol,
    side: input.side,
    positionSide: positionSide ?? input.positionSide,
    type: input.type,
    price: toNumber(result.avgPrice, toNumber(result.price, input.price ?? 0)),
    quantity: toNumber(result.origQty, input.quantity),
    status: result.status ?? 'NEW',
    strategyId: input.strategyId,
    idempotencyKey: input.idempotencyKey,
  }
}

export function makeMockSnapshot(symbol: string, interval: CandleInterval, seed = Date.now()): MarketSnapshot {
  const now = Date.now()
  const base = symbol.startsWith('BTC') ? 67284 : symbol.startsWith('ETH') ? 3642 : symbol.startsWith('SOL') ? 152 : 87
  const drift = Math.sin(seed / 90_000) * base * 0.015
  const step = intervalMs[interval]
  const candles: Candle[] = Array.from({ length: 180 }).map((_, index) => {
    const t = now - (179 - index) * step
    const trend = Math.sin((seed / 140_000 + index) / 7) * base * 0.028
    const pulse = Math.cos((seed / 80_000 + index) / 3) * base * 0.006
    const open = base + drift + trend
    const close = open + pulse
    const high = Math.max(open, close) + base * (0.004 + (index % 5) * 0.0005)
    const low = Math.min(open, close) - base * (0.004 + (index % 3) * 0.0007)
    return {
      time: t,
      open,
      high,
      low,
      close,
      volume: 80 + Math.abs(Math.sin(index / 3)) * 780 + (index % 9) * 24,
    }
  })
  const last = candles[candles.length - 1].close
  const spreadStep = base * 0.00008
  const bids = Array.from({ length: 20 }).map((_, index) => ({
    price: last - (index + 1) * spreadStep,
    quantity: 0.09 + ((index * 37) % 85) / 100,
  }))
  const asks = Array.from({ length: 20 }).map((_, index) => ({
    price: last + (index + 1) * spreadStep,
    quantity: 0.12 + ((index * 29) % 90) / 100,
  }))
  const trades = Array.from({ length: 30 }).map((_, index) => ({
    id: seed + index,
    time: now - index * 1500,
    price: index % 3 === 0 ? bids[0].price : index % 3 === 1 ? asks[0].price : last,
    quantity: 0.006 + ((index * 11) % 43) / 1000,
    side: index % 3 === 0 ? 'SELL' : 'BUY',
  })) satisfies TradeTick[]
  const latestTradePrice = trades[0]?.price ?? last
  const latestCandle = candles[candles.length - 1]
  candles[candles.length - 1] = {
    ...latestCandle,
    high: Math.max(latestCandle.high, latestTradePrice),
    low: Math.min(latestCandle.low, latestTradePrice),
    close: latestTradePrice,
  }

  return {
    symbol,
    interval,
    ticker: {
      symbol,
      lastPrice: latestTradePrice,
      priceChangePercent: symbol.startsWith('ETH') ? 2.05 : symbol.startsWith('ADA') ? -0.83 : 1.32,
      quoteVolume: 1_342_000_000,
      latencyMs: 18,
    },
    candles,
    bids,
    asks,
    quoteMidPrice: bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : undefined,
    trades,
    serverTime: now,
    source: 'mock',
  }
}
