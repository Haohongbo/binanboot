import type { RiskLevel, StrategyStatus } from '../../../shared/types'

export const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
})

export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatPrice(value: number): string {
  if (Math.abs(value) >= 1000) return formatNumber(value, 2)
  if (Math.abs(value) >= 10) return formatNumber(value, 3)
  return formatNumber(value, 5)
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function formatRatio(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatMoney(value: number, currency = 'USDT'): string {
  if (!Number.isFinite(value)) return '--'
  return `${formatNumber(value, 2)} ${currency}`
}

export function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)
}

export function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value)
}

export function formatRuntime(ms: number): string {
  if (ms <= 0) return '--'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (days > 0) return `${days}天 ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function symbolDisplay(symbol: string): string {
  return symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}/USDT` : symbol
}

export function statusText(status: StrategyStatus): string {
  return {
    running: '运行中',
    paused: '已暂停',
    stopped: '已停止',
    tripped: '已熔断',
  }[status]
}

export function riskText(level: RiskLevel): string {
  return {
    normal: '正常',
    watch: '关注',
    warning: '警告',
    danger: '危险',
  }[level]
}

export function riskClass(level: RiskLevel): string {
  return `risk-${level}`
}
