export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export type StrategyStatus = 'running' | 'paused' | 'stopped' | 'tripped'

export type RiskLevel = 'normal' | 'watch' | 'warning' | 'danger'

export type OrderSide = 'BUY' | 'SELL'

export type OrderType = 'MARKET' | 'LIMIT'

export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | 'FAILED'

export type PositionSide = 'BOTH' | 'LONG' | 'SHORT'

export type BinanceEnvironment = 'live' | 'testnet'

export interface MarketTicker {
  symbol: string
  lastPrice: number
  priceChangePercent: number
  quoteVolume: number
  latencyMs: number
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface DepthLevel {
  price: number
  quantity: number
}

export interface TradeTick {
  id: number
  symbol?: string
  time: number
  price: number
  quantity: number
  side: OrderSide
}

export interface MarketSnapshot {
  symbol: string
  interval: CandleInterval
  ticker: MarketTicker
  candles: Candle[]
  bids: DepthLevel[]
  asks: DepthLevel[]
  quoteMidPrice?: number
  trades: TradeTick[]
  serverTime: number
  source: 'binance' | 'mock'
}

export interface ApiProfile {
  id: string
  exchange: 'Binance USD-M Futures'
  environment: BinanceEnvironment
  label: string
  apiKeyTail: string
  canRead: boolean
  canTrade: boolean
  tradePermissionRequested: boolean
  withdrawWarning: boolean
  latencyMs: number
  status: 'connected' | 'disconnected' | 'error'
  lastCheckedAt: number
  lastError?: string
}

export interface StoredApiInput {
  label: string
  apiKey: string
  apiSecret: string
  canTrade: boolean
  environment: BinanceEnvironment
}

export interface StrategyConfig {
  id: string
  name: string
  type: 'grid' | 'trend' | 'ma-cross' | 'multi-factor' | 'arbitrage' | 'script'
  symbol: string
  orderAmount: number
  maxPositionRatio: number
  takeProfitRatio: number
  stopLossRatio: number
  interval: CandleInterval
  slippageLimit: number
  status: StrategyStatus
  pnl: number
  runtimeMs: number
  riskLevel: RiskLevel
  customScript?: string
}

export interface RiskRuleSet {
  strategyMaxLoss: number
  dailyMaxLoss: number
  maxPositionRatio: number
  maxLeverage: number
  maxLossStreak: number
}

export interface RiskEvent {
  id: string
  time: number
  level: RiskLevel
  strategyId?: string
  title: string
  message: string
}

export interface AccountAsset {
  asset: string
  walletBalance: number
  availableBalance: number
  frozenBalance: number
  unrealizedPnl: number
  allocation: number
}

export interface AccountPosition {
  symbol: string
  positionSide: PositionSide
  positionAmount: number
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  leverage: number
  notional: number
  isolatedMargin: number
  marginType: 'cross' | 'isolated'
  updateTime: number
}

export interface FuturesAccountSnapshot {
  summary: {
    totalWalletBalance: number
    totalMarginBalance: number
    totalUnrealizedProfit: number
    totalCrossWalletBalance: number
    totalCrossUnPnl: number
    availableBalance: number
    maxWithdrawAmount: number
  }
  assets: AccountAsset[]
  positions: AccountPosition[]
}

export interface OrderRecord {
  id: string
  time: number
  symbol: string
  side: OrderSide
  positionSide?: PositionSide
  type: OrderType
  price: number
  quantity: number
  executedQuantity?: number
  status: OrderStatus
  strategyId?: string
  idempotencyKey: string
  failureReason?: string
}

export interface StrategyPosition {
  strategyId: string
  symbol: string
  positionAmount: number
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  updateTime: number
}

export interface BacktestParams {
  symbol: string
  interval: CandleInterval
  initialCapital: number
  feeRate: number
  from: number
  to: number
  strategyType: StrategyConfig['type']
  strategyId?: string
}

export interface MarketDataCacheRequest {
  symbol: string
  interval: CandleInterval
  from: number
  to: number
}

export interface MarketDataCacheResult {
  symbol: string
  interval: CandleInterval
  from: number
  to: number
  candles: number
  source: 'duckdb' | 'binance'
}

export interface UserSettings {
  requireActionConfirm: boolean
  autoPauseOnApiError: boolean
  enableTwoFactor: boolean
  defaultRunMode: 'paper' | 'live'
  notifyOnRiskEvent: boolean
  feishuNotifyEnabled: boolean
  feishuAppId: string
  feishuAppSecret: string
  feishuUserId: string
  feishuThreshold: number
  compactTableMode: boolean
}

export interface AppPreferences {
  selectedSymbol: string
  selectedInterval: CandleInterval
  watchlist: string[]
  liveMode: 'paper' | 'live'
  backtestParams: BacktestParams
  userSettings: UserSettings
}

export interface BacktestResult {
  source: 'binance' | 'duckdb' | 'mock'
  initialCapital: number
  leverage: {
    value: number
    source: 'binance-position' | 'risk-rule'
    profileLabel?: string
    message?: string
  }
  candleCount: number
  range: {
    from: number
    to: number
  }
  metrics: {
    totalReturn: number
    annualizedReturn: number
    maxDrawdown: number
    sharpeRatio: number
    winRate: number
    profitFactor: number
    trades: number
  }
  equityCurve: Array<{ time: number; value: number }>
  trades: Array<{
    time: number
    symbol: string
    side: OrderSide
    positionSide?: PositionSide
    price: number
    quantity: number
    pnl: number
  }>
}

export interface LogEntry {
  id: string
  time: number
  level: 'info' | 'warn' | 'error'
  scope: 'strategy' | 'trade' | 'risk' | 'api' | 'system'
  strategyId?: string
  message: string
}

export interface LogClearFilter {
  scope?: LogEntry['scope']
  strategyId?: string
}

export interface PlaceOrderInput {
  apiProfileId: string
  symbol: string
  side: OrderSide
  positionSide?: PositionSide
  type: OrderType
  quantity: number
  price?: number
  reduceOnly?: boolean
  strategyId?: string
  idempotencyKey: string
}

export interface AppStateSnapshot {
  preferences: AppPreferences
  strategies: StrategyConfig[]
  riskRules: RiskRuleSet
  riskEvents: RiskEvent[]
  assets: AccountAsset[]
  positions: AccountPosition[]
  strategyPositions: StrategyPosition[]
  orders: OrderRecord[]
  logs: LogEntry[]
  apiProfiles: ApiProfile[]
}
