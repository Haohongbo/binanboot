import { ipcMain } from 'electron'
import crypto from 'node:crypto'
import {
  getFuturesAccount,
  getHistoricalKlines,
  getMarketSnapshot,
  getSymbolPositionLeverage,
  getTickers,
  pingBinance,
  placeFuturesOrder,
  testCredentials,
} from './binance'
import type { AnalyticsStore } from './analytics'
import type { LocalStore } from './store'
import type {
  BacktestParams,
  BacktestResult,
  Candle,
  CandleInterval,
  MarketDataCacheRequest,
  LogClearFilter,
  OrderRecord,
  PlaceOrderInput,
  PositionSide,
  RiskEvent,
  RiskRuleSet,
  StoredApiInput,
  StrategyConfig,
} from '../shared/types'
import {
  buildSignalContext,
  evalScriptExpression,
  lowestLow,
  parseScriptRules,
} from '../shared/script-signals'

function getCredentialsWithEnvironment(store: LocalStore, profileId: string): { apiKey: string; apiSecret: string; environment: 'live' | 'testnet' } | undefined {
  const credentials = store.getCredentials(profileId)
  const profile = store.snapshot().apiProfiles.find((item) => item.id === profileId)
  if (!credentials || !profile) return undefined
  return { ...credentials, environment: profile.environment }
}

function makePaperOrder(input: PlaceOrderInput, marketPrice: number): OrderRecord {
  return {
    id: `paper-${crypto.randomUUID()}`,
    time: Date.now(),
    symbol: input.symbol,
    side: input.side,
    positionSide: input.positionSide,
    type: input.type,
    price: input.type === 'LIMIT' ? input.price ?? marketPrice : marketPrice,
    quantity: input.quantity,
    executedQuantity: input.quantity,
    status: 'FILLED',
    strategyId: input.strategyId,
    idempotencyKey: input.idempotencyKey,
  }
}

function makeFailedOrder(input: PlaceOrderInput, marketPrice: number, reason: string): OrderRecord {
  return {
    id: `failed-${crypto.randomUUID()}`,
    time: Date.now(),
    symbol: input.symbol,
    side: input.side,
    positionSide: input.positionSide,
    type: input.type,
    price: input.type === 'LIMIT' ? input.price ?? marketPrice : marketPrice,
    quantity: input.quantity,
    executedQuantity: 0,
    status: 'FAILED',
    strategyId: input.strategyId,
    idempotencyKey: input.idempotencyKey,
    failureReason: reason,
  }
}

const intervalMs: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

function compactEquityCurve(curve: BacktestResult['equityCurve'], maxPoints = 1600): BacktestResult['equityCurve'] {
  if (curve.length <= maxPoints) return curve
  const compacted: BacktestResult['equityCurve'] = [curve[0]]
  const step = (curve.length - 2) / (maxPoints - 2)
  for (let index = 1; index < maxPoints - 1; index += 1) {
    compacted.push(curve[Math.round(index * step)])
  }
  compacted.push(curve[curve.length - 1])
  return compacted
}

