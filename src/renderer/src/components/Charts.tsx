import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent, ReactElement } from 'react'
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  LineSeries,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { BacktestResult, MarketSnapshot } from '../../../shared/types'
import { formatDate, formatMoney, formatNumber, formatRatio } from '../lib/format'
import { crossoverSignals, movingAverage } from '../lib/indicators'

export function MarketChart({ market }: { market: MarketSnapshot | null }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ma5Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ma20Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const quoteLineRef = useRef<IPriceLine | null>(null)
  const lastFitKeyRef = useRef<string | null>(null)
  const lastDataKeyRef = useRef<string | null>(null)
  const lastCandleCountRef = useRef(0)

  const data = useMemo(() => {
    if (!market) return null
    return {
      candles: market.candles.map((candle) => ({
        time: Math.floor(candle.time / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
      ma5: movingAverage(market.candles, 5).map((item) => ({ ...item, time: item.time as UTCTimestamp })),
      ma20: movingAverage(market.candles, 20).map((item) => ({ ...item, time: item.time as UTCTimestamp })),
      markers: crossoverSignals(market.candles),
    }
  }, [market])

  useLayoutEffect(() => {
    if (!containerRef.current) return
    lastFitKeyRef.current = null
    lastDataKeyRef.current = null
    lastCandleCountRef.current = 0

    const chart = createChart(containerRef.current, {
      width: Math.max(containerRef.current.clientWidth, 320),
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: '#0b1118' },
        textColor: '#c8d1dd',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(99, 116, 142, 0.14)' },
        horzLines: { color: 'rgba(99, 116, 142, 0.14)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(99, 116, 142, 0.2)',
      },
      timeScale: {
        borderColor: 'rgba(99, 116, 142, 0.2)',
        rightOffset: 10,
        barSpacing: 8,
        minBarSpacing: 3,
        lockVisibleTimeRangeOnResize: true,
        rightBarStaysOnScroll: true,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
      },
      kineticScroll: {
        mouse: true,
        touch: true,
      },
    })

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#27d6a2',
      downColor: '#ff6b6b',
      borderVisible: false,
      wickUpColor: '#27d6a2',
      wickDownColor: '#ff6b6b',
    })
    const ma5 = chart.addSeries(LineSeries, {
      color: '#f7b739',
      lineWidth: 2,
    })
    const ma20 = chart.addSeries(LineSeries, {
      color: '#8f61ff',
      lineWidth: 2,
    })

    chartRef.current = chart
    candleRef.current = candles
    ma5Ref.current = ma5
    ma20Ref.current = ma20

    let resizeFrame = 0
    const resize = (): void => {
      if (!containerRef.current) return
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (!containerRef.current || chartRef.current !== chart) return
        chart.applyOptions({ width: Math.max(containerRef.current.clientWidth, 320) })
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(containerRef.current)
    window.addEventListener('resize', resize)
    requestAnimationFrame(resize)
    return () => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      window.removeEventListener('resize', resize)
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      ma5Ref.current = null
      ma20Ref.current = null
      quoteLineRef.current = null
      lastFitKeyRef.current = null
      lastDataKeyRef.current = null
      lastCandleCountRef.current = 0
    }
  }, [containerRef])

  useEffect(() => {
    if (!data || !candleRef.current || !ma5Ref.current || !ma20Ref.current || !chartRef.current) return
    const dataKey = market ? `${market.symbol}:${market.interval}` : null
    const latestCandle = data.candles[data.candles.length - 1]
    const canIncrementalUpdate =
      dataKey &&
      dataKey === lastDataKeyRef.current &&
      latestCandle &&
      data.candles.length === lastCandleCountRef.current
    if (canIncrementalUpdate) {
      candleRef.current.update(latestCandle)
    } else {
      candleRef.current.setData(data.candles)
      lastDataKeyRef.current = dataKey
      lastCandleCountRef.current = data.candles.length
    }
    ma5Ref.current.setData(data.ma5)
    ma20Ref.current.setData(data.ma20)
    const fitKey = market ? `${market.symbol}:${market.interval}` : null
    if (fitKey && fitKey !== lastFitKeyRef.current) {
      requestAnimationFrame(() => {
        if (!chartRef.current) return
        chartRef.current.timeScale().fitContent()
      })
      lastFitKeyRef.current = fitKey
    }
  }, [data, market])

  useEffect(() => {
    const midPrice = market?.quoteMidPrice
      ?? (market?.bids[0] && market?.asks[0] ? (market.bids[0].price + market.asks[0].price) / 2 : undefined)
    if (!candleRef.current) return
    if (!midPrice || midPrice <= 0) {
      if (quoteLineRef.current) {
        candleRef.current.removePriceLine(quoteLineRef.current)
        quoteLineRef.current = null
      }
      return
    }
    if (quoteLineRef.current) {
      quoteLineRef.current.applyOptions({ price: midPrice })
      return
    }
    quoteLineRef.current = candleRef.current.createPriceLine({
      price: midPrice,
      color: '#4d8dff',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '盘口',
    })
  }, [market?.quoteMidPrice, market?.bids, market?.asks])

  return <div className="chart-root" ref={containerRef} />
}

export function MiniAreaChart({
  values,
  tone,
  large = false,
}: {
  values: number[]
  tone: 'green' | 'amber' | 'blue'
  large?: boolean
}): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: Math.max(containerRef.current.clientWidth, 80),
      height: large ? 180 : 76,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#7e90a5',
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
    })
    const series = chart.addSeries(AreaSeries, {
      lineColor: tone === 'amber' ? '#f7b739' : tone === 'blue' ? '#4d8dff' : '#27d6a2',
      topColor:
        tone === 'amber'
          ? 'rgba(247, 183, 57, 0.24)'
          : tone === 'blue'
            ? 'rgba(77, 141, 255, 0.24)'
            : 'rgba(39, 214, 162, 0.24)',
      bottomColor: 'rgba(39, 214, 162, 0.02)',
      lineWidth: 2,
    })
    chartRef.current = chart
    seriesRef.current = series

    const resize = (): void => {
      if (containerRef.current) chart.applyOptions({ width: Math.max(containerRef.current.clientWidth, 80) })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(containerRef.current)
    window.addEventListener('resize', resize)
    requestAnimationFrame(resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [containerRef, large, tone])

  useEffect(() => {
    if (!seriesRef.current || values.length === 0) return
    const min = Math.min(...values)
    const max = Math.max(...values)
    const scaled = values.map((value, index) => ({
      time: (index + 1) as UTCTimestamp,
      value: max === min ? 0 : (value - min) / (max - min),
    }))
    seriesRef.current.setData(scaled)
    chartRef.current?.timeScale().fitContent()
  }, [values])

  return <div className={large ? 'mini-chart large' : 'mini-chart'} ref={containerRef} />
}

