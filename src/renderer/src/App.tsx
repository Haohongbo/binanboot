import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, MouseEvent, ReactElement } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bell,
  Bot,
  Briefcase,
  CircleDollarSign,
  ClipboardList,
  DatabaseZap,
  Download,
  FileClock,
  Gauge,
  GripVertical,
  KeyRound,
  LayoutDashboard,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  PenLine,
  UserCircle,
  X,
} from 'lucide-react'
import type { AppUpdateState } from '../../shared/updates'
import type {
  AccountPosition,
  BacktestParams,
  BacktestResult,
  CandleInterval,
  OrderSide,
  OrderType,
  PositionSide,
  RiskEvent,
  RiskLevel,
  StrategyPosition,
  StrategyConfig,
  UserSettings,
} from '../../shared/types'
import { normalizeSymbolInput } from '../../shared/market-symbols'
import {
  formatCompact,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRatio,
  formatRuntime,
  formatTime,
  riskClass,
  riskText,
  statusText,
  symbolDisplay,
} from './lib/format'
import { bollinger, macd, rsi } from './lib/indicators'
import {
  PageId,
  currentRiskLevel,
  refreshRuntime,
  useQuantStore,
} from './store'
import { useAccountAutoSync } from './hooks/useAccountAutoSync'
import { useAppStateSync } from './hooks/useAppStateSync'
import { useMarketStream } from './hooks/useMarketStream'
import { usePreferencePersistence } from './hooks/usePreferencePersistence'
import { useWatchlistTickerSync } from './hooks/useWatchlistTickerSync'
import { ApiPage } from './pages/ApiPage'
import { EquityCurveChart, MarketChart, MiniAreaChart } from './components/Charts'

type NavItem = { id: PageId; label: string; icon: React.ComponentType<{ size?: number }>; children?: Array<{ id: PageId; label: string }> }

const navItems: NavItem[] = [
  { id: 'dashboard', label: '控制台', icon: LayoutDashboard },
  {
    id: 'strategies',
    label: '策略管理',
    icon: Bot,
    children: [
      { id: 'strategies', label: '策略配置' },
      { id: 'strategy-diagnostics', label: '策略诊断日志' },
    ],
  },
  { id: 'backtest', label: '回测中心', icon: BarChart3 },
  { id: 'orders', label: '交易记录', icon: ClipboardList },
  { id: 'risk', label: '风控中心', icon: ShieldCheck },
  { id: 'assets', label: '资产账户', icon: Briefcase },
  { id: 'api', label: 'API 管理', icon: KeyRound },
  { id: 'logs', label: '系统日志', icon: ScrollText },
  { id: 'settings', label: '用户设置', icon: Settings },
]

const navExpandedStorageKey = 'quant-nav-expanded'

const intervals: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d']

function findSymbolPosition(positions: AccountPosition[], symbol: string): AccountPosition | undefined {
  return positions
    .filter((position) => position.symbol === symbol && Math.abs(position.positionAmount) > 0)
    .sort((left, right) => Math.abs(right.positionAmount) - Math.abs(left.positionAmount))[0]
}

function positionDisplay(position: AccountPosition): string {
  const side = position.positionSide === 'BOTH' ? (position.positionAmount < 0 ? 'SHORT' : 'LONG') : position.positionSide
  return `${side} ${formatNumber(Math.abs(position.positionAmount), 4)}`
}

function findStrategyPosition(positions: StrategyPosition[], strategyId: string, symbol: string): StrategyPosition | undefined {
  return positions
    .filter((position) => position.strategyId === strategyId && position.symbol === symbol)
    .sort((left, right) => right.updateTime - left.updateTime)[0]
}

function strategyPositionDisplay(position: StrategyPosition): string {
  return `${position.positionAmount < 0 ? 'SHORT' : 'LONG'} ${formatNumber(Math.abs(position.positionAmount), 4)}`
}

function hasLiveStrategyExposure(strategy: StrategyConfig): boolean {
  return strategy.status === 'running' || strategy.status === 'tripped'
}

function strategyPnlClass(strategy: StrategyConfig): string {
  if (!hasLiveStrategyExposure(strategy)) return 'muted'
  return strategy.pnl >= 0 ? 'up' : 'down'
}

function strategyPnlText(strategy: StrategyConfig, showSign = false): string {
  if (!hasLiveStrategyExposure(strategy)) return '--'
  return `${showSign && strategy.pnl >= 0 ? '+' : ''}${formatNumber(strategy.pnl, 2)}`
}

const defaultCustomScript = `LONG: candleReturn > 0.001 && momentum3 > 0.0055 && momentum5 > 0.005 && rsi14 > 50 && rsi14 < 60 && close > ma20 && closeLocation > 0.45 && volumeRatio > 0.45
CLOSE_LONG: unrealizedPnlPct > 0.016 || unrealizedPnlPct < -0.02 || drawdownSinceEntry > 0.03 || barsHeld > 24 || close < ma20
SHORT: candleReturn < -0.001 && momentum3 < -0.0055 && momentum5 < -0.005 && rsi14 < 46 && rsi14 > 32 && close < ma20 && closeLocation < 0.55 && volumeRatio > 0.45
CLOSE_SHORT: unrealizedPnlPct > 0.016 || unrealizedPnlPct < -0.02 || drawdownSinceEntry > 0.03 || barsHeld > 24 || close > ma20
POSITION: 0.8`

function playRiskAlertSound(level: RiskEvent['level']): void {
  try {
    const audioContext = new AudioContext()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const now = audioContext.currentTime
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(level === 'danger' ? 880 : 660, now)
    oscillator.frequency.exponentialRampToValueAtTime(level === 'danger' ? 560 : 440, now + 0.22)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.28)
    window.setTimeout(() => void audioContext.close(), 420)
  } catch {
    // System audio can be blocked by OS or device policy; the in-app toast still appears.
  }
}

function moveStrategyInList(strategies: StrategyConfig[], strategyId: string, direction: -1 | 1): StrategyConfig[] {
  const index = strategies.findIndex((strategy) => strategy.id === strategyId)
  const targetIndex = index + direction
  if (index < 0 || targetIndex < 0 || targetIndex >= strategies.length) return strategies
  const next = [...strategies]
  const [strategy] = next.splice(index, 1)
  next.splice(targetIndex, 0, strategy)
  return next
}

function placeStrategyBefore(strategies: StrategyConfig[], draggedId: string, targetId: string): StrategyConfig[] {
  if (draggedId === targetId) return strategies
  const dragged = strategies.find((strategy) => strategy.id === draggedId)
  if (!dragged) return strategies
  const withoutDragged = strategies.filter((strategy) => strategy.id !== draggedId)
  const targetIndex = withoutDragged.findIndex((strategy) => strategy.id === targetId)
  if (targetIndex < 0) return strategies
  const next = [...withoutDragged]
  next.splice(targetIndex, 0, dragged)
  return next
}

