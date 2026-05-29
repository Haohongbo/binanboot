import type { QuantApi } from '../../../preload'
import type {
  AccountAsset,
  AccountPosition,
  AppStateSnapshot,
  BacktestParams,
  BacktestResult,
  Candle,
  CandleInterval,
  DepthLevel,
  FuturesAccountSnapshot,
  MarketSnapshot,
  OrderRecord,
  PlaceOrderInput,
  RiskEvent,
  TradeTick,
} from '../../../shared/types'
import type { AppStatePatch } from '../../../shared/app-state-events'
import type { AppUpdateState } from '../../../shared/updates'
import { DEFAULT_WATCHLIST } from '../../../shared/market-symbols'
import { useQuantStore } from '../store'

const intervalMs: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

const seedSnapshot: AppStateSnapshot = {
  preferences: {
    selectedSymbol: 'BTCUSDT',
    selectedInterval: '1d',
    watchlist: DEFAULT_WATCHLIST,
    liveMode: 'paper',
    backtestParams: {
      symbol: 'BTCUSDT',
      interval: '1h',
      initialCapital: 100_000,
      feeRate: 0.0004,
      from: Date.now() - 180 * 86_400_000,
      to: Date.now(),
      strategyType: 'ma-cross',
    },
    userSettings: {
      requireActionConfirm: true,
      autoPauseOnApiError: true,
      enableTwoFactor: false,
      defaultRunMode: 'paper',
      notifyOnRiskEvent: true,
      feishuNotifyEnabled: false,
      feishuAppId: '',
      feishuAppSecret: '',
      feishuUserId: '',
      feishuThreshold: 4,
      compactTableMode: false,
    },
  },
  strategies: [
    {
      id: 'grid-btc-core',
      name: 'BTC 网格核心策略',
      type: 'grid',
      symbol: 'BTCUSDT',
      orderAmount: 120,
      maxPositionRatio: 25,
      takeProfitRatio: 1.2,
      stopLossRatio: 3.5,
      interval: '5m',
      slippageLimit: 0.18,
      status: 'running',
      pnl: 1284.35,
      runtimeMs: 12 * 86_400_000 + 4 * 3_600_000,
      riskLevel: 'normal',
    },
    {
      id: 'trend-eth-swing',
      name: 'ETH 趋势跟踪',
      type: 'trend',
      symbol: 'ETHUSDT',
      orderAmount: 90,
      maxPositionRatio: 18,
      takeProfitRatio: 2.2,
      stopLossRatio: 2.8,
      interval: '15m',
      slippageLimit: 0.2,
      status: 'running',
      pnl: 862.11,
      runtimeMs: 7 * 86_400_000 + 18 * 3_600_000,
      riskLevel: 'normal',
    },
    {
      id: 'ma-sol-fast',
      name: 'SOL 均线交叉',
      type: 'ma-cross',
      symbol: 'SOLUSDT',
      orderAmount: 60,
      maxPositionRatio: 12,
      takeProfitRatio: 1.8,
      stopLossRatio: 2.4,
      interval: '1m',
      slippageLimit: 0.28,
      status: 'paused',
      pnl: -156.32,
      runtimeMs: 3 * 86_400_000,
      riskLevel: 'watch',
    },
  ],
  riskRules: {
    strategyMaxLoss: 5,
    dailyMaxLoss: 8,
    maxPositionRatio: 35,
    maxLeverage: 5,
    maxLossStreak: 4,
  },
  riskEvents: [
    {
      id: 'risk-browser-startup',
      time: Date.now() - 540_000,
      level: 'normal',
      title: '风控引擎已启动',
      message: '基础仓位、亏损、杠杆和连续亏损规则已加载。',
    },
  ],
  assets: [],
  positions: [],
  strategyPositions: [],
  orders: [],
  logs: [
    {
      id: 'log-browser-seed',
      time: Date.now() - 320_000,
      level: 'info',
      scope: 'system',
      message: '浏览器预览模式已启用，本地模拟 API 正在提供控制台数据。',
    },
  ],
  apiProfiles: [],
}

const browserUpdateState: AppUpdateState = {
  phase: 'idle',
  currentVersion: '0.1.0',
  isPackaged: false,
  message: '浏览器预览模式不会连接 GitHub 更新源。',
  updatedAt: Date.now(),
}

