import crypto from 'node:crypto'
import {
  getFuturesAccount,
  getKlines,
  getSymbolTradeRules,
  isBinanceRateLimitBan,
  placeFuturesOrder,
  setSymbolLeverage,
  type Credentials,
} from './binance'
import type { LocalStore } from './store'
import type {
  AccountPosition,
  Candle,
  OrderRecord,
  OrderSide,
  RiskEvent,
  StrategyConfig,
} from '../shared/types'
import {
  buildSignalContext,
  evalScriptExpression,
  parseScriptRules,
  type ScriptRules,
  type SignalContext,
} from '../shared/script-signals'

const intervalMs: Record<StrategyConfig['interval'], number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

function latestClosedCandleIndex(candles: Candle[], interval: StrategyConfig['interval']): number {
  const now = Date.now()
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (candles[index].time + intervalMs[interval] <= now) return index
  }
  return -1
}

function roundDownStep(value: number, stepSize: number, precision: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  const step = stepSize > 0 ? stepSize : Math.pow(10, -precision)
  const rounded = Math.floor(value / step) * step
  return Number(rounded.toFixed(Math.max(0, precision)))
}

function normalizeLeverage(value: number): number {
  return Math.max(1, Math.min(125, Math.floor(Number.isFinite(value) ? value : 1)))
}

function idempotencyKey(strategyId: string, side: OrderSide, candleTime: number): string {
  const digest = crypto.createHash('sha256').update(`${strategyId}:${side}:${candleTime}`).digest('hex').slice(0, 24)
  return `st_${digest}`
}

type SignalEvaluation = {
  shouldLong: boolean
  shouldCloseLong: boolean
  shouldShort: boolean
  shouldCloseShort: boolean
  positionRatio: number
}

type RuleNode =
  | { type: 'leaf'; expression: string }
  | { type: 'and' | 'or'; children: RuleNode[] }

const percentLikeNames = new Set([
  'candleReturn',
  'momentum',
  'momentum3',
  'momentum5',
  'momentum12',
  'momentum20',
  'volatility',
  'atrPct',
  'trueRangePct',
  'unrealizedPnlPct',
  'drawdownSinceEntry',
  'positionRatio',
])

function stripOuterParens(expression: string): string {
  let next = expression.trim()
  while (next.startsWith('(') && next.endsWith(')')) {
    let depth = 0
    let wrapsAll = true
    for (let index = 0; index < next.length; index += 1) {
      const char = next[index]
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (depth === 0 && index < next.length - 1) {
        wrapsAll = false
        break
      }
    }
    if (!wrapsAll) break
    next = next.slice(1, -1).trim()
  }
  return next
}

function splitTopLevel(expression: string, operator: '&&' | '||'): string[] {
  const parts: string[] = []
  let depth = 0
  let lastIndex = 0
  for (let index = 0; index < expression.length - 1; index += 1) {
    const char = expression[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (depth === 0 && expression.slice(index, index + 2) === operator) {
      parts.push(expression.slice(lastIndex, index).trim())
      lastIndex = index + 2
      index += 1
    }
  }
  const tail = expression.slice(lastIndex).trim()
  if (parts.length === 0) return [expression.trim()]
  parts.push(tail)
  return parts.filter(Boolean)
}

function parseRuleTree(expression: string): RuleNode {
  const trimmed = stripOuterParens(expression)
  const orParts = splitTopLevel(trimmed, '||')
  if (orParts.length > 1) return { type: 'or', children: orParts.map(parseRuleTree) }
  const andParts = splitTopLevel(trimmed, '&&')
  if (andParts.length > 1) return { type: 'and', children: andParts.map(parseRuleTree) }
  return { type: 'leaf', expression: trimmed }
}

function splitComparisonExpression(expression: string): { left: string; operator: string; right: string } | undefined {
  const operators = ['===', '!==', '>=', '<=', '==', '!=', '>', '<']
  let depth = 0
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (depth !== 0) continue
    const operator = operators.find((item) => expression.slice(index, index + item.length) === item)
    if (!operator) continue
    return {
      left: expression.slice(0, index).trim(),
      operator,
      right: expression.slice(index + operator.length).trim(),
    }
  }
  return undefined
}

