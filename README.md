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

## GitHub 版本发布

应用内版本更新读取 GitHub Releases。发布 Windows 安装包前先更新 `package.json` 的 `version`，再执行：

```bash
GH_TOKEN=你的GitHubToken npm run publish:win
```

`GH_TOKEN` 需要有发布 Release 的权限。仓库如果保持私有，客户端检查更新也需要能访问私有 Release；面向普通用户分发时建议将 Release 可访问性改为公开。

GitHub Actions 也会在推送 `v*` 标签时自动构建 Windows、macOS、Linux 安装包并上传到 Releases：

```bash
npm version patch
git push
git push origin v$(node -p "require('./package.json').version")
```

也可以在 GitHub 的 Actions 页面手动运行 `Build release` 工作流。

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
