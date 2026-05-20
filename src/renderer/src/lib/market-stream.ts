import type { CandleInterval, DepthLevel, MarketTicker, TradeTick } from '../../../shared/types'
import { DEFAULT_WATCHLIST, makeInitialTicker, normalizeWatchlistSymbols } from '../../../shared/market-symbols'

export const WATCHLIST = DEFAULT_WATCHLIST

export const INITIAL_TICKERS: MarketTicker[] = WATCHLIST.map(makeInitialTicker)

type StreamHandlers = {
  onTicker: (ticker: MarketTicker) => void
  onKline: (candle: { time: number; open: number; high: number; low: number; close: number; volume: number }) => void
  onTrade: (trade: TradeTick) => void
  onDepth: (depth: { bids: DepthLevel[]; asks: DepthLevel[] }) => void
  onStatus: (status: 'connecting' | 'live' | 'mock' | 'error') => void
}

const FUTURES_STREAM_BASE = 'wss://fstream.binance.com/stream?streams='
const STALE_STREAM_MS = 20_000
const HEARTBEAT_MS = 5_000
const RECONNECT_BASE_DELAY_MS = 700
const RECONNECT_MAX_DELAY_MS = 8_000

function parseNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function streamUrl(symbol: string, interval: CandleInterval, watchlist: string[]): string {
  const lower = symbol.toLowerCase()
  const trackedStreams = normalizeWatchlistSymbols(watchlist).flatMap((item) => {
    const streamSymbol = item.toLowerCase()
    return [`${streamSymbol}@ticker`, `${streamSymbol}@aggTrade`]
  })
  const streams = new Set([
    ...trackedStreams,
    `${lower}@kline_${interval}`,
    `${lower}@depth20@100ms`,
  ])
  return `${FUTURES_STREAM_BASE}${[...streams].join('/')}`
}

export function connectBinanceStreams(
  symbol: string,
  interval: CandleInterval,
  handlers: StreamHandlers,
  watchlist = WATCHLIST,
): () => void {
  const trackedSymbols = new Set(normalizeWatchlistSymbols(watchlist))
  handlers.onStatus('connecting')

  let socket: WebSocket | undefined
  let closedByCaller = false
  let lastMessageAt = Date.now()
  let reconnectAttempts = 0
  let reconnectTimer: number | undefined
  let heartbeatTimer: number | undefined

  const cleanupSocket = (): void => {
    if (!socket) return
    const current = socket
    socket = undefined
    try {
      current.onopen = null
      current.onclose = null
      current.onerror = null
      current.onmessage = null
      current.close()
    } catch {
      // Best effort cleanup.
    }
  }

  const scheduleReconnect = (): void => {
    if (closedByCaller || reconnectTimer !== undefined) return
    handlers.onStatus('connecting')
    cleanupSocket()
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts)
    reconnectAttempts += 1
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  const handleMessage = (event: MessageEvent): void => {
    lastMessageAt = Date.now()
    let payload: { stream?: string; data?: unknown }
    try {
      payload = JSON.parse(String(event.data)) as { stream?: string; data?: unknown }
    } catch {
      return
    }
    const data = payload.data as Record<string, unknown> | Array<Record<string, unknown>>
    if (!data) return

    if (Array.isArray(data)) {
      data
        .filter((item) => trackedSymbols.has(String(item.s)))
        .forEach((item) => {
          handlers.onTicker({
            symbol: String(item.s),
            lastPrice: parseNumber(item.c),
            priceChangePercent: parseNumber(item.P),
            quoteVolume: parseNumber(item.q),
            latencyMs: Math.max(0, Date.now() - parseNumber(item.E)),
          })
        })
      return
    }

    if (payload.stream?.includes('@ticker')) {
      const tickerSymbol = String(data.s)
      if (trackedSymbols.has(tickerSymbol)) {
        handlers.onTicker({
          symbol: tickerSymbol,
          lastPrice: parseNumber(data.c),
          priceChangePercent: parseNumber(data.P),
          quoteVolume: parseNumber(data.q),
          latencyMs: Math.max(0, Date.now() - parseNumber(data.E)),
        })
      }
      return
    }

    if (payload.stream?.includes('@kline_') && data.k && typeof data.k === 'object') {
      const kline = data.k as Record<string, unknown>
      handlers.onKline({
        time: parseNumber(kline.t),
        open: parseNumber(kline.o),
        high: parseNumber(kline.h),
        low: parseNumber(kline.l),
        close: parseNumber(kline.c),
        volume: parseNumber(kline.v),
      })
      return
    }

    if (payload.stream?.includes('@aggTrade')) {
      handlers.onTrade({
        id: parseNumber(data.a),
        symbol: String(data.s),
        time: parseNumber(data.T),
        price: parseNumber(data.p),
        quantity: parseNumber(data.q),
        side: data.m ? 'SELL' : 'BUY',
      })
      return
    }

    if (payload.stream?.includes('@depth')) {
      const bids = Array.isArray(data.b) ? (data.b as string[][]) : []
      const asks = Array.isArray(data.a) ? (data.a as string[][]) : []
      handlers.onDepth({
        bids: bids.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) })),
        asks: asks.map(([price, quantity]) => ({ price: parseNumber(price), quantity: parseNumber(quantity) })),
      })
    }
  }

  function connect(): void {
    if (closedByCaller) return
    lastMessageAt = Date.now()
    cleanupSocket()
    socket = new WebSocket(streamUrl(symbol, interval, watchlist))
    socket.onopen = () => {
      reconnectAttempts = 0
      lastMessageAt = Date.now()
      handlers.onStatus('live')
    }
    socket.onclose = () => {
      if (closedByCaller) return
      scheduleReconnect()
    }
    socket.onerror = () => {
      if (closedByCaller) return
      handlers.onStatus('error')
      scheduleReconnect()
    }
    socket.onmessage = handleMessage
  }

  const restartIfStale = (): void => {
    if (closedByCaller || document.visibilityState === 'hidden') return
    if (Date.now() - lastMessageAt > STALE_STREAM_MS) scheduleReconnect()
  }

  const reconnectOnVisible = (): void => {
    if (closedByCaller || document.visibilityState !== 'visible') return
    if (!socket || socket.readyState !== WebSocket.OPEN || Date.now() - lastMessageAt > HEARTBEAT_MS) {
      scheduleReconnect()
    }
  }

  connect()
  heartbeatTimer = window.setInterval(restartIfStale, HEARTBEAT_MS)
  document.addEventListener('visibilitychange', reconnectOnVisible)
  window.addEventListener('online', scheduleReconnect)

  const close = (): void => {
    closedByCaller = true
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
    if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer)
    document.removeEventListener('visibilitychange', reconnectOnVisible)
    window.removeEventListener('online', scheduleReconnect)
    if (socket) {
      try {
        socket.close()
      } catch {
        // Best effort cleanup.
      }
    }
  }

  return close
}
