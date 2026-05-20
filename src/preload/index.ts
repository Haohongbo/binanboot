import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { APP_STATE_PATCH_CHANNEL } from '../shared/app-state-events'
import type { AppStatePatch } from '../shared/app-state-events'
import type {
  ApiProfile,
  AppPreferences,
  AppStateSnapshot,
  BacktestParams,
  BacktestResult,
  CandleInterval,
  FuturesAccountSnapshot,
  LogEntry,
  LogClearFilter,
  MarketDataCacheRequest,
  MarketDataCacheResult,
  MarketSnapshot,
  MarketTicker,
  OrderRecord,
  PlaceOrderInput,
  RiskEvent,
  RiskRuleSet,
  StoredApiInput,
  StrategyConfig,
} from '../shared/types'

const api = {
  getSnapshot: (): Promise<AppStateSnapshot> => ipcRenderer.invoke('app:snapshot'),
  getMarketSnapshot: (symbol: string, interval: CandleInterval): Promise<MarketSnapshot> =>
    ipcRenderer.invoke('market:snapshot', symbol, interval),
  getMarketTickers: (symbols: string[]): Promise<MarketTicker[]> => ipcRenderer.invoke('market:tickers', symbols),
  addApiProfile: (input: StoredApiInput): Promise<ApiProfile> => ipcRenderer.invoke('api:add', input),
  testApiProfile: (profileId: string): Promise<ApiProfile> => ipcRenderer.invoke('api:test', profileId),
  removeApiProfile: (profileId: string): Promise<ApiProfile[]> => ipcRenderer.invoke('api:remove', profileId),
  pingBinance: (): Promise<{ latencyMs: number; serverTime: number; error?: string }> => ipcRenderer.invoke('api:ping'),
  fetchAccount: (profileId: string): Promise<FuturesAccountSnapshot> => ipcRenderer.invoke('account:fetch', profileId),
  updateStrategies: (strategies: StrategyConfig[]): Promise<StrategyConfig[]> =>
    ipcRenderer.invoke('strategy:update', strategies),
  updateRiskRules: (rules: RiskRuleSet): Promise<RiskRuleSet> => ipcRenderer.invoke('risk:update-rules', rules),
  addRiskEvent: (event: Omit<RiskEvent, 'id' | 'time'>): Promise<RiskEvent> => ipcRenderer.invoke('risk:event', event),
  placeOrder: (input: PlaceOrderInput): Promise<OrderRecord> => ipcRenderer.invoke('trade:place-order', input),
  runBacktest: (params: BacktestParams): Promise<BacktestResult> => ipcRenderer.invoke('backtest:run', params),
  cacheMarketHistory: (request: MarketDataCacheRequest): Promise<MarketDataCacheResult> =>
    ipcRenderer.invoke('market:cache-history', request),
  updatePreferences: (patch: Partial<AppPreferences>): Promise<AppPreferences> => ipcRenderer.invoke('preferences:update', patch),
  clearLogs: (filter?: LogClearFilter): Promise<LogEntry[]> => ipcRenderer.invoke('logs:clear', filter),
  toggleWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
  onStatePatch: (listener: (patch: AppStatePatch) => void): void => {
    const channel = (_event: IpcRendererEvent, patch: AppStatePatch) => {
      listener(patch)
    }
    ipcRenderer.on(APP_STATE_PATCH_CHANNEL, channel)
  },
}

contextBridge.exposeInMainWorld('quantApi', api)

export type QuantApi = typeof api
