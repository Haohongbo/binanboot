# Linux 服务器浏览器部署说明

## 结论

这个项目**可以**发布到 Linux 服务器上，通过浏览器访问，但要分两种情况理解：

1. **浏览器预览版**：可以直接把前端构建产物部署到 Web 服务器，浏览器能打开页面。
2. **完整桌面版能力**：当前项目本质上是 Electron 桌面应用，主进程、`preload`、IPC、`@duckdb/node-api` 等能力不能直接在纯浏览器环境里运行，所以**不能原封不动地当成标准 Web 应用上线**。

项目里已经做了浏览器降级处理：

- `src/renderer/src/main.tsx` 会在没有 Electron 注入时自动使用 `createBrowserQuantApi()`
- `src/renderer/src/lib/browser-api.ts` 提供了浏览器可运行的 mock 数据和 mock 接口

所以，**如果你的目标是“在 Linux 服务器上用浏览器打开一个可用的控制台界面”**，是可以做的；  
**如果你的目标是“浏览器里直接连 Binance、写本地存储、跑 Electron 主进程逻辑”**，那就需要额外做后端改造。

## 当前项目的发布方式

### 可直接发布的部分

只发布前端构建产物：

```bash
npm run build
```

构建后，浏览器可访问的静态文件在：

```bash
out/renderer
```

### 不会随浏览器部署一起工作的部分

- Electron 主进程
- `preload` 暴露的桌面端 API
- 本地 SQLite / DuckDB 的桌面端读写逻辑
- 桌面窗口控制、系统托盘、原生窗口行为

## Linux 服务器部署教程

下面是最常见的“静态站点 + Nginx”方案。

### 1. 安装环境

Linux 服务器上准备好以下软件：

- `node.js` 20+ 
- `npm`
- `nginx`

Ubuntu / Debian 示例：

```bash
sudo apt update
sudo apt install -y nginx nodejs npm
```

如果你的系统自带的 Node 版本太旧，建议用 `nvm` 安装较新的 Node。

### 2. 拉取代码并安装依赖

```bash
git clone <你的仓库地址>
cd binanboot
npm ci
```

### 3. 构建前端

```bash
npm run build
```

构建完成后，确认存在：

```bash
out/renderer/index.html
```

### 4. 把构建产物发布到 Web 根目录

把 `out/renderer` 目录复制到服务器的站点目录，例如：

```bash
sudo mkdir -p /var/www/binanboot
sudo cp -r out/renderer/* /var/www/binanboot/
```

### 5. 配置 Nginx

创建站点配置，例如：

```bash
sudo nano /etc/nginx/sites-available/binanboot
```

写入：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    root /var/www/binanboot;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

启用站点并重载：

```bash
sudo ln -s /etc/nginx/sites-available/binanboot /etc/nginx/sites-enabled/binanboot
sudo nginx -t
sudo systemctl reload nginx
```

### 6. 浏览器访问

直接打开：

```text
http://your-domain.com
```

## 使用说明

浏览器方式打开后，界面会使用 mock 数据源运行，适合：

- 演示界面
- 预览策略面板
- 检查前端交互
- 做产品原型展示

它不适合直接承担真实交易职责。

## 如果要做“真正的 Web 版”

如果你希望浏览器里直接使用真实功能，建议把下面这些能力迁到后端服务：

- Binance API 调用
- 账户和订单管理
- 策略执行引擎
- 状态持久化
- 风控和日志服务

然后前端只保留 UI，通过 HTTP / WebSocket / SSE 和后端通信。

## 另一种方案

如果你只是想“在 Linux 服务器上运行桌面版，然后远程在浏览器里看见它”，也可以考虑：

- `xrdp`
- `noVNC`
- 远程桌面网关

这类方案本质上还是 Electron 桌面应用，不是纯 Web 发布。

