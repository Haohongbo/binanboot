import { create } from 'zustand'
import type {
  AccountAsset,
  AccountPosition,
  AppPreferences,
  ApiProfile,
  AppStateSnapshot,
  BacktestParams,
  BacktestResult,
  Candle,
  CandleInterval,
  DepthLevel,
  LogEntry,
  MarketSnapshot,
  MarketTicker,
  OrderRecord,
  RiskEvent,
  RiskRuleSet,
  StrategyConfig,
  UserSettings,
} from '../../shared/types'
import type { AppStatePatch as SharedAppStatePatch } from '../../shared/app-state-events'
import { INITIAL_TICKERS } from './lib/market-stream'
import { makeInitialTicker, normalizeSymbolInput, normalizeWatchlistSymbols } from '../../shared/market-symbols'

export type PageId = 'dashboard' | 'strategies' | 'strategy-diagnostics' | 'backtest' | 'orders' | 'risk' | 'assets' | 'api' | 'logs' | 'settings'

export type MarketStatus = 'connecting' | 'live' | 'mock' | 'error'
export type AccountSyncStatus = 'idle' | 'loading' | 'ready' | 'error'
export type BacktestRunStatus = 'idle' | 'running' | 'succeeded' | 'error'

type AccountSyncMeta = {
  accountSyncStatus?: AccountSyncStatus
  accountLastSyncedAt?: number | null
  accountSyncError?: string
}

type BacktestRunMeta = {
  backtestRunStatus?: BacktestRunStatus
  backtestRunError?: string
  backtestStartedAt?: number | null
  backtestCompletedAt?: number | null
}

interface QuantStore {
  activePage: PageId
  selectedSymbol: string
  selectedInterval: CandleInterval
  liveMode: 'paper' | 'live'
  userSettings: UserSettings
  watchlist: string[]
  isBootstrapped: boolean
  marketStatus: MarketStatus
  marketError?: string
  systemTime: number
  currentMarket: MarketSnapshot | null
  topTickers: MarketTicker[]
  strategies: StrategyConfig[]
  riskRules: RiskRuleSet
  riskEvents: RiskEvent[]
  orders: OrderRecord[]
  logs: LogEntry[]
  assets: AccountAsset[]
  positions: AccountPosition[]
  apiProfiles: ApiProfile[]
  backtestParams: BacktestParams
  backtestResult: BacktestResult | null
  backtestRunStatus: BacktestRunStatus
  backtestRunError: string
  backtestStartedAt: number | null
  backtestCompletedAt: number | null
  accountSyncStatus: AccountSyncStatus
  accountLastSyncedAt: number | null
  accountSyncError: string
  setActivePage: (page: PageId) => void
  setSelectedSymbol: (symbol: string) => void
  setSelectedInterval: (interval: CandleInterval) => void
  setLiveMode: (mode: 'paper' | 'live') => void
  setSystemTime: (time: number) => void
  addWatchlistSymbol: (symbol: string) => string | null
  removeWatchlistSymbol: (symbol: string) => void
  hydrate: (snapshot: AppStateSnapshot) => void
  syncRuntimeSnapshot: (snapshot: AppStateSnapshot) => void
  applyStatePatch: (patch: SharedAppStatePatch) => void
  setMarketStatus: (status: MarketStatus, error?: string) => void
  setCurrentMarket: (snapshot: MarketSnapshot) => void
  updateTicker: (ticker: MarketTicker) => void
  updateTickers: (tickers: MarketTicker[]) => void
  updateKline: (candle: Candle) => void
  updateDepth: (depth: { bids: DepthLevel[]; asks: DepthLevel[] }) => void
  addTrade: (trade: MarketSnapshot['trades'][number]) => void
  setStrategies: (strategies: StrategyConfig[]) => void
  setRiskRules: (rules: RiskRuleSet) => void
  addRiskEvent: (event: RiskEvent) => void
  addOrder: (order: OrderRecord) => void
  addLog: (entry: LogEntry) => void
  setLogs: (logs: LogEntry[]) => void
  setApiProfiles: (profiles: ApiProfile[]) => void
  upsertApiProfile: (profile: ApiProfile) => void
  removeApiProfile: (id: string) => void
  setAssets: (assets: AccountAsset[]) => void
  setPositions: (positions: AccountPosition[]) => void
  setBacktestParams: (params: Partial<BacktestParams>) => void
  setBacktestResult: (result: BacktestResult | null) => void
  setBacktestRunMeta: (meta: BacktestRunMeta) => void
  setAccountSyncStatus: (status: AccountSyncStatus) => void
  setAccountSyncMeta: (meta: AccountSyncMeta) => void
  setUserSettings: (settings: UserSettings) => void
  applyPreferences: (preferences: AppPreferences) => void
}

