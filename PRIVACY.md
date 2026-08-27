# 隐私说明 / Privacy

适用于 TuGo 1.0.0 当前源码。模型和 MCP 服务受各自政策约束。

## 本地数据 / Local data

画板、项目、对话、快照、运行记录和导入附件保存在本机。TuGo 默认不提供账户、云同步或多人协作，也不自动替你创建异地副本。

Boards, conversations, snapshots, run records and imported attachments are stored locally. The default app does not provide accounts, cloud sync or collaboration.

## 凭据边界 / Credential storage

当前实现将凭据加密保存在应用目录中的 `runtime-secrets.json`；数据库通常保存引用。它使用应用/用户/路径上下文派生本地加密密钥，**不是 macOS Keychain 或其他操作系统凭据保险库**。加密不能防御已经能访问本机账户、文件和相关上下文的恶意程序。服务地址、非敏感配置、用户自行写进聊天/URL/命令参数的密钥也不受自动保护保证。

Credentials currently use a local encrypted file, not an OS keychain. The encryption key is derived from application/user/path context, which is not secret material. Do not rely on it against a compromised local account. Secrets placed in messages, URLs, command arguments or unrecognized configuration fields may remain exposed.

## 可能离开设备的数据 / External requests

使用模型、Web 或外部 MCP 工具时，提示词、对话上下文、工具定义和结果、画板内容、附件内容可能发往对应服务。Agent 可以主动读取当前画板；圈选引用并不保证只有圈选内容会被发送。stdio MCP 也可能自行访问文件和网络。

Using model, Web or MCP tools can send prompts, history, tool results, canvas content and attachments to external services. Region selection is not a strict data-isolation boundary. Third-party MCP processes can have their own file and network access.

只向可信服务发送你有权处理的数据。费用、保留期限、训练使用和删除请求取决于服务商。

## 备份、诊断与删除 / Backups, diagnostics and deletion

“导出完整备份”当前只含 App/Runtime 数据库，不含附件和凭据；诊断包包含配置摘要和日志，自动脱敏可能不完整。分享前必须检查私人路径、内容、地址和密钥。

The backup ZIP is not a full migration archive. Diagnostics may contain sensitive information despite redaction. Inspect all files before sharing.

删除项目不会自动删除备份中的历史副本或第三方已经收到的数据。备份由用户保管和处置，远端数据按服务商流程处理。更多操作见 [备份指南](docs/DATA_RECOVERY.md)。

发现数据泄露问题，请按 [安全策略](SECURITY.md) 私下报告。