function findRequestedRange(candles: Candle[], from: number, to: number): { startIndex: number; endIndex: number } {
  let startIndex = -1
  let endIndex = -1
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    if (startIndex < 0 && candle.time >= from) startIndex = index
    if (candle.time <= to) endIndex = index
    if (candle.time > to && endIndex >= 0) break
  }
  return { startIndex, endIndex }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function runNaiveBacktest(
  params: BacktestParams,
  candles: Candle[],
  source: BacktestResult['source'],
  customStrategy?: StrategyConfig,
  leverageInfo: BacktestResult['leverage'] = { value: 1, source: 'risk-rule' },
): Promise<BacktestResult> {
  if (candles.length === 0) throw new Error('未获取到历史 K 线，无法运行回测')
  const { startIndex, endIndex } = findRequestedRange(candles, params.from, params.to)
  if (startIndex < 0 || endIndex < startIndex) throw new Error('指定回测区间内没有 K 线，请扩大时间范围或更换周期')
  const requestedCandles = candles.slice(startIndex, endIndex + 1)

  const slowPeriod = 22
  let cash = params.initialCapital
  let position = 0
  let entryPrice = 0
  let highestSinceEntry = 0
  let lowestSinceEntry = 0
  const equityCurve: BacktestResult['equityCurve'] = []
  const trades: BacktestResult['trades'] = []
  let wins = 0
  let closedTrades = 0
  let grossProfit = 0
  let grossLoss = 0
  let peak = params.initialCapital
  let maxDrawdown = 0
  let lastRequestedCandle: Candle | undefined
  let entryIndex = -1
  const scriptRules = params.strategyType === 'script'
    ? parseScriptRules(customStrategy?.customScript, {
        buy: 'maFast > maSlow && momentum > 0.01',
        sell: 'maFast < maSlow || close < entryPrice * 0.97',
        long: 'maFast > maSlow && momentum > 0.01',
        closeLong: 'maFast < maSlow || close < entryPrice * 0.97',
        short: 'false',
        closeShort: 'false',
        position: '0.25',
      })
    : undefined
  const effectiveLeverage = Math.max(1, Math.min(125, Math.floor(Number.isFinite(leverageInfo.value) ? leverageInfo.value : 1)))

  const yieldEvery = 2048
  for (let index = startIndex; index <= endIndex; index += 1) {
    const candle = candles[index]
    lastRequestedCandle = candle

    if (index > startIndex && (index - startIndex) % yieldEvery === 0) {
      await yieldToEventLoop()
    }

    if (index < slowPeriod - 1) {
      equityCurve.push({ time: candle.time, value: cash + (position !== 0 ? position * (candle.close - entryPrice) : 0) })
      continue
    }

    highestSinceEntry = position !== 0 ? Math.max(highestSinceEntry, candle.high) : 0
    lowestSinceEntry = position !== 0 ? Math.min(lowestSinceEntry, candle.low) : 0
    const context = buildSignalContext(candles, index, {
      entryPrice,
      position,
      entryIndex: entryIndex >= 0 ? entryIndex : undefined,
      highestSinceEntry,
      lowestSinceEntry,
    })
    const {
      maFast,
      maSlow,
      momentum,
      channelHigh,
      channelMid,
      channelWidth,
      volatility,
      volumeRatio,
    } = context
    let shouldEnter = false
    let shouldExit = false
    let positionRatio = 0.24

    if (params.strategyType === 'trend') {
      const breakoutConfirmed = candle.close >= channelHigh * 0.992
      const trendAligned = maFast > maSlow && candle.close > maSlow
      const trailingStop = highestSinceEntry * 0.94
      shouldEnter = position === 0 && trendAligned && (breakoutConfirmed || momentum > 0.012)
      shouldExit = position > 0 && (maFast < maSlow || candle.close < trailingStop || candle.close < entryPrice * 0.93)
      positionRatio = 0.36
    } else if (params.strategyType === 'multi-factor') {
      highestSinceEntry = position > 0 ? Math.max(highestSinceEntry, candle.high) : 0
      const recentWindow = candles.slice(Math.max(0, index - 8), index + 1)
      const volumeFactor = volumeRatio > 1.08 ? 1 : 0
      const trendFactor = maFast > maSlow && candle.close > maSlow ? 1 : maFast > maSlow ? 0.5 : -0.5
      const momentumFactor = momentum > 0.018 ? 1 : momentum > 0.006 ? 0.5 : momentum < -0.012 ? -0.5 : 0
      const volatilityFactor = volatility > 0 && volatility < 0.045 ? 0.5 : volatility >= 0.075 ? -0.75 : 0
      const pullbackFactor = candle.close > lowestLow(recentWindow) * 1.018 ? 0.35 : 0
      const factorScore = trendFactor + momentumFactor + volumeFactor + volatilityFactor + pullbackFactor
      const trailingStop = highestSinceEntry * 0.925
      shouldEnter = position === 0 && factorScore >= 2.1
      shouldExit = position > 0 && (factorScore <= 0.25 || candle.close < trailingStop || candle.close < entryPrice * 0.94)
      positionRatio = 0.3
    } else if (params.strategyType === 'script') {
      const parsedPosition = Number(evalScriptExpression(scriptRules?.position ?? '0.25', context))
      const longRule = scriptRules?.long ?? scriptRules?.buy ?? 'false'
      const closeLongRule = scriptRules?.closeLong ?? scriptRules?.sell ?? 'false'
      const shortRule = scriptRules?.short ?? 'false'
      const closeShortRule = scriptRules?.closeShort ?? 'false'
      const shouldLong = Boolean(evalScriptExpression(longRule, context))
      const shouldShort = Boolean(evalScriptExpression(shortRule, context))
      shouldEnter = position === 0 && (shouldLong || shouldShort)
      shouldExit = position > 0
        ? Boolean(evalScriptExpression(closeLongRule, context))
        : position < 0
          ? Boolean(evalScriptExpression(closeShortRule, context))
          : false
      positionRatio = Math.min(0.8, Math.max(0.01, Number.isFinite(parsedPosition) ? parsedPosition : 0.25))
      if (shouldEnter && shouldShort && !shouldLong) positionRatio *= -1
    } else if (params.strategyType === 'grid') {
      const lowerBand = channelMid * (1 - Math.min(0.08, channelWidth * 0.35))
      const upperBand = channelMid * (1 + Math.min(0.08, channelWidth * 0.28))
      shouldEnter = position === 0 && candle.close <= lowerBand
      shouldExit = position > 0 && (candle.close >= upperBand || candle.close < entryPrice * 0.965)
      positionRatio = 0.18
    } else {
      shouldEnter = position === 0 && maFast > maSlow
      shouldExit = position > 0 && (maFast < maSlow || candle.close > entryPrice * 1.024 || candle.close < entryPrice * 0.982)
      positionRatio = 0.24
    }

    if (shouldEnter) {
      const quantity = (cash * Math.abs(positionRatio) * effectiveLeverage) / candle.close
      const signedQuantity = positionRatio < 0 ? -quantity : quantity
      const cost = quantity * candle.close
      const fee = cost * params.feeRate
      cash -= fee
      position = signedQuantity
      entryPrice = candle.close
      highestSinceEntry = candle.high
      lowestSinceEntry = candle.low
      entryIndex = index
      trades.push({
        time: candle.time,
        symbol: params.symbol,
        side: signedQuantity < 0 ? 'SELL' : 'BUY',
        positionSide: signedQuantity < 0 ? 'SHORT' : 'LONG',
        price: candle.close,
        quantity,
        pnl: -fee,
      })
    }

    if (shouldExit) {
      const quantity = Math.abs(position)
      const fee = quantity * candle.close * params.feeRate
      const pnl = position * (candle.close - entryPrice) - fee
      cash += pnl
      if (pnl > 0) {
        wins += 1
        grossProfit += pnl
      } else {
        grossLoss += Math.abs(pnl)
      }
      closedTrades += 1
      trades.push({
        time: candle.time,
        symbol: params.symbol,
        side: position < 0 ? 'BUY' : 'SELL',
        positionSide: position < 0 ? 'SHORT' : 'LONG',
        price: candle.close,
        quantity,
        pnl,
      })
      position = 0
      entryPrice = 0
      highestSinceEntry = 0
      lowestSinceEntry = 0
      entryIndex = -1
    }

    const equity = cash + (position !== 0 ? position * (candle.close - entryPrice) : 0)
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
    equityCurve.push({ time: candle.time, value: equity })
  }

  if (position !== 0 && lastRequestedCandle) {
    const quantity = Math.abs(position)
    const fee = quantity * lastRequestedCandle.close * params.feeRate
    const pnl = position * (lastRequestedCandle.close - entryPrice) - fee
    cash += pnl
    if (pnl > 0) {
      wins += 1
      grossProfit += pnl
    } else {
      grossLoss += Math.abs(pnl)
    }
    closedTrades += 1
    trades.push({
      time: lastRequestedCandle.time,
      symbol: params.symbol,
      side: position < 0 ? 'BUY' : 'SELL',
      positionSide: position < 0 ? 'SHORT' : 'LONG',
      price: lastRequestedCandle.close,
      quantity,
      pnl,
    })
    position = 0
    entryPrice = 0
    highestSinceEntry = 0
    lowestSinceEntry = 0
    entryIndex = -1
    if (equityCurve.length > 0) {
      equityCurve[equityCurve.length - 1] = { time: lastRequestedCandle.time, value: cash }
      peak = Math.max(peak, cash)
      maxDrawdown = Math.max(maxDrawdown, (peak - cash) / peak)
    }
  }

  const finalEquity = equityCurve[equityCurve.length - 1]?.value ?? params.initialCapital
  const totalReturn = (finalEquity - params.initialCapital) / params.initialCapital
  const daySpan = Math.max(1, (params.to - params.from) / 86_400_000)
  const annualizedReturn = Math.pow(1 + totalReturn, 365 / daySpan) - 1
  const returns = equityCurve.slice(1).map((item, index) => (item.value - equityCurve[index].value) / equityCurve[index].value)
  const avg = returns.reduce((sum, item) => sum + item, 0) / Math.max(1, returns.length)
  const variance = returns.reduce((sum, item) => sum + Math.pow(item - avg, 2), 0) / Math.max(1, returns.length)
  const sharpeRatio = variance > 0 ? (avg / Math.sqrt(variance)) * Math.sqrt(365) : 0

  return {
    source,
    initialCapital: params.initialCapital,
    leverage: {
      ...leverageInfo,
      value: effectiveLeverage,
    },
    candleCount: requestedCandles.length,
    range: {
      from: requestedCandles[0]?.time ?? params.from,
      to: requestedCandles[requestedCandles.length - 1]?.time ?? params.to,
    },
    metrics: {
      totalReturn,
      annualizedReturn,
      maxDrawdown,
      sharpeRatio,
      winRate: closedTrades > 0 ? wins / closedTrades : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0,
      trades: trades.length,
    },
    equityCurve: compactEquityCurve(equityCurve),
    trades,
  }
}

