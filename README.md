# binanboot

Electron + React 的 Binance 合约量化控制台，支持行情、策略、回测、订单、风控和账户同步。

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
npm run typecheck
```

## 目录

- `src/main`：主进程、SQLite 持久化、Binance / 飞书集成
- `src/preload`：安全桥接 API
- `src/renderer`：React 前端与图表
- `src/shared`：跨进程共享类型与常量
- `strategies`：策略脚本与回测说明

## 配置

建议通过环境变量配置飞书凭据：`FEISHU_BOT_2_APP_ID`、`FEISHU_BOT_2_APP_SECRET`、`FEISHU_BOT_2_USER_ID`、`FEISHU_BOT_2_THRESHOLD`，不要把真实密钥写进仓库。

## 说明

- 行情由 Binance WebSocket 推送，业务状态由主进程增量广播。
- 本地会缓存状态到 SQLite，并在可用时写入 DuckDB 回测数据。
