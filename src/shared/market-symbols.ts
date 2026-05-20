import type { MarketTicker } from './types'

export const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT', 'LTCUSDT']

const defaultTickerProfiles: Record<string, Omit<MarketTicker, 'symbol'>> = {
  BTCUSDT: { lastPrice: 80_653.1, priceChangePercent: -1.65, quoteVolume: 186_700_000, latencyMs: 21 },
  ETHUSDT: { lastPrice: 2_281.68, priceChangePercent: -2.52, quoteVolume: 91_200_000, latencyMs: 23 },
  SOLUSDT: { lastPrice: 94.55, priceChangePercent: -3.1, quoteVolume: 47_900_000, latencyMs: 19 },
  ADAUSDT: { lastPrice: 0.2705, priceChangePercent: -3.67, quoteVolume: 19_300_000, latencyMs: 26 },
  XRPUSDT: { lastPrice: 1.4359, priceChangePercent: -2.57, quoteVolume: 36_100_000, latencyMs: 24 },
  LTCUSDT: { lastPrice: 57.58, priceChangePercent: -2.44, quoteVolume: 11_800_000, latencyMs: 31 },
}

export function normalizeSymbolInput(input: string): string | null {
  const normalized = input.trim().toUpperCase().replace(/\s+/g, '').replace(/[\/_-]/g, '')
  if (!normalized) return null
  if (normalized.endsWith('USDT')) {
    return /^[A-Z0-9]{2,20}USDT$/.test(normalized) ? normalized : null
  }
  if (!/^[A-Z0-9]{2,20}$/.test(normalized)) return null
  return `${normalized}USDT`
}

export function normalizeWatchlistSymbols(symbols?: string[]): string[] {
  const source = Array.isArray(symbols) && symbols.length > 0 ? symbols : DEFAULT_WATCHLIST
  const unique = new Set<string>()
  source.forEach((symbol) => {
    const normalized = normalizeSymbolInput(symbol)
    if (normalized) unique.add(normalized)
  })
  if (unique.size === 0) DEFAULT_WATCHLIST.forEach((symbol) => unique.add(symbol))
  return [...unique]
}

export function makeInitialTicker(symbol: string): MarketTicker {
  return {
    symbol,
    ...(defaultTickerProfiles[symbol] ?? { lastPrice: 0, priceChangePercent: 0, quoteVolume: 0, latencyMs: 0 }),
  }
}