const now = Date.now()

const initialRiskRules: RiskRuleSet = {
  strategyMaxLoss: 5,
  dailyMaxLoss: 8,
  maxPositionRatio: 35,
  maxLeverage: 5,
  maxLossStreak: 4,
}

const intervalMs: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

const bookTradeMinIntervalMs = 250

function reconcileTickers(watchlist: string[], tickers: MarketTicker[]): MarketTicker[] {
  const bySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]))
  return watchlist.map((symbol) => bySymbol.get(symbol) ?? makeInitialTicker(symbol))
}

function mergeTickers(
  existing: MarketTicker[],
  incoming: MarketTicker[],
  watchlist: string[],
): MarketTicker[] {
  if (incoming.length === 0) return existing
  const bySymbol = new Map(existing.map((ticker) => [ticker.symbol, ticker]))
  const normalizedIncoming = new Map(incoming.map((ticker) => [ticker.symbol, ticker]))
  return watchlist.map((symbol) => normalizedIncoming.get(symbol) ?? bySymbol.get(symbol) ?? makeInitialTicker(symbol))
}

function normalizeBacktestResult(result: BacktestResult | null): BacktestResult | null {
  if (!result) return null
  return {
    ...result,
    leverage: result.leverage ?? {
      value: 1,
      source: 'risk-rule',
      message: '旧回测结果未记录杠杆，已按 1x 兼容显示。',
    },
  }
}

function resolvePreferenceState(preferences: AppPreferences, currentTopTickers: MarketTicker[]): Pick<QuantStore, 'watchlist' | 'topTickers' | 'selectedSymbol' | 'selectedInterval' | 'liveMode' | 'backtestParams' | 'userSettings'> {
  const watchlist = normalizeWatchlistSymbols(preferences.watchlist)
  const selectedSymbol = watchlist.includes(preferences.selectedSymbol) ? preferences.selectedSymbol : watchlist[0]
  const backtestParams = watchlist.includes(preferences.backtestParams.symbol)
    ? preferences.backtestParams
    : { ...preferences.backtestParams, symbol: selectedSymbol }
  return {
    watchlist,
    topTickers: reconcileTickers(watchlist, currentTopTickers),
    selectedSymbol,
    selectedInterval: preferences.selectedInterval,
    liveMode: preferences.liveMode,
    backtestParams,
    userSettings: preferences.userSettings,
  }
}

function sortTradesNewestFirst(trades: MarketSnapshot['trades']): MarketSnapshot['trades'] {
  return [...trades].sort((left, right) => right.time - left.time || right.id - left.id)
}

function tickerWithPrice(ticker: MarketTicker, price: number | undefined, time = Date.now()): MarketTicker {
  if (!price || price <= 0) return ticker
  return {
    ...ticker,
    lastPrice: price,
    latencyMs: Math.max(0, Date.now() - time),
  }
}

function sortDepth(depth: { bids: DepthLevel[]; asks: DepthLevel[] }): { bids: DepthLevel[]; asks: DepthLevel[] } {
  return {
    bids: [...depth.bids].filter((item) => item.price > 0 && item.quantity > 0).sort((left, right) => right.price - left.price),
    asks: [...depth.asks].filter((item) => item.price > 0 && item.quantity > 0).sort((left, right) => left.price - right.price),
  }
}

function depthMidPrice(depth: { bids: DepthLevel[]; asks: DepthLevel[] }): number | undefined {
  const bestBid = depth.bids[0]?.price
  const bestAsk = depth.asks[0]?.price
  return bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined
}

function updateCandlesWithPrice(candles: Candle[], interval: CandleInterval, price: number, quantity: number, time: number): Candle[] {
  const nextCandles = [...candles]
  const candleTime = Math.floor(time / intervalMs[interval]) * intervalMs[interval]
  const last = nextCandles[nextCandles.length - 1]
  const updatesLatestCandle = last && candleTime <= last.time && time < last.time + intervalMs[interval]
  if (last && (last.time === candleTime || updatesLatestCandle)) {
    nextCandles[nextCandles.length - 1] = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: last.volume + quantity,
    }
  } else if (!last || candleTime > last.time) {
    const open = last?.close ?? price
    nextCandles.push({
      time: candleTime,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
      volume: quantity,
    })
  }
  return nextCandles.slice(-220)
}

