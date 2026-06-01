import { useEffect, useRef } from 'react'
import { connectBinanceStreams } from '../lib/market-stream'
import { useQuantStore } from '../store'
import type { Candle, DepthLevel, MarketTicker, TradeTick } from '../../../shared/types'

const marketFlushIntervalMs = 180

export function useMarketStream(): void {
  const isBootstrapped = useQuantStore((state) => state.isBootstrapped)
  const selectedSymbol = useQuantStore((state) => state.selectedSymbol)
  const selectedInterval = useQuantStore((state) => state.selectedInterval)
  const watchlist = useQuantStore((state) => state.watchlist)
  const setCurrentMarket = useQuantStore((state) => state.setCurrentMarket)
  const setMarketStatus = useQuantStore((state) => state.setMarketStatus)
  const setSystemTime = useQuantStore((state) => state.setSystemTime)
  const updateTickers = useQuantStore((state) => state.updateTickers)
  const updateKline = useQuantStore((state) => state.updateKline)
  const updateDepth = useQuantStore((state) => state.updateDepth)
  const addTrade = useQuantStore((state) => state.addTrade)
  const frameRef = useRef<{
    tickers: Map<string, MarketTicker>
    kline?: Candle
    depth?: { bids: DepthLevel[]; asks: DepthLevel[] }
    trades: TradeTick[]
    timer?: number
  }>({
    tickers: new Map(),
    trades: [],
  })

  useEffect(() => {
    if (!isBootstrapped) return undefined

    let active = true
    setMarketStatus('connecting')

    const flushMarketFrame = (): void => {
      const frame = frameRef.current
      frame.timer = undefined
      const tickers = [...frame.tickers.values()]
      const kline = frame.kline
      const depth = frame.depth
      const trades = frame.trades.slice(-8)
      frame.tickers.clear()
      frame.kline = undefined
      frame.depth = undefined
      frame.trades = []
      if (tickers.length > 0) updateTickers(tickers)
      if (kline) updateKline(kline)
      if (depth) updateDepth(depth)
      trades.forEach(addTrade)
    }

    const scheduleFlush = (): void => {
      const frame = frameRef.current
      if (frame.timer !== undefined) return
      frame.timer = window.setTimeout(flushMarketFrame, marketFlushIntervalMs)
    }

    const refreshSnapshot = async (): Promise<void> => {
      try {
        const snapshot = await window.quantApi.getMarketSnapshot(selectedSymbol, selectedInterval)
        if (!active) return
        setCurrentMarket(snapshot)
        setMarketStatus(snapshot.source === 'binance' ? 'live' : 'mock')
        setSystemTime(Date.now())
      } catch (error) {
        if (!active) return
        const current = useQuantStore.getState().currentMarket
        setMarketStatus(current ? 'live' : 'mock', String(error))
      }
    }

    void refreshSnapshot()

    const dispose = connectBinanceStreams(
      selectedSymbol,
      selectedInterval,
      {
        onTicker: (ticker) => {
          frameRef.current.tickers.set(ticker.symbol, ticker)
          scheduleFlush()
        },
        onKline: (candle) => {
          frameRef.current.kline = candle
          scheduleFlush()
        },
        onTrade: (trade) => {
          frameRef.current.trades.push(trade)
          scheduleFlush()
        },
        onDepth: (depth) => {
          frameRef.current.depth = depth
          scheduleFlush()
        },
        onStatus: (status) => setMarketStatus(status),
      },
      watchlist,
    )

    return () => {
      active = false
      const frame = frameRef.current
      if (frame.timer !== undefined) window.clearTimeout(frame.timer)
      frame.timer = undefined
      frame.tickers.clear()
      frame.kline = undefined
      frame.depth = undefined
      frame.trades = []
      dispose()
    }
  }, [
    addTrade,
    isBootstrapped,
    selectedInterval,
    selectedSymbol,
    setCurrentMarket,
    setMarketStatus,
    setSystemTime,
    updateDepth,
    updateKline,
    updateTickers,
    watchlist,
  ])
}
