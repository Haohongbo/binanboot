import { useEffect, useRef } from 'react'
import { useQuantStore } from '../store'

export function usePreferencePersistence(): void {
  const isBootstrapped = useQuantStore((state) => state.isBootstrapped)
  const selectedSymbol = useQuantStore((state) => state.selectedSymbol)
  const selectedInterval = useQuantStore((state) => state.selectedInterval)
  const watchlist = useQuantStore((state) => state.watchlist)
  const liveMode = useQuantStore((state) => state.liveMode)
  const backtestParams = useQuantStore((state) => state.backtestParams)
  const userSettings = useQuantStore((state) => state.userSettings)
  const lastPersistedPreferencesRef = useRef('')
  const preferencesKey = JSON.stringify({
    selectedSymbol,
    selectedInterval,
    watchlist,
    liveMode,
    backtestParams,
    userSettings,
  })

  useEffect(() => {
    if (!isBootstrapped) return undefined
    if (!lastPersistedPreferencesRef.current) {
      lastPersistedPreferencesRef.current = preferencesKey
      return undefined
    }
    if (lastPersistedPreferencesRef.current === preferencesKey) return undefined
    const timer = window.setTimeout(() => {
      lastPersistedPreferencesRef.current = preferencesKey
      void window.quantApi.updatePreferences({
        selectedSymbol,
        selectedInterval,
        watchlist,
        liveMode,
        backtestParams,
        userSettings,
      }).catch(() => {
        lastPersistedPreferencesRef.current = ''
      })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [backtestParams, isBootstrapped, liveMode, preferencesKey, selectedInterval, selectedSymbol, userSettings, watchlist])
}
