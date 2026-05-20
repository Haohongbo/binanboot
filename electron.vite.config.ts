import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('lightweight-charts')) return 'charts'
            if (id.includes('lucide-react')) return 'icons'
            if (id.includes('zustand')) return 'state'
            if (id.includes('react-dom') || id.includes('/react/')) return 'react'
            return 'vendor'
          },
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    server: {
      port: 5173,
      host: '127.0.0.1',
    },
    plugins: [react()],
  },
})