async function resolveBacktestLeverage(
  store: LocalStore,
  symbol: string,
  riskRules: RiskRuleSet,
): Promise<BacktestResult['leverage']> {
  const fallbackLeverage = Math.max(1, Math.min(125, Math.floor(riskRules.maxLeverage)))
  const profiles = store.snapshot().apiProfiles
  const profile = profiles.find((item) => item.canRead && item.status === 'connected' && item.environment === 'live')
    ?? profiles.find((item) => item.canRead && item.environment === 'live')
    ?? profiles.find((item) => item.canRead && item.status === 'connected')
    ?? profiles.find((item) => item.canRead)
  if (!profile) {
    return {
      value: fallbackLeverage,
      source: 'risk-rule',
      message: '未找到可读取 Binance 账户的 API，已使用全局风控最大杠杆。',
    }
  }

  const credentials = getCredentialsWithEnvironment(store, profile.id)
  if (!credentials) {
    return {
      value: fallbackLeverage,
      source: 'risk-rule',
      profileLabel: profile.label,
      message: 'API 凭据不可用，已使用全局风控最大杠杆。',
    }
  }

  try {
    const leverage = await getSymbolPositionLeverage(credentials, symbol)
    return {
      value: leverage.leverage,
      source: 'binance-position',
      profileLabel: profile.label,
      message: `${symbol} 当前 Binance 持仓杠杆 ${leverage.leverage}x。`,
    }
  } catch (error) {
    return {
      value: fallbackLeverage,
      source: 'risk-rule',
      profileLabel: profile.label,
      message: `读取 Binance 持仓杠杆失败，已使用全局风控最大杠杆：${String(error).replace(/^Error:\s*/, '')}`,
    }
  }
}

