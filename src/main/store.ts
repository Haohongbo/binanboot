import { app, net, Notification, safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'
import type {
  AccountAsset,
  AccountPosition,
  AppPreferences,
  ApiProfile,
  AppStateSnapshot,
  LogClearFilter,
  LogEntry,
  OrderRecord,
  RiskEvent,
  RiskRuleSet,
  StoredApiInput,
  StrategyConfig,
  StrategyPosition,
  UserSettings,
} from '../shared/types'
import type { AppStatePatch } from '../shared/app-state-events'
import { DEFAULT_WATCHLIST, normalizeSymbolInput, normalizeWatchlistSymbols } from '../shared/market-symbols'
import {
  applyStrategyOrder,
  rebuildStrategyPositions,
  updateStrategyPositionMark as updateStrategyPositionMarkList,
} from '../shared/strategy-positions'

interface ApiRecord extends ApiProfile {
  encryptedSecret: string
  apiKey: string
}

interface PersistedState extends Omit<AppStateSnapshot, 'apiProfiles'> {
  apiRecords: ApiRecord[]
}

const defaultRiskRules: RiskRuleSet = {
  strategyMaxLoss: 5,
  dailyMaxLoss: 8,
  maxPositionRatio: 35,
  maxLeverage: 5,
  maxLossStreak: 4,
}

const defaultBacktestParams = {
  symbol: 'BTCUSDT',
  interval: '1h' as const,
  initialCapital: 100_000,
  feeRate: 0.0004,
  leverage: undefined as number | undefined,
  from: Date.now() - 180 * 86_400_000,
  to: Date.now(),
  strategyType: 'ma-cross' as const,
}

function normalizeBacktestParams(backtestParams?: Partial<AppPreferences['backtestParams']>): AppPreferences['backtestParams'] {
  const now = Date.now()
  const minBacktestTime = Date.UTC(2017, 0, 1)
  const maxBacktestTime = now + 2 * 86_400_000
  const next = {
    ...defaultBacktestParams,
    ...backtestParams,
  }
  const to = Number.isFinite(next.to) && next.to >= minBacktestTime && next.to <= maxBacktestTime
    ? next.to
    : now
  const from = Number.isFinite(next.from) && next.from >= minBacktestTime && next.from < to
    ? next.from
    : to - 365 * 86_400_000
  return {
    ...next,
    initialCapital: Number.isFinite(next.initialCapital) && next.initialCapital > 0 ? next.initialCapital : defaultBacktestParams.initialCapital,
    feeRate: Number.isFinite(next.feeRate) && next.feeRate >= 0 ? next.feeRate : defaultBacktestParams.feeRate,
    leverage: Number.isFinite(next.leverage) && Number(next.leverage) >= 1 ? Math.min(125, Math.floor(Number(next.leverage))) : undefined,
    from,
    to,
  }
}

const defaultUserSettings: UserSettings = {
  requireActionConfirm: true,
  autoPauseOnApiError: true,
  enableTwoFactor: false,
  defaultRunMode: 'paper',
  notifyOnRiskEvent: true,
  feishuNotifyEnabled: false,
  feishuAppId: process.env.FEISHU_BOT_2_APP_ID ?? '',
  feishuAppSecret: process.env.FEISHU_BOT_2_APP_SECRET ?? '',
  feishuUserId: process.env.FEISHU_BOT_2_USER_ID ?? '',
  feishuThreshold: Number(process.env.FEISHU_BOT_2_THRESHOLD ?? 4),
  compactTableMode: false,
}

const sol15mHighWinScript = `BUY: close > ma120 && ma20 > ma60 && rsi14 < 78 && bbPctB < 0.36 && momentum3 > -0.004 && closeLocation > 0.2 && volumeRatio > 0.5 && atrPct < 0.07
SELL: unrealizedPnlPct > 0.008 || unrealizedPnlPct < -0.065 || drawdownSinceEntry > 0.022 || barsHeld > 48 || (rsi14 > 72 && unrealizedPnlPct > 0.002)
POSITION: 0.8`

const legacySol5mLongShortPulseScript = `LONG: candleReturn > 0.002 && momentum3 > 0.006 && rsi14 > 55 && rsi14 < 60 && close > ma20
CLOSE_LONG: unrealizedPnlPct > 0.02 || unrealizedPnlPct < -0.06 || drawdownSinceEntry > 0.1
SHORT: candleReturn < -0.002 && momentum3 < -0.006 && rsi14 < 55 && rsi14 > 40 && close < ma20
CLOSE_SHORT: unrealizedPnlPct > 0.02 || unrealizedPnlPct < -0.06 || drawdownSinceEntry > 0.1
POSITION: 0.8`

const legacySol5mLooseScript = `LONG: ma20 > ma60 && close > ma20 * 0.996 && momentum3 > 0.0006 && momentum5 > 0.0012 && rsi14 > 46 && rsi14 < 69 && closeLocation > 0.52 && volumeRatio > 0.38
CLOSE_LONG: unrealizedPnlPct > 0.015 || unrealizedPnlPct < -0.01 || drawdownSinceEntry > 0.02 || barsHeld > 20 || close < ma20
SHORT: ma20 < ma60 && close < ma20 * 1.004 && momentum3 < -0.0006 && momentum5 < -0.0012 && rsi14 < 54 && rsi14 > 31 && closeLocation < 0.48 && volumeRatio > 0.38
CLOSE_SHORT: unrealizedPnlPct > 0.015 || unrealizedPnlPct < -0.01 || drawdownSinceEntry > 0.02 || barsHeld > 20 || close > ma20
POSITION: 0.8`

const legacySol5mMomentumPulseScript = `LONG: candleReturn > 0.001 && momentum3 > 0.0055 && momentum5 > 0.005 && rsi14 > 50 && rsi14 < 60 && close > ma20 && closeLocation > 0.45 && volumeRatio > 0.45
CLOSE_LONG: unrealizedPnlPct > 0.016 || unrealizedPnlPct < -0.02 || drawdownSinceEntry > 0.03 || barsHeld > 24 || close < ma20
SHORT: candleReturn < -0.001 && momentum3 < -0.0055 && momentum5 < -0.005 && rsi14 < 46 && rsi14 > 32 && close < ma20 && closeLocation < 0.55 && volumeRatio > 0.45
CLOSE_SHORT: unrealizedPnlPct > 0.016 || unrealizedPnlPct < -0.02 || drawdownSinceEntry > 0.03 || barsHeld > 24 || close > ma20
POSITION: 0.8`

const legacySol5mThirtyDayTrendScript = `LONG: !(rsi14 > 60 && bbPctB > 0.55 && closeLocation > 0.65 && volumeRatio > 0.8 && momentum3 < 0.008 && momentum5 < 0.008 && factorScore < 2) && close > ma120 * 0.94 && rsi14 > 22 && rsi14 < 96 && volumeRatio > 0.1 && atrPct < 0.08
CLOSE_LONG: unrealizedPnlPct < -0.05 || drawdownSinceEntry > 0.05 || barsHeld > 144 || (close < ma120 * 0.92 && momentum5 < -0.01)
SHORT: rsi14 > 60 && bbPctB > 0.55 && closeLocation > 0.65 && volumeRatio > 0.8 && momentum3 < 0.008 && momentum5 < 0.008 && factorScore < 2
CLOSE_SHORT: unrealizedPnlPct > 0.006 || unrealizedPnlPct < -0.01 || drawdownSinceEntry > 0.035 || barsHeld > 10 || (close < ma20 && unrealizedPnlPct > 0.001) || rsi14 < 45
POSITION: 0.8`

const previousSol5mLongShortPulseScript = `LONG: close > ma120 * 0.985 && ma20 > ma60 * 0.997 && htfTrendScore > 0 && htfMomentum20 > -0.006 && momentum5 > 0.008 && momentum20 > 0 && rsi14 > 5 && rsi14 < 66 && volumeRatio > 0.05 && bbPctB > -1 && bbPctB < 1.2 && closeLocation > 0.5 && factorScore > -1 && atrPct < 0.026
CLOSE_LONG: unrealizedPnlPct > 0.04 || unrealizedPnlPct < -0.02 || drawdownSinceEntry > 0.05 || barsHeld > 288 || ((close < ma20 || maFast < maSlow || macd < macdSignal) && unrealizedPnlPct > 0.02)
SHORT: close < ma120 * 0.94 && htfMomentum20 < 0 && momentum5 < -0.006 && momentum20 < -0.012 && rsi14 > 18 && rsi14 < 52 && volumeRatio > 0.1 && bbPctB > -0.5 && bbPctB < 1.7 && closeLocation < 0.8 && factorScore < 1.5 && atrPct < 0.022
CLOSE_SHORT: unrealizedPnlPct > 0.03 || unrealizedPnlPct < -0.035 || drawdownSinceEntry > 0.025 || barsHeld > 48 || htfTrendScore > 0.2 || ((close > ma20 || maFast > maSlow || macd > macdSignal) && unrealizedPnlPct > 0.003)
POSITION: 1`

const sol5mLongShortPulseScript = `LONG: close > ma120 && ma20 > ma60 * 0.997 && htfTrendScore > 0 && htfMomentum20 > -0.006 && momentum5 > 0.008 && momentum20 > 0 && rsi14 > 5 && rsi14 < 66 && volumeRatio > 0.05 && bbPctB > -1 && bbPctB < 1.2 && closeLocation > 0.5 && factorScore > 0 && atrPct < 0.03
CLOSE_LONG: unrealizedPnlPct > 0.04 || unrealizedPnlPct < -0.02 || drawdownSinceEntry > 0.05 || barsHeld > 288 || ((close < ma20 || maFast < maSlow || macd < macdSignal) && unrealizedPnlPct > 0.02)
SHORT: close < ma120 * 0.98 && ma20 < ma60 * 1.004 && htfMomentum20 < 0 && momentum5 < -0.01 && momentum20 < 0.002 && rsi14 > 28 && rsi14 < 68 && volumeRatio > 0.1 && bbPctB > -0.5 && bbPctB < 1.7 && closeLocation < 0.8 && factorScore < 0 && atrPct < 0.018
CLOSE_SHORT: unrealizedPnlPct > 0.03 || unrealizedPnlPct < -0.025 || drawdownSinceEntry > 0.025 || barsHeld > 48 || htfTrendScore > 0 || ((close > ma20 || maFast > maSlow || macd > macdSignal) && unrealizedPnlPct > 0.003)
POSITION: 0.8`

const defaultPreferences: AppPreferences = {
  selectedSymbol: 'BTCUSDT',
  selectedInterval: '1d',
  watchlist: DEFAULT_WATCHLIST,
  liveMode: 'paper',
  backtestParams: defaultBacktestParams,
  userSettings: defaultUserSettings,
}

const defaultStrategies: StrategyConfig[] = [
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
  {
    id: 'script-sol-15m-high-win',
    name: 'SOL 15m 高胜率脚本',
    type: 'script',
    symbol: 'SOLUSDT',
    orderAmount: 100,
    maxPositionRatio: 35,
    takeProfitRatio: 0.8,
    stopLossRatio: 6.5,
    interval: '15m',
    slippageLimit: 0.2,
    status: 'stopped',
    pnl: 0,
    runtimeMs: 0,
    riskLevel: 'normal',
    customScript: sol15mHighWinScript,
  },
  {
    id: 'script-sol-5m-long-short-pulse',
    name: 'SOL 5m 多空脉冲脚本',
    type: 'script',
    symbol: 'SOLUSDT',
    orderAmount: 100,
    maxPositionRatio: 35,
    takeProfitRatio: 2,
    stopLossRatio: 6,
    interval: '5m',
    slippageLimit: 0.2,
    status: 'stopped',
    pnl: 0,
    runtimeMs: 0,
    riskLevel: 'normal',
    customScript: sol5mLongShortPulseScript,
  },
]

const defaultState: PersistedState = {
  preferences: defaultPreferences,
  strategies: defaultStrategies,
  riskRules: defaultRiskRules,
  riskEvents: [
    {
      id: 'risk-startup',
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
      id: 'log-seed-1',
      time: Date.now() - 320_000,
      level: 'info',
      scope: 'system',
      message: '系统初始化完成，当前运行在模拟执行模式。',
    },
  ],
  apiRecords: [],
}

function dataFilePath(): string {
  return join(app.getPath('userData'), 'quant-platform-state.json')
}

function sqliteFilePath(): string {
  return join(app.getPath('userData'), 'quant-platform-state.sqlite')
}

function encryptSecret(secret: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(secret).toString('base64')}`
  }
  return `fallback:${Buffer.from(secret, 'utf8').toString('base64')}`
}

function decryptSecret(encryptedSecret: string): string {
  if (encryptedSecret.startsWith('safe:')) {
    return safeStorage.decryptString(Buffer.from(encryptedSecret.slice(5), 'base64'))
  }
  if (encryptedSecret.startsWith('fallback:')) {
    return Buffer.from(encryptedSecret.slice(9), 'base64').toString('utf8')
  }
  return ''
}

function normalizeApiRecord(record: Partial<ApiRecord>): ApiRecord {
  return {
    id: record.id ?? crypto.randomUUID(),
    exchange: 'Binance USD-M Futures',
    environment: record.environment ?? 'live',
    label: record.label ?? '未命名 API',
    apiKeyTail: record.apiKeyTail ?? '******',
    canRead: record.canRead ?? false,
    canTrade: record.canTrade ?? false,
    tradePermissionRequested: record.tradePermissionRequested ?? record.canTrade ?? false,
    withdrawWarning: record.withdrawWarning ?? true,
    latencyMs: record.latencyMs ?? 0,
    status: record.status ?? 'disconnected',
    lastCheckedAt: record.lastCheckedAt ?? Date.now(),
    lastError: record.lastError,
    encryptedSecret: record.encryptedSecret ?? '',
    apiKey: record.apiKey ?? '',
  }
}

function normalizePreferences(preferences?: Partial<AppPreferences>): AppPreferences {
  const selectedSymbol = normalizeSymbolInput(preferences?.selectedSymbol ?? defaultPreferences.selectedSymbol) ?? defaultPreferences.selectedSymbol
  const backtestParams = normalizeBacktestParams(preferences?.backtestParams)
  const backtestSymbol = normalizeSymbolInput(backtestParams.symbol) ?? selectedSymbol
  const watchlist = normalizeWatchlistSymbols([
    ...(preferences?.watchlist ?? defaultPreferences.watchlist),
    selectedSymbol,
    backtestSymbol,
  ])
  return {
    ...defaultPreferences,
    ...preferences,
    selectedSymbol: watchlist.includes(selectedSymbol) ? selectedSymbol : watchlist[0],
    watchlist,
    backtestParams: {
      ...backtestParams,
      symbol: watchlist.includes(backtestSymbol) ? backtestSymbol : watchlist[0],
    },
    userSettings: {
      ...defaultUserSettings,
      ...preferences?.userSettings,
    },
  }
}

function normalizeStrategies(strategies?: StrategyConfig[]): StrategyConfig[] {
  const items = Array.isArray(strategies) ? strategies : defaultStrategies
  const requiredStrategies = defaultStrategies.filter((strategy) => strategy.id === 'script-sol-5m-long-short-pulse')
  const upgradeableSol5mScripts = new Set([
    legacySol5mLongShortPulseScript,
    legacySol5mLooseScript,
    legacySol5mMomentumPulseScript,
    legacySol5mThirtyDayTrendScript,
    previousSol5mLongShortPulseScript,
  ])
  return [
    ...items.map((strategy) => {
      const isSol5mScript = strategy.type === 'script' && strategy.symbol === 'SOLUSDT' && strategy.interval === '5m'
      const shouldUpgrade =
        strategy.id === 'script-sol-5m-long-short-pulse'
          ? !strategy.customScript || upgradeableSol5mScripts.has(strategy.customScript)
          : isSol5mScript && strategy.customScript !== undefined && upgradeableSol5mScripts.has(strategy.customScript)
      return shouldUpgrade ? { ...strategy, customScript: sol5mLongShortPulseScript } : strategy
    }),
    ...requiredStrategies.filter((strategy) => !items.some((item) => item.id === strategy.id)),
  ]
}

export class LocalStore {
  private state: PersistedState = defaultState
  private db: DatabaseSync | null = null
  private feishuTenantAccessToken = ''
  private feishuTenantTokenExpiresAt = 0
  private readonly listeners = new Set<(patch: AppStatePatch) => void>()

  subscribe(listener: (patch: AppStatePatch) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publishChange(patch: AppStatePatch): void {
    for (const listener of this.listeners) {
      try {
        listener(patch)
      } catch {
        // Best effort.
      }
    }
  }

  async load(): Promise<void> {
    const file = sqliteFilePath()
    await mkdir(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      create table if not exists kv_store (
        key text primary key,
        value text not null,
        updated_at integer not null
      );
      create table if not exists app_settings (
        key text primary key,
        value text not null,
        updated_at integer not null
      );
    `)

    const stored = this.db.prepare('select value from kv_store where key = ?').get('app_state') as { value?: string } | undefined
    if (stored?.value) {
      this.hydrate(JSON.parse(stored.value) as PersistedState)
      return
    }

    try {
      const content = await readFile(dataFilePath(), 'utf8')
      this.hydrate(JSON.parse(content) as PersistedState)
      await this.save()
    } catch {
      await this.save()
    }
  }

  private hydrate(parsed: PersistedState): void {
    const apiRecords = Array.isArray(parsed.apiRecords) ? parsed.apiRecords.map((record) => normalizeApiRecord(record)) : []
    this.state = {
      ...defaultState,
      ...parsed,
      preferences: normalizePreferences(parsed.preferences),
      strategies: normalizeStrategies(parsed.strategies),
      riskRules: { ...defaultRiskRules, ...parsed.riskRules },
      strategyPositions: rebuildStrategyPositions(parsed.orders ?? []),
      apiRecords,
    }
  }

  async save(): Promise<void> {
    if (!this.db) {
      const file = sqliteFilePath()
      await mkdir(dirname(file), { recursive: true })
      this.db = new DatabaseSync(file)
      this.db.exec(`
        create table if not exists kv_store (
          key text primary key,
          value text not null,
          updated_at integer not null
        );
        create table if not exists app_settings (
          key text primary key,
          value text not null,
          updated_at integer not null
        );
      `)
    }
    const now = Date.now()
    this.db
      .prepare(
        `insert into kv_store (key, value, updated_at)
         values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run('app_state', JSON.stringify(this.state), now)
    this.db
      .prepare(
        `insert into app_settings (key, value, updated_at)
         values (?, ?, ?)
         on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run('preferences', JSON.stringify(this.state.preferences), now)
  }

  snapshot(): AppStateSnapshot {
    return {
      ...this.state,
      apiProfiles: this.state.apiRecords.map(({ encryptedSecret: _encryptedSecret, apiKey: _apiKey, ...profile }) => profile),
    }
  }

  getCredentials(id: string): { apiKey: string; apiSecret: string } | undefined {
    const record = this.state.apiRecords.find((item) => item.id === id)
    if (!record) return undefined
    return {
      apiKey: record.apiKey,
      apiSecret: decryptSecret(record.encryptedSecret),
    }
  }

  async updatePreferences(patch: Partial<AppPreferences>): Promise<AppPreferences> {
    this.state.preferences = normalizePreferences({
      ...this.state.preferences,
      ...patch,
      backtestParams: patch.backtestParams ?? this.state.preferences.backtestParams,
      userSettings: patch.userSettings ?? this.state.preferences.userSettings,
    })
    await this.save()
    this.publishChange({ preferences: this.state.preferences })
    return this.state.preferences
  }

  async addApiProfile(input: StoredApiInput): Promise<ApiProfile> {
    const id = crypto.randomUUID()
    const now = Date.now()
    const profile: ApiRecord = {
      id,
      exchange: 'Binance USD-M Futures',
      environment: input.environment,
      label: input.label,
      apiKey: input.apiKey,
      encryptedSecret: encryptSecret(input.apiSecret),
      apiKeyTail: `${input.apiKey.length > 6 ? '****' : '******'}${input.apiKey.slice(-6)}`,
      canRead: false,
      canTrade: false,
      tradePermissionRequested: input.canTrade,
      withdrawWarning: true,
      latencyMs: 0,
      status: 'disconnected',
      lastCheckedAt: now,
      lastError: undefined,
    }
    this.state.apiRecords.push(profile)
    this.addLog('api', 'info', `已添加 API 配置「${input.label}」，Secret 已加密存储。`)
    await this.save()
    this.publishChange({ apiProfiles: this.snapshot().apiProfiles })
    return this.snapshot().apiProfiles.find((item) => item.id === id)!
  }

  async updateApiProfile(profile: ApiProfile): Promise<void> {
    const index = this.state.apiRecords.findIndex((item) => item.id === profile.id)
    if (index >= 0) {
      this.state.apiRecords[index] = { ...this.state.apiRecords[index], ...profile }
      await this.save()
      this.publishChange({ apiProfiles: this.snapshot().apiProfiles })
    }
  }

  async removeApiProfile(id: string): Promise<void> {
    this.state.apiRecords = this.state.apiRecords.filter((item) => item.id !== id)
    this.addLog('api', 'warn', '已删除 API 配置。')
    await this.save()
    this.publishChange({ apiProfiles: this.snapshot().apiProfiles })
  }

  async updateAssets(assets: AccountAsset[]): Promise<AccountAsset[]> {
    this.state.assets = assets
    await this.save()
    this.publishChange({ assets: this.state.assets })
    return this.state.assets
  }

  async updatePositions(positions: AccountPosition[]): Promise<AccountPosition[]> {
    this.state.positions = positions
    await this.save()
    this.publishChange({ positions: this.state.positions })
    return this.state.positions
  }

  async updateStrategyPositionMark(strategyId: string, symbol: string, markPrice: number): Promise<StrategyPosition | undefined> {
    const next = updateStrategyPositionMarkList(this.state.strategyPositions, strategyId, symbol, markPrice)
    if (next !== this.state.strategyPositions) {
      this.state.strategyPositions = next
      await this.save()
      this.publishChange({ strategyPositions: this.state.strategyPositions })
    }
    return this.state.strategyPositions.find((position) => position.strategyId === strategyId && position.symbol === symbol)
  }

  async addOrder(order: OrderRecord): Promise<OrderRecord> {
    this.state.orders.unshift(order)
    this.state.orders = this.state.orders.slice(0, 180)
    this.state.strategyPositions = applyStrategyOrder(this.state.strategyPositions, order)
    this.addLog('trade', 'info', `订单已记录：${order.symbol} ${order.side} ${order.quantity} ${order.status}`, order.strategyId)
    await this.save()
    this.publishChange({ orders: this.state.orders, strategyPositions: this.state.strategyPositions })
    return order
  }

  async upsertStrategies(strategies: StrategyConfig[]): Promise<StrategyConfig[]> {
    this.state.strategies = strategies
    await this.save()
    this.publishChange({ strategies: this.state.strategies })
    return this.state.strategies
  }

  async updateRiskRules(riskRules: RiskRuleSet): Promise<RiskRuleSet> {
    this.state.riskRules = riskRules
    this.addLog('risk', 'warn', '全局风控规则已更新。')
    await this.save()
    this.publishChange({ riskRules: this.state.riskRules })
    return this.state.riskRules
  }

  addRiskEvent(event: RiskEvent): void {
    this.state.riskEvents.unshift(event)
    this.state.riskEvents = this.state.riskEvents.slice(0, 80)
    this.addLog('risk', event.level === 'danger' ? 'error' : 'warn', `${event.title}：${event.message}`)
    this.publishChange({ riskEvents: this.state.riskEvents, logs: this.state.logs })
    this.showRiskNotification(event)
    void this.syncFeishuNotification(event)
  }

  private showRiskNotification(event: RiskEvent): void {
    if (event.level === 'normal') return
    if (!this.state.preferences.userSettings.notifyOnRiskEvent || !Notification.isSupported()) return
    try {
      new Notification({
        title: `风控提醒 · ${event.title}`,
        body: event.message,
        urgency: event.level === 'danger' ? 'critical' : 'normal',
        silent: false,
      }).show()
    } catch (error) {
      this.addLog('system', 'warn', `系统通知发送失败：${String(error).replace(/^Error:\s*/, '')}`)
    }
  }

  private riskEventScore(level: RiskEvent['level']): number {
    if (level === 'danger') return 4
    if (level === 'warning') return 3
    if (level === 'watch') return 2
    return 1
  }

  private async fetchFeishuTenantAccessToken(settings: UserSettings): Promise<string> {
    const now = Date.now()
    if (this.feishuTenantAccessToken && now < this.feishuTenantTokenExpiresAt - 60_000) return this.feishuTenantAccessToken
    const response = await net.fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: settings.feishuAppId,
        app_secret: settings.feishuAppSecret,
      }),
    })
    const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(payload.msg || `飞书 tenant_access_token 获取失败：HTTP ${response.status}`)
    }
    this.feishuTenantAccessToken = payload.tenant_access_token
    this.feishuTenantTokenExpiresAt = now + Math.max(60, payload.expire ?? 3600) * 1000
    return this.feishuTenantAccessToken
  }

  private async syncFeishuNotification(event: RiskEvent): Promise<void> {
    const settings = this.state.preferences.userSettings
    if (!settings.feishuNotifyEnabled) return
    const threshold = Math.max(1, Math.min(4, Math.floor(Number.isFinite(settings.feishuThreshold) ? settings.feishuThreshold : 4)))
    if (this.riskEventScore(event.level) < threshold) return
    if (!settings.feishuAppId.trim() || !settings.feishuAppSecret.trim() || !settings.feishuUserId.trim()) return
    try {
      const token = await this.fetchFeishuTenantAccessToken(settings)
      const text = [
        `【${event.level === 'danger' ? '危险' : event.level === 'warning' ? '警告' : event.level === 'watch' ? '关注' : '正常'}】${event.title}`,
        event.message,
        event.strategyId ? `策略ID：${event.strategyId}` : '',
        `时间：${new Date(event.time).toLocaleString('zh-CN')}`,
      ].filter(Boolean).join('\n')
      const response = await net.fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=user_id', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: settings.feishuUserId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      })
      const payload = await response.json() as { code?: number; msg?: string }
      if (!response.ok || payload.code !== 0) {
        throw new Error(payload.msg || `飞书消息发送失败：HTTP ${response.status}`)
      }
      this.addLog('system', 'info', `已同步风控通知到飞书：${event.title}`)
    } catch (error) {
      this.addLog('system', 'warn', `飞书通知同步失败：${String(error).replace(/^Error:\s*/, '')}`)
    } finally {
      await this.save()
    }
  }

  addLog(scope: LogEntry['scope'], level: LogEntry['level'], message: string, strategyId?: string): void {
    this.state.logs.unshift({
      id: crypto.randomUUID(),
      time: Date.now(),
      scope,
      level,
      strategyId,
      message,
    })
    this.state.logs = this.state.logs.slice(0, 200)
    this.publishChange({ logs: this.state.logs })
  }

  async clearLogs(filter?: LogClearFilter): Promise<LogEntry[]> {
    if (!filter?.scope && !filter?.strategyId) {
      this.state.logs = []
    } else {
      this.state.logs = this.state.logs.filter((log) => {
        const matchesScope = !filter.scope || log.scope === filter.scope
        const matchesStrategy = !filter.strategyId || log.strategyId === filter.strategyId
        return !(matchesScope && matchesStrategy)
      })
    }
    await this.save()
    this.publishChange({ logs: this.state.logs })
    return this.state.logs
  }
}
