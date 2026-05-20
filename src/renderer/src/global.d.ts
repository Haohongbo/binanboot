import type { QuantApi } from '../../preload'

declare global {
  interface Window {
    quantApi: QuantApi
  }
}
