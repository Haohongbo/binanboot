import { app } from 'electron'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import crypto from 'node:crypto'
import type { BacktestParams, BacktestResult, Candle, CandleInterval, MarketSnapshot } from '../shared/types'

function duckDbFilePath(): string {
  return join(app.getPath('userData'), 'quant-platform-analytics.duckdb')
}

export class AnalyticsStore {
  private connection: any = null
  private available = false
  private writeQueue: Promise<void> = Promise.resolve()

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task)
    this.writeQueue = next.catch(() => undefined)
    return next
  }

  async load(): Promise<void> {
    try {
      const file = duckDbFilePath()
      await mkdir(dirname(file), { recursive: true })
      const { DuckDBInstance } = await import('@duckdb/node-api')
      const instance = await DuckDBInstance.fromCache(file)
      const connection = await instance.connect()
      this.connection = connection
      await connection.run(`
        create table if not exists backtest_runs (
          id varchar primary key,
          created_at timestamp,
          symbol varchar,
          interval varchar,
          strategy_type varchar,
          initial_capital double,
          fee_rate double,
          metrics_json varchar
        );
      `)
      await connection.run(`
        create table if not exists backtest_equity_curve (
          run_id varchar,
          time_ms bigint,
          value double
        );
      `)
      await connection.run(`
        create table if not exists backtest_trades (
          run_id varchar,
          time_ms bigint,
          symbol varchar,
          side varchar,
          price double,
          quantity double,
          pnl double
        );
      `)
      await connection.run(`
        create table if not exists market_candles (
          symbol varchar,
          interval varchar,
          time_ms bigint,
          open double,
          high double,
          low double,
          close double,
          volume double,
          primary key(symbol, interval, time_ms)
        );
      `)
      this.available = true
    } catch (error) {
      this.available = false
      console.error(`DuckDB analytics unavailable: ${String(error)}`)
    }
  }

  async recordBacktest(params: BacktestParams, result: BacktestResult): Promise<void> {
    if (!this.available || !this.connection) return
    await this.enqueueWrite(async () => {
      const runId = crypto.randomUUID()
      await this.connection.run('begin transaction')
      try {
        await this.connection.run(
          `insert into backtest_runs
           values ($id, current_timestamp, $symbol, $interval, $strategyType, $initialCapital, $feeRate, $metrics)`,
          {
            id: runId,
            symbol: params.symbol,
            interval: params.interval,
            strategyType: params.strategyType,
            initialCapital: params.initialCapital,
            feeRate: params.feeRate,
            metrics: JSON.stringify(result.metrics),
          },
        )
        const equityInsert = await this.connection.prepare('insert into backtest_equity_curve values ($runId, $time, $value)')
        try {
          for (const point of result.equityCurve) {
            equityInsert.clearBindings()
            equityInsert.bind({
              runId,
              time: point.time,
              value: point.value,
            })
            await equityInsert.run()
          }
        } finally {
          equityInsert.destroySync()
        }
        const tradeInsert = await this.connection.prepare('insert into backtest_trades values ($runId, $time, $symbol, $side, $price, $quantity, $pnl)')
        try {
          for (const trade of result.trades) {
            tradeInsert.clearBindings()
            tradeInsert.bind({
              runId,
              time: trade.time,
              symbol: trade.symbol,
              side: trade.side,
              price: trade.price,
              quantity: trade.quantity,
              pnl: trade.pnl,
            })
            await tradeInsert.run()
          }
        } finally {
          tradeInsert.destroySync()
        }
        await this.connection.run('commit')
      } catch (error) {
        await this.connection.run('rollback').catch(() => undefined)
        console.error(`DuckDB backtest write failed: ${String(error)}`)
      }
    })
  }

  async recordMarketSnapshot(snapshot: MarketSnapshot): Promise<void> {
    if (!this.available || !this.connection) return
    await this.recordMarketCandles(snapshot.symbol, snapshot.interval, snapshot.candles)
  }

  async recordMarketCandles(symbol: string, interval: CandleInterval, candles: Candle[]): Promise<void> {
    if (!this.available || !this.connection || candles.length === 0) return
    await this.enqueueWrite(async () => {
      await this.connection.run('begin transaction')
      try {
        const insert = await this.connection.prepare(
          `insert into market_candles
           values ($symbol, $interval, $time, $open, $high, $low, $close, $volume)
           on conflict(symbol, interval, time_ms) do update set
             open = excluded.open,
             high = excluded.high,
             low = excluded.low,
             close = excluded.close,
             volume = excluded.volume`,
        )
        try {
          for (const candle of candles) {
            insert.clearBindings()
            insert.bind({
              symbol,
              interval,
              time: candle.time,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
            })
            await insert.run()
          }
        } finally {
          insert.destroySync()
        }
        await this.connection.run('commit')
      } catch (error) {
        await this.connection.run('rollback').catch(() => undefined)
        console.error(`DuckDB market snapshot write failed: ${String(error)}`)
      }
    })
  }

  async getMarketCandles(symbol: string, interval: CandleInterval, from: number, to: number): Promise<Candle[]> {
    if (!this.available || !this.connection) return []
    try {
      const reader = await this.connection.runAndReadAll(
        `select time_ms, open, high, low, close, volume
         from market_candles
         where symbol = $symbol and interval = $interval and time_ms between $from and $to
         order by time_ms`,
        { symbol, interval, from, to },
      )
      const rows = reader.getRows()
      return rows.map((row: unknown[]) => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      }))
    } catch (error) {
      console.error(`DuckDB market candle read failed: ${String(error)}`)
      return []
    }
  }

  hasSufficientCoverage(candles: Candle[], from: number, to: number, intervalMs: number): boolean {
    if (candles.length === 0) return false
    const first = candles[0]?.time ?? Number.POSITIVE_INFINITY
    const last = candles[candles.length - 1]?.time ?? 0
    return first <= from + intervalMs * 2 && last >= to - intervalMs * 2
  }
}
