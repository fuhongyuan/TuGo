# TuGo 打包手册

[文档目录](../docs/README.md) · [发布清单](../docs/RELEASING.md)

目标安装包含 Electron 与 TypeScript Runtime，不要求最终用户另装 Node/Python。本文是构建说明，不是签名、兼容或实机验收报告。

## 环境与验证

使用 Node.js 25.2.1、npm 11.6.2。ARM64 Mac 包在 macOS Apple Silicon 环境构建；需要依赖下载网络与足够磁盘空间。全量视觉验证另需 LibreOffice。

取得源码后，在项目根目录运行：

```bash
npm ci
npm run build
npm test
npm run test:electron
```

确认每条命令的实际结果；构建成功不等于测试通过。

## 本地 macOS 测试包

```bash
npm run package:mac:zip
npm run package:mac:dmg
```

默认 `electron-builder.json` 使用 ad-hoc 签名，没有 Apple 公证。输出位于 `release/`，Apple Silicon 展开应用通常在 `release/mac-arm64/TuGo.app`。

```bash
file release/mac-arm64/TuGo.app/Contents/MacOS/TuGo
codesign --verify --deep --strict release/mac-arm64/TuGo.app
npm run test:electron:packaged
```

以上签名完整性校验不能证明 Developer ID 身份或公证通过。验证 DMG 时，将实际输出路径传给 `hdiutil verify`。

## 签名与公证发布包

准备 Developer ID Application 证书与 Apple 公证凭据，通过环境提供，不要提交 Git：

```bash
npm run package:mac:release
npm run test:electron:packaged
```

命令使用 `electron-builder.release.cjs`，缺少可用签名身份时失败，配置公证并生成扫描/发布辅助文件。它不替代完整测试，也不会创建 GitHub Release。

```bash
codesign -dv --verbose=4 release/mac-arm64/TuGo.app
spctl --assess --type execute --verbose release/mac-arm64/TuGo.app
xcrun stapler validate release/mac-arm64/TuGo.app
```

## Windows x64

```bash
npm run package:win
```

源码有 NSIS 打包配置。Mac 交叉构建取决于宿主环境和工具下载；生成 EXE 不等于 Windows 已经支持验收。实际输出在 `release/`，展开应用在 `win-unpacked/`。

必须在真实 Windows x64 或虚拟机验证安装、启动、模型调用、保存/恢复、图片/PPT、中文/空格路径及卸载。当前配置未预置项目 Authenticode 证书，不要声称发布者身份已验证。

## 校验与许可

```bash
npm run release:scan
npm run release:artifacts
```

扫描默认针对 Mac 展开包，不是跨平台通用验收。可以用 `TUGO_RELEASE_DIR`、`TUGO_APP_DIR` 指定对象。人工核对实际上传文件是否全部进入 SHA-256 清单，尤其默认含空格的 Windows 安装器文件名。

保留项目 LICENSE/NOTICE、依赖许可和 Electron 法律文件，详见 [第三方许可说明](../THIRD_PARTY_NOTICES.md)。SBOM 不代替许可证全文。

## 排错

- EBADENGINE：按 package.json 更换 Node/npm。
- 下载失败：检查代理/下载源，必要时配置可信的 `ELECTRON_MIRROR`，不要忽略哈希或证书错误。
- 旧界面/版本：核对实际启动路径并重新构建，不覆盖未备份的用户数据。
- 签名失败：修复证书/公证环境，不要静默退回 ad-hoc 并称为正式签名。
- 首发版本是 1.0.0，未来版本同时更新 package.json 与锁文件。
