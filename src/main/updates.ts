import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import type { LocalStore } from './store'
import {
  APP_UPDATE_STATE_CHANNEL,
  type AppUpdateProgress,
  type AppUpdateState,
} from '../shared/updates'

function cleanError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, '').slice(0, 240)
}

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  return notes
    .map((item) => [item.version, item.note].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n')
}

function updateInfoPatch(info: UpdateInfo): Partial<AppUpdateState> {
  return {
    availableVersion: info.version,
    releaseName: info.releaseName ?? undefined,
    releaseDate: info.releaseDate,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  }
}

function progressPatch(progress: ProgressInfo): AppUpdateProgress {
  return {
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
  }
}

export class GitHubUpdateService {
  private state: AppUpdateState = {
    phase: 'idle',
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    message: app.isPackaged ? undefined : '开发模式不会连接 GitHub 更新源，打包安装后可用。',
    updatedAt: Date.now(),
  }

  constructor(private readonly store: LocalStore) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    const githubToken = process.env.GH_TOKEN?.trim()
    if (githubToken) {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'Haohongbo',
        repo: 'binanboot',
        private: true,
        token: githubToken,
      })
    }

    autoUpdater.on('checking-for-update', () => {
      this.setState({ phase: 'checking', progress: undefined, error: undefined, message: '正在检查 GitHub Release。' })
    })

    autoUpdater.on('update-available', (info) => {
      this.setState({ phase: 'available', ...updateInfoPatch(info), message: '发现新版本，可以开始下载。' })
      this.store.addLog('system', 'info', `发现新版本 ${info.version}，来源 GitHub Release。`)
    })

    autoUpdater.on('update-not-available', (info) => {
      this.setState({ phase: 'not-available', ...updateInfoPatch(info), progress: undefined, message: '当前已经是最新版本。' })
    })

    autoUpdater.on('download-progress', (progress) => {
      this.setState({ phase: 'downloading', progress: progressPatch(progress), message: '正在下载更新。' })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.setState({ phase: 'downloaded', ...updateInfoPatch(info), progress: undefined, message: '更新已下载，重启后安装。' })
      this.store.addLog('system', 'info', `新版本 ${info.version} 已下载，等待重启安装。`)
    })

    autoUpdater.on('error', (error) => {
      const message = cleanError(error)
      this.setState({ phase: 'error', error: message, message: '更新检查失败。' })
      this.store.addLog('system', 'error', `GitHub 更新失败：${message}`)
    })
  }

  getState(): AppUpdateState {
    return this.state
  }

  async checkForUpdates(): Promise<AppUpdateState> {
    if (!app.isPackaged) {
      return this.setState({
        phase: 'idle',
        message: '开发模式不会连接 GitHub 更新源，打包安装后可用。',
        error: undefined,
      })
    }

    await autoUpdater.checkForUpdates()
    return this.state
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    if (!app.isPackaged) {
      return this.setState({
        phase: 'idle',
        message: '开发模式不会下载更新，打包安装后可用。',
        error: undefined,
      })
    }

    await autoUpdater.downloadUpdate()
    return this.state
  }

  quitAndInstall(): AppUpdateState {
    if (this.state.phase !== 'downloaded') {
      return this.setState({ error: '更新尚未下载完成。' })
    }
    autoUpdater.quitAndInstall(false, true)
    return this.state
  }

  openReleases(): void {
    void shell.openExternal('https://github.com/Haohongbo/binanboot/releases')
  }

  private setState(patch: Partial<AppUpdateState>): AppUpdateState {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(APP_UPDATE_STATE_CHANNEL, this.state)
      }
    }
    return this.state
  }
}

export function registerUpdateIpc(service: GitHubUpdateService): void {
  ipcMain.handle('updates:state', () => service.getState())
  ipcMain.handle('updates:check', () => service.checkForUpdates())
  ipcMain.handle('updates:download', () => service.downloadUpdate())
  ipcMain.handle('updates:install', () => service.quitAndInstall())
  ipcMain.handle('updates:open-releases', () => service.openReleases())
}
