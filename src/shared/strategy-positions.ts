import type { OrderRecord, StrategyPosition } from './types'

const fillStatuses = new Set<OrderRecord['status']>(['FILLED', 'PARTIALLY_FILLED'])

function positionKey(strategyId: string, symbol: string): string {
  return `${strategyId}::${symbol}`
}

function signedDelta(order: Pick<OrderRecord, 'side' | 'quantity' | 'executedQuantity'>): number {
  const quantity = Number.isFinite(order.executedQuantity) && (order.executedQuantity ?? 0) > 0
    ? order.executedQuantity!
    : order.quantity
  return order.side === 'BUY' ? quantity : -quantity
}

function positionSide(positionAmount: number): 'LONG' | 'SHORT' | 'BOTH' {
  if (positionAmount < 0) return 'SHORT'
  if (positionAmount > 0) return 'LONG'
  return 'BOTH'
}

function applyOrder(existing: StrategyPosition | undefined, order: OrderRecord): StrategyPosition | undefined {
  if (!order.strategyId || !fillStatuses.has(order.status)) return existing
  const delta = signedDelta(order)
  if (!Number.isFinite(delta) || delta === 0) return existing
  const current = existing ?? {
    strategyId: order.strategyId,
    symbol: order.symbol,
    positionAmount: 0,
    entryPrice: order.price > 0 ? order.price : 0,
    markPrice: order.price > 0 ? order.price : 0,
    unrealizedPnl: 0,
    updateTime: order.time,
  }

  const currentAmount = current.positionAmount
  const nextAmount = currentAmount + delta
  const orderPrice = order.price > 0 ? order.price : current.entryPrice
  if (nextAmount === 0) return undefined

  const sameDirection = currentAmount === 0 || Math.sign(currentAmount) === Math.sign(delta)
  const nextEntryPrice = sameDirection
    ? (currentAmount === 0
      ? orderPrice
      : ((Math.abs(currentAmount) * current.entryPrice) + (Math.abs(delta) * orderPrice)) / Math.abs(nextAmount))
    : Math.sign(nextAmount) === Math.sign(currentAmount)
      ? current.entryPrice
      : orderPrice

  return {
    ...current,
    strategyId: order.strategyId,
    symbol: order.symbol,
    positionAmount: nextAmount,
    entryPrice: nextEntryPrice,
    markPrice: orderPrice,
    unrealizedPnl: 0,
    updateTime: order.time,
  }
}

export function rebuildStrategyPositions(orders: OrderRecord[]): StrategyPosition[] {
  const positions = new Map<string, StrategyPosition>()
  const fillableOrders = orders
    .filter((order) => order.strategyId && fillStatuses.has(order.status))
    .slice()
    .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id))

  for (const order of fillableOrders) {
    const key = positionKey(order.strategyId!, order.symbol)
    const next = applyOrder(positions.get(key), order)
    if (next) {
      positions.set(key, next)
    } else {
      positions.delete(key)
    }
  }

  return [...positions.values()].sort((left, right) =>
    right.updateTime - left.updateTime ||
    left.strategyId.localeCompare(right.strategyId) ||
    left.symbol.localeCompare(right.symbol),
  )
}

export function applyStrategyOrder(positions: StrategyPosition[], order: OrderRecord): StrategyPosition[] {
  if (!order.strategyId || !fillStatuses.has(order.status)) return positions
  const key = positionKey(order.strategyId, order.symbol)
  const next = applyOrder(positions.find((item) => positionKey(item.strategyId, item.symbol) === key), order)
  const filtered = positions.filter((item) => positionKey(item.strategyId, item.symbol) !== key)
  if (!next) return filtered
  return [next, ...filtered].sort((left, right) =>
    right.updateTime - left.updateTime ||
    left.strategyId.localeCompare(right.strategyId) ||
    left.symbol.localeCompare(right.symbol),
  )
}

export function updateStrategyPositionMark(
  positions: StrategyPosition[],
  strategyId: string,
  symbol: string,
  markPrice: number,
): StrategyPosition[] {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return positions
  let changed = false
  const next = positions.map((position) => {
    if (position.strategyId !== strategyId || position.symbol !== symbol) return position
    changed = true
    return {
      ...position,
      markPrice,
      unrealizedPnl: (markPrice - position.entryPrice) * position.positionAmount,
      updateTime: Date.now(),
    }
  })
  return changed ? next.sort((left, right) =>
    right.updateTime - left.updateTime ||
    left.strategyId.localeCompare(right.strategyId) ||
    left.symbol.localeCompare(right.symbol),
  ) : positions
}

export function findStrategyPosition(positions: StrategyPosition[], strategyId: string, symbol: string): StrategyPosition | undefined {
  return positions.find((position) => position.strategyId === strategyId && position.symbol === symbol)
}

export function strategyPositionSide(position?: Pick<StrategyPosition, 'positionAmount'>): 'LONG' | 'SHORT' | 'BOTH' {
  return positionSide(position?.positionAmount ?? 0)
}

export function calculateStrategyUnrealizedPnl(position: Pick<StrategyPosition, 'entryPrice' | 'positionAmount'>, markPrice: number): number {
  if (!Number.isFinite(markPrice)) return 0
  return (markPrice - position.entryPrice) * position.positionAmount
}