function bookTradeId(time: number, price: number): number {
  return time * 1000 + Math.round(price * 1000) % 1000
}

function syncTradesWithBookPrice(
  trades: MarketSnapshot['trades'],
  symbol: string,
  price: number,
  quantity: number,
  time: number,
  previousPrice?: number,
): MarketSnapshot['trades'] {
  const sortedTrades = sortTradesNewestFirst(trades)
  const latestTrade = sortedTrades[0]
  if (latestTrade && latestTrade.price === price && time - latestTrade.time < bookTradeMinIntervalMs) return sortedTrades.slice(0, 42)
  const side = previousPrice !== undefined && price < previousPrice ? 'SELL' : 'BUY'
  const bookTrade: MarketSnapshot['trades'][number] = {
    id: bookTradeId(time, price),
    symbol,
    time,
    price,
    quantity,
    side,
  }
  return sortTradesNewestFirst([bookTrade, ...sortedTrades]).slice(0, 42)
}

function normalizeMarketSnapshot(snapshot: MarketSnapshot): MarketSnapshot {
  const depth = sortDepth(snapshot)
  const bookPrice = depthMidPrice(depth)
  const trades = bookPrice
    ? syncTradesWithBookPrice(snapshot.trades, snapshot.symbol, bookPrice, depth.bids[0]?.quantity ?? depth.asks[0]?.quantity ?? 0, snapshot.serverTime, snapshot.ticker.lastPrice)
    : sortTradesNewestFirst(snapshot.trades)
  const latestTrade = trades[0]
  const displayPrice = bookPrice ?? latestTrade?.price
  const displayTime = bookPrice ? snapshot.serverTime : latestTrade?.time
  return {
    ...snapshot,
    bids: depth.bids,
    asks: depth.asks,
    quoteMidPrice: bookPrice ?? snapshot.quoteMidPrice,
    trades,
    ticker: tickerWithPrice(snapshot.ticker, displayPrice, displayTime),
    candles: displayPrice ? updateCandlesWithPrice(snapshot.candles, snapshot.interval, displayPrice, latestTrade?.quantity ?? 0, displayTime ?? snapshot.serverTime) : snapshot.candles,
  }
}

