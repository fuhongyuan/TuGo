# TuGo 1.0.0 已知限制

[文档目录](../docs/README.md) · [English FAQ](../docs/en/FAQ.md)

- 首发目标为 macOS 13+ Apple Silicon。Windows x64 有打包配置，实际支持承诺以 Release 的实机验证为准。不承诺 Intel Mac 或 Linux 桌面。
- 没有账户、云同步、多人协作或自动跨设备迁移。
- AI 需要用户自备模型服务，可能收费；不附送额度或离线大模型。
- 多种 Provider 适配器不代表所有模型、网关、流式与视觉协议都经过实测。
- 当前单 Lead Agent，不提供多 Agent 编排或通用 HITL 暂停恢复。
- MCP 服务需用户信任与配置，不提供 MCP OAuth 登录。
- 本地化覆盖不完整，可能混用中文/英文；互动教程尚未实现。
- Mermaid/PlantUML/draw.io 为兼容范围，不保证任意样式无损往返。
- PPTX 支持的图形可编辑，但图片仍是图片，字体/复杂样式需要检查。
- “完整备份”ZIP 只有 App/Runtime 数据库，不含附件、配置和凭据，也没有全量 ZIP 一键恢复。
- 凭据采用本地文件加密，不是系统钥匙串，不防御本机账户被攻破。
- 画板引用是上下文提示，不是权限/隐私隔离；AI 结果需要人工审阅。
- ad-hoc 测试构建不等于通过 Developer ID 签名与 Apple 公证。

测试、签名、公证结果必须针对最终提交和实际产物记录，不能从这份说明推断。见 [隐私说明](../PRIVACY.md)。
