import { useCallback, useEffect, useRef } from 'react'
import { useQuantStore } from '../store'

export function useAccountAutoSync(): void {
  const autoAccountProfileId = useQuantStore(
    (state) => state.apiProfiles.find((profile) => profile.status === 'connected' || profile.canRead)?.id ?? '',
  )
  const setAccountSyncMeta = useQuantStore((state) => state.setAccountSyncMeta)
  const isSyncingRef = useRef(false)

  const syncAccountAssets = useCallback(async (): Promise<void> => {
    if (isSyncingRef.current || !autoAccountProfileId) return
    isSyncingRef.current = true
    setAccountSyncMeta({ accountSyncStatus: 'loading', accountSyncError: '' })
    try {
      await window.quantApi.fetchAccount(autoAccountProfileId)
      setAccountSyncMeta({ accountSyncStatus: 'ready', accountLastSyncedAt: Date.now(), accountSyncError: '' })
    } catch (error) {
      setAccountSyncMeta({ accountSyncStatus: 'error', accountSyncError: String(error).replace(/^Error:\s*/, '') })
    } finally {
      isSyncingRef.current = false
    }
  }, [autoAccountProfileId, setAccountSyncMeta])

  useEffect(() => {
    if (!autoAccountProfileId) {
      setAccountSyncMeta({ accountSyncError: '请先在 API 管理中添加并测试 Binance API。' })
      return undefined
    }

    void syncAccountAssets()
    const timer = window.setInterval(() => void syncAccountAssets(), 15_000)
    const syncOnFocus = (): void => void syncAccountAssets()
    const syncOnVisible = (): void => {
      if (document.visibilityState === 'visible') void syncAccountAssets()
    }

    window.addEventListener('focus', syncOnFocus)
    document.addEventListener('visibilitychange', syncOnVisible)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', syncOnFocus)
      document.removeEventListener('visibilitychange', syncOnVisible)
    }
  }, [autoAccountProfileId, setAccountSyncMeta, syncAccountAssets])
}
