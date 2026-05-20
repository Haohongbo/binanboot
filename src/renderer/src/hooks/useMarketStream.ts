import { useEffect } from 'react'
import { connectBinanceStreams } from '../lib/market-stream'
import { useQuantStore } from '../store'

export function useMarketStream(): void {
  const isBootstrapped = useQuantStore((state) => state.isBootstrapped)
  const selectedSymbol = useQuantStore((state) => state.selectedSymbol)
  const selectedInterval = useQuantStore((state) => state.selectedInterval)
  const watchlist = useQuantStore((state) => state.watchlist)
  const setCurrentMarket = useQuantStore((state) => state.setCurrentMarket)
  const setMarketStatus = useQuantStore((state) => state.setMarketStatus)
  const setSystemTime = useQuantStore((state) => state.setSystemTime)
  const updateTicker = useQuantStore((state) => state.updateTicker)
  const updateKline = useQuantStore((state) => state.updateKline)
  const updateDepth = useQuantStore((state) => state.updateDepth)
  const addTrade = useQuantStore((state) => state.addTrade)

  useEffect(() => {
    if (!isBootstrapped) return undefined

    let active = true
    setMarketStatus('connecting')

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
        onTicker: updateTicker,
        onKline: updateKline,
        onTrade: addTrade,
        onDepth: updateDepth,
        onStatus: (status) => setMarketStatus(status),
      },
      watchlist,
    )

    return () => {
      active = false
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
    updateTicker,
    watchlist,
  ])
}
