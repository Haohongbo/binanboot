import { useEffect, useRef } from 'react'
import type { AppStatePatch } from '../../../shared/app-state-events'
import { useQuantStore } from '../store'

export function useAppStateSync(): void {
  const hydrate = useQuantStore((state) => state.hydrate)
  const pendingPatchesRef = useRef<AppStatePatch[]>([])

  useEffect(() => {
    window.quantApi.onStatePatch((patch) => {
      if (!useQuantStore.getState().isBootstrapped) {
        pendingPatchesRef.current.push(patch)
        return
      }
      useQuantStore.getState().applyStatePatch(patch)
    })
  }, [])

  useEffect(() => {
    let active = true
    window.quantApi.getSnapshot()
      .then((snapshot) => {
        if (!active) return
        hydrate(snapshot)
        const queuedPatches = pendingPatchesRef.current
        pendingPatchesRef.current = []
        queuedPatches.forEach((patch) => useQuantStore.getState().applyStatePatch(patch))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [hydrate])
}