export const useQuantStore = create<QuantStore>((set, get) => ({
  activePage: 'dashboard',
  selectedSymbol: 'BTCUSDT',
  selectedInterval: '1d',
  liveMode: 'paper',
  watchlist: INITIAL_TICKERS.map((ticker) => ticker.symbol),
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
  isBootstrapped: false,
  marketStatus: 'connecting',
  systemTime: now,
  currentMarket: null,
  topTickers: INITIAL_TICKERS,
  strategies: [],
  riskRules: initialRiskRules,
  riskEvents: [],
  orders: [],
  logs: [],
  assets: [],
  positions: [],
  apiProfiles: [],
  backtestParams: {
    symbol: 'BTCUSDT',
    interval: '1h',
    initialCapital: 100_000,
    feeRate: 0.0004,
    from: now - 180 * 86_400_000,
    to: now,
    strategyType: 'ma-cross',
  },
  backtestResult: null,
  backtestRunStatus: 'idle',
  backtestRunError: '',
  backtestStartedAt: null,
  backtestCompletedAt: null,
  accountSyncStatus: 'idle',
  accountLastSyncedAt: null,
  accountSyncError: '',
  setActivePage: (activePage) => set({ activePage }),
  setSelectedSymbol: (selectedSymbol) => set({ selectedSymbol }),
  setSelectedInterval: (selectedInterval) => set({ selectedInterval }),
  setLiveMode: (liveMode) => set({ liveMode }),
  setSystemTime: (systemTime) => set({ systemTime }),
  addWatchlistSymbol: (symbol) => {
    const normalized = normalizeSymbolInput(symbol)
    if (!normalized) return null
    set((state) => {
      if (state.watchlist.includes(normalized)) {
        return state.selectedSymbol === normalized ? { selectedSymbol: normalized } : {}
      }
      const nextWatchlist = [...state.watchlist, normalized]
      return {
        watchlist: nextWatchlist,
        topTickers: reconcileTickers(nextWatchlist, state.topTickers),
        selectedSymbol: normalized,
      }
    })
    return normalized
  },
  removeWatchlistSymbol: (symbol) =>
    set((state) => {
      const normalized = normalizeSymbolInput(symbol)
      if (!normalized || state.watchlist.length <= 1) return {}
      const nextWatchlist = state.watchlist.filter((item) => item !== normalized)
      if (nextWatchlist.length === state.watchlist.length) return {}
      const nextSelectedSymbol = state.selectedSymbol === normalized ? nextWatchlist[0] ?? state.selectedSymbol : state.selectedSymbol
      const nextBacktestSymbol = state.backtestParams.symbol === normalized ? nextWatchlist[0] ?? state.backtestParams.symbol : state.backtestParams.symbol
      return {
        watchlist: nextWatchlist,
        topTickers: reconcileTickers(nextWatchlist, state.topTickers),
        selectedSymbol: nextSelectedSymbol,
        backtestParams: nextBacktestSymbol === state.backtestParams.symbol ? state.backtestParams : { ...state.backtestParams, symbol: nextBacktestSymbol },
      }
    }),
  hydrate: (snapshot) => {
    const preferenceState = resolvePreferenceState(snapshot.preferences, get().topTickers)
    set({
      isBootstrapped: true,
      ...preferenceState,
      strategies: snapshot.strategies,
      riskRules: snapshot.riskRules,
      riskEvents: snapshot.riskEvents,
      orders: snapshot.orders,
      logs: snapshot.logs,
      assets: snapshot.assets,
      positions: snapshot.positions,
      apiProfiles: snapshot.apiProfiles,
    })
  },
  syncRuntimeSnapshot: (snapshot) =>
    set({
      strategies: snapshot.strategies,
      riskRules: snapshot.riskRules,
      riskEvents: snapshot.riskEvents,
      orders: snapshot.orders,
      logs: snapshot.logs,
      assets: snapshot.assets,
      positions: snapshot.positions,
      apiProfiles: snapshot.apiProfiles,
    }),
  applyStatePatch: (patch) =>
    set((state) => {
      const nextState: Partial<QuantStore> = {}
      if (patch.preferences) {
        Object.assign(nextState, resolvePreferenceState(patch.preferences, state.topTickers))
      }
      if (patch.strategies) nextState.strategies = patch.strategies
      if (patch.riskRules) nextState.riskRules = patch.riskRules
      if (patch.riskEvents) nextState.riskEvents = patch.riskEvents
      if (patch.assets) nextState.assets = patch.assets
      if (patch.positions) nextState.positions = patch.positions
      if (patch.orders) nextState.orders = patch.orders
      if (patch.logs) nextState.logs = patch.logs
      if (patch.apiProfiles) nextState.apiProfiles = patch.apiProfiles
      return nextState
    }),
  setMarketStatus: (marketStatus, marketError) => set({ marketStatus, marketError }),
  setCurrentMarket: (snapshot) =>
    set((state) => {
      const normalized = normalizeMarketSnapshot(snapshot)
      return {
        currentMarket: normalized,
        topTickers: state.topTickers.some((ticker) => ticker.symbol === normalized.symbol)
          ? state.topTickers.map((ticker) => (ticker.symbol === normalized.symbol ? normalized.ticker : ticker))
          : [...state.topTickers, normalized.ticker],
      }
    }),
  updateTicker: (ticker) =>
    set((state) => {
      const bookPrice = state.currentMarket?.symbol === ticker.symbol ? depthMidPrice(state.currentMarket) : undefined
      const latestTrade = state.currentMarket?.symbol === ticker.symbol ? state.currentMarket.trades[0] : undefined
      const currentTicker = tickerWithPrice(ticker, bookPrice ?? latestTrade?.price, latestTrade?.time)
      return {
        topTickers: state.topTickers.some((item) => item.symbol === ticker.symbol)
          ? state.topTickers.map((item) => (item.symbol === ticker.symbol ? currentTicker : item))
          : state.watchlist.includes(ticker.symbol)
            ? [...state.topTickers, currentTicker]
            : state.topTickers,
        currentMarket:
          state.currentMarket?.symbol === ticker.symbol
            ? {
                ...state.currentMarket,
                ticker: currentTicker,
              }
            : state.currentMarket,
      }
    }),
  updateKline: (candle) =>
    set((state) => {
      if (!state.currentMarket) {
        const tickerProfile = state.topTickers.find((item) => item.symbol === state.selectedSymbol)
        return {
          currentMarket: {
            symbol: state.selectedSymbol,
            interval: state.selectedInterval,
            ticker: {
              symbol: state.selectedSymbol,
              lastPrice: candle.close,
              priceChangePercent: tickerProfile?.priceChangePercent ?? 0,
              quoteVolume: tickerProfile?.quoteVolume ?? 0,
              latencyMs: 0,
            },
            candles: [candle],
            bids: [],
            asks: [],
            trades: [],
            serverTime: Date.now(),
            source: 'binance',
          },
        }
      }
      const candles = [...state.currentMarket.candles]
      const last = candles[candles.length - 1]
      if (last?.time === candle.time) {
        candles[candles.length - 1] = candle
      } else if (!last || candle.time > last.time) {
        candles.push(candle)
      }
      const bookPrice = depthMidPrice(state.currentMarket)
      const displayTime = Date.now()
      const displayCandles = bookPrice
        ? updateCandlesWithPrice(candles, state.currentMarket.interval, bookPrice, 0, displayTime)
        : candles.slice(-220)
      return {
        currentMarket: {
          ...state.currentMarket,
          candles: displayCandles,
          ticker: tickerWithPrice({ ...state.currentMarket.ticker, lastPrice: candle.close, latencyMs: 0 }, bookPrice ?? state.currentMarket.trades[0]?.price),
        },
      }
    }),
  updateTickers: (tickers) =>
    set((state) => {
      const nextTopTickers = mergeTickers(state.topTickers, tickers, state.watchlist)
      const market = state.currentMarket
      const currentTicker = market ? tickers.find((item) => item.symbol === market.symbol) : undefined
      return {
        topTickers: nextTopTickers,
        currentMarket: currentTicker && market
          ? {
              ...market,
              ticker: tickerWithPrice(currentTicker, currentTicker.lastPrice, Date.now()),
            }
          : market,
      }
    }),
  updateDepth: (depth) =>
    set((state) => {
      const sortedDepth = sortDepth(depth)
      const midPrice = depthMidPrice(sortedDepth)
      const now = Date.now()
      const market = state.currentMarket
      if (!market) {
        const tickerProfile = state.topTickers.find((item) => item.symbol === state.selectedSymbol)
        const ticker = tickerWithPrice({
          symbol: state.selectedSymbol,
          lastPrice: tickerProfile?.lastPrice ?? midPrice ?? 0,
          priceChangePercent: tickerProfile?.priceChangePercent ?? 0,
          quoteVolume: tickerProfile?.quoteVolume ?? 0,
          latencyMs: 0,
        }, midPrice, now)
        const quantity = sortedDepth.bids[0]?.quantity ?? sortedDepth.asks[0]?.quantity ?? 0
        const trades = midPrice ? syncTradesWithBookPrice([], state.selectedSymbol, midPrice, quantity, now, tickerProfile?.lastPrice) : []
        return {
          currentMarket: {
            symbol: state.selectedSymbol,
            interval: state.selectedInterval,
            ticker,
            candles: midPrice ? updateCandlesWithPrice([], state.selectedInterval, midPrice, quantity, now) : [],
            bids: sortedDepth.bids,
            asks: sortedDepth.asks,
            quoteMidPrice: midPrice,
            trades,
            serverTime: Date.now(),
            source: 'binance',
          },
          topTickers: state.topTickers.map((item) => (item.symbol === state.selectedSymbol ? ticker : item)),
        }
      }
      const quantity = sortedDepth.bids[0]?.quantity ?? sortedDepth.asks[0]?.quantity ?? 0
      const ticker = tickerWithPrice(market.ticker, midPrice, now)
      const trades = midPrice ? syncTradesWithBookPrice(market.trades, market.symbol, midPrice, quantity, now, market.ticker.lastPrice) : market.trades
      const candles = midPrice ? updateCandlesWithPrice(market.candles, market.interval, midPrice, quantity, now) : market.candles
      return {
        currentMarket: {
          ...market,
          ticker,
          candles,
          bids: sortedDepth.bids,
          asks: sortedDepth.asks,
          quoteMidPrice: midPrice,
          trades,
        },
        topTickers: state.topTickers.map((item) => (item.symbol === market.symbol ? ticker : item)),
      }
    }),
  addTrade: (trade) =>
    set((state) => {
      const market = state.currentMarket
      const tradeSymbol = trade.symbol ?? market?.symbol
      const bookPrice = market && tradeSymbol === market.symbol ? depthMidPrice(market) : undefined
      const displayTime = bookPrice ? Date.now() : trade.time
      const displayTrade = bookPrice ? { ...trade, price: bookPrice, time: displayTime } : trade
      const latencyMs = Math.max(0, Date.now() - displayTrade.time)
      const topTickers = tradeSymbol
        ? state.topTickers.map((item) =>
            item.symbol === tradeSymbol
              ? {
                  ...item,
                  lastPrice: displayTrade.price,
                  latencyMs,
                }
              : item,
          )
        : state.topTickers
      if (!market) {
        if (tradeSymbol !== state.selectedSymbol) return { topTickers }
        const tickerProfile = topTickers.find((item) => item.symbol === tradeSymbol)
        const candleTime = Math.floor(displayTrade.time / intervalMs[state.selectedInterval]) * intervalMs[state.selectedInterval]
        return {
          currentMarket: {
            symbol: state.selectedSymbol,
            interval: state.selectedInterval,
            ticker: {
              symbol: state.selectedSymbol,
              lastPrice: displayTrade.price,
              priceChangePercent: tickerProfile?.priceChangePercent ?? 0,
              quoteVolume: tickerProfile?.quoteVolume ?? 0,
              latencyMs,
            },
            candles: [{
              time: candleTime,
              open: displayTrade.price,
              high: displayTrade.price,
              low: displayTrade.price,
              close: displayTrade.price,
              volume: displayTrade.quantity,
            }],
            bids: [],
            asks: [],
            trades: [displayTrade],
            serverTime: Date.now(),
            source: 'binance',
          },
          topTickers,
        }
      }
      if (tradeSymbol !== market.symbol) return { topTickers }
      const ticker = {
        ...market.ticker,
        lastPrice: displayTrade.price,
        latencyMs,
      }
      const trades = sortTradesNewestFirst([displayTrade, ...market.trades]).slice(0, 42)
      const candles = updateCandlesWithPrice(market.candles, market.interval, displayTrade.price, displayTrade.quantity, displayTrade.time)
      return {
        currentMarket: {
          ...market,
          ticker,
          candles,
          trades,
        },
        topTickers: topTickers.map((item) => (item.symbol === market.symbol ? ticker : item)),
      }
    }),
  setStrategies: (strategies) => set({ strategies }),
  setRiskRules: (riskRules) => set({ riskRules }),
  addRiskEvent: (event) => set((state) => ({ riskEvents: [event, ...state.riskEvents].slice(0, 80) })),
  addOrder: (order) => set((state) => ({ orders: [order, ...state.orders].slice(0, 180) })),
  addLog: (entry) => set((state) => ({ logs: [entry, ...state.logs].slice(0, 240) })),
  setLogs: (logs) => set({ logs }),
  setApiProfiles: (apiProfiles) => set({ apiProfiles }),
  upsertApiProfile: (profile) =>
    set((state) => ({
      apiProfiles: state.apiProfiles.some((item) => item.id === profile.id)
        ? state.apiProfiles.map((item) => (item.id === profile.id ? profile : item))
        : [profile, ...state.apiProfiles],
    })),
  removeApiProfile: (id) => set((state) => ({ apiProfiles: state.apiProfiles.filter((item) => item.id !== id) })),
  setAssets: (assets) => set({ assets }),
  setPositions: (positions) => set({ positions }),
  setBacktestParams: (params) => set((state) => ({ backtestParams: { ...state.backtestParams, ...params } })),
  setBacktestResult: (backtestResult) => set({ backtestResult: normalizeBacktestResult(backtestResult) }),
  setBacktestRunMeta: (meta) => set(meta),
  setAccountSyncStatus: (accountSyncStatus) => set({ accountSyncStatus }),
  setAccountSyncMeta: (meta) => set(meta),
  setUserSettings: (userSettings) => set({ userSettings }),
  applyPreferences: (preferences) => {
    set((state) => resolvePreferenceState(preferences, state.topTickers))
  },
}))

export function currentRiskLevel(events: RiskEvent[]): RiskEvent['level'] {
  if (events.some((event) => event.level === 'danger')) return 'danger'
  if (events.some((event) => event.level === 'warning')) return 'warning'
  if (events.some((event) => event.level === 'watch')) return 'watch'
  return 'normal'
}

export function refreshRuntime(): void {
  const { strategies } = useQuantStore.getState()
  useQuantStore.setState({
    strategies: strategies.map((strategy) =>
      strategy.status === 'running' ? { ...strategy, runtimeMs: strategy.runtimeMs + 1000 } : strategy,
    ),
    systemTime: Date.now(),
  })
}
