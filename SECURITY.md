# Security policy / 安全策略

## Supported versions

安全报告面向当前 TuGo 1.0.x 主线。尚未发布的构建和历史内部版本不承诺长期维护或响应时限。

## Report privately

请勿在公开 Issue 中粘贴可利用漏洞、密钥、私人画板或完整数据库。仓库启用私密漏洞报告后，可在 **Security → Report a vulnerability** 提交报告，包含：

- 受影响版本、系统与安装方式；
- 最小复现、影响范围；
- 已脱敏日志与可能的修复建议。

If private vulnerability reporting is available, use the repository's **Security → Report a vulnerability** form. If the form is absent, do not post exploit details publicly: ask a maintainer for a private channel without disclosing the vulnerability. No dedicated security email or guaranteed response time is currently published.

若看不到私密报告入口，请仅请求维护者提供私下联系渠道，不要先公开利用细节。

## Security boundaries

- Embedded Runtime 使用 Worker/IPC，不开放本地 HTTP 服务；这不代表模型或 MCP 不联网。
- 内置附件读取以受控导入与附件 ID 为基础，第三方 MCP 有自己的权限边界。
- 当前凭据为本地文件加密，不是系统钥匙串；不防御本机账户被攻破。见 [隐私说明](PRIVACY.md)。
- 生产 Electron 配置包含上下文隔离、禁用 Node integration 等限制；这些配置不替代安全审计。
- 诊断自动脱敏、模型行为和第三方工具均不应被视为绝对安全保证。

Maintainers: enable GitHub private vulnerability reporting before public launch; see the [release checklist](docs/RELEASING.md).