function randomId(): string {
  if ('crypto' in window && 'randomUUID' in window.crypto) return window.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function cloneSnapshot(snapshot: AppStateSnapshot): AppStateSnapshot {
  return structuredClone(snapshot)
}

function basePrice(symbol: string): number {
  if (symbol.startsWith('BTC')) return 67_284
  if (symbol.startsWith('ETH')) return 3_642
  if (symbol.startsWith('SOL')) return 152
  if (symbol.startsWith('ADA')) return 0.4812
  if (symbol.startsWith('XRP')) return 0.5256
  if (symbol.startsWith('LTC')) return 87
  return 100
}

function makeBrowserSnapshot(symbol: string, interval: CandleInterval, seed = Date.now()): MarketSnapshot {
  const now = Date.now()
  const base = basePrice(symbol)
  const step = intervalMs[interval]
  const drift = Math.sin(seed / 90_000) * base * 0.015
  const candles: Candle[] = Array.from({ length: 180 }).map((_, index) => {
    const time = now - (179 - index) * step
    const trend = Math.sin((seed / 140_000 + index) / 7) * base * 0.028
    const pulse = Math.cos((seed / 80_000 + index) / 3) * base * 0.006
    const open = base + drift + trend
    const close = open + pulse
    const high = Math.max(open, close) + base * (0.004 + (index % 5) * 0.0005)
    const low = Math.min(open, close) - base * (0.004 + (index % 3) * 0.0007)
    return {
      time,
      open,
      high,
      low,
      close,
      volume: 80 + Math.abs(Math.sin(index / 3)) * 780 + (index % 9) * 24,
    }
  })
  const last = candles[candles.length - 1].close
  const spreadStep = base * 0.00008
  const bids: DepthLevel[] = Array.from({ length: 20 }).map((_, index) => ({
    price: last - (index + 1) * spreadStep,
    quantity: 0.09 + ((index * 37) % 85) / 100,
  }))
  const asks: DepthLevel[] = Array.from({ length: 20 }).map((_, index) => ({
    price: last + (index + 1) * spreadStep,
    quantity: 0.12 + ((index * 29) % 90) / 100,
  }))
  const trades: TradeTick[] = Array.from({ length: 30 }).map((_, index) => ({
    id: seed + index,
    time: now - index * 1500,
    price: index % 3 === 0 ? bids[0].price : index % 3 === 1 ? asks[0].price : last,
    quantity: 0.006 + ((index * 11) % 43) / 1000,
    side: index % 3 === 0 ? 'SELL' : 'BUY',
  }))
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
      priceChangePercent: symbol.startsWith('ADA') || symbol.startsWith('LTC') ? -0.83 : 1.32,
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

function makeBacktest(params: BacktestParams): BacktestResult {
  const snapshot = makeBrowserSnapshot(params.symbol, params.interval, params.from || Date.now() - 90 * 86_400_000)
  const profile =
    params.strategyType === 'trend'
      ? { waveDivisor: 13, waveWeight: 0.009, trendWeight: 0.0022, winRate: 0.54, profitFactor: 1.72, trades: 18 }
      : params.strategyType === 'multi-factor'
        ? { waveDivisor: 10, waveWeight: 0.011, trendWeight: 0.0019, winRate: 0.59, profitFactor: 1.95, trades: 26 }
      : params.strategyType === 'script'
        ? { waveDivisor: 7, waveWeight: 0.012, trendWeight: 0.0013, winRate: 0.56, profitFactor: 1.58, trades: 32 }
      : params.strategyType === 'grid'
        ? { waveDivisor: 4, waveWeight: 0.006, trendWeight: 0.0007, winRate: 0.68, profitFactor: 1.38, trades: 64 }
        : { waveDivisor: 8, waveWeight: 0.015, trendWeight: 0.0016, winRate: 0.6234, profitFactor: 2.35, trades: 42 }
  const equityCurve = snapshot.candles.map((candle, index) => {
    const wave = Math.sin(index / profile.waveDivisor) * params.initialCapital * profile.waveWeight
    const trend = index * params.initialCapital * profile.trendWeight
    return { time: candle.time, value: params.initialCapital + trend + wave }
  })
  const finalValue = equityCurve[equityCurve.length - 1]?.value ?? params.initialCapital
  return {
    source: 'mock',
    initialCapital: params.initialCapital,
    leverage: {
      value: 1,
      source: 'risk-rule',
      message: '浏览器预览模式使用 1x 模拟杠杆。',
    },
    candleCount: snapshot.candles.length,
    range: {
      from: snapshot.candles[0]?.time ?? params.from,
      to: snapshot.candles[snapshot.candles.length - 1]?.time ?? params.to,
    },
    metrics: {
      totalReturn: (finalValue - params.initialCapital) / params.initialCapital,
      annualizedReturn: 0.5231,
      maxDrawdown: 0.0912,
      sharpeRatio: 1.89,
      winRate: profile.winRate,
      profitFactor: profile.profitFactor,
      trades: profile.trades,
    },
    equityCurve,
    trades: snapshot.candles.slice(40, 52).map((candle, index) => ({
      time: candle.time,
      symbol: params.symbol,
      side: index % 2 === 0 ? 'BUY' : 'SELL',
      price: candle.close,
      quantity: params.initialCapital * 0.02 / candle.close,
      pnl: index % 2 === 0 ? -params.initialCapital * params.feeRate * 0.02 : 80 + index * 13,
    })),
  }
}

function currentSnapshot(): AppStateSnapshot {
  const state = useQuantStore.getState()
  return {
    preferences: {
      selectedSymbol: state.selectedSymbol,
      selectedInterval: state.selectedInterval,
      watchlist: state.watchlist,
      liveMode: state.liveMode,
      backtestParams: state.backtestParams,
      userSettings: state.userSettings,
    },
    strategies: state.strategies.length ? state.strategies : seedSnapshot.strategies,
    riskRules: state.riskRules,
    riskEvents: state.riskEvents.length ? state.riskEvents : seedSnapshot.riskEvents,
    assets: state.assets.length ? state.assets : seedSnapshot.assets,
    positions: state.positions.length ? state.positions : seedSnapshot.positions,
    strategyPositions: state.strategyPositions.length ? state.strategyPositions : seedSnapshot.strategyPositions,
    orders: state.orders,
    logs: state.logs.length ? state.logs : seedSnapshot.logs,
    apiProfiles: state.apiProfiles,
  }
}

export function createBrowserQuantApi(): QuantApi {
  return {
    getSnapshot: async () => cloneSnapshot(seedSnapshot),
    getMarketSnapshot: async (symbol, interval) => makeBrowserSnapshot(symbol, interval),
    getMarketTickers: async (symbols) => symbols.map((symbol) => makeBrowserSnapshot(symbol, '1m').ticker),
    addApiProfile: async (input) => {
      const profile = {
        id: randomId(),
        exchange: 'Binance USD-M Futures' as const,
        environment: input.environment,
        label: input.label,
        apiKeyTail: `${input.apiKey.length > 6 ? '****' : '******'}${input.apiKey.slice(-6)}`,
        canRead: false,
        canTrade: false,
        tradePermissionRequested: input.canTrade,
        withdrawWarning: true,
        latencyMs: 0,
        status: 'disconnected' as const,
        lastCheckedAt: Date.now(),
        lastError: undefined,
      }
      useQuantStore.getState().upsertApiProfile(profile)
      return profile
    },
    testApiProfile: async (profileId) => {
      const state = useQuantStore.getState()
      const profile = state.apiProfiles.find((item) => item.id === profileId)
      if (!profile) throw new Error('API 配置不存在')
      const updated = {
        ...profile,
        canRead: true,
        canTrade: profile.tradePermissionRequested,
        withdrawWarning: true,
        latencyMs: 18,
        status: 'connected' as const,
        lastCheckedAt: Date.now(),
        lastError: undefined,
      }
      state.upsertApiProfile(updated)
      return updated
    },
    removeApiProfile: async (profileId) => {
      const state = useQuantStore.getState()
      state.removeApiProfile(profileId)
      return useQuantStore.getState().apiProfiles
    },
    pingBinance: async () => ({ latencyMs: 18, serverTime: Date.now() }),
    fetchAccount: async () => {
      const assets: AccountAsset[] = []
      const positions: AccountPosition[] = []
      const summary = {
        totalWalletBalance: assets.reduce((sum, asset) => sum + asset.walletBalance, 0),
        totalMarginBalance: assets.reduce((sum, asset) => sum + asset.walletBalance, 0),
        totalUnrealizedProfit: assets.reduce((sum, asset) => sum + asset.unrealizedPnl, 0),
        totalCrossWalletBalance: assets.reduce((sum, asset) => sum + asset.availableBalance, 0),
        totalCrossUnPnl: assets.reduce((sum, asset) => sum + asset.unrealizedPnl, 0),
        availableBalance: assets.reduce((sum, asset) => sum + asset.availableBalance, 0),
        maxWithdrawAmount: assets.reduce((sum, asset) => sum + asset.availableBalance, 0),
      }
      return { summary, assets, positions } satisfies FuturesAccountSnapshot
    },
    updateStrategies: async (strategies) => {
      useQuantStore.getState().setStrategies(strategies)
      return strategies
    },
    updateRiskRules: async (rules) => {
      useQuantStore.getState().setRiskRules(rules)
      return rules
    },
    addRiskEvent: async (event) => {
      const riskEvent: RiskEvent = { ...event, id: randomId(), time: Date.now() }
      const state = useQuantStore.getState()
      state.addRiskEvent(riskEvent)
      if (riskEvent.strategyId && (riskEvent.level === 'warning' || riskEvent.level === 'danger')) {
        state.setStrategies(
          state.strategies.map((strategy) =>
            strategy.id === riskEvent.strategyId ? { ...strategy, status: 'tripped', riskLevel: riskEvent.level } : strategy,
          ),
        )
      }
      return riskEvent
    },
    placeOrder: async (input: PlaceOrderInput) => {
      const state = useQuantStore.getState()
      const marketPrice = state.currentMarket?.ticker.lastPrice ?? basePrice(input.symbol)
      const order: OrderRecord = {
        id: `browser-${randomId()}`,
        time: Date.now(),
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        price: input.type === 'LIMIT' ? input.price ?? marketPrice : marketPrice,
        quantity: input.quantity,
        executedQuantity: input.quantity,
        status: 'FILLED',
        strategyId: input.strategyId,
        idempotencyKey: input.idempotencyKey,
      }
      state.addOrder(order)
      return order
    },
    runBacktest: async (params) => makeBacktest(params),
    cacheMarketHistory: async (request) => ({
      symbol: request.symbol,
      interval: request.interval,
      from: request.from,
      to: request.to,
      candles: makeBrowserSnapshot(request.symbol, request.interval, request.from).candles.length,
      source: 'binance' as const,
    }),
    updatePreferences: async (patch) => {
      const state = useQuantStore.getState()
      const preferences = {
        selectedSymbol: state.selectedSymbol,
        selectedInterval: state.selectedInterval,
        watchlist: state.watchlist,
        liveMode: state.liveMode,
        backtestParams: state.backtestParams,
        userSettings: state.userSettings,
        ...patch,
      }
      state.applyPreferences(preferences)
      return preferences
    },
    clearLogs: async (filter) => {
      const state = useQuantStore.getState()
      const nextLogs = !filter?.scope && !filter?.strategyId
        ? []
        : state.logs.filter((log) => {
            const matchesScope = !filter?.scope || log.scope === filter.scope
            const matchesStrategy = !filter?.strategyId || log.strategyId === filter.strategyId
            return !(matchesScope && matchesStrategy)
          })
      state.setLogs(nextLogs)
      return nextLogs
    },
    getUpdateState: async () => browserUpdateState,
    checkForUpdates: async () => browserUpdateState,
    downloadUpdate: async () => browserUpdateState,
    installUpdate: async () => browserUpdateState,
    openReleases: async () => {
      window.open('https://github.com/Haohongbo/binanboot/releases', '_blank', 'noopener,noreferrer')
    },
    toggleWindowMaximized: async () => false,
    onStatePatch: (_listener: (patch: AppStatePatch) => void) => undefined,
    onUpdateState: (_listener: (state: AppUpdateState) => void) => () => undefined,
  }
}
