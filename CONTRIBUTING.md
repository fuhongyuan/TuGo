# Contributing to TuGo

欢迎提交缺陷修复、文档、翻译和测试。Please include a clear description and verification results with each contribution.

## 开发环境

Node.js 25.2.1、npm 11.6.2；版本范围以 `package.json` 为准。在项目根目录：

```bash
npm ci
npm run dev
```

开发版与安装版数据目录应分别使用；不要拿唯一的正式数据副本测试迁移。更多结构说明见 [开发指南](docs/DEVELOPMENT.md)。

## 提交前

```bash
npm run build
npm test
```

按改动范围补跑：

- UI/交互：`npm run test:electron`
- Provider/MCP：`npm run test:compat`
- 导出：`npm run test:visual`（需要 LibreOffice）
- 完整源码门禁：`npm run verify:release`
- 打包：`npm run verify:package`（macOS）

测试没有执行或没有通过时，在 PR 中写明原因，不要报告为已验证。

## 约定

- 保持 Renderer、Electron 和 Runtime 的职责边界。
- 数据库变更新增独立 migration，并覆盖旧库升级。
- UI 文案接入现有国际化，保留英文回退；不要将未完成翻译称为完整语言支持。
- Provider/MCP 测试使用无真实凭据的 fixtures。
- 避免提交密钥、数据库、私人画板、日志、安装包或本机代理/编辑器配置；检查暂存区而不只是工作目录。
- 使用简洁提交说明，例如 `fix:`、`docs:`、`test:`；较大变更先开 Issue 讨论。

## 许可与行为准则

请确认你有权提交代码、文档、图片和资源，并保留引用的第三方许可与署名。按 Apache-2.0 第 5 节，有意提交给本项目的贡献在未明确另作说明时适用项目许可证。没有额外 CLA 流程。

By contributing, confirm that you have the rights to submit the work. Preserve third-party notices and follow [Apache License 2.0](LICENSE) and the [Code of Conduct](CODE_OF_CONDUCT.md).