function resolveManualBacktestLeverage(value: number | undefined): BacktestResult['leverage'] | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined
  return {
    value: Math.max(1, Math.min(125, Math.floor(value))),
    source: 'manual',
    message: '本次回测使用手动设置的杠杆。',
  }
}

export function registerIpc(store: LocalStore, analytics?: AnalyticsStore): void {
  ipcMain.handle('app:snapshot', () => store.snapshot())

  ipcMain.handle('preferences:update', async (_event, patch) => store.updatePreferences(patch))

  ipcMain.handle('logs:clear', async (_event, filter?: LogClearFilter) => store.clearLogs(filter))

  ipcMain.handle('market:snapshot', async (_event, symbol: string, interval: CandleInterval) => {
    try {
      const snapshot = await getMarketSnapshot(symbol, interval)
      await analytics?.recordMarketSnapshot(snapshot)
      return snapshot
    } catch (error) {
      store.addLog('api', 'warn', `Binance REST 行情快照失败，实时流将继续尝试更新：${String(error).replace(/^Error:\s*/, '').slice(0, 180)}`)
      throw error
    }
  })

  ipcMain.handle('market:tickers', async (_event, symbols: string[]) => getTickers(symbols))

  ipcMain.handle('market:cache-history', async (_event, request: MarketDataCacheRequest) => {
    const candles = await getHistoricalKlines(request.symbol, request.interval, request.from, request.to)
    await analytics?.recordMarketCandles(request.symbol, request.interval, candles)
    store.addLog('api', 'info', `已缓存 ${request.symbol} ${request.interval} 历史行情 ${candles.length} 根到 DuckDB。`)
    await store.save()
    return {
      symbol: request.symbol,
      interval: request.interval,
      from: candles[0]?.time ?? request.from,
      to: candles[candles.length - 1]?.time ?? request.to,
      candles: candles.length,
      source: 'binance' as const,
    }
  })

  ipcMain.handle('api:add', async (_event, input: StoredApiInput) => store.addApiProfile(input))

  ipcMain.handle('api:test', async (_event, profileId: string) => {
    const snapshot = store.snapshot()
    const profile = snapshot.apiProfiles.find((item) => item.id === profileId)
    const credentials = getCredentialsWithEnvironment(store, profileId)
    if (!profile || !credentials) throw new Error('API 配置不存在')

    try {
      const result = await testCredentials(credentials, profile.tradePermissionRequested)
      const updated = {
        ...profile,
        ...result,
        status: 'connected' as const,
        withdrawWarning: true,
        lastCheckedAt: Date.now(),
        lastError: undefined,
      }
      await store.updateApiProfile(updated)
      store.addLog('api', 'info', `API「${profile.label}」连接测试成功，延迟 ${result.latencyMs}ms。`)
      return updated
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, '').slice(0, 220)
      const updated = {
        ...profile,
        canRead: false,
        status: 'error' as const,
        lastCheckedAt: Date.now(),
        lastError: message,
      }
      await store.updateApiProfile(updated)
      store.addLog('api', 'error', `API「${profile.label}」连接测试失败：${message}`)
      return updated
    }
  })

  ipcMain.handle('api:remove', async (_event, profileId: string) => {
    await store.removeApiProfile(profileId)
    return store.snapshot().apiProfiles
  })

  ipcMain.handle('api:ping', async () => {
    try {
      return await pingBinance()
    } catch (error) {
      return { latencyMs: 0, serverTime: Date.now(), error: String(error) }
    }
  })

  ipcMain.handle('account:fetch', async (_event, profileId: string) => {
    const credentials = getCredentialsWithEnvironment(store, profileId)
    if (!credentials) throw new Error('API 配置不存在')
    const account = await getFuturesAccount(credentials)
    await store.updatePositions(account.positions)
    if (account.assets.length > 0) {
      await store.updateAssets(account.assets)
      store.addLog('api', 'info', `已同步账户资产，余额资产 ${account.assets.length} 项，持仓 ${account.positions.length} 项。`)
      await store.save()
    }
    return account
  })

  ipcMain.handle('strategy:update', async (_event, strategies: StrategyConfig[]) => {
    const rules = store.snapshot().riskRules
    const guarded = strategies.map((strategy) => {
      if (strategy.status === 'running' && strategy.maxPositionRatio > rules.maxPositionRatio) {
        const riskEvent: RiskEvent = {
          id: crypto.randomUUID(),
          time: Date.now(),
          level: 'warning',
          strategyId: strategy.id,
          title: '策略启动风控拦截',
          message: `策略仓位 ${strategy.maxPositionRatio}% 超过全局限制 ${rules.maxPositionRatio}%。`,
        }
        store.addRiskEvent(riskEvent)
        return { ...strategy, status: 'tripped' as const, riskLevel: riskEvent.level }
      }
      if (strategy.status !== 'running' && strategy.status !== 'tripped' && strategy.pnl !== 0) {
        return { ...strategy, pnl: 0 }
      }
      return strategy
    })
    guarded.forEach((strategy) => {
      if (strategy.status === 'running') {
        store.addLog('strategy', 'info', `策略「${strategy.name}」进入运行状态。`, strategy.id)
      }
    })
    return store.upsertStrategies(guarded)
  })

  ipcMain.handle('risk:update-rules', async (_event, rules: RiskRuleSet) => store.updateRiskRules(rules))

  ipcMain.handle('risk:event', async (_event, event: Omit<RiskEvent, 'id' | 'time'>) => {
    const riskEvent: RiskEvent = { ...event, id: crypto.randomUUID(), time: Date.now() }
    store.addRiskEvent(riskEvent)
    if (riskEvent.strategyId && (riskEvent.level === 'warning' || riskEvent.level === 'danger')) {
      const snapshot = store.snapshot()
      const next = snapshot.strategies.map((strategy) =>
        strategy.id === riskEvent.strategyId ? { ...strategy, status: 'tripped' as const, riskLevel: riskEvent.level } : strategy,
      )
      await store.upsertStrategies(next)
    }
    await store.save()
    return riskEvent
  })

  ipcMain.handle('trade:place-order', async (_event, input: PlaceOrderInput) => {
    const snapshot = store.snapshot()
    const profile = snapshot.apiProfiles.find((item) => item.id === input.apiProfileId)
    const credentials = getCredentialsWithEnvironment(store, input.apiProfileId)
    if (!credentials && input.apiProfileId !== 'paper') throw new Error('API 配置不存在')
    if (input.quantity <= 0) throw new Error('下单数量必须大于 0')
    const strategy = snapshot.strategies.find((item) => item.id === input.strategyId)
    const rules = snapshot.riskRules
    const latestPrice = await getMarketSnapshot(input.symbol, '1m').then((snapshot) => snapshot.ticker.lastPrice)
    const notional = (input.type === 'LIMIT' ? input.price ?? latestPrice : latestPrice) * input.quantity
    if (notional <= 0) throw new Error('订单名义价值必须大于 0')
    if (notional > rules.dailyMaxLoss * 10_000) {
      const event: RiskEvent = {
        id: crypto.randomUUID(),
        time: Date.now(),
        level: 'warning',
        strategyId: strategy?.id,
        title: '下单前风控拦截',
        message: `订单名义价值 ${notional.toFixed(2)} USDT 超过当前单笔校验阈值。`,
      }
      store.addRiskEvent(event)
      if (strategy) {
        await store.upsertStrategies(
          snapshot.strategies.map((item) =>
            item.id === strategy.id ? { ...item, status: 'tripped' as const, riskLevel: event.level } : item,
          ),
        )
      }
      await store.save()
      throw new Error(event.message)
    }
    if (strategy && strategy.maxPositionRatio > rules.maxPositionRatio) {
      const event: RiskEvent = {
        id: crypto.randomUUID(),
        time: Date.now(),
        level: 'warning',
        strategyId: strategy.id,
        title: '下单前风控拦截',
        message: `策略仓位 ${strategy.maxPositionRatio}% 超过全局限制 ${rules.maxPositionRatio}%。`,
      }
      store.addRiskEvent(event)
      await store.upsertStrategies(
        snapshot.strategies.map((item) =>
          item.id === strategy.id ? { ...item, status: 'tripped' as const, riskLevel: event.level } : item,
        ),
      )
      await store.save()
      throw new Error(event.message)
    }
    if (!credentials || input.apiProfileId === 'paper') {
      return store.addOrder(makePaperOrder(input, latestPrice))
    }
    if (!profile?.canTrade) throw new Error('该 API 尚未通过交易权限检测，请先在 API 管理中测试。')
    try {
      const order = await placeFuturesOrder(credentials, input)
      return store.addOrder(order)
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, '')
      await store.addOrder(makeFailedOrder(input, latestPrice, message))
      throw error
    }
  })

  ipcMain.handle('backtest:run', async (_event, params: BacktestParams) => {
    const riskRules = store.snapshot().riskRules
    const scriptStrategies = params.strategyType === 'script'
      ? store.snapshot().strategies.filter((strategy) => strategy.type === 'script')
      : []
    const customStrategy = params.strategyType === 'script'
      ? params.strategyId
        ? scriptStrategies.find((strategy) => strategy.id === params.strategyId)
        : scriptStrategies[0]
      : undefined
    if (params.strategyType === 'script' && scriptStrategies.length === 0) {
      throw new Error('请先在策略管理创建并选择一个自定义脚本策略')
    }
    if (params.strategyType === 'script' && !customStrategy) {
      throw new Error('所选自定义脚本策略不存在，请重新选择')
    }
    const warmupFrom = Math.max(0, params.from - intervalMs[params.interval] * 80)
    let source: BacktestResult['source'] = 'duckdb'
    let candles = await analytics?.getMarketCandles(params.symbol, params.interval, warmupFrom, params.to) ?? []
    if (!analytics?.hasSufficientCoverage(candles, warmupFrom, params.to, intervalMs[params.interval])) {
      candles = await getHistoricalKlines(params.symbol, params.interval, warmupFrom, params.to)
      await analytics?.recordMarketCandles(params.symbol, params.interval, candles)
      source = 'binance'
    }
    const leverageInfo = resolveManualBacktestLeverage(params.leverage) ?? await resolveBacktestLeverage(store, params.symbol, riskRules)
    const result = await runNaiveBacktest(params, candles, source, customStrategy, leverageInfo)
    void analytics?.recordBacktest(params, result)
    store.addLog(
      'strategy',
      'info',
      `已使用 ${source === 'duckdb' ? 'DuckDB 本地缓存' : 'Binance 历史 K 线'} 完成 ${params.symbol} ${params.strategyType} 回测，杠杆 ${result.leverage.value}x（${result.leverage.source === 'manual' ? '手动设置' : result.leverage.source === 'binance-position' ? 'Binance 持仓接口' : '全局风控'}），区间样本 ${result.candleCount} 根，预热样本 ${Math.max(0, candles.length - result.candleCount)} 根，交易 ${result.metrics.trades} 笔。`,
    )
    await store.save()
    return result
  })
}