export function SparklineValue({ value }: { value: number }): ReactElement {
  return <span>{formatNumber(value, 2)}</span>
}

type EquityTooltip = {
  left: number
  top: number
  time: number
  value: number
  returnRatio: number
  x: number
  y: number
}

export function EquityCurveChart({
  curve,
  initialCapital,
}: {
  curve: BacktestResult['equityCurve']
  initialCapital: number
}): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [tooltip, setTooltip] = useState<EquityTooltip | null>(null)

  const geometry = useMemo(() => {
    if (curve.length === 0) return null
    const width = 1000
    const height = 220
    const top = 14
    const bottom = 34
    const left = 0
    const right = width
    const values = curve.map((item) => item.value)
    const min = Math.min(...values, initialCapital)
    const max = Math.max(...values, initialCapital)
    const span = Math.max(max - min, Math.max(1, initialCapital) * 0.002)
    const points = curve.map((item, index) => {
      const x = curve.length === 1 ? left : left + (index / (curve.length - 1)) * (right - left)
      const y = top + ((max - item.value) / span) * (height - top - bottom)
      return { ...item, x, y }
    })
    const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
    const areaPath = `${linePath} L ${points.at(-1)?.x.toFixed(2) ?? right} ${height} L ${points[0].x.toFixed(2)} ${height} Z`
    const baselineY = top + ((max - initialCapital) / span) * (height - top - bottom)
    return { width, height, points, linePath, areaPath, baselineY }
  }, [curve, initialCapital])

  useEffect(() => {
    setTooltip(null)
  }, [curve])

  if (!geometry) {
    return <div className="equity-chart-empty">运行回测后显示真实权益曲线</div>
  }
  const chartGeometry = geometry

  function handleMove(event: PointerEvent<HTMLDivElement>): void {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
    const index = Math.min(Math.round(ratio * (chartGeometry.points.length - 1)), chartGeometry.points.length - 1)
    const point = chartGeometry.points[index]
    const pixelX = (point.x / chartGeometry.width) * rect.width
    const pixelY = (point.y / chartGeometry.height) * rect.height
    setTooltip({
      left: Math.min(Math.max(pixelX + 12, 8), rect.width - 172),
      top: Math.min(Math.max(pixelY + 12, 8), rect.height - 72),
      x: point.x,
      y: point.y,
      time: point.time,
      value: point.value,
      returnRatio: initialCapital > 0 ? (point.value - initialCapital) / initialCapital : 0,
    })
  }

  return (
    <div className="equity-chart-shell" ref={containerRef} onPointerMove={handleMove} onPointerLeave={() => setTooltip(null)}>
      <svg className="equity-chart-svg" viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-label="回测权益曲线">
        <defs>
          <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(39, 214, 162, 0.34)" />
            <stop offset="100%" stopColor="rgba(39, 214, 162, 0.03)" />
          </linearGradient>
        </defs>
        <path d={geometry.areaPath} fill="url(#equity-fill)" />
        <line className="equity-baseline" x1="0" x2={geometry.width} y1={geometry.baselineY} y2={geometry.baselineY} />
        <path className="equity-line" d={geometry.linePath} />
        {tooltip && (
          <>
            <line className="equity-crosshair" x1={tooltip.x} x2={tooltip.x} y1="0" y2={geometry.height} />
            <circle className="equity-point" cx={tooltip.x} cy={tooltip.y} r="5" />
          </>
        )}
      </svg>
      {tooltip && (
        <div className="equity-tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
          <strong className={tooltip.returnRatio >= 0 ? 'up' : 'down'}>{formatRatio(tooltip.returnRatio)}</strong>
          <span>{formatMoney(tooltip.value)}</span>
          <em>{formatDate(tooltip.time)}</em>
        </div>
      )}
    </div>
  )
}
