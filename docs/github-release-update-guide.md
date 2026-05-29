# GitHub 版本更新与多平台构建发布教程

本文档说明如何把新版本推送到 GitHub，并由 GitHub Actions 自动构建 Windows/macOS 安装包，发布到 GitHub Releases，供应用内“版本更新”功能检查和下载。

## 当前项目能力

本项目已经配置：

- GitHub 仓库：`Haohongbo/binanboot`
- 自动构建工作流：`.github/workflows/release.yml`
- 发布配置：`electron-builder.yml`
- 自动更新依赖：`electron-updater`
- 支持平台：
  - Windows x64：`.exe` 安装包、`.zip`
  - macOS Intel：`.dmg`、`.zip`
  - macOS Apple Silicon：`.dmg`、`.zip`
- 自动更新元数据：
  - Windows：`latest.yml`
  - macOS：`latest-mac.yml`

## 发布流程总览

发布一个新版只需要做四件事：

1. 确认代码已经提交并推送到 `main`
2. 更新 `package.json` 里的版本号
3. 推送 Git tag，例如 `v0.1.1`
4. 等待 GitHub Actions 自动构建并上传 Release

GitHub Actions 会在推送 `v*` 标签时自动运行。

## 1. 确认工作区干净

在项目根目录执行：

```bash
git status
```

如果有未提交改动，先提交：

```bash
git add .
git commit -m "你的提交说明"
git push
```

## 2. 更新版本号

推荐使用 `npm version`，它会自动修改 `package.json` 和 `package-lock.json`，并创建对应 tag。

补丁版本：

```bash
npm version patch
```

小版本：

```bash
npm version minor
```

大版本：

```bash
npm version major
```

示例：当前版本是 `0.1.0`，执行 `npm version patch` 后会变成 `0.1.1`，并生成 tag：

```text
v0.1.1
```

## 3. 推送代码和版本标签

执行：

```bash
git push
git push origin v$(node -p "require('./package.json').version")
```

也可以手动指定标签：

```bash
git push origin v0.1.1
```

推送 tag 后，GitHub 会自动触发 `Build release` 工作流。

## 4. 查看 GitHub Actions 构建状态

打开仓库的 Actions 页面：

```text
https://github.com/Haohongbo/binanboot/actions
```

也可以用 GitHub CLI 查看：

```bash
gh run list --repo Haohongbo/binanboot --workflow "Build release" --limit 5
```

查看最新运行：

```bash
gh run watch --repo Haohongbo/binanboot
```

成功时会看到 Windows 和 macOS 两个 job 都完成：

```text
Build Windows  success
Build macOS    success
```

## 5. 查看 Release 产物

发布完成后打开：

```text
https://github.com/Haohongbo/binanboot/releases
```

一个正常的 Release 应该包含这些主要文件：

```text
Binanboot-版本号-win-x64.exe
Binanboot-版本号-win-x64.zip
Binanboot-版本号-mac-x64.dmg
Binanboot-版本号-mac-x64.zip
Binanboot-版本号-mac-arm64.dmg
Binanboot-版本号-mac-arm64.zip
latest.yml
latest-mac.yml
```

其中：

- `.exe`：Windows 安装包
- `.dmg`：macOS 安装包
- `.zip`：供下载和自动更新使用
- `.blockmap`：差分更新文件
- `latest.yml` / `latest-mac.yml`：应用内更新检查需要的元数据

## 6. 应用内版本更新验证

安装旧版本应用后，发布一个更高版本，例如从 `0.1.0` 发布到 `0.1.1`。

然后在应用中打开：

```text
用户设置 -> 版本更新 -> 检查更新
```

预期结果：

- 如果 GitHub 上有更高版本，界面显示“可更新”
- 点击“下载”后开始下载更新包
- 下载完成后显示“待安装”
- 点击“重启安装”后安装新版
- 如果没有新版本，会提示“没有发现新版本，当前已经是最新版本。”

## 7. 手动触发构建

如果不想通过 tag 触发，也可以在 GitHub 页面手动运行：

```text
Actions -> Build release -> Run workflow
```

注意：手动运行通常适合测试工作流。正式发布建议仍然使用 `v*` tag，因为 Release 版本号和应用版本号会更清晰。

## 8. 私有仓库注意事项

当前仓库是私有仓库时，发布和更新有两个注意点：

- GitHub Actions 发布 Release 可以使用内置的 `GITHUB_TOKEN`，不需要额外配置。
- 已安装的客户端如果要检查私有仓库 Release，需要有访问权限；面向普通用户分发时，建议改为公开仓库或公开 Release。

如果保持私有仓库，运行应用的环境需要提供 `GH_TOKEN`，否则客户端可能无法读取私有 Release 更新信息。

## 9. macOS 签名注意事项

当前 GitHub Actions 设置了：

```yaml
CSC_IDENTITY_AUTO_DISCOVERY: false
```

这表示 macOS 包不会自动寻找 Apple 证书签名。未签名应用可以构建出来，但用户首次打开可能被 macOS Gatekeeper 拦截。

正式公开分发 macOS 版本时，建议补充：

- Apple Developer ID Application 证书
- 代码签名
- notarization 公证

## 10. Windows 签名注意事项

当前 Windows 安装包可以构建和安装，但未签名。未签名安装包可能出现：

- Windows SmartScreen 警告
- 杀毒软件误报概率增加

正式公开分发时，建议配置 Windows 代码签名证书。

## 常见问题

### 推送 tag 后没有触发构建

检查 tag 是否以 `v` 开头：

```bash
git tag --list 'v*'
```

工作流只监听：

```yaml
tags:
  - 'v*'
```

### Release 里没有 latest.yml

`latest.yml` 由 `electron-builder --publish always` 生成。确认工作流中仍然有：

```bash
npx electron-builder ${{ matrix.target }} --publish always
```

### 应用提示已经是最新版本

确认 GitHub Release 的版本号大于当前安装版本。应用当前版本来自：

```json
{
  "version": "0.1.0"
}
```

只有发布更高版本，例如 `0.1.1`，应用内更新才会认为有新版。

### 构建成功但应用内检查不到更新

依次检查：

1. Release 是否存在 `latest.yml` 或 `latest-mac.yml`
2. Release 是否是 draft
3. 当前仓库是否私有
4. 客户端是否能访问 GitHub
5. 新版本号是否真的高于当前版本

## 推荐发布命令

日常发布补丁版本可以直接使用：

```bash
npm version patch
git push
git push origin v$(node -p "require('./package.json').version")
```

然后等待 GitHub Actions 完成即可。
