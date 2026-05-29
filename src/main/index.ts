import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { AnalyticsStore } from './analytics'
import { registerIpc } from './ipc'
import { LocalStore } from './store'
import { StrategyExecutionEngine } from './strategy-engine'
import { GitHubUpdateService, registerUpdateIpc } from './updates'
import { APP_STATE_PATCH_CHANNEL } from '../shared/app-state-events'

const store = new LocalStore()
const analytics = new AnalyticsStore()
const strategyEngine = new StrategyExecutionEngine(store)
const updateService = new GitHubUpdateService(store)

ipcMain.handle('window:toggle-maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return false
  if (window.isMaximized()) {
    window.unmaximize()
    return false
  }
  window.maximize()
  return true
})

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1280,
    minHeight: 780,
    title: '虚拟货币量化自动化交易平台',
    backgroundColor: '#081018',
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Renderer failed to load (${errorCode}) ${validatedURL}: ${errorDescription}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer process gone: ${details.reason}`)
  })
  mainWindow.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.sourceId}:${event.lineNumber} ${event.message}`)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || (!app.isPackaged ? 'http://127.0.0.1:5173/' : '')
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.show()
  console.log(`Renderer loaded: ${mainWindow.webContents.getURL()}`)
}

app.whenReady().then(async () => {
  await store.load()
  await analytics.load()
  store.subscribe((patch) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(APP_STATE_PATCH_CHANNEL, patch)
      }
    }
  })
  registerIpc(store, analytics)
  registerUpdateIpc(updateService)
  strategyEngine.start()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  strategyEngine.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  strategyEngine.stop()
})
