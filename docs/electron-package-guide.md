# 多平台程序打包教程

## 结论

本项目是 **Electron + React + electron-vite** 项目，可以打包成桌面程序，常见目标包括：

- macOS：`.dmg`、`.zip`
- Windows：`.exe` 安装包
- Linux：`.AppImage`、`.deb`、`.rpm`

当前项目已有：

```bash
npm run build
```

这个命令只会生成 Electron 运行所需的构建产物：

```text
out/main
out/preload
out/renderer
```

它还不是最终安装包。要生成各平台可分发程序，建议使用 `electron-builder`。

## 1. 安装打包工具

在项目根目录执行：

```bash
npm install -D electron-builder
```

安装完成后，`package.json` 会新增 `electron-builder` 到 `devDependencies`。

## 2. 添加打包脚本

修改 `package.json` 的 `scripts`，保留原脚本，并增加下面这些命令：

```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "pack": "npm run typecheck && npm run build && electron-builder --dir",
    "dist": "npm run typecheck && npm run build && electron-builder",
    "dist:mac": "npm run typecheck && npm run build && electron-builder --mac",
    "dist:win": "npm run typecheck && npm run build && electron-builder --win",
    "dist:linux": "npm run typecheck && npm run build && electron-builder --linux"
  }
}
```

命令说明：

- `pack`：只生成未压缩的应用目录，适合本地检查。
- `dist`：按当前系统生成正式安装包。
- `dist:mac`：生成 macOS 安装包。
- `dist:win`：生成 Windows 安装包。
- `dist:linux`：生成 Linux 安装包。

## 3. 添加 electron-builder 配置

建议在项目根目录新增：

```text
electron-builder.yml
```

基础配置示例：

```yaml
appId: com.binanboot.app
productName: Binanboot
directories:
  output: release
files:
  - out/**
  - package.json
asar: true
asarUnpack:
  - node_modules/@duckdb/node-api/**

mac:
  target:
    - dmg
    - zip
  category: public.app-category.finance

win:
  target:
    - nsis
  artifactName: ${productName}-${version}-setup.${ext}

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true

linux:
  target:
    - AppImage
    - deb
    - rpm
  category: Finance
```

说明：

- `appId`：应用唯一标识，建议改成你自己的域名格式。
- `productName`：安装后显示的应用名称。
- `output: release`：最终安装包输出到 `release` 目录。
- `asarUnpack`：本项目使用了 `@duckdb/node-api`，这是原生依赖，打包后如加载失败，需要保持解包。

## 4. 可选：添加应用图标

建议准备这些图标文件：

```text
build/icon.icns
build/icon.ico
build/icon.png
```

然后把配置改成：

```yaml
mac:
  icon: build/icon.icns
  target:
    - dmg
    - zip

win:
  icon: build/icon.ico
  target:
    - nsis

linux:
  icon: build/icon.png
  target:
    - AppImage
    - deb
    - rpm
```

## 5. macOS 打包

推荐在 macOS 上执行：

```bash
npm ci
npm run dist:mac
```

输出目录：

```text
release
```

常见产物：

```text
Binanboot-0.1.0.dmg
Binanboot-0.1.0-mac.zip
```

注意：

- 未签名的 macOS 应用可能会被 Gatekeeper 拦截。
- 如果要公开分发，建议配置 Apple Developer 证书、代码签名和 notarization。
- Apple Silicon 和 Intel 双架构包需要额外配置 `arch`。

## 6. Windows 打包

推荐在 Windows 上执行：

```bash
npm ci
npm run dist:win
```

输出目录：

```text
release
```

常见产物：

```text
Binanboot-0.1.0-setup.exe
```

注意：

- Windows 安装包推荐在 Windows 环境构建。
- 如果需要减少杀毒软件误报，建议配置代码签名证书。
- 从 macOS 或 Linux 交叉打包 Windows 通常需要 Wine，原生依赖项目更容易遇到兼容问题。

## 7. Linux 打包

推荐在 Linux 上执行：

```bash
npm ci
npm run dist:linux
```

输出目录：

```text
release
```

常见产物：

```text
Binanboot-0.1.0.AppImage
binanboot_0.1.0_amd64.deb
binanboot-0.1.0.x86_64.rpm
```

安装 `.deb`：

```bash
sudo dpkg -i binanboot_0.1.0_amd64.deb
sudo apt -f install
```

运行 `.AppImage`：

```bash
chmod +x Binanboot-0.1.0.AppImage
./Binanboot-0.1.0.AppImage
```

注意：

- Linux 桌面程序需要图形环境。
- 服务器无桌面环境时，不能直接展示 Electron 窗口。
- 如果只想通过浏览器访问，请参考 `docs/linux-browser-deploy.md`。

## 8. 推荐的打包顺序

首次配置时建议按这个顺序验证：

```bash
npm run typecheck
npm run build
npm run pack
npm run dist
```

确认 `pack` 能正常启动后，再生成正式安装包。

## 9. 多平台构建建议

最稳妥的方式是在对应系统上构建对应平台：

| 目标平台 | 推荐构建系统 |
| --- | --- |
| macOS | macOS |
| Windows | Windows |
| Linux | Linux |

如果需要一次性自动构建所有平台，建议使用 GitHub Actions、GitLab CI 或其他 CI 服务，分别启动 macOS、Windows、Linux runner。

## 10. GitHub Actions 示例

可以新增：

```text
.github/workflows/release.yml
```

示例内容：

```yaml
name: Build Desktop Apps

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  build:
    strategy:
      matrix:
        os:
          - macos-latest
          - windows-latest
          - ubuntu-latest

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - run: npm run typecheck

      - run: npm run build

      - run: npx electron-builder

      - uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.os }}
          path: release/**
```

## 11. 敏感配置提醒

本项目涉及 Binance API、飞书通知等敏感配置。打包发布时注意：

- 不要把真实 API Key 写进源码。
- 不要把 `.env`、配置文件、证书文件提交到仓库。
- 生产环境建议通过系统环境变量或安全配置页录入凭据。
- 发布给他人使用前，确认默认是模拟盘或只读模式。

## 12. 常见问题

### 只执行 `npm run build` 为什么没有安装包？

`npm run build` 只是执行 `electron-vite build`，生成 Electron 应用运行所需的 `out` 目录。  
真正的安装包需要再执行 `electron-builder`。

### 可以在 macOS 上一次性打出 Windows、Linux、macOS 包吗？

理论上部分平台可以交叉打包，但不推荐作为首选。  
本项目包含原生依赖，跨平台打包更容易遇到依赖、签名、系统库和架构问题。

### 打包后 DuckDB 报错怎么办？

先确认 `electron-builder.yml` 里有：

```yaml
asarUnpack:
  - node_modules/@duckdb/node-api/**
```

如果仍然失败，建议在目标平台本机执行：

```bash
rm -rf node_modules package-lock.json
npm install
npm run dist
```

### 打包后应用打不开怎么办？

优先检查：

```bash
npm run typecheck
npm run build
npm run pack
```

再进入 `release` 中未压缩的应用目录手动运行，查看终端日志。

