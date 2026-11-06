# Proposal

## Why

当前上下文治理、调用恢复与画板观察分散，缺少统一的证据、责任和升级契约。需要在保留现有用户数据和绘图能力的前提下，让每层可确定地处理自身问题，并把无法解决的问题及实际副作用反馈到 Agent Loop。

## What Changes

- 引入版本化观察契约，分开执行事实、质量判断、处理动作、再验证和未知/过期状态。
- 持久化受控原始证据，按当前模型生成可追溯、可恢复的紧凑视图。
- 统一工具执行恢复责任、共享预算、结果未知时的状态核对，避免重复写入。
- 建立上下文预算与模型能力适配、领域扩展、分级调度及可信交付门禁。
- 以非绘图查询适配器和 TuGo 画板验证通用性，加入故障注入及包内回归。
- 本轮不实现完整像素视觉判断、外部 Office 验证、自动换模型或分布式 exactly-once。

## Capabilities

### New Capabilities

- `observation-evidence`: 类型化证据、持久化、隔离、版本有效性和可逆投影。
- `tool-execution-recovery`: 执行状态、恢复归责、幂等核对及共享预算。
- `context-adaptation`: 模型预算、能力适配与关键信息保护。
- `domain-observation`: 领域检查、宿主探针与透明的本层处理。
- `observation-orchestration`: 观察触发、升级、去重和交付门禁。

### Modified Capabilities

无；当前主规格目录为空。新增规格描述目标行为，不表示现有代码没有部分能力。

## Impact

涉及 runtime-ts 的循环、工具、上下文、存储端口及宿主装配；TuGo 的领域工具、CLI 和实际画板探针。遵守现行 Kernel / TuGo Package / Platform 边界，不另造循环或观察服务。旧结果、配置及自定义资源须兼容；测试与发布范围沿用 docs/LAYERED_OBSERVATION_IMPLEMENTATION_PLAN.md 的 S1–S8 门禁。

## 2026-11-03 Approved Security Scope

用户已批准将完整依赖安全升级纳入本轮，包含进入前端/PPT产物的devDependencies及构建/测试工具主版本变更。禁止使用忽略审计或盲目force降级来验收；保持绘图/导出、用户配置和数据契约，升级后重新执行当前源码及包内全门禁。