export class StrategyExecutionEngine {
  private timer: NodeJS.Timeout | undefined
  private running = false
  private readonly inFlight = new Set<string>()
  private readonly lastCandleByStrategy = new Map<string, number>()
  private readonly entryCandleByStrategy = new Map<string, number>()
  private readonly lastPositionByStrategy = new Map<string, string>()
  private readonly notices = new Set<string>()

  constructor(private readonly store: LocalStore) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 10_000)
    void this.tick()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const snapshot = this.store.snapshot()
      if (snapshot.preferences.liveMode !== 'live') return

      const runningStrategies = snapshot.strategies.filter((strategy) => strategy.status === 'running')
      for (const strategy of runningStrategies) {
        await this.executeStrategy(strategy)
      }
    } finally {
      this.running = false
    }
  }

  private async executeStrategy(strategy: StrategyConfig): Promise<void> {
    if (this.inFlight.has(strategy.id)) return
    this.inFlight.add(strategy.id)
    try {
      if (strategy.type !== 'script') {
        await this.noticeOnce(`skip:${strategy.id}`, `策略「${strategy.name}」暂未接入自动实盘执行：当前仅自动执行自定义脚本策略。`, strategy.id)
        return
      }

      const snapshot = this.store.snapshot()
      const rules = snapshot.riskRules
      if (strategy.maxPositionRatio > rules.maxPositionRatio) {
        await this.tripStrategy(strategy, 'warning', '策略执行风控拦截', `策略仓位 ${strategy.maxPositionRatio}% 超过全局限制 ${rules.maxPositionRatio}%。`)
        return
      }

      const profile = snapshot.apiProfiles.find((item) => item.canTrade && item.status === 'connected') ?? snapshot.apiProfiles.find((item) => item.canTrade)
      if (!profile) {
        await this.noticeOnce('missing-live-api', '实盘策略执行器未找到已通过交易权限检测的 API，已跳过自动下单。请到 API 管理添加/选择合约 API，勾选交易权限，并点击“测试”确认交易权限通过。')
        return
      }

      const credentials = this.credentialsFor(profile.id, profile.environment)
      if (!credentials) {
        await this.noticeOnce(`missing-credentials:${profile.id}`, `API「${profile.label}」凭据不可用，策略执行器已跳过自动下单。`)
        return
      }

      const account = await getFuturesAccount(credentials)
      await this.store.updatePositions(account.positions)
      const currentPosition = this.findStrategyPosition(account.positions, strategy.symbol)
      await this.syncExternalPositionState(strategy, currentPosition)
      await this.syncStrategyPnl(strategy, currentPosition?.unrealizedPnl ?? 0)

      if (currentPosition && currentPosition.leverage > rules.maxLeverage) {
        await this.tripStrategy(strategy, 'warning', '持仓杠杆风控触发', `当前 ${strategy.symbol} 杠杆 ${currentPosition.leverage}x 超过全局限制 ${rules.maxLeverage}x。`)
        return
      }

      if (currentPosition && currentPosition.unrealizedPnl < -Math.max(1, account.summary.totalWalletBalance) * (rules.strategyMaxLoss / 100)) {
        await this.tripStrategy(strategy, 'danger', '单策略亏损风控触发', `${strategy.symbol} 未实现亏损 ${currentPosition.unrealizedPnl.toFixed(2)} USDT 超过阈值。`)
        return
      }

      const candles = await getKlines(strategy.symbol, strategy.interval, 140, profile.environment)
      const index = latestClosedCandleIndex(candles, strategy.interval)
      if (index < 60) return
      const candle = candles[index]
      if (this.lastCandleByStrategy.get(strategy.id) === candle.time) return

      const entryCandleTime = this.entryCandleByStrategy.get(strategy.id)
      const currentPositionSide = currentPosition ? this.positionSideNumber(currentPosition) : 0
      const latestBuyOrderTime = currentPosition
        ? snapshot.orders.find((order) =>
            order.strategyId === strategy.id &&
            order.symbol === strategy.symbol &&
            order.side === (currentPositionSide < 0 ? 'SELL' : 'BUY')
          )?.time
        : undefined
      const inferredEntryCandleTime = currentPosition
        ? this.inferEntryCandleTime(candles, latestBuyOrderTime || currentPosition.updateTime || 0, strategy.interval)
        : undefined
      const effectiveEntryCandleTime = entryCandleTime ?? inferredEntryCandleTime
      const entryIndex = effectiveEntryCandleTime === undefined ? undefined : candles.findIndex((item) => item.time === effectiveEntryCandleTime)
      const context = buildSignalContext(candles, index, {
        entryPrice: currentPosition ? this.resolveEntryPrice(currentPosition, candle.close) : undefined,
        position: currentPosition ? Math.abs(currentPosition.positionAmount) * currentPositionSide : undefined,
        entryIndex: entryIndex !== undefined && entryIndex >= 0 ? entryIndex : undefined,
      })
      const script = parseScriptRules(strategy.customScript, {
        buy: 'false',
        sell: 'false',
        long: 'false',
        closeLong: 'false',
        short: 'false',
        closeShort: 'false',
        position: '0.1',
      })
      const shouldLong = Boolean(evalScriptExpression(script.long, context))
      const shouldCloseLong = Boolean(evalScriptExpression(script.closeLong, context))
      const shouldShort = Boolean(evalScriptExpression(script.short, context))
      const shouldCloseShort = Boolean(evalScriptExpression(script.closeShort, context))
      const leverage = normalizeLeverage(rules.maxLeverage)
      const positionRatio = Math.min(
        Math.max(Number(evalScriptExpression(script.position, context)), 0),
        strategy.maxPositionRatio / 100,
        rules.maxPositionRatio / 100,
      )
      await this.recordSignalDiagnostics(
        strategy,
        candle,
        script,
        context,
        {
          shouldLong,
          shouldCloseLong,
          shouldShort,
          shouldCloseShort,
          positionRatio,
        },
        currentPosition,
        currentPositionSide,
      )

      if (currentPosition && currentPositionSide > 0 && shouldCloseLong) {
        await this.placeReduceOnlyOrder(strategy, credentials, profile.id, currentPosition, 'SELL', 'LONG', candle.time)
        this.entryCandleByStrategy.delete(strategy.id)
      } else if (currentPosition && currentPositionSide < 0 && shouldCloseShort) {
        await this.placeReduceOnlyOrder(strategy, credentials, profile.id, currentPosition, 'BUY', 'SHORT', candle.time)
        this.entryCandleByStrategy.delete(strategy.id)
      } else if (!currentPosition && shouldLong) {
        await this.placeOpenOrder(strategy, credentials, profile.id, account.summary.availableBalance, context.close, positionRatio, leverage, 'BUY', 'LONG', candle.time)
        this.entryCandleByStrategy.set(strategy.id, candle.time)
      } else if (!currentPosition && shouldShort) {
        await this.placeOpenOrder(strategy, credentials, profile.id, account.summary.availableBalance, context.close, positionRatio, leverage, 'SELL', 'SHORT', candle.time)
        this.entryCandleByStrategy.set(strategy.id, candle.time)
      }

      this.lastCandleByStrategy.set(strategy.id, candle.time)
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, '')
      if (isBinanceRateLimitBan(error)) {
        await this.noticeOnce(
          `binance-rate-limit:${strategy.id}`,
          `策略「${strategy.name}」遇到 Binance REST 限频/封禁，已暂停本轮执行但不自动暂停策略：${message}`,
          strategy.id,
        )
        return
      }
      const snapshot = this.store.snapshot()
      if (snapshot.preferences.userSettings.autoPauseOnApiError) {
        await this.tripStrategy(strategy, 'warning', '策略执行异常自动暂停', message)
      } else {
        this.store.addLog('strategy', 'error', `策略「${strategy.name}」执行失败：${message}`, strategy.id)
        await this.store.save()
      }
    } finally {
      this.inFlight.delete(strategy.id)
    }
  }

  private credentialsFor(profileId: string, environment: Credentials['environment']): Credentials | undefined {
    const credentials = this.store.getCredentials(profileId)
    if (!credentials) return undefined
    return { ...credentials, environment }
  }

  private async placeOpenOrder(
    strategy: StrategyConfig,
    credentials: Credentials,
    apiProfileId: string,
    availableBalance: number,
    close: number,
    positionRatio: number,
    leverage: number,
    side: OrderSide,
    positionSide: AccountPosition['positionSide'],
    candleTime: number,
  ): Promise<void> {
    const key = idempotencyKey(strategy.id, side, candleTime)
    if (this.store.snapshot().orders.some((order) => order.idempotencyKey === key)) return
    const leverageResult = await setSymbolLeverage(credentials, strategy.symbol, leverage)
    const effectiveLeverage = normalizeLeverage(leverageResult.leverage)
    const tradeRules = await getSymbolTradeRules(strategy.symbol, credentials.environment)
    const targetMargin = Number.isFinite(strategy.orderAmount) && strategy.orderAmount > 0 ? strategy.orderAmount : availableBalance * positionRatio
    const maxMargin = availableBalance * positionRatio
    const margin = Math.min(targetMargin, maxMargin)
    const targetNotional = targetMargin * effectiveLeverage
    const maxNotional = maxMargin * effectiveLeverage
    const notional = margin * effectiveLeverage
    if (notional < tradeRules.minNotional) {
      await this.noticeOnce(
        `min-notional:${strategy.id}`,
        `策略「${strategy.name}」开仓名义价值 ${notional.toFixed(2)} USDT 小于最小交易额 ${tradeRules.minNotional}。目标保证金 ${targetMargin.toFixed(2)} USDT，${effectiveLeverage}x 杠杆目标名义价值 ${targetNotional.toFixed(2)} USDT，仓位上限 ${(
          positionRatio * 100
        ).toFixed(1)}% 可用保证金 ${maxMargin.toFixed(2)} USDT，对应名义上限 ${maxNotional.toFixed(2)} USDT。`,
        strategy.id,
      )
      return
    }
    const quantity = roundDownStep(notional / close, tradeRules.stepSize, tradeRules.quantityPrecision)
    if (quantity < tradeRules.minQty || quantity <= 0) {
      await this.noticeOnce(
        `min-qty:${strategy.id}`,
        `策略「${strategy.name}」计算得到的开仓数量 ${quantity} 小于最小下单数量 ${tradeRules.minQty}，已跳过开仓。目标保证金 ${targetMargin.toFixed(2)} USDT，${effectiveLeverage}x 杠杆后实际名义价值 ${notional.toFixed(
          2,
        )} USDT。`,
        strategy.id,
      )
      return
    }
    const order = await placeFuturesOrder(credentials, {
      apiProfileId,
      symbol: strategy.symbol,
      side,
      positionSide,
      type: 'MARKET',
      quantity,
      strategyId: strategy.id,
      idempotencyKey: key,
    })
    await this.recordOrder(
      strategy,
      order,
      `${positionSide} 信号触发，目标保证金 ${targetMargin.toFixed(2)} USDT，${effectiveLeverage}x 杠杆后实际名义价值 ${notional.toFixed(2)} USDT，仓位上限 ${(positionRatio * 100).toFixed(
        1,
      )}% 可用保证金。`,
    )
  }

  private async placeReduceOnlyOrder(
    strategy: StrategyConfig,
    credentials: Credentials,
    apiProfileId: string,
    position: AccountPosition,
    side: OrderSide,
    positionSide: AccountPosition['positionSide'],
    candleTime: number,
  ): Promise<void> {
    const tradeRules = await getSymbolTradeRules(strategy.symbol, credentials.environment)
    const quantity = roundDownStep(Math.abs(position.positionAmount), tradeRules.stepSize, tradeRules.quantityPrecision)
    const key = `${idempotencyKey(strategy.id, side, candleTime)}:${quantity}`
    if (this.store.snapshot().orders.some((order) => order.idempotencyKey === key)) return
    if (quantity < tradeRules.minQty || quantity <= 0) {
      await this.noticeOnce(`close-min-qty:${strategy.id}`, `策略「${strategy.name}」平仓数量 ${quantity} 小于最小下单数量 ${tradeRules.minQty}，已跳过平仓。`, strategy.id)
      return
    }
    const order = await placeFuturesOrder(credentials, {
      apiProfileId,
      symbol: strategy.symbol,
      side,
      positionSide,
      type: 'MARKET',
      quantity,
      reduceOnly: true,
      strategyId: strategy.id,
      idempotencyKey: key,
    })
    await this.recordOrder(strategy, order, `${positionSide} 平仓信号触发，已使用 reduceOnly 平仓。`)
  }

  private findStrategyPosition(positions: AccountPosition[], symbol: string): AccountPosition | undefined {
    return positions.find(
      (position) =>
        position.symbol === symbol &&
        Math.abs(position.positionAmount) > 0 &&
        (position.positionSide === 'BOTH' || position.positionSide === 'LONG' || position.positionSide === 'SHORT'),
    )
  }

  private positionSideNumber(position: AccountPosition): number {
    if (position.positionSide === 'SHORT') return -1
    if (position.positionSide === 'LONG') return 1
    return position.positionAmount < 0 ? -1 : 1
  }

  private resolveEntryPrice(position: AccountPosition, fallbackPrice: number): number {
    if (position.entryPrice > 0) return position.entryPrice
    if (position.positionAmount !== 0 && position.notional !== 0) return Math.abs(position.notional / position.positionAmount)
    return fallbackPrice
  }

  private formatPercent(value: number, digits = 2): string {
    return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--'
  }

  private formatValue(value: number, digits = 4): string {
    return Number.isFinite(value) ? value.toFixed(digits) : '--'
  }

  private inferSignalName(expression: string, context: SignalContext): string | undefined {
    const tokens = expression.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
    return tokens.find((token) => Object.prototype.hasOwnProperty.call(context, token))
  }

  private formatOperandValue(expression: string, value: number | boolean, context: SignalContext, hintName?: string): string {
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (!Number.isFinite(value)) return '--'
    const signalName = this.inferSignalName(expression, context) ?? hintName
    if (signalName && percentLikeNames.has(signalName)) return this.formatPercent(value)
    if (signalName === 'rsi14') return this.formatValue(value, 2)
    if (signalName && ['volumeRatio', 'bbPctB', 'bbWidth', 'channelWidth', 'closeLocation', 'bodyPct', 'upperShadowPct', 'lowerShadowPct', 'rangePct', 'factorScore'].includes(signalName)) {
      return this.formatValue(value, 2)
    }
    return this.formatValue(value, 4)
  }

  private compareOperands(left: number | boolean, right: number | boolean, operator: string): boolean {
    switch (operator) {
      case '>':
        return Number(left) > Number(right)
      case '<':
        return Number(left) < Number(right)
      case '>=':
        return Number(left) >= Number(right)
      case '<=':
        return Number(left) <= Number(right)
      case '==':
      case '===':
        return left === right
      case '!=':
      case '!==':
        return left !== right
      default:
        return false
    }
  }

  private invertOperator(operator: string): string {
    switch (operator) {
      case '>':
        return '<='
      case '<':
        return '>='
      case '>=':
        return '<'
      case '<=':
        return '>'
      case '==':
      case '===':
        return '!='
      case '!=':
      case '!==':
        return '=='
      default:
        return operator
    }
  }

  private renderRuleNode(node: RuleNode, context: SignalContext, parentType?: RuleNode['type']): string {
    if (node.type === 'leaf') return this.renderRuleLeaf(node.expression, context)
    const separator = node.type === 'or' ? ' ｜ ' : '；'
    const rendered = node.children.map((child) => {
      const text = this.renderRuleNode(child, context, node.type)
      return child.type !== 'leaf' && child.type !== node.type ? `(${text})` : text
    })
    const joined = rendered.join(separator)
    return parentType && parentType !== node.type ? `(${joined})` : joined
  }

  private renderRuleLeaf(expression: string, context: SignalContext): string {
    const trimmed = stripOuterParens(expression)
    const comparison = splitComparisonExpression(trimmed)
    if (!comparison) {
      const result = Boolean(evalScriptExpression(trimmed, context))
      return `${trimmed} ${result ? '✓' : '✗'}`
    }
    const leftValue = evalScriptExpression(comparison.left, context)
    const rightValue = evalScriptExpression(comparison.right, context)
    const satisfied = this.compareOperands(leftValue, rightValue, comparison.operator)
    const displayOperator = satisfied ? comparison.operator : this.invertOperator(comparison.operator)
    const hintName = this.inferSignalName(comparison.left, context) ?? this.inferSignalName(comparison.right, context)
    const leftDisplay = this.formatOperandValue(comparison.left, leftValue, context, hintName)
    const rightDisplay = this.formatOperandValue(comparison.right, rightValue, context, hintName)
    return `${trimmed} ${satisfied ? '✓' : '✗'}（当前 ${leftDisplay} ${displayOperator} ${rightDisplay}）`
  }

  private describeRuleBreakdown(label: string, expression: string, context: SignalContext): string {
    return `${label}条件：${this.renderRuleNode(parseRuleTree(expression), context)}`
  }

  private summarizeSignalContext(context: SignalContext): string {
    return [
      `close=${this.formatValue(context.close, 4)}`,
      `candleReturn=${this.formatPercent(context.candleReturn)}`,
      `momentum3=${this.formatPercent(context.momentum3)}`,
      `momentum5=${this.formatPercent(context.momentum5)}`,
      `rsi14=${this.formatValue(context.rsi14, 2)}`,
      `ma20=${this.formatValue(context.ma20, 4)}`,
      `ma60=${this.formatValue(context.ma60, 4)}`,
      `ma120=${this.formatValue(context.ma120, 4)}`,
      `atrPct=${this.formatPercent(context.atrPct)}`,
      `volumeRatio=${this.formatValue(context.volumeRatio, 2)}`,
      `bbPctB=${this.formatValue(context.bbPctB, 2)}`,
      `unrealizedPnlPct=${this.formatPercent(context.unrealizedPnlPct)}`,
      `drawdownSinceEntry=${this.formatPercent(context.drawdownSinceEntry)}`,
    ].join('；')
  }

  private describeEntryBlockReason(
    currentPosition: AccountPosition | undefined,
    currentPositionSide: number,
    shouldLong: boolean,
    shouldShort: boolean,
    positionRatio: number,
  ): string {
    if (currentPosition) return `已有 ${currentPositionSide < 0 ? 'SHORT' : 'LONG'} 持仓，等待平仓条件`
    if (!Number.isFinite(positionRatio) || positionRatio <= 0) return '仓位比例为 0 或无效'
    if (!shouldLong && !shouldShort) return 'LONG/SHORT 均未满足'
    if (shouldLong && shouldShort) return 'LONG/SHORT 同时满足，按 LONG 优先'
    return shouldLong ? 'LONG 满足，等待开多' : 'SHORT 满足，等待开空'
  }

  private async recordSignalDiagnostics(
    strategy: StrategyConfig,
    candle: Candle,
    rules: ScriptRules,
    context: SignalContext,
    evaluation: SignalEvaluation,
    currentPosition: AccountPosition | undefined,
    currentPositionSide: number,
  ): Promise<void> {
    const stateSummary = [
      `LONG=${evaluation.shouldLong ? '满足' : '未满足'}`,
      `SHORT=${evaluation.shouldShort ? '满足' : '未满足'}`,
      `CLOSE_LONG=${evaluation.shouldCloseLong ? '满足' : '未满足'}`,
      `CLOSE_SHORT=${evaluation.shouldCloseShort ? '满足' : '未满足'}`,
      `POSITION=${this.formatPercent(evaluation.positionRatio)}`,
    ].join('，')
    const reason = this.describeEntryBlockReason(
      currentPosition,
      currentPositionSide,
      evaluation.shouldLong,
      evaluation.shouldShort,
      evaluation.positionRatio,
    )
    const breakdown = [
      this.describeRuleBreakdown('LONG', rules.long, context),
      this.describeRuleBreakdown('SHORT', rules.short, context),
      this.describeRuleBreakdown('CLOSE_LONG', rules.closeLong, context),
      this.describeRuleBreakdown('CLOSE_SHORT', rules.closeShort, context),
    ].join('；')
    const message = `信号诊断 ${strategy.symbol} ${strategy.interval} ${new Date(candle.time).toLocaleString('zh-CN')}：${stateSummary}；未开仓原因：${reason}；${breakdown}；关键指标：${this.summarizeSignalContext(context)}`
    const level = !evaluation.shouldLong && !evaluation.shouldShort && !evaluation.shouldCloseLong && !evaluation.shouldCloseShort ? 'warn' : 'info'
    this.store.addLog('strategy', level, message, strategy.id)
    await this.store.save()
  }

  private async recordOrder(strategy: StrategyConfig, order: OrderRecord, message: string): Promise<void> {
    await this.store.addOrder(order)
    this.store.addLog('strategy', 'info', `策略「${strategy.name}」自动下单：${message}`, strategy.id)
    await this.store.save()
  }

  private inferEntryCandleTime(candles: Candle[], updateTime: number, interval: StrategyConfig['interval']): number | undefined {
    if (!Number.isFinite(updateTime) || updateTime <= 0) return undefined
    const entryTime = updateTime - intervalMs[interval]
    for (let index = candles.length - 1; index >= 0; index -= 1) {
      if (candles[index].time <= entryTime) return candles[index].time
    }
    return candles[0]?.time
  }

  private async syncStrategyPnl(strategy: StrategyConfig, pnl: number): Promise<void> {
    if (!Number.isFinite(pnl) || Math.abs((strategy.pnl ?? 0) - pnl) < 0.005) return
    const snapshot = this.store.snapshot()
    await this.store.upsertStrategies(
      snapshot.strategies.map((item) => (item.id === strategy.id ? { ...item, pnl } : item)),
    )
  }

  private positionSignature(position: AccountPosition | undefined): string {
    if (!position || Math.abs(position.positionAmount) <= 0) return 'flat'
    return [
      position.symbol,
      position.positionSide,
      position.positionAmount.toFixed(8),
      position.entryPrice.toFixed(8),
      position.leverage,
    ].join(':')
  }

  private async syncExternalPositionState(strategy: StrategyConfig, position: AccountPosition | undefined): Promise<void> {
    const signature = this.positionSignature(position)
    const previous = this.lastPositionByStrategy.get(strategy.id)
    if (previous === signature) return
    this.lastPositionByStrategy.set(strategy.id, signature)
    if (!previous && signature === 'flat') return
    if (signature === 'flat') {
      this.store.addLog('strategy', 'info', `策略「${strategy.name}」已同步交易所仓位：${strategy.symbol} 当前无持仓。`, strategy.id)
    } else if (position) {
      const side = position.positionSide === 'BOTH' ? (position.positionAmount < 0 ? 'SHORT' : 'LONG') : position.positionSide
      this.store.addLog(
        'strategy',
        'info',
        `策略「${strategy.name}」已同步交易所当前持仓：${strategy.symbol} ${side} ${Math.abs(position.positionAmount).toFixed(6)}，均价 ${this.formatValue(this.resolveEntryPrice(position, 0), 4)}，后续平仓将按当前仓位 reduceOnly 执行。`,
        strategy.id,
      )
    }
    await this.store.save()
  }

  private async tripStrategy(strategy: StrategyConfig, level: RiskEvent['level'], title: string, message: string): Promise<void> {
    const snapshot = this.store.snapshot()
    this.store.addRiskEvent({
      id: crypto.randomUUID(),
      time: Date.now(),
      level,
      strategyId: strategy.id,
      title,
      message,
    })
    this.store.addLog('strategy', level === 'danger' ? 'error' : 'warn', `策略「${strategy.name}」${title}：${message}`, strategy.id)
    await this.store.upsertStrategies(
      snapshot.strategies.map((item) =>
        item.id === strategy.id ? { ...item, status: 'tripped' as const, riskLevel: level } : item,
      ),
    )
    await this.store.save()
  }

  private async noticeOnce(key: string, message: string, strategyId?: string): Promise<void> {
    if (this.notices.has(key)) return
    this.notices.add(key)
    this.store.addLog('strategy', 'warn', message, strategyId)
    await this.store.save()
  }
}
