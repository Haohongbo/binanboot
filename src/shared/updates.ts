export const APP_UPDATE_STATE_CHANNEL = 'updates:state'

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface AppUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  isPackaged: boolean
  availableVersion?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: string
  progress?: AppUpdateProgress
  message?: string
  error?: string
  updatedAt: number
}
