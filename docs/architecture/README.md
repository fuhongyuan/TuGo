# Kernel / TuGo Package / Platform 架构

当前实施方案：[三部分拆分与数据兼容](IMPLEMENTATION.md)。

专项计划：[分层观察与应对体系](../LAYERED_OBSERVATION_IMPLEMENTATION_PLAN.md)，遵守本目录的 Kernel / TuGo Package / Platform 职责边界，以专项计划台账记录进度和验收证据。

目标：同一套 Node Kernel，由平台装配 TuGo 或其他官方应用包，支持 PC 宿主及无界面 Node 宿主；不建设浏览器 Runtime。

迁移以现有用户数据和配置兼容为发布门禁。方案状态和测试证据分开记录，未验证能力不视为已完成。

## 历史资料

- [SDK v0.1 讨论稿与原版源码基线](archive/sdk-v0.1/README.md)：已归档，不作为现行设计。

仅归档被本方案替代的架构草稿；用户指南、备份说明、图形质量文档和发布手册仍保留，实施改变实际行为时更新。

[分层观察协议与接入状态](OBSERVATION_CONTRACTS.md)：S2/S3已验收，S4已接入实际工具调用；正式集成状态以OpenSpec任务与证据为准。

[S4执行恢复接入](OBSERVATION_EXECUTION.md)：真实调用链、安全重试、未知写结果、取消/晚到/重启语义及实测范围。

[S5上下文观察接入](OBSERVATION_CONTEXT.md)：预算分项、逐次调用准入、可逆集合引用、历史保护及视觉/纯文本/能力未知的模态适配。

[S6领域观察接入](OBSERVATION_DOMAINS.md)：可信只读贡献、领域/宿主探针、循环应用边界及查询/绘图同循环验收；后续修复和稳定性验收见对应阶段记录。

[S6.3修复隔离与回执](OBSERVATION_REPAIR.md)：候选/保存ACK/新版本复检、权限和本地预算、拒绝与未知、单步撤销及因果链。

- [实际画板观察与有效性](OBSERVATION_RENDER_EVIDENCE.md)：DOM/像素/PPT覆盖、稳定性与竞态门禁。

## 设计提案（不代表已实施）

- [工具契约与影响反馈 v0.1](TOOL_CONTRACT_OBSERVATION_DESIGN.md)：声明/执行/观察三部分契约、多来源影响反馈、逻辑与执行视图、现有代码映射及 A/B/C 验证方案；2026-11-04，本轮仅设计。
- [首版落地设计](TOOL_FEEDBACK_IMPLEMENTATION_PLAN.md)：限定两种写工具，列出文件、接口、保存 ACK 边界、接线、兼容模式和逐步验收；待实施。
