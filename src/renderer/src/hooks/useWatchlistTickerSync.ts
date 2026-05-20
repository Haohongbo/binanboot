import { useEffect, useRef } from 'react'
import { useQuantStore } from '../store'

export function useWatchlistTickerSync(): void {
  const isBootstrapped = useQuantStore((state) => state.isBootstrapped)
  const watchlist = useQuantStore((state) => state.watchlist)
  const updateTickers = useQuantStore((state) => state.updateTickers)
  const syncingRef = useRef(false)

  useEffect(() => {
    if (!isBootstrapped || watchlist.length === 0) return undefined

    const syncTickers = async (): Promise<void> => {
      if (syncingRef.current) return
      syncingRef.current = true
      try {
        const tickers = await window.quantApi.getMarketTickers(watchlist)
        updateTickers(tickers)
      } catch {
        // WebSocket still keeps the selected symbol live; REST is a best-effort fallback.
      } finally {
        syncingRef.current = false
      }
    }

    void syncTickers()
    const timer = window.setInterval(() => void syncTickers(), 5_000)
    return () => window.clearInterval(timer)
  }, [isBootstrapped, updateTickers, watchlist])
}