function App(): ReactElement {
  const {
    isBootstrapped,
    selectedSymbol,
    selectedInterval,
    setSelectedSymbol,
    setSelectedInterval,
    userSettings,
    riskEvents,
  } = useQuantStore()
  useAppStateSync()
  usePreferencePersistence()
  useMarketStream()
  useWatchlistTickerSync()
  useAccountAutoSync()
  const [riskToast, setRiskToast] = useState<RiskEvent | null>(null)
  const [showIndicators, setShowIndicators] = useState(true)
  const [drawingMode, setDrawingMode] = useState(false)
  const latestRiskEventIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    const timer = window.setInterval(refreshRuntime, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!isBootstrapped) return undefined
    const latestRiskEvent = riskEvents[0]
    if (latestRiskEventIdRef.current === undefined) {
      latestRiskEventIdRef.current = latestRiskEvent?.id ?? ''
      return undefined
    }
    if (!latestRiskEvent) return undefined
    if (latestRiskEventIdRef.current === latestRiskEvent.id) return undefined
    latestRiskEventIdRef.current = latestRiskEvent.id
    if (!userSettings.notifyOnRiskEvent || latestRiskEvent.level === 'normal') return undefined
    setRiskToast(latestRiskEvent)
    playRiskAlertSound(latestRiskEvent.level)
    const timer = window.setTimeout(() => {
      setRiskToast((current) => (current?.id === latestRiskEvent.id ? null : current))
    }, 7200)
    return () => window.clearTimeout(timer)
  }, [isBootstrapped, riskEvents, userSettings.notifyOnRiskEvent])

  if (!isBootstrapped) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">
          <Activity size={30} />
        </div>
        <div>
          <strong>虚拟货币量化自动化交易平台</strong>
          <span>正在初始化交易控制台...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="workspace">
        <TopBar onSelectSymbol={setSelectedSymbol} />
        <Toolbar
          selectedSymbol={selectedSymbol}
          selectedInterval={selectedInterval}
          onSelectSymbol={setSelectedSymbol}
          onSelectInterval={setSelectedInterval}
          showIndicators={showIndicators}
          drawingMode={drawingMode}
          onToggleIndicators={() => setShowIndicators((current) => !current)}
          onToggleDrawing={() => setDrawingMode((current) => !current)}
        />
        <Content showIndicators={showIndicators} drawingMode={drawingMode} />
      </main>
      {riskToast && (
        <div className={`risk-toast ${riskClass(riskToast.level)}`} role="alert">
          <i />
          <div>
            <strong>{riskToast.title}</strong>
            <p>{riskToast.message}</p>
            <span>{formatTime(riskToast.time)} · {riskText(riskToast.level)}</span>
          </div>
          <button className="icon-button compact" title="关闭提醒" onClick={() => setRiskToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function Sidebar(): ReactElement {
  const { activePage, setActivePage, systemTime, marketStatus } = useQuantStore()
  const [expandedNav, setExpandedNav] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return { strategies: true }
    try {
      const stored = window.localStorage.getItem(navExpandedStorageKey)
      return { strategies: true, ...(stored ? JSON.parse(stored) as Record<string, boolean> : {}) }
    } catch {
      return { strategies: true }
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(navExpandedStorageKey, JSON.stringify(expandedNav))
    } catch {
      // Ignore localStorage failures; the menu still works for this session.
    }
  }, [expandedNav])

  function openPage(page: PageId): void {
    setActivePage(page)
  }

  function toggleNavGroup(page: PageId): void {
    setExpandedNav((current) => ({ ...current, [page]: !(current[page] ?? true) }))
  }

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <BarChart3 size={24} />
        <strong>量化交易控制台</strong>
      </div>
      <nav className="side-nav">
        {navItems.map((item) => {
          const Icon = item.icon
          const isGroupActive = activePage === item.id || item.children?.some((child) => child.id === activePage)
          const hasChildren = Boolean(item.children?.length)
          const isExpanded = !hasChildren || (expandedNav[item.id] ?? true)
          return (
            <div key={item.id} className="nav-group">
              <button
                className={isGroupActive ? 'nav-item active' : 'nav-item'}
                onClick={hasChildren ? () => toggleNavGroup(item.id) : () => openPage(item.id)}
                aria-expanded={hasChildren ? isExpanded : undefined}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
              {item.children && isExpanded && (
                <div className="nav-submenu">
                  {item.children.map((child) => (
                    <button
                      key={child.id}
                      className={activePage === child.id ? 'nav-subitem active' : 'nav-subitem'}
                      onClick={() => {
                        setExpandedNav((current) => ({ ...current, [item.id]: true }))
                        setActivePage(child.id)
                      }}
                    >
                      <span>{child.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>
      <div className="sidebar-status">
        <span>系统时间</span>
        <strong>{formatDate(systemTime)}</strong>
        <div className={`status-dot ${marketStatus}`}>
          <i />
          {marketStatus === 'live' ? 'Binance 实时连接' : marketStatus === 'mock' ? '模拟行情模式' : '连接检测中'}
        </div>
      </div>
    </aside>
  )
}

function TopBar({ onSelectSymbol }: { onSelectSymbol: (symbol: string) => void }): ReactElement {
  const { topTickers, watchlist, selectedSymbol, riskEvents, setActivePage, addWatchlistSymbol, removeWatchlistSymbol } = useQuantStore()
  const [isAddingSymbol, setIsAddingSymbol] = useState(false)
  const [symbolDraft, setSymbolDraft] = useState('')
  const [symbolError, setSymbolError] = useState('')
  const [isNotificationOpen, setIsNotificationOpen] = useState(false)
  const [lastNotificationReadAt, setLastNotificationReadAt] = useState(() => Number(window.localStorage.getItem('quant-notification-read-at') ?? 0))
  const notificationRef = useRef<HTMLDivElement | null>(null)
  const unreadNotifications = riskEvents.filter((event) => event.time > lastNotificationReadAt).length
  const visibleNotifications = riskEvents.slice(0, 12)

  useEffect(() => {
    if (!isNotificationOpen) return undefined
    function closeOnOutsideClick(event: PointerEvent): void {
      if (notificationRef.current?.contains(event.target as Node)) return
      setIsNotificationOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') setIsNotificationOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isNotificationOpen])

  function handleDoubleClick(event: MouseEvent<HTMLElement>): void {
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button,input,select,label')) return
    void window.quantApi.toggleWindowMaximized()
  }

  function resetAddForm(): void {
    setIsAddingSymbol(false)
    setSymbolDraft('')
    setSymbolError('')
  }

  function submitSymbol(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const normalized = normalizeSymbolInput(symbolDraft)
    if (!normalized) {
      setSymbolError('请输入有效的 USDT 交易对')
      return
    }
    addWatchlistSymbol(normalized)
    onSelectSymbol(normalized)
    resetAddForm()
  }

  function deleteSymbol(symbol: string): void {
    removeWatchlistSymbol(symbol)
    if (symbol === selectedSymbol) {
      const nextSymbol = watchlist.find((item) => item !== symbol)
      if (nextSymbol) onSelectSymbol(nextSymbol)
    }
  }

  function toggleNotifications(): void {
    const nextOpen = !isNotificationOpen
    setIsNotificationOpen(nextOpen)
    if (nextOpen) {
      const now = Date.now()
      setLastNotificationReadAt(now)
      window.localStorage.setItem('quant-notification-read-at', String(now))
    }
  }

  return (
    <header className="topbar" onDoubleClick={handleDoubleClick}>
      <div className="ticker-strip">
        {topTickers.map((ticker) => (
          <div key={ticker.symbol} className="ticker-chip-shell">
            <button
              className={ticker.symbol === selectedSymbol ? 'ticker-chip active' : 'ticker-chip'}
              onClick={() => onSelectSymbol(ticker.symbol)}
            >
              <span>{symbolDisplay(ticker.symbol)}</span>
              <strong>{ticker.lastPrice > 0 ? formatPrice(ticker.lastPrice) : '--'}</strong>
              <em className={ticker.priceChangePercent >= 0 ? 'up' : 'down'}>{formatPercent(ticker.priceChangePercent)}</em>
            </button>
            <button
              className="ticker-remove"
              title={`删除 ${symbolDisplay(ticker.symbol)}`}
              disabled={watchlist.length <= 1}
              onClick={() => deleteSymbol(ticker.symbol)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {isAddingSymbol ? (
          <form className="ticker-add-form" onSubmit={submitSymbol}>
            <input
              value={symbolDraft}
              autoFocus
              placeholder="如 DOGE"
              onChange={(event) => {
                setSymbolDraft(event.target.value)
                setSymbolError('')
              }}
            />
            <button type="submit" className="icon-button compact" title="新增币种">
              <Plus size={16} />
            </button>
            <button type="button" className="icon-button compact" title="取消" onClick={resetAddForm}>
              <X size={16} />
            </button>
            {symbolError && <small>{symbolError}</small>}
          </form>
        ) : (
          <button className="ticker-add-button" title="新增币种" onClick={() => setIsAddingSymbol(true)}>
            <Plus size={18} />
          </button>
        )}
      </div>
      <div className="top-actions" ref={notificationRef}>
        <button className={unreadNotifications > 0 ? 'icon-button notification-button has-unread' : 'icon-button notification-button'} title="通知" onClick={toggleNotifications}>
          <Bell size={18} />
          {unreadNotifications > 0 && <span>{Math.min(unreadNotifications, 99)}</span>}
        </button>
        {isNotificationOpen && (
          <div className="notification-popover">
            <div className="notification-head">
              <strong>通知消息</strong>
              <button className="ghost-button small" onClick={() => setActivePage('risk')}>
                查看风控中心
              </button>
            </div>
            <div className="notification-list">
              {visibleNotifications.length === 0 ? (
                <p className="empty-state">暂无通知</p>
              ) : (
                visibleNotifications.map((event) => (
                  <button key={event.id} className="notification-item" onClick={() => setActivePage('risk')}>
                    <i className={riskClass(event.level)} />
                    <span>
                      <strong>{event.title}</strong>
                      <em>{event.message}</em>
                      <small>{formatDate(event.time)} · {riskText(event.level)}</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        <button className="icon-button" title="系统设置" onClick={() => setActivePage('settings')}>
          <Settings size={18} />
        </button>
        <button className="icon-button" title="账户">
          <UserCircle size={21} />
        </button>
      </div>
    </header>
  )
}

function Toolbar({
  selectedSymbol,
  selectedInterval,
  onSelectSymbol,
  onSelectInterval,
  showIndicators,
  drawingMode,
  onToggleIndicators,
  onToggleDrawing,
}: {
  selectedSymbol: string
  selectedInterval: CandleInterval
  onSelectSymbol: (symbol: string) => void
  onSelectInterval: (interval: CandleInterval) => void
  showIndicators: boolean
  drawingMode: boolean
  onToggleIndicators: () => void
  onToggleDrawing: () => void
}): ReactElement {
  const { liveMode, setLiveMode, marketStatus, currentMarket, watchlist } = useQuantStore()
  const bestBid = currentMarket?.bids[0]?.price
  const bestAsk = currentMarket?.asks[0]?.price
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined
  return (
    <section className="toolbar">
      <div className="symbol-title">
        <select value={selectedSymbol} onChange={(event) => onSelectSymbol(event.target.value)}>
          {watchlist.map((symbol) => (
            <option key={symbol} value={symbol}>
              {symbolDisplay(symbol)}
            </option>
          ))}
        </select>
        <div>
          <span className={currentMarket?.ticker.priceChangePercent && currentMarket.ticker.priceChangePercent >= 0 ? 'up' : 'down'}>
            {currentMarket ? formatPrice(currentMarket.ticker.lastPrice) : '--'}
          </span>
          <small>
            最新成交 {currentMarket ? formatPercent(currentMarket.ticker.priceChangePercent) : '--'} · 延迟 {currentMarket?.ticker.latencyMs ?? 0}ms
            {midPrice ? ` · 盘口中间价 ${formatPrice(midPrice)}` : ''}
          </small>
        </div>
      </div>
      <div className="interval-group" role="group" aria-label="K线周期">
        {intervals.map((interval) => (
          <button
            key={interval}
            className={interval === selectedInterval ? 'active' : ''}
            onClick={() => onSelectInterval(interval)}
          >
            {interval}
          </button>
        ))}
      </div>
      <div className="toolbar-tools">
        <button
          className={showIndicators ? 'ghost-button active' : 'ghost-button'}
          onClick={onToggleIndicators}
          aria-pressed={showIndicators}
          title={showIndicators ? '隐藏指标' : '显示指标'}
        >
          <SlidersHorizontal size={16} />
          指标
        </button>
        <button
          className={drawingMode ? 'ghost-button active' : 'ghost-button'}
          onClick={onToggleDrawing}
          aria-pressed={drawingMode}
          title={drawingMode ? '退出画线' : '进入画线'}
        >
          <PenLine size={16} />
          画线
        </button>
        <label className="mode-toggle">
          <input
            type="checkbox"
            checked={liveMode === 'live'}
            onChange={(event) => setLiveMode(event.target.checked ? 'live' : 'paper')}
          />
          <span>{liveMode === 'live' ? '实盘' : '模拟'}</span>
        </label>
        <div className={`market-pill ${marketStatus}`}>{marketStatus === 'live' ? '实时' : marketStatus === 'mock' ? '模拟' : '连接中'}</div>
      </div>
    </section>
  )
}

function Content({ showIndicators, drawingMode }: { showIndicators: boolean; drawingMode: boolean }): ReactElement {
  const activePage = useQuantStore((state) => state.activePage)
  if (activePage === 'strategies') return <StrategiesPage />
  if (activePage === 'strategy-diagnostics') return <StrategyDiagnosticsPage />
  if (activePage === 'backtest') return <BacktestPage />
  if (activePage === 'orders') return <OrdersPage />
  if (activePage === 'risk') return <RiskPage />
  if (activePage === 'assets') return <AssetsPage />
  if (activePage === 'api') return <ApiPage />
  if (activePage === 'logs') return <LogsPage />
  if (activePage === 'settings') return <SettingsPage />
  return <Dashboard showIndicators={showIndicators} drawingMode={drawingMode} />
}

function Dashboard({ showIndicators, drawingMode }: { showIndicators: boolean; drawingMode: boolean }): ReactElement {
  const market = useQuantStore((state) => state.currentMarket)
  const topTickers = useQuantStore((state) => state.topTickers)
  const strategies = useQuantStore((state) => state.strategies)
  const riskEvents = useQuantStore((state) => state.riskEvents)
  const assets = useQuantStore((state) => state.assets)
  const orders = useQuantStore((state) => state.orders)
  const backtestResult = useQuantStore((state) => state.backtestResult)
  const indicators = useMemo(() => {
    if (!showIndicators || !market?.candles.length) return null
    return {
      rsi: rsi(market.candles),
      macd: macd(market.candles),
      boll: bollinger(market.candles),
    }
  }, [market?.candles, showIndicators])

  const accountValue = assets.reduce((sum, item) => sum + assetValue(item, undefined, topTickers), 0)
  const accountPnl = assets.reduce((sum, item) => sum + item.unrealizedPnl, 0)
  const pnlRatio = accountValue > 0 ? accountPnl / accountValue : 0
  const running = strategies.filter((item) => item.status === 'running').length
  const riskLevel = currentRiskLevel(riskEvents)

  return (
    <div className="content dashboard-grid">
      <section className="panel chart-panel">
        <div className="panel-head">
          <div>
            <h2>{market ? symbolDisplay(market.symbol) : 'BTC/USDT'}</h2>
            <p>
              开 {market ? formatPrice(market.candles.at(-1)?.open ?? 0) : '--'}　高{' '}
              {market ? formatPrice(market.candles.at(-1)?.high ?? 0) : '--'}　低{' '}
              {market ? formatPrice(market.candles.at(-1)?.low ?? 0) : '--'}　收{' '}
              {market ? formatPrice(market.candles.at(-1)?.close ?? 0) : '--'}
            </p>
          </div>
          {indicators && (
            <div className="indicator-readout">
              <span>RSI {formatNumber(indicators.rsi, 1)}</span>
              <span>MACD {formatNumber(indicators.macd.hist, 2)}</span>
              <span>BOLL {formatPrice(indicators.boll.middle)}</span>
            </div>
          )}
        </div>
        <MarketChart market={market} showIndicators={showIndicators} drawingMode={drawingMode} />
      </section>
      <OrderBookPanel />
      <RecentTradesPanel />
      <StrategyRunPanel />
      <RiskMonitorPanel riskLevel={riskLevel} />
      <BacktestSummaryPanel />
      <AssetAllocationPanel assets={assets} />
      <ApiStatusPanel />
      <KpiStrip
        items={[
          { label: '账户估值(USDT)', value: formatNumber(accountValue, 2), delta: assets.length ? '来自账户资产' : '未同步账户', tone: 'blue' },
          { label: '持仓盈亏(USDT)', value: formatNumber(accountPnl, 2), delta: formatRatio(pnlRatio), tone: accountPnl >= 0 ? 'green' : 'amber' },
          { label: '回测最大回撤', value: backtestResult ? formatRatio(backtestResult.metrics.maxDrawdown) : '--', delta: backtestResult ? '最近一次回测' : '无回测', tone: 'amber', chartValues: backtestResult?.equityCurve.map((item) => item.value) },
          { label: '回测夏普比率', value: backtestResult ? formatNumber(backtestResult.metrics.sharpeRatio, 2) : '--', delta: backtestResult ? `${backtestResult.candleCount} 样本` : '无回测', tone: 'blue', chartValues: backtestResult?.equityCurve.map((item) => item.value) },
          { label: '订单记录数', value: formatNumber(orders.length, 0), delta: '本地真实记录', tone: 'blue' },
          { label: '运行策略', value: String(running), delta: riskText(riskLevel), tone: riskLevel === 'normal' ? 'green' : 'amber' },
        ]}
      />
    </div>
  )
}

function OrderBookPanel(): ReactElement {
  const market = useQuantStore((state) => state.currentMarket)
  const asks = market?.asks.slice(0, 8).reverse() ?? []
  const bids = market?.bids.slice(0, 8) ?? []
  const maxQty = Math.max(1, ...asks.map((item) => item.quantity), ...bids.map((item) => item.quantity))
  const bestBid = market?.bids[0]?.price
  const bestAsk = market?.asks[0]?.price
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined

  return (
    <section className="panel orderbook-panel">
      <div className="panel-head compact">
        <h3>订单簿</h3>
        <select defaultValue="0.01">
          <option>0.01</option>
          <option>0.1</option>
          <option>1</option>
        </select>
      </div>
      <div className="book-table">
        <div className="book-row head">
          <span>价格(USDT)</span>
          <span>数量</span>
          <span>累计</span>
        </div>
        {asks.map((ask) => (
          <div key={`ask-${ask.price}`} className="book-row ask">
            <i style={{ width: `${(ask.quantity / maxQty) * 100}%` }} />
            <span>{formatPrice(ask.price)}</span>
            <span>{formatNumber(ask.quantity, 4)}</span>
            <span>{formatNumber(ask.quantity * 1.9, 4)}</span>
          </div>
        ))}
        <div className="last-price">
          <strong>{market ? formatPrice(market.ticker.lastPrice) : '--'}</strong>
          <span>最新成交 {market ? formatPercent(market.ticker.priceChangePercent) : '--'}</span>
          <div className="book-midline">
            <em>买一 {bestBid ? formatPrice(bestBid) : '--'}</em>
            <em>中间 {midPrice ? formatPrice(midPrice) : '--'}</em>
            <em>卖一 {bestAsk ? formatPrice(bestAsk) : '--'}</em>
          </div>
        </div>
        {bids.map((bid) => (
          <div key={`bid-${bid.price}`} className="book-row bid">
            <i style={{ width: `${(bid.quantity / maxQty) * 100}%` }} />
            <span>{formatPrice(bid.price)}</span>
            <span>{formatNumber(bid.quantity, 4)}</span>
            <span>{formatNumber(bid.quantity * 2.2, 4)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function RecentTradesPanel(): ReactElement {
  const trades = useQuantStore((state) => state.currentMarket?.trades)
  return (
    <section className="panel trades-panel">
      <div className="panel-head compact">
        <h3>最近成交</h3>
        <DatabaseZap size={16} />
      </div>
      <div className="trade-list">
        <div className="trade-row head">
          <span>时间</span>
          <span>价格</span>
          <span>数量</span>
        </div>
        {(trades ?? []).slice(0, 18).map((trade) => (
          <div key={`${trade.id}-${trade.time}`} className={`trade-row ${trade.side === 'BUY' ? 'bid-text' : 'ask-text'}`}>
            <span>{formatTime(trade.time)}</span>
            <span>{formatPrice(trade.price)}</span>
            <span>{formatNumber(trade.quantity, 4)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function StrategyRunPanel(): ReactElement {
  const { strategies, setStrategies, liveMode, apiProfiles, strategyPositions, setActivePage } = useQuantStore()
  const [updatingStrategyId, setUpdatingStrategyId] = useState('')
  const [draggedStrategyId, setDraggedStrategyId] = useState('')
  const [dragOverStrategyId, setDragOverStrategyId] = useState('')

  async function updateStatus(strategy: StrategyConfig, status: StrategyConfig['status']): Promise<void> {
    if (strategy.status === status || updatingStrategyId) return
    if (status === 'running' && liveMode === 'live') {
      const hasTradeApi = apiProfiles.some((profile) => profile.canTrade)
      if (!hasTradeApi) {
        window.alert('未找到已通过交易权限检测的 API。请先到 API 管理添加 API、勾选交易权限并点击测试连接。')
        setActivePage('api')
        return
      }
      const confirmed = window.confirm(`即将启动实盘策略「${strategy.name}」。请确认 API、余额与风控规则已经检查完成。`)
      if (!confirmed) return
    }
    setUpdatingStrategyId(strategy.id)
    try {
      const next = strategies.map((item) => (item.id === strategy.id ? { ...item, status, pnl: hasLiveStrategyExposure({ ...item, status }) ? item.pnl : 0 } : item))
      setStrategies(next)
      const saved = await window.quantApi.updateStrategies(next)
      setStrategies(saved)
    } catch (error) {
      window.alert(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setUpdatingStrategyId('')
    }
  }

  async function persistStrategyOrder(next: StrategyConfig[]): Promise<void> {
    if (next === strategies || next.map((strategy) => strategy.id).join('|') === strategies.map((strategy) => strategy.id).join('|')) return
    setStrategies(next)
    try {
      setStrategies(await window.quantApi.updateStrategies(next))
    } catch (error) {
      window.alert(String(error).replace(/^Error:\s*/, ''))
      setStrategies(strategies)
    }
  }

  function startDrag(strategyId: string): void {
    setDraggedStrategyId(strategyId)
  }

  async function dropOnStrategy(targetId: string): Promise<void> {
    const draggedId = draggedStrategyId
    setDraggedStrategyId('')
    setDragOverStrategyId('')
    if (!draggedId) return
    await persistStrategyOrder(placeStrategyBefore(strategies, draggedId, targetId))
  }

  async function moveStrategy(strategyId: string, direction: -1 | 1): Promise<void> {
    await persistStrategyOrder(moveStrategyInList(strategies, strategyId, direction))
  }

  return (
    <section className="panel strategy-panel">
      <div className="panel-head compact">
        <div>
          <h3>策略运行</h3>
          <p>{strategies.filter((item) => item.status === 'running').length} 个运行中</p>
        </div>
        <button className="small-button" onClick={() => setActivePage('strategies')}>全部策略</button>
      </div>
      <div className="strategy-list">
        {strategies.slice(0, 5).map((strategy, index) => {
          const position = hasLiveStrategyExposure(strategy)
            ? findStrategyPosition(strategyPositions, strategy.id, strategy.symbol)
            : undefined
          return (
            <div
              className={`strategy-row draggable-row ${draggedStrategyId === strategy.id ? 'dragging' : ''} ${dragOverStrategyId === strategy.id ? 'drag-over' : ''}`}
              key={strategy.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', strategy.id)
                startDrag(strategy.id)
              }}
              onDragEnter={() => setDragOverStrategyId(strategy.id)}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDragOverStrategyId(strategy.id)
              }}
              onDragLeave={() => setDragOverStrategyId((current) => (current === strategy.id ? '' : current))}
              onDrop={(event) => {
                event.preventDefault()
                void dropOnStrategy(strategy.id)
              }}
              onDragEnd={() => {
                setDraggedStrategyId('')
                setDragOverStrategyId('')
              }}
            >
              <button className="drag-handle" title="拖动排序" aria-label={`拖动 ${strategy.name} 排序`}>
                <GripVertical size={15} />
              </button>
              <div className="strategy-row-main">
                <strong>{strategy.name}</strong>
                <span>{symbolDisplay(strategy.symbol)} · {formatRuntime(strategy.runtimeMs)}</span>
                <span className="position-line">
                  {position
                    ? `${strategyPositionDisplay(position)} · 入场 ${formatPrice(position.entryPrice)} · 现价 ${formatPrice(position.markPrice)}`
                    : '无持仓'}
                </span>
              </div>
              <span className={`state-pill ${strategy.status}`}>{statusText(strategy.status)}</span>
              <em className={strategyPnlClass(strategy)}>{strategyPnlText(strategy, true)}</em>
              <div className="row-actions">
                <button title="上移" disabled={index === 0} onClick={() => void moveStrategy(strategy.id, -1)}>
                  <ArrowUp size={14} />
                </button>
                <button title="下移" disabled={index >= strategies.length - 1} onClick={() => void moveStrategy(strategy.id, 1)}>
                  <ArrowDown size={14} />
                </button>
                <button title="启动" disabled={strategy.status === 'running' || updatingStrategyId === strategy.id} onClick={() => updateStatus(strategy, 'running')}>
                  <Play size={14} />
                </button>
                <button title="暂停" disabled={strategy.status === 'paused' || updatingStrategyId === strategy.id} onClick={() => updateStatus(strategy, 'paused')}>
                  <Pause size={14} />
                </button>
                <button title="停止" disabled={strategy.status === 'stopped' || updatingStrategyId === strategy.id} onClick={() => updateStatus(strategy, 'stopped')}>
                  <Square size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function RiskMonitorPanel({ riskLevel }: { riskLevel: RiskLevel }): ReactElement {
  const rules = useQuantStore((state) => state.riskRules)
  const events = useQuantStore((state) => state.riskEvents)
  const strategies = useQuantStore((state) => state.strategies)
  const backtestResult = useQuantStore((state) => state.backtestResult)
  const exposure = strategies.reduce((sum, strategy) => (strategy.status === 'running' ? sum + strategy.maxPositionRatio : sum), 0)
  const score = Math.min(
    100,
    Math.round(
      exposure * 0.9 +
        (backtestResult?.metrics.maxDrawdown ? backtestResult.metrics.maxDrawdown * 100 : 0) * 1.4 +
      (riskLevel === 'danger' ? 35 : riskLevel === 'warning' ? 22 : riskLevel === 'watch' ? 12 : 0),
    ),
  )
  const latestEvents = events.slice(0, 2)
  return (
    <section className="panel risk-panel">
      <div className="panel-head compact">
        <div>
          <h3>风险监控</h3>
          <p>{riskText(riskLevel)}</p>
        </div>
        <span className={`risk-status ${riskClass(riskLevel)}`}>
          <AlertTriangle size={14} />
          {riskLevel === 'normal' ? '稳态' : '关注'}
        </span>
      </div>
      <div className="risk-stage">
        <div className={`risk-gauge ${riskClass(riskLevel)}`} style={{ '--score': `${score * 1.8}deg` } as CSSProperties}>
          <div>
            <strong>{score}</strong>
            <span>风险指数</span>
            <em>{score >= 80 ? '危险' : score >= 55 ? '偏高' : score >= 30 ? '观察' : '健康'}</em>
          </div>
        </div>
        <div className="risk-band">
          <span>低</span>
          <span>中</span>
          <span>高</span>
        </div>
      </div>
      <div className="risk-metrics">
        <span>最大回撤 <strong>{backtestResult ? formatRatio(backtestResult.metrics.maxDrawdown) : '--'}</strong></span>
        <span>风险敞口 <strong>{formatNumber(exposure, 0)}%</strong></span>
        <span>杠杆使用 <strong>{rules.maxLeverage}x</strong></span>
        <span>仓位上限 <strong>{rules.maxPositionRatio}%</strong></span>
      </div>
      <div className="risk-feed">
        {latestEvents.length === 0 ? (
          <p>
            <i className="risk-normal" />
            暂无新的风控事件
          </p>
        ) : latestEvents.map((event) => (
          <p key={event.id}>
            <i className={riskClass(event.level)} />
            {event.title}
          </p>
        ))}
      </div>
    </section>
  )
}

function BacktestSummaryPanel(): ReactElement {
  const result = useQuantStore((state) => state.backtestResult)
  const curve = result?.equityCurve.map((item) => item.value) ?? []
  return (
    <section className="panel backtest-panel">
      <div className="panel-head compact">
        <div>
          <h3>回测收益</h3>
          <p>{result ? formatBacktestSource(result.source) : '未运行回测'}</p>
        </div>
        <span className="period-pill">{result ? `${result.candleCount} 样本` : '无数据'}</span>
      </div>
      <div className="return-grid">
        <div>
          <span>累计收益率</span>
          <strong className={result && result.metrics.totalReturn < 0 ? 'down' : 'up'}>{result ? formatRatio(result.metrics.totalReturn) : '--'}</strong>
        </div>
        <div>
          <span>年化收益率</span>
          <strong className={result && result.metrics.annualizedReturn < 0 ? 'down' : 'up'}>{result ? formatRatio(result.metrics.annualizedReturn) : '--'}</strong>
        </div>
      </div>
      <MiniAreaChart values={curve} tone="green" />
      <div className="metric-row">
        <span>胜率 <strong>{result ? formatRatio(result.metrics.winRate) : '--'}</strong></span>
        <span>盈亏比 <strong>{result ? formatNumber(result.metrics.profitFactor, 2) : '--'}</strong></span>
        <span>最大回撤 <strong>{result ? formatRatio(result.metrics.maxDrawdown) : '--'}</strong></span>
      </div>
    </section>
  )
}

type AssetRow = ReturnType<typeof useQuantStore.getState>['assets'][number]

function assetReferencePrice(asset: string, tickers: ReturnType<typeof useQuantStore.getState>['topTickers']): number {
  if (['USDT', 'USDC', 'BUSD', 'FDUSD'].includes(asset)) return 1
  return tickers.find((ticker) => ticker.symbol === `${asset}USDT`)?.lastPrice ?? 0
}

function assetValue(
  asset: AssetRow,
  field: 'walletBalance' | 'availableBalance' | 'frozenBalance' = 'walletBalance',
  tickers: ReturnType<typeof useQuantStore.getState>['topTickers'] = [],
): number {
  return asset[field] * assetReferencePrice(asset.asset, tickers)
}

function AssetAllocationPanel({ assets }: { assets: ReturnType<typeof useQuantStore.getState>['assets'] }): ReactElement {
  const topTickers = useQuantStore((state) => state.topTickers)
  const valuedAssets = assets.map((asset) => ({ ...asset, value: assetValue(asset, 'walletBalance', topTickers) }))
  const total = valuedAssets.reduce((sum, item) => sum + item.value, 0)
  const available = assets.reduce((sum, item) => sum + assetValue(item, 'availableBalance', topTickers), 0)
  const frozen = assets.reduce((sum, item) => sum + assetValue(item, 'frozenBalance', topTickers), 0)
  const allocation = valuedAssets.map((asset) => ({ ...asset, allocation: total > 0 ? (asset.value / total) * 100 : 0 }))
  const sortedAllocation = [...allocation].sort((left, right) => right.value - left.value)
  const gradient = makeAllocationGradient(sortedAllocation)
  const primaryAsset = sortedAllocation[0]
  return (
    <section className="panel asset-panel">
      <div className="panel-head compact">
        <div>
          <h3>资产配置</h3>
          <p>{primaryAsset ? `${primaryAsset.asset} 占比 ${formatNumber(primaryAsset.allocation, 2)}%` : '等待账户同步'}</p>
        </div>
        <CircleDollarSign size={16} />
      </div>
      <div className="asset-body">
        <div className="asset-orbit">
          <div className="donut" style={{ background: gradient }}>
            <div>
              <span>总资产</span>
              <strong>{formatNumber(total, 2)}</strong>
              <small>USDT</small>
            </div>
          </div>
          <span className="asset-orbit-caption">{primaryAsset ? `主资产 ${primaryAsset.asset}` : '未同步'}</span>
        </div>
        <div className="asset-legend">
          {sortedAllocation.length === 0 ? (
            <span>
              <em><i className="legend-0" />未同步账户</em>
              <strong>--</strong>
            </span>
          ) : sortedAllocation.slice(0, 6).map((asset, index) => (
            <span key={asset.asset}>
              <em><i className={`legend-${index}`} />{asset.asset}</em>
              <strong>{formatNumber(asset.allocation, 2)}%</strong>
              <b style={{ width: `${Math.max(4, asset.allocation)}%` }} />
            </span>
          ))}
        </div>
      </div>
      <div className="asset-footer">
        <span>可用余额 <strong>{formatMoney(available)}</strong></span>
        <span>冻结资金 <strong>{formatMoney(frozen)}</strong></span>
      </div>
    </section>
  )
}

function makeAllocationGradient(assets: Array<{ allocation: number }>): string {
  if (assets.length === 0) return 'conic-gradient(#2f81ff 0% 100%)'
  const colors = ['#2f81ff', '#27d6a2', '#f6b84b', '#ff6565', '#70d57a', '#8c7cff']
  let cursor = 0
  const parts = assets.map((asset, index) => {
    const start = cursor
    cursor += asset.allocation
    return `${colors[index % colors.length]} ${start}% ${cursor}%`
  })
  return `conic-gradient(${parts.join(', ')})`
}

function ApiStatusPanel(): ReactElement {
  const profiles = useQuantStore((state) => state.apiProfiles)
  const marketStatus = useQuantStore((state) => state.marketStatus)
  const market = useQuantStore((state) => state.currentMarket)
  const rows = [
    {
      id: 'market',
      label: 'Binance 行情',
      latencyMs: market?.ticker.latencyMs ?? 0,
      status: marketStatus === 'live' ? 'connected' : 'disconnected',
    },
    ...profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      latencyMs: profile.latencyMs,
      status: profile.status,
    })),
  ]
  return (
    <section className="panel api-panel">
      <div className="panel-head compact">
        <h3>API 状态</h3>
        <button className="small-button" onClick={() => useQuantStore.getState().setActivePage('api')}>
          管理
        </button>
      </div>
      <div className="api-list">
        {rows.map((profile) => (
          <div key={profile.id} className="api-row">
            <span>{profile.label}</span>
            <em>延迟 {profile.latencyMs}ms</em>
            <strong className={profile.status === 'connected' ? 'up' : 'muted'}>
              {profile.status === 'connected' ? '连接正常' : '未连接'}
            </strong>
          </div>
        ))}
      </div>
    </section>
  )
}

function KpiStrip({ items }: { items: Array<{ label: string; value: string; delta: string; tone: 'green' | 'amber' | 'blue'; chartValues?: number[] }> }): ReactElement {
  return (
    <section className="kpi-strip">
      {items.map((item) => (
        <div className={`kpi-card ${item.tone}`} key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          <em>{item.delta}</em>
          {item.chartValues?.length ? (
            <MiniAreaChart values={item.chartValues} tone={item.tone} />
          ) : (
            <div className="kpi-chart-placeholder">无历史曲线</div>
          )}
        </div>
      ))}
    </section>
  )
}

function StrategiesPage(): ReactElement {
  const { strategies, setStrategies, selectedSymbol, strategyPositions } = useQuantStore()
  const [editingStrategyId, setEditingStrategyId] = useState('')
  const [draggedStrategyId, setDraggedStrategyId] = useState('')
  const [dragOverStrategyId, setDragOverStrategyId] = useState('')
  const [draft, setDraft] = useState({
    name: '新建网格策略',
    type: 'grid' as StrategyConfig['type'],
    orderAmount: 100,
    maxPositionRatio: 20,
    takeProfitRatio: 1.5,
    stopLossRatio: 3,
    interval: '15m' as CandleInterval,
    slippageLimit: 0.2,
    customScript: defaultCustomScript,
  })

  function resetDraft(): void {
    setEditingStrategyId('')
    setDraft({
      name: '新建网格策略',
      type: 'grid',
      orderAmount: 100,
      maxPositionRatio: 20,
      takeProfitRatio: 1.5,
      stopLossRatio: 3,
      interval: '15m',
      slippageLimit: 0.2,
      customScript: defaultCustomScript,
    })
  }

  function editStrategy(strategyId: string): void {
    setEditingStrategyId(strategyId)
    const strategy = strategies.find((item) => item.id === strategyId)
    if (!strategy) {
      resetDraft()
      return
    }
    setDraft({
      name: strategy.name,
      type: strategy.type,
      orderAmount: strategy.orderAmount,
      maxPositionRatio: strategy.maxPositionRatio,
      takeProfitRatio: strategy.takeProfitRatio,
      stopLossRatio: strategy.stopLossRatio,
      interval: strategy.interval,
      slippageLimit: strategy.slippageLimit,
      customScript: strategy.customScript ?? defaultCustomScript,
    })
  }

  async function addStrategy(): Promise<void> {
    const next: StrategyConfig = {
      id: cryptoRandomId(),
      name: draft.name,
      type: draft.type,
      symbol: selectedSymbol,
      orderAmount: draft.orderAmount,
      maxPositionRatio: draft.maxPositionRatio,
      takeProfitRatio: draft.takeProfitRatio,
      stopLossRatio: draft.stopLossRatio,
      interval: draft.interval,
      slippageLimit: draft.slippageLimit,
      status: 'stopped',
      pnl: 0,
      runtimeMs: 0,
      riskLevel: 'normal',
      customScript: draft.type === 'script' ? draft.customScript : undefined,
    }
    const updated = [next, ...strategies]
    setStrategies(updated)
    setStrategies(await window.quantApi.updateStrategies(updated))
  }

  async function saveStrategy(): Promise<void> {
    const strategy = strategies.find((item) => item.id === editingStrategyId)
    if (!strategy) {
      await addStrategy()
      return
    }
    const next = strategies.map((item) =>
      item.id === editingStrategyId
        ? {
            ...item,
            name: draft.name,
            type: draft.type,
            orderAmount: draft.orderAmount,
            maxPositionRatio: draft.maxPositionRatio,
            takeProfitRatio: draft.takeProfitRatio,
            stopLossRatio: draft.stopLossRatio,
            interval: draft.interval,
            slippageLimit: draft.slippageLimit,
            customScript: draft.type === 'script' ? draft.customScript : undefined,
          }
        : item,
    )
    setStrategies(next)
    setStrategies(await window.quantApi.updateStrategies(next))
  }

  async function patchStrategy(strategy: StrategyConfig, patch: Partial<StrategyConfig>): Promise<void> {
    const next = strategies.map((item) => {
      if (item.id !== strategy.id) return item
      const updated = { ...item, ...patch }
      return hasLiveStrategyExposure(updated) ? updated : { ...updated, pnl: 0 }
    })
    setStrategies(next)
    setStrategies(await window.quantApi.updateStrategies(next))
  }

  async function cloneStrategy(strategy: StrategyConfig): Promise<void> {
    const clone = { ...strategy, id: cryptoRandomId(), name: `${strategy.name} 副本`, status: 'stopped' as const, pnl: 0, runtimeMs: 0 }
    const next = [clone, ...strategies]
    setStrategies(next)
    setStrategies(await window.quantApi.updateStrategies(next))
  }

  async function deleteStrategy(strategy: StrategyConfig): Promise<void> {
    const confirmed = window.confirm(`删除策略「${strategy.name}」？此操作会写入操作日志。`)
    if (!confirmed) return
    const next = strategies.filter((item) => item.id !== strategy.id)
    setStrategies(next)
    setStrategies(await window.quantApi.updateStrategies(next))
  }

  async function persistStrategyOrder(next: StrategyConfig[]): Promise<void> {
    if (next === strategies || next.map((strategy) => strategy.id).join('|') === strategies.map((strategy) => strategy.id).join('|')) return
    setStrategies(next)
    try {
      setStrategies(await window.quantApi.updateStrategies(next))
    } catch (error) {
      window.alert(String(error).replace(/^Error:\s*/, ''))
      setStrategies(strategies)
    }
  }

  async function dropOnStrategy(targetId: string): Promise<void> {
    const draggedId = draggedStrategyId
    setDraggedStrategyId('')
    setDragOverStrategyId('')
    if (!draggedId) return
    await persistStrategyOrder(placeStrategyBefore(strategies, draggedId, targetId))
  }

  async function moveStrategy(strategyId: string, direction: -1 | 1): Promise<void> {
    await persistStrategyOrder(moveStrategyInList(strategies, strategyId, direction))
  }

  return (
    <div className="content two-column-page">
      <section className="panel form-panel">
        <div className="panel-head">
          <div>
            <h2>策略配置</h2>
            <p>支持网格、趋势、均线交叉、套利和自定义脚本策略</p>
          </div>
          <Bot size={20} />
        </div>
        <div className="form-grid">
          <label className="wide-field">
            编辑已有策略
            <select value={editingStrategyId} onChange={(event) => (event.target.value ? editStrategy(event.target.value) : resetDraft())}>
              <option value="">新建策略</option>
              {strategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name} · {symbolDisplay(strategy.symbol)}
                </option>
              ))}
            </select>
          </label>
          <label>
            策略名称
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label>
            策略类型
            <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as StrategyConfig['type'] })}>
              <option value="grid">网格策略</option>
              <option value="trend">趋势跟踪策略</option>
              <option value="ma-cross">均线交叉策略</option>
              <option value="multi-factor">多因子策略</option>
              <option value="arbitrage">套利策略</option>
              <option value="script">自定义脚本策略</option>
            </select>
          </label>
          <label>
            下单金额
            <input type="number" value={draft.orderAmount} onChange={(event) => setDraft({ ...draft, orderAmount: Number(event.target.value) })} />
          </label>
          <label>
            最大仓位 %
            <input
              type="number"
              value={draft.maxPositionRatio}
              onChange={(event) => setDraft({ ...draft, maxPositionRatio: Number(event.target.value) })}
            />
          </label>
          <label>
            止盈比例 %
            <input
              type="number"
              value={draft.takeProfitRatio}
              onChange={(event) => setDraft({ ...draft, takeProfitRatio: Number(event.target.value) })}
            />
          </label>
          <label>
            止损比例 %
            <input
              type="number"
              value={draft.stopLossRatio}
              onChange={(event) => setDraft({ ...draft, stopLossRatio: Number(event.target.value) })}
            />
          </label>
          <label>
            周期
            <select value={draft.interval} onChange={(event) => setDraft({ ...draft, interval: event.target.value as CandleInterval })}>
              {intervals.map((interval) => (
                <option key={interval}>{interval}</option>
              ))}
            </select>
          </label>
          <label>
            滑点限制 %
            <input
              type="number"
              step="0.01"
              value={draft.slippageLimit}
              onChange={(event) => setDraft({ ...draft, slippageLimit: Number(event.target.value) })}
            />
          </label>
        </div>
        {draft.type === 'script' && (
          <div className="script-editor">
            <label>
              自定义回测脚本
              <textarea
                value={draft.customScript}
                onChange={(event) => setDraft({ ...draft, customScript: event.target.value })}
                spellCheck={false}
              />
            </label>
            <p>
              支持 LONG、CLOSE_LONG、SHORT、CLOSE_SHORT、POSITION，兼容 BUY、SELL。可用变量：open、high、low、close、volume、maFast、maSlow、ma20、ma60、ma120、maFastSlope、maSlowSlope、momentum、momentum3、momentum5、momentum12、momentum20、channelHigh、channelLow、channelMid、channelWidth、volatility、volumeRatio、rsi14、macd、macdSignal、macdHist、atr14、atrPct、trueRangePct、bbUpper、bbMiddle、bbLower、bbWidth、bbPctB、bodyPct、upperShadowPct、lowerShadowPct、rangePct、candleReturn、closeLocation、entryPrice、position、signedPosition、positionSide、barsHeld、unrealizedPnlPct、highestSinceEntry、lowestSinceEntry、drawdownSinceEntry、factorScore。
            </p>
          </div>
        )}
        <div className="button-row">
          <button className="primary-button" onClick={editingStrategyId ? saveStrategy : addStrategy}>
            <Play size={16} />
            {editingStrategyId ? '保存策略' : '创建策略'}
          </button>
          {editingStrategyId && (
            <button className="ghost-button" onClick={resetDraft}>
              新建策略
            </button>
          )}
        </div>
      </section>
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>策略列表</h2>
            <p>启动、暂停、停止、复制和删除策略</p>
          </div>
        </div>
        <div className="data-table strategy-table">
          <div className="table-row head">
            <span>策略</span>
            <span>参数</span>
            <span>状态</span>
            <span>收益</span>
            <span>操作</span>
          </div>
          {strategies.length === 0 ? (
            <EmptyRow text="暂无策略。请先在左侧创建一个策略。" />
          ) : strategies.map((strategy, index) => {
            const position = hasLiveStrategyExposure(strategy)
              ? findStrategyPosition(strategyPositions, strategy.id, strategy.symbol)
              : undefined
            return (
            <div
              className={`table-row draggable-row ${draggedStrategyId === strategy.id ? 'dragging' : ''} ${dragOverStrategyId === strategy.id ? 'drag-over' : ''}`}
              key={strategy.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', strategy.id)
                setDraggedStrategyId(strategy.id)
              }}
              onDragEnter={() => setDragOverStrategyId(strategy.id)}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDragOverStrategyId(strategy.id)
              }}
              onDragLeave={() => setDragOverStrategyId((current) => (current === strategy.id ? '' : current))}
              onDrop={(event) => {
                event.preventDefault()
                void dropOnStrategy(strategy.id)
              }}
              onDragEnd={() => {
                setDraggedStrategyId('')
                setDragOverStrategyId('')
              }}
            >
              <span>
                <strong className="strategy-name-with-handle">
                  <button className="drag-handle" title="拖动排序" aria-label={`拖动 ${strategy.name} 排序`}>
                    <GripVertical size={15} />
                  </button>
                  {strategy.name}
                </strong>
                <em>{symbolDisplay(strategy.symbol)} · {strategy.type}</em>
                <em>{position ? `${strategyPositionDisplay(position)} · 入场 ${formatPrice(position.entryPrice)} · 现价 ${formatPrice(position.markPrice)}` : '无持仓'}</em>
              </span>
              <span>
                {formatMoney(strategy.orderAmount)} / 仓位 {strategy.maxPositionRatio}%
                <em>止盈 {strategy.takeProfitRatio}% · 止损 {strategy.stopLossRatio}%</em>
              </span>
              <span className={`state-pill ${strategy.status}`}>{statusText(strategy.status)}</span>
              <span className={strategyPnlClass(strategy)}>{strategyPnlText(strategy)}</span>
              <span className="table-actions">
                <button title="上移" disabled={index === 0} onClick={() => void moveStrategy(strategy.id, -1)}>
                  <ArrowUp size={14} />
                </button>
                <button title="下移" disabled={index === strategies.length - 1} onClick={() => void moveStrategy(strategy.id, 1)}>
                  <ArrowDown size={14} />
                </button>
                <button onClick={() => patchStrategy(strategy, { status: 'running' })}>
                  <Play size={14} />
                </button>
                <button onClick={() => patchStrategy(strategy, { status: 'paused' })}>
                  <Pause size={14} />
                </button>
                <button onClick={() => patchStrategy(strategy, { status: 'stopped' })}>
                  <Square size={13} />
                </button>
                <button onClick={() => cloneStrategy(strategy)}>复制</button>
                <button onClick={() => deleteStrategy(strategy)}>删除</button>
              </span>
            </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function StrategyDiagnosticsPage(): ReactElement {
  const { strategies, logs, orders, strategyPositions, setActivePage, setLogs } = useQuantStore()
  const runningStrategies = useMemo(
    () => strategies.filter((strategy) => strategy.status === 'running' || strategy.status === 'tripped'),
    [strategies],
  )
  const [selectedStrategyId, setSelectedStrategyId] = useState(runningStrategies[0]?.id ?? strategies[0]?.id ?? '')

  useEffect(() => {
    const hasSelected = strategies.some((strategy) => strategy.id === selectedStrategyId)
    if (!hasSelected) {
      setSelectedStrategyId(runningStrategies[0]?.id ?? strategies[0]?.id ?? '')
    }
  }, [runningStrategies, selectedStrategyId, strategies])

  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId) ?? runningStrategies[0] ?? strategies[0]
  const selectedLogs = useMemo(
    () => logs.filter((log) => log.strategyId === selectedStrategy?.id || (log.scope === 'strategy' && !selectedStrategy)),
    [logs, selectedStrategy],
  )
  const strategyOrders = useMemo(
    () => orders.filter((order) => order.strategyId === selectedStrategy?.id).slice(0, 12),
    [orders, selectedStrategy?.id],
  )
  const selectedPosition = selectedStrategy && hasLiveStrategyExposure(selectedStrategy)
    ? findStrategyPosition(strategyPositions, selectedStrategy.id, selectedStrategy.symbol)
    : undefined
  const recentLogs = selectedLogs.slice(0, 80)
  const latestSignalLog = recentLogs.find((log) => log.message.startsWith('信号诊断'))

  async function clearSelectedStrategyLogs(): Promise<void> {
    if (!selectedStrategy || selectedLogs.length === 0) return
    const confirmed = window.confirm(`确认清空「${selectedStrategy.name}」的诊断日志？此操作不会删除订单记录。`)
    if (!confirmed) return
    setLogs(await window.quantApi.clearLogs({ strategyId: selectedStrategy.id }))
  }

  return (
    <div className="content two-column-page">
      <section className="panel table-panel diagnostic-strategy-panel">
        <div className="panel-head">
          <div>
            <h2>策略诊断日志</h2>
            <p>监控运行中的策略、最近信号、下单与风控事件</p>
          </div>
          <button className="small-button" onClick={() => setActivePage('strategies')}>
            返回策略管理
          </button>
        </div>
        <div className="diagnostic-strategy-list">
          {runningStrategies.length === 0 ? (
            <EmptyRow text="当前没有运行中的策略。" />
          ) : (
            runningStrategies.map((strategy) => {
              const position = findStrategyPosition(strategyPositions, strategy.id, strategy.symbol)
              const isActive = strategy.id === selectedStrategy?.id
              return (
                <button
                  key={strategy.id}
                  className={isActive ? 'diagnostic-strategy-card active' : 'diagnostic-strategy-card'}
                  onClick={() => setSelectedStrategyId(strategy.id)}
                >
                  <strong>{strategy.name}</strong>
                  <span>{symbolDisplay(strategy.symbol)} · {strategy.interval}</span>
                  <span>{position ? `${strategyPositionDisplay(position)} · 入场 ${formatPrice(position.entryPrice)} · 现价 ${formatPrice(position.markPrice)}` : '无持仓'}</span>
                  <em className={strategyPnlClass(strategy)}>{strategyPnlText(strategy)}</em>
                </button>
              )
            })
          )}
        </div>
      </section>
      <section className="panel table-panel diagnostic-detail-panel">
        <div className="panel-head">
          <div>
            <h2>{selectedStrategy ? selectedStrategy.name : '策略诊断'}</h2>
            <p>
              {selectedStrategy
                ? `${symbolDisplay(selectedStrategy.symbol)} · ${statusText(selectedStrategy.status)} · ${formatRuntime(selectedStrategy.runtimeMs)}`
                : '选择一个运行中的策略查看诊断信息'}
            </p>
          </div>
          <button className="danger-button" onClick={clearSelectedStrategyLogs} disabled={!selectedStrategy || selectedLogs.length === 0}>
            清空日志
          </button>
        </div>
        {selectedStrategy ? (
          <>
            <div className="metric-grid diagnostic-metrics">
              <div>
                <span>状态</span>
                <strong className={selectedStrategy.status === 'running' ? 'up' : 'down'}>{statusText(selectedStrategy.status)}</strong>
              </div>
              <div>
                <span>收益</span>
                <strong className={strategyPnlClass(selectedStrategy)}>{strategyPnlText(selectedStrategy)}</strong>
              </div>
              <div>
                <span>持仓</span>
                <strong>{selectedPosition ? `${strategyPositionDisplay(selectedPosition)} · 入场 ${formatPrice(selectedPosition.entryPrice)} · 现价 ${formatPrice(selectedPosition.markPrice)}` : '无持仓'}</strong>
              </div>
              <div>
                <span>日志数</span>
                <strong>{recentLogs.length}</strong>
              </div>
            </div>
            <div className="diagnostic-summary diagnostic-signal-summary">
              <span>最近信号诊断</span>
              {latestSignalLog ? (
                <>
                  <strong>{formatDate(latestSignalLog.time)}</strong>
                  <p>{latestSignalLog.message}</p>
                </>
              ) : (
                <strong>暂无信号诊断记录</strong>
              )}
            </div>
            <div className="diagnostic-summary">
              <span>最近订单</span>
              {strategyOrders.length === 0 ? (
                <strong>暂无该策略订单</strong>
              ) : (
                strategyOrders.map((order) => (
                  <div key={order.id} className="diagnostic-order-row">
                    <span>{formatDate(order.time)}</span>
                    <strong className={order.side === 'BUY' ? 'up' : 'down'}>{order.side}{order.positionSide ? ` ${order.positionSide}` : ''}</strong>
                    <span>{formatPrice(order.price)}</span>
                    <span>{formatNumber(order.quantity, 4)}</span>
                    <em>{order.status}</em>
                  </div>
                ))
              )}
            </div>
            <div className="log-list diagnostic-log-list">
              {recentLogs.length === 0 ? (
                <EmptyRow text="暂无该策略的诊断记录。" />
              ) : (
                recentLogs.map((log) => (
                  <div className={`log-row ${log.level}`} key={log.id}>
                    <span>{formatDate(log.time)}</span>
                    <strong>{log.scope}{log.strategyId ? ` · ${log.strategyId.slice(0, 8)}` : ''}</strong>
                    <p>{log.message}</p>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <EmptyRow text="请先在左侧选择一个运行中的策略。" />
        )}
      </section>
    </div>
  )
}

function BacktestPage(): ReactElement {
  const {
    backtestParams,
    setBacktestParams,
    backtestResult,
    setBacktestResult,
    backtestRunStatus,
    backtestRunError,
    backtestStartedAt,
    setBacktestRunMeta,
    strategies,
  } = useQuantStore()
  const [caching, setCaching] = useState(false)
  const [cacheStatus, setCacheStatus] = useState('')
  const [error, setError] = useState('')
  const customStrategies = useMemo(() => strategies.filter((strategy) => strategy.type === 'script'), [strategies])
  const visibleTrades = useMemo(() => (backtestResult?.trades ?? []).slice(-600), [backtestResult?.trades])
  const loading = backtestRunStatus === 'running'

  async function runBacktest(): Promise<void> {
    if (loading) return
    setError('')
    setBacktestRunMeta({
      backtestRunStatus: 'running',
      backtestRunError: '',
      backtestStartedAt: Date.now(),
      backtestCompletedAt: null,
    })
    try {
      const selectedScriptStrategy = customStrategies.find((strategy) => strategy.id === backtestParams.strategyId) ?? customStrategies[0]
      const params =
        backtestParams.strategyType === 'script'
          ? { ...backtestParams, strategyId: selectedScriptStrategy?.id }
          : backtestParams
      const result = await window.quantApi.runBacktest(params)
      setBacktestResult(result)
      setBacktestRunMeta({
        backtestRunStatus: 'succeeded',
        backtestRunError: '',
        backtestCompletedAt: Date.now(),
      })
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, '')
      setBacktestRunMeta({
        backtestRunStatus: 'error',
        backtestRunError: message,
        backtestCompletedAt: Date.now(),
      })
    }
  }

  async function cacheHistory(): Promise<void> {
    setCaching(true)
    setError('')
    setCacheStatus('')
    try {
      const warmupFrom = Math.max(0, backtestParams.from - intervalDurationMs(backtestParams.interval) * 80)
      const result = await window.quantApi.cacheMarketHistory({
        symbol: backtestParams.symbol,
        interval: backtestParams.interval,
        from: warmupFrom,
        to: backtestParams.to,
      })
      setCacheStatus(`已缓存 ${symbolDisplay(result.symbol)} ${result.interval} 历史 K 线 ${result.candles} 根到 DuckDB。`)
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, '')
      setError(message)
      window.alert(message)
    } finally {
      setCaching(false)
    }
  }

  return (
    <div className="content two-column-page">
      <section className="panel form-panel">
        <div className="panel-head">
          <div>
            <h2>回测参数</h2>
            <p>历史模拟结果不代表未来收益</p>
          </div>
          <FileClock size={20} />
        </div>
        <BacktestForm params={backtestParams} onChange={setBacktestParams} />
        <div className="security-note">
          <DatabaseZap size={16} />
          回测将拉取 Binance 历史 K 线并写入 DuckDB；均线策略会额外加载前置 K 线做指标预热，结果只统计所选区间。
        </div>
        {backtestRunError && <div className="form-error">{backtestRunError}</div>}
        {error && <div className="form-error">{error}</div>}
        {loading && <div className="cache-status">回测正在后台运行，开始于 {backtestStartedAt ? formatDate(backtestStartedAt) : '--'}；切换页面不会中断。</div>}
        {cacheStatus && <div className="cache-status">{cacheStatus}</div>}
        <div className="button-row">
          <button className="primary-button" onClick={runBacktest} disabled={loading || caching}>
            <Play size={16} />
            {loading ? '回测中...' : '运行回测'}
          </button>
          <button className="ghost-button" onClick={cacheHistory} disabled={loading || caching}>
            <DatabaseZap size={16} />
            {caching ? '下载中...' : '预下载行情'}
          </button>
        </div>
      </section>
      <section className="panel analytics-panel">
        <div className="panel-head">
          <div>
            <h2>回测结果</h2>
            <p>
              {backtestResult
                ? `${formatBacktestSource(backtestResult.source)} · ${backtestResult.candleCount} 根样本 · ${formatDate(backtestResult.range.from)} 至 ${formatDate(backtestResult.range.to)}`
                : '收益曲线、关键指标和交易明细'}
            </p>
          </div>
        </div>
        <BacktestMetrics />
        <EquityCurveChart curve={backtestResult?.equityCurve ?? []} initialCapital={backtestResult?.initialCapital ?? backtestParams.initialCapital} />
        {(backtestResult?.trades.length ?? 0) > visibleTrades.length && (
          <div className="table-note">交易明细较多，当前仅显示最近 {visibleTrades.length} 笔；统计指标仍按全部 {backtestResult?.trades.length ?? 0} 笔计算。</div>
        )}
        <div className="data-table compact-table backtest-trades-table">
          <div className="table-row head">
            <span>时间</span>
            <span>方向</span>
            <span>价格</span>
            <span>数量</span>
            <span>盈亏</span>
          </div>
          {(backtestResult?.trades ?? []).length === 0 ? (
            <EmptyRow text="暂无交易明细。运行回测后会显示全部买卖记录。" />
          ) : (
            visibleTrades.map((trade, index) => (
              <div className="table-row" key={`${trade.time}-${index}`}>
                <span>{formatDate(trade.time)}</span>
                <span className={trade.side === 'BUY' ? 'up' : 'down'}>{trade.positionSide ? `${trade.side} ${trade.positionSide}` : trade.side}</span>
                <span>{formatPrice(trade.price)}</span>
                <span>{formatNumber(trade.quantity, 4)}</span>
                <span className={trade.pnl >= 0 ? 'up' : 'down'}>{formatNumber(trade.pnl, 2)}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function BacktestForm({ params, onChange }: { params: BacktestParams; onChange: (params: Partial<BacktestParams>) => void }): ReactElement {
  const strategies = useQuantStore((state) => state.strategies)
  const watchlist = useQuantStore((state) => state.watchlist)
  const customStrategies = useMemo(() => strategies.filter((strategy) => strategy.type === 'script'), [strategies])
  const selectedCustomId = customStrategies.find((strategy) => strategy.id === params.strategyId)?.id ?? customStrategies[0]?.id ?? ''
  const [dateDraft, setDateDraft] = useState({
    from: dateInputValue(params.from),
    to: dateInputValue(params.to),
  })

  useEffect(() => {
    if (params.strategyType === 'script' && customStrategies.length > 0 && params.strategyId !== selectedCustomId) {
      onChange({ strategyId: selectedCustomId })
    }
  }, [customStrategies.length, onChange, params.strategyId, params.strategyType, selectedCustomId])

  useEffect(() => {
    setDateDraft({
      from: dateInputValue(params.from),
      to: dateInputValue(params.to),
    })
  }, [params.from, params.to])

  useEffect(() => {
    const nextFrom = parseDateInputValue(dateDraft.from, Number.NaN)
    const nextTo = parseDateInputValue(dateDraft.to, Number.NaN)
    if (!Number.isFinite(nextFrom) || !Number.isFinite(nextTo)) return
    if (nextFrom === params.from && nextTo === params.to) return
    const timer = window.setTimeout(() => {
      onChange({
        from: nextFrom,
        to: nextTo > nextFrom ? nextTo : nextFrom + 86_400_000,
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [dateDraft.from, dateDraft.to, onChange, params.from, params.to])

  function changeStrategyType(strategyType: StrategyConfig['type']): void {
    onChange({
      strategyType,
      strategyId: strategyType === 'script' ? selectedCustomId : undefined,
    })
  }

  function setRecentRange(days: number): void {
    const to = Date.now()
    const from = to - days * 86_400_000
    onChange({ from, to })
  }

  return (
    <div className="form-grid">
      <label>
        交易对
        <select value={params.symbol} onChange={(event) => onChange({ symbol: event.target.value })}>
          {watchlist.map((symbol) => (
            <option key={symbol} value={symbol}>
              {symbolDisplay(symbol)}
            </option>
          ))}
        </select>
      </label>
      <label>
        周期
        <select value={params.interval} onChange={(event) => onChange({ interval: event.target.value as CandleInterval })}>
          {intervals.map((interval) => (
            <option key={interval}>{interval}</option>
          ))}
        </select>
      </label>
      <label>
        初始资金
        <input type="number" value={params.initialCapital} onChange={(event) => onChange({ initialCapital: Number(event.target.value) })} />
      </label>
      <label>
        手续费率
        <input
          type="number"
          step="0.0001"
          value={params.feeRate}
          onChange={(event) => onChange({ feeRate: Number(event.target.value) })}
        />
      </label>
      <label>
        回测杠杆
        <input
          type="number"
          min="1"
          max="125"
          step="1"
          placeholder="自动"
          value={params.leverage ?? ''}
          onChange={(event) => onChange({ leverage: event.target.value === '' ? undefined : Number(event.target.value) })}
        />
      </label>
      <label>
        开始时间
        <input type="date" value={dateDraft.from} onChange={(event) => setDateDraft((draft) => ({ ...draft, from: event.target.value }))} />
      </label>
      <label>
        结束时间
        <input type="date" value={dateDraft.to} onChange={(event) => setDateDraft((draft) => ({ ...draft, to: event.target.value }))} />
      </label>
      <div className="date-presets wide-field" role="group" aria-label="回测区间快捷选择">
        {[30, 90, 180, 365].map((days) => (
          <button key={days} type="button" onClick={() => setRecentRange(days)}>
            近{days}天
          </button>
        ))}
      </div>
      <label>
        策略类型
        <select value={params.strategyType} onChange={(event) => changeStrategyType(event.target.value as StrategyConfig['type'])}>
          <option value="grid">网格策略</option>
          <option value="trend">趋势跟踪策略</option>
          <option value="ma-cross">均线交叉策略</option>
          <option value="multi-factor">多因子策略</option>
          <option value="script">自定义脚本策略</option>
        </select>
      </label>
      {params.strategyType === 'script' && (
        <label>
          自定义策略
          <select value={selectedCustomId} onChange={(event) => onChange({ strategyId: event.target.value })}>
            {customStrategies.length === 0 ? (
              <option value="">请先在策略管理创建自定义脚本策略</option>
            ) : (
              customStrategies.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name}
                </option>
              ))
            )}
          </select>
        </label>
      )}
    </div>
  )
}

function BacktestMetrics(): ReactElement {
  const result = useQuantStore((state) => state.backtestResult)
  const metrics = result?.metrics
  const finalEquity = result?.equityCurve.at(-1)?.value
  const leverage = (result as Partial<BacktestResult> | null)?.leverage
  const rows = [
    ['最终金额', finalEquity !== undefined ? formatMoney(finalEquity) : '--'],
    ['回测杠杆', leverage ? `${leverage.value}x · ${leverage.source === 'manual' ? '手动' : leverage.source === 'binance-position' ? 'Binance' : '风控'}` : '--'],
    ['总收益率', metrics ? formatRatio(metrics.totalReturn) : '--'],
    ['年化收益率', metrics ? formatRatio(metrics.annualizedReturn) : '--'],
    ['最大回撤', metrics ? formatRatio(metrics.maxDrawdown) : '--'],
    ['夏普比率', metrics ? formatNumber(metrics.sharpeRatio, 2) : '--'],
    ['胜率', metrics ? formatRatio(metrics.winRate) : '--'],
    ['盈亏比', metrics ? formatNumber(metrics.profitFactor, 2) : '--'],
    ['交易次数', metrics ? formatNumber(metrics.trades, 0) : '--'],
  ]
  return (
    <div className="metric-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

function OrdersPage(): ReactElement {
  const { apiProfiles, selectedSymbol, currentMarket, addOrder, orders, liveMode, strategies } = useQuantStore()
  const defaultLiveProfileId = useMemo(() => {
    const liveProfiles = apiProfiles.filter((profile) => profile.environment === 'live')
    return (
      liveProfiles.find((profile) => profile.canTrade && profile.status === 'connected')?.id ??
      liveProfiles.find((profile) => profile.canTrade)?.id ??
      liveProfiles[0]?.id ??
      ''
    )
  }, [apiProfiles])
  const strategyNameById = useMemo(() => new Map(strategies.map((strategy) => [strategy.id, strategy.name])), [strategies])
  const [ticket, setTicket] = useState({
    apiProfileId: 'paper',
    side: 'BUY' as OrderSide,
    positionSide: 'LONG' as PositionSide,
    type: 'MARKET' as OrderType,
    quantity: 0.001,
    price: 0,
  })
  const [placing, setPlacing] = useState(false)

  useEffect(() => {
    setTicket((current) => {
      if (liveMode !== 'live') {
        return current.apiProfileId === 'paper' ? current : { ...current, apiProfileId: 'paper' }
      }
      const selectedProfile = apiProfiles.find((profile) => profile.id === current.apiProfileId)
      if (selectedProfile?.environment === 'live') return current
      return defaultLiveProfileId ? { ...current, apiProfileId: defaultLiveProfileId } : current
    })
  }, [apiProfiles, defaultLiveProfileId, liveMode])

  async function submitOrder(): Promise<void> {
    if (ticket.apiProfileId !== 'paper' && liveMode !== 'live') {
      window.alert('当前为模拟模式。若要提交实盘订单，请先在顶部切换到实盘。')
      return
    }
    if (ticket.apiProfileId !== 'paper') {
      const confirmed = window.confirm('即将向 Binance USDⓈ-M Futures 提交实盘订单，请确认数量、价格、API 权限和风控规则。')
      if (!confirmed) return
    }
    setPlacing(true)
    try {
      const order = await window.quantApi.placeOrder({
        apiProfileId: ticket.apiProfileId,
        symbol: selectedSymbol,
        side: ticket.side,
        positionSide: ticket.positionSide,
        type: ticket.type,
        quantity: ticket.quantity,
        price: ticket.type === 'LIMIT' ? ticket.price || currentMarket?.ticker.lastPrice : undefined,
        idempotencyKey: `order_${cryptoRandomId().replace(/-/g, '').slice(0, 24)}`,
      })
      addOrder(order)
    } catch (error) {
      window.alert(String(error))
    } finally {
      setPlacing(false)
    }
  }

  const lastPrice = currentMarket?.ticker.lastPrice ?? 0
  return (
    <div className="content single-page">
      <section className="panel form-panel order-ticket">
        <div className="panel-head">
          <div>
            <h2>交易执行</h2>
            <p>下单前会执行本地风控校验；实盘订单需二次确认并通过交易权限检测</p>
          </div>
        </div>
        <div className="form-grid order-form-grid">
          <label>
            账户
            <select value={ticket.apiProfileId} onChange={(event) => setTicket({ ...ticket, apiProfileId: event.target.value })}>
              <option value="paper">模拟成交账户</option>
              {apiProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label} · {profile.environment === 'testnet' ? '测试网' : '实盘'}
                </option>
              ))}
            </select>
          </label>
          <label>
            交易对
            <input value={symbolDisplay(selectedSymbol)} readOnly />
          </label>
          <label>
            方向
            <select value={ticket.side} onChange={(event) => setTicket({ ...ticket, side: event.target.value as OrderSide })}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </label>
          <label>
            持仓方向
            <select value={ticket.positionSide} onChange={(event) => setTicket({ ...ticket, positionSide: event.target.value as PositionSide })}>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </label>
          <label>
            订单类型
            <select value={ticket.type} onChange={(event) => setTicket({ ...ticket, type: event.target.value as OrderType })}>
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT</option>
            </select>
          </label>
          <label>
            数量
            <input
              type="number"
              min="0"
              step="0.001"
              value={ticket.quantity}
              onChange={(event) => setTicket({ ...ticket, quantity: Number(event.target.value) })}
            />
          </label>
          <label>
            限价
            <input
              type="number"
              min="0"
              step="0.01"
              value={ticket.type === 'MARKET' ? lastPrice : ticket.price}
              disabled={ticket.type === 'MARKET'}
              onChange={(event) => setTicket({ ...ticket, price: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={submitOrder} disabled={placing}>
            <Play size={16} />
            {placing ? '提交中...' : ticket.apiProfileId === 'paper' ? '模拟成交' : '提交订单'}
          </button>
        </div>
      </section>
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>订单与成交记录</h2>
            <p>同步待成交、部分成交、已成交、已撤销和失败订单</p>
          </div>
        </div>
        <div className="data-table order-record-table">
          <div className="table-row head">
            <span>时间</span>
            <span>交易对</span>
            <span>策略</span>
            <span>方向</span>
            <span>持仓</span>
            <span>类型</span>
            <span>价格</span>
            <span>数量</span>
            <span>状态</span>
            <span>幂等键</span>
          </div>
          {orders.length === 0 ? (
            <EmptyRow text="暂无订单记录。模拟成交和实盘回报都会写入这里。" />
          ) : (
            orders.map((order) => (
              <div className="table-row" key={order.id}>
                <span>{formatDate(order.time)}</span>
                <span>{symbolDisplay(order.symbol)}</span>
                <span title={order.strategyId}>{order.strategyId ? (strategyNameById.get(order.strategyId) ?? order.strategyId.slice(0, 8)) : '--'}</span>
                <span className={order.side === 'BUY' ? 'up' : 'down'}>{order.side}</span>
                <span>{order.positionSide ?? '--'}</span>
                <span>{order.type}</span>
                <span>{formatPrice(order.price)}</span>
                <span>{formatNumber(order.quantity, 4)}</span>
                <span title={order.failureReason}>{order.status}</span>
                <span>{order.idempotencyKey.slice(0, 12)}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function RiskPage(): ReactElement {
  const { riskRules, setRiskRules, riskEvents, addRiskEvent, strategies, setStrategies } = useQuantStore()
  const [draft, setDraft] = useState(riskRules)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [saveError, setSaveError] = useState('')

  async function saveRules(): Promise<void> {
    setSaving(true)
    setSaveMessage('')
    setSaveError('')
    try {
      const updated = await window.quantApi.updateRiskRules(draft)
      setRiskRules(updated)
      setSaveMessage(`风控规则已保存到 SQLite · ${formatTime(Date.now())}`)
      window.setTimeout(() => setSaveMessage(''), 2600)
    } catch (error) {
      setSaveError(String(error).replace(/^Error:\s*/, ''))
    } finally {
      setSaving(false)
    }
  }

  async function simulateTrip(): Promise<void> {
    const event = await window.quantApi.addRiskEvent({
      level: 'warning',
      title: '模拟风控熔断',
      message: '单策略亏损接近阈值，系统已暂停相关策略并准备撤销未成交订单。',
      strategyId: 'grid-btc-core',
    })
    addRiskEvent(event)
    setStrategies(
      strategies.map((strategy) =>
        strategy.id === event.strategyId ? { ...strategy, status: 'tripped' as const, riskLevel: event.level } : strategy,
      ),
    )
  }

  return (
    <div className="content two-column-page">
      <section className="panel form-panel">
        <div className="panel-head">
          <div>
            <h2>全局风控规则</h2>
            <p>触发高风险条件时自动暂停策略并记录日志</p>
          </div>
          <Gauge size={20} />
        </div>
        <div className="form-grid">
          {[
            ['strategyMaxLoss', '单策略最大亏损 %'],
            ['dailyMaxLoss', '单日最大亏损 %'],
            ['maxPositionRatio', '最大仓位比例 %'],
            ['maxLeverage', '最大杠杆倍数'],
            ['maxLossStreak', '最大连续亏损次数'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                value={draft[key as keyof typeof draft]}
                onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
              />
            </label>
          ))}
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveRules} disabled={saving}>
            {saving ? '保存中...' : '保存风控规则'}
          </button>
          <button className="danger-button" onClick={simulateTrip}>
            模拟熔断
          </button>
        </div>
        {saveMessage && <div className="form-success">{saveMessage}</div>}
        {saveError && <div className="form-error">{saveError}</div>}
      </section>
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>风险事件</h2>
            <p>所有风控触发事件会写入日志</p>
          </div>
        </div>
        <div className="event-list">
          {riskEvents.map((event) => (
            <div className="event-item" key={event.id}>
              <i className={riskClass(event.level)} />
              <div>
                <strong>{event.title}</strong>
                <p>{event.message}</p>
                <span>{formatDate(event.time)} · {riskText(event.level)}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function AssetsPage(): ReactElement {
  const {
    assets,
    apiProfiles,
    accountSyncStatus,
    accountLastSyncedAt,
    accountSyncError,
    setAccountSyncMeta,
  } = useQuantStore()
  const profileOptions = useMemo(() => apiProfiles.filter((profile) => profile.status === 'connected' || profile.canRead), [apiProfiles])
  const [profileId, setProfileId] = useState('')
  const isSyncingRef = useRef(false)
  const selectedProfileId = profileId || profileOptions[0]?.id || ''
  const total = assets.reduce((sum, asset) => sum + assetValue(asset), 0)
  const available = assets.reduce((sum, asset) => sum + assetValue(asset, 'availableBalance'), 0)
  const frozen = assets.reduce((sum, asset) => sum + assetValue(asset, 'frozenBalance'), 0)
  const pnl = assets.reduce((sum, asset) => sum + asset.unrealizedPnl, 0)

  const syncAccount = useCallback(async (): Promise<void> => {
    if (isSyncingRef.current) return
    if (!selectedProfileId) {
      setAccountSyncMeta({ accountSyncError: '请先在 API 管理中添加并测试 Binance API。' })
      return
    }
    isSyncingRef.current = true
    setAccountSyncMeta({ accountSyncStatus: 'loading', accountSyncError: '' })
    try {
      await window.quantApi.fetchAccount(selectedProfileId)
      setAccountSyncMeta({ accountSyncStatus: 'ready', accountLastSyncedAt: Date.now(), accountSyncError: '' })
    } catch (error) {
      setAccountSyncMeta({ accountSyncStatus: 'error', accountSyncError: String(error).replace(/^Error:\s*/, '') })
    } finally {
      isSyncingRef.current = false
    }
  }, [selectedProfileId, setAccountSyncMeta])

  const syncStatusText = accountSyncStatus === 'loading'
    ? '同步中'
    : accountSyncStatus === 'ready'
      ? `自动同步中${accountLastSyncedAt ? ` · ${formatTime(accountLastSyncedAt)}` : ''}`
      : accountSyncStatus === 'error'
        ? '同步失败'
        : selectedProfileId
          ? '准备自动同步'
          : '等待选择 API'

  return (
    <div className="content single-page">
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>资产与账户</h2>
            <p>余额、冻结资金、持仓盈亏与资产配置比例 · {syncStatusText}</p>
          </div>
          <div className="asset-sync-actions">
            <select value={selectedProfileId} onChange={(event) => setProfileId(event.target.value)}>
              <option value="">选择 API</option>
              {profileOptions.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
            <button className="small-button" onClick={syncAccount} disabled={accountSyncStatus === 'loading'}>
              {accountSyncStatus === 'loading' ? '同步中' : '立即刷新'}
            </button>
          </div>
        </div>
        {accountSyncError && <div className="form-error">{accountSyncError}</div>}
        <div className="asset-overview">
          <AssetAllocationPanel assets={assets} />
          <div className="metric-grid asset-metrics">
            <div><span>总资产估值</span><strong>{formatMoney(total)}</strong></div>
            <div><span>可用余额</span><strong>{formatMoney(available)}</strong></div>
            <div><span>冻结资金</span><strong>{formatMoney(frozen)}</strong></div>
            <div><span>持仓盈亏</span><strong className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : ''}{formatMoney(pnl)}</strong></div>
          </div>
        </div>
        <div className="data-table asset-balance-table">
          <div className="table-row head">
            <span>币种</span>
            <span>钱包余额</span>
            <span>可用余额</span>
            <span>冻结余额</span>
            <span>未实现盈亏</span>
            <span>配置比例</span>
          </div>
          {assets.map((asset) => (
            <div className="table-row" key={asset.asset}>
              <span>{asset.asset}</span>
              <span>{formatNumber(asset.walletBalance, asset.asset === 'USDT' ? 2 : 4)}</span>
              <span>{formatNumber(asset.availableBalance, asset.asset === 'USDT' ? 2 : 4)}</span>
              <span>{formatNumber(asset.frozenBalance, asset.asset === 'USDT' ? 2 : 4)}</span>
              <span className={asset.unrealizedPnl >= 0 ? 'up' : 'down'}>{formatNumber(asset.unrealizedPnl, 2)}</span>
              <span>{formatNumber(asset.allocation, 2)}%</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function LogsPage(): ReactElement {
  const { logs, setLogs } = useQuantStore()

  async function clearLogs(): Promise<void> {
    if (logs.length === 0) return
    const confirmed = window.confirm('确认清空所有系统日志？此操作会同步写入本地 SQLite，清空后不可恢复。')
    if (!confirmed) return
    setLogs(await window.quantApi.clearLogs())
  }

  return (
    <div className="content single-page">
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>系统日志</h2>
            <p>策略、交易、风控、API 和敏感操作记录</p>
          </div>
          <button className="danger-button" onClick={clearLogs} disabled={logs.length === 0}>
            清空日志
          </button>
        </div>
        <div className="log-list">
          {logs.length === 0 ? (
            <EmptyRow text="暂无系统日志。" />
          ) : (
            logs.map((log) => (
              <div className={`log-row ${log.level}`} key={log.id}>
                <span>{formatDate(log.time)}</span>
                <strong>{log.scope}{log.strategyId ? ` · ${log.strategyId.slice(0, 8)}` : ''}</strong>
                <p>{log.message}</p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function updatePhaseText(phase: AppUpdateState['phase']): string {
  const labels: Record<AppUpdateState['phase'], string> = {
    idle: '待检查',
    checking: '检查中',
    available: '可更新',
    'not-available': '已最新',
    downloading: '下载中',
    downloaded: '待安装',
    error: '异常',
  }
  return labels[phase]
}

function SettingsPage(): ReactElement {
  const { userSettings, setUserSettings } = useQuantStore()
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  useEffect(() => {
    let disposed = false
    window.quantApi.getUpdateState().then((state) => {
      if (!disposed) setUpdateState(state)
    }).catch(() => undefined)
    const removeListener = window.quantApi.onUpdateState((state) => {
      setUpdateState(state)
    })
    return () => {
      disposed = true
      removeListener()
    }
  }, [])

  function patchSettings(patch: Partial<UserSettings>): void {
    setUserSettings({ ...userSettings, ...patch })
  }

  async function runUpdateAction(action: () => Promise<AppUpdateState | void>): Promise<void> {
    setUpdateBusy(true)
    try {
      const next = await action()
      if (next) setUpdateState(next)
    } finally {
      setUpdateBusy(false)
    }
  }

  async function checkForUpdates(): Promise<void> {
    await runUpdateAction(async () => {
      const next = await window.quantApi.checkForUpdates()
      if (next.phase === 'not-available') {
        window.alert('没有发现新版本，当前已经是最新版本。')
      }
      return next
    })
  }

  const updatePhase = updateState?.phase ?? 'idle'
  const updateProgress = Math.max(0, Math.min(100, updateState?.progress?.percent ?? 0))
  const canCheckUpdate = !updateBusy && updatePhase !== 'checking' && updatePhase !== 'downloading'
  const canDownloadUpdate = !updateBusy && updatePhase === 'available'
  const canInstallUpdate = !updateBusy && updatePhase === 'downloaded'

  return (
    <div className="content single-page">
      <section className="panel settings-panel">
        <div className="panel-head">
          <div>
            <h2>用户设置</h2>
            <p>安全设置、通知设置和偏好设置</p>
          </div>
        </div>
        <div className="settings-grid">
          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>安全与执行</h3>
                <p>关键操作、API 异常和默认运行模式</p>
              </div>
            </div>
            <div className="settings-checks">
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={userSettings.requireActionConfirm}
                  onChange={(event) => patchSettings({ requireActionConfirm: event.target.checked })}
                />
                启用关键操作二次确认
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={userSettings.autoPauseOnApiError}
                  onChange={(event) => patchSettings({ autoPauseOnApiError: event.target.checked })}
                />
                API 异常时自动暂停相关策略
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={userSettings.enableTwoFactor}
                  onChange={(event) => patchSettings({ enableTwoFactor: event.target.checked })}
                />
                启用 2FA 二次验证
              </label>
            </div>
            <label>
              默认运行模式
              <select
                value={userSettings.defaultRunMode}
                onChange={(event) => patchSettings({ defaultRunMode: event.target.value as UserSettings['defaultRunMode'] })}
              >
                <option value="paper">模拟交易</option>
                <option value="live">实盘交易</option>
              </select>
            </label>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>通知消息</h3>
                <p>应用内提醒、系统通知和表格显示偏好</p>
              </div>
            </div>
            <div className="settings-checks">
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={userSettings.notifyOnRiskEvent}
                  onChange={(event) => patchSettings({ notifyOnRiskEvent: event.target.checked })}
                />
                风控事件通知提醒
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={userSettings.compactTableMode}
                  onChange={(event) => patchSettings({ compactTableMode: event.target.checked })}
                />
                紧凑表格显示
              </label>
            </div>
          </section>

          <section className="settings-section update-settings">
            <div className="settings-section-head">
              <div>
                <h3>版本更新</h3>
                <p>当前版本 {updateState?.currentVersion ?? '0.1.0'} · GitHub Release</p>
              </div>
              <span className={`update-badge ${updatePhase}`}>{updatePhaseText(updatePhase)}</span>
            </div>
            <div className="update-summary">
              {updateState?.availableVersion ? (
                <strong>发现版本 {updateState.availableVersion}</strong>
              ) : (
                <strong>暂无待安装版本</strong>
              )}
              <span>{updateState?.error ?? updateState?.message ?? '可以手动检查 GitHub 上的新版本。'}</span>
              {updateState?.releaseDate ? <small>发布时间 {formatDate(new Date(updateState.releaseDate).getTime())}</small> : null}
            </div>
            {updatePhase === 'downloading' ? (
              <div className="update-progress" aria-label="更新下载进度">
                <span style={{ width: `${updateProgress}%` }} />
              </div>
            ) : null}
            <div className="update-actions">
              <button className="ghost-button" disabled={!canCheckUpdate} onClick={() => void checkForUpdates()}>
                <RefreshCw size={15} />
                检查更新
              </button>
              <button className="primary-button" disabled={!canDownloadUpdate} onClick={() => void runUpdateAction(() => window.quantApi.downloadUpdate())}>
                <Download size={15} />
                下载
              </button>
              <button className="primary-button" disabled={!canInstallUpdate} onClick={() => void runUpdateAction(() => window.quantApi.installUpdate())}>
                <Rocket size={15} />
                重启安装
              </button>
              <button className="ghost-button" onClick={() => void window.quantApi.openReleases()}>
                <FileClock size={15} />
                Releases
              </button>
            </div>
          </section>

          <section className="settings-section feishu-settings">
            <div className="settings-section-head">
              <div>
                <h3>飞书同步</h3>
                <p>达到通知阈值时发送到指定飞书用户</p>
              </div>
              <label className="check-field switch-field">
                <input
                  type="checkbox"
                  checked={userSettings.feishuNotifyEnabled}
                  onChange={(event) => patchSettings({ feishuNotifyEnabled: event.target.checked })}
                />
                启用
              </label>
            </div>
            <div className="feishu-grid">
              <label>
                App ID
                <input
                  value={userSettings.feishuAppId}
                  spellCheck={false}
                  onChange={(event) => patchSettings({ feishuAppId: event.target.value.trim() })}
                />
              </label>
              <label>
                User ID
                <input
                  value={userSettings.feishuUserId}
                  spellCheck={false}
                  onChange={(event) => patchSettings({ feishuUserId: event.target.value.trim() })}
                />
              </label>
              <label>
                通知阈值
                <select
                  value={userSettings.feishuThreshold}
                  onChange={(event) => patchSettings({ feishuThreshold: Number(event.target.value) })}
                >
                  <option value={1}>全部事件</option>
                  <option value={2}>关注及以上</option>
                  <option value={3}>警告及以上</option>
                  <option value={4}>仅危险</option>
                </select>
              </label>
              <label className="settings-field-wide">
                App Secret
                <input
                  type="password"
                  value={userSettings.feishuAppSecret}
                  spellCheck={false}
                  onChange={(event) => patchSettings({ feishuAppSecret: event.target.value })}
                />
              </label>
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}

function EmptyRow({ text }: { text: string }): ReactElement {
  return <div className="empty-row">{text}</div>
}

function dateInputValue(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(value) || Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10)
  }
  const year = date.getUTCFullYear()
  if (year < 1000 || year > 9999) {
    return new Date().toISOString().slice(0, 10)
  }
  return date.toISOString().slice(0, 10)
}

function parseDateInputValue(value: string, fallback: number): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return fallback
  const parsed = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(parsed) ? parsed : fallback
}

function intervalDurationMs(interval: CandleInterval): number {
  if (interval === '1m') return 60_000
  if (interval === '5m') return 300_000
  if (interval === '15m') return 900_000
  if (interval === '1h') return 3_600_000
  if (interval === '4h') return 14_400_000
  return 86_400_000
}

function formatBacktestSource(source: BacktestResult['source']): string {
  if (source === 'duckdb') return 'DuckDB 本地缓存'
  if (source === 'binance') return 'Binance 历史 K 线'
  return '浏览器演示数据'
}

function cryptoRandomId(): string {
  if ('crypto' in window && 'randomUUID' in window.crypto) return window.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export default App
