import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { createBrowserQuantApi } from './lib/browser-api'
import './styles.css'

if (!window.quantApi) {
  window.quantApi = createBrowserQuantApi()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
