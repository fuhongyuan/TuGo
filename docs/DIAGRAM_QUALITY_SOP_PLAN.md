# TuGo 图形质量 SOP 建设计划

## 1. 文档目标

本文是 TuGo 图形质量体系的单一建设基线。它回答四个问题：

1. 专业、稳定、可验证的制图 SOP 应包含哪些层次。
2. TuGo 当前已经具备什么，缺少什么。
3. 应增加哪些工具、提示词、算法、Runtime 机制和评测资产。
4. 每个阶段如何验收，避免把“提示模型注意质量”误当成质量保证。

本文使用 POM 表表达实施项：

- **Priority**：优先级和实施批次。
- **Objective**：要解决的质量目标。
- **Measure**：具体改动、代码落点和验收指标。

> 架构修正（2026-08-25）：SOP 是 Agent 可读取、可裁量的知识与检查清单，不应被固化为每次都必须经过的硬编码工作流。Runtime 只保存必要状态、提供工具并设置少量安全门槛；可由页面确定性解决的排版问题优先在渲染与几何算法中解决，不交给 LLM 反复试坐标。

### 当前实施状态（页面算法优先批次）

| 项目 | 状态 | 已落地点 |
| --- | --- | --- |
| 容器与内容遮挡 | 已完成 | SVG 分层固定为背景容器 -> 连线 -> 标签 -> 前景节点 -> 编辑命中层 |
| 多行文字裁切 | 已完成 | 使用真实 DOM `scrollHeight` 测量并持久化扩高，不再依赖字符数估算 |
| 连线穿过节点 | 已完成 | 无显式控制点的正交线自动进行节点避障 |
| 连线交叉与共线堆叠 | 已完成 | 路由评分加入既有路径的交叉与共享长度，自动选择相邻通道 |
| 标签压线/压节点 | 已完成 | 标签按真实路径长线段放置，避让节点与其他标签，并使用独立底板 |
| 无视觉模型降级 | 已完成（几何层） | 质量审计复用与页面一致的避障、采样和软避线路径 |
| 节点拖动时连线变形 | 已完成 | 手调控制点按新旧端点坐标系重映射；自动路径按实时端点重算 |
| 直线/曲线/折线转换 | 已完成 | 切换时转换或清理路由专属参数，曲线与折线之间保留原路径的主要形态 |
| 视觉语义问题 | 保留给 LLM/视觉 Critic | 仅处理算法无法确定的内容层级、表达取舍和审美判断 |

## 2. 质量目标与边界

TuGo 的目标不是保证所有图的业务事实绝对正确，而是建立一条可追踪的质量链：

```text
用户意图
  -> Diagram Brief
  -> 语义模型
  -> 图型专属规则
  -> 布局规划
  -> 画板操作
  -> 确定性审计
  -> 内容 Critic / 视觉 Critic
  -> 有界修复
  -> Acceptance Gate
  -> 快照与交付
  -> 离线 Eval 与线上反馈
```

质量分为八个独立维度，不用一个总分掩盖致命缺陷：

| 维度 | 定义 | 典型阻断问题 |
| --- | --- | --- |
| 内容正确性 | 事实、方向、因果和关系可信 | 错误关系、无来源的关键结论 |
| 内容完整性 | 覆盖 Brief 要求的实体、关系和路径 | 关键角色、主流程或异常路径缺失 |
| 结构清晰度 | 抽象层一致，分组和边界合理 | 混合部署层与代码层、断链 |
| 布局质量 | 对齐、间距、阅读路径和连线合理 | 重叠、穿线、严重拥挤 |
| 视觉一致性 | 字体、颜色、形状和边线具有统一语义 | 同类节点样式漂移 |
| 可读性 | 文字完整、字号合理、信息密度适中 | 文字溢出、字号过小 |
| 可访问性 | 对比度、色盲和非颜色编码可用 | 低对比度、只靠颜色表达状态 |
| 交付就绪度 | 视口、导出、标题、图例和风险说明完整 | 高严重度问题未处理却宣称完成 |

## 3. 当前成熟度基线

| 能力 | 当前成熟度 | 已具备 | 主要缺口 |
| --- | ---: | --- | --- |
| Agent Runtime | 75% | Plan、Checkpoint、Tool Repair、循环限制、受控附件 | 没有质量阶段状态机和验收门禁 |
| 画板工具 | 75% | 查询、批量编辑、局部编辑、DSL、撤销、快照 | 偏底层 CRUD，缺少语义组件和高层布局工具 |
| 几何与可读性审计 | 65% | 六维审计、局部反馈、自动优化、三轮上限 | 缺少全局平衡、密度、可访问性、图例等指标 |
| 样式系统 | 40% | 色板、基础 Skill 规则、部分样式字段 | 缺少语义 Token、组件规范和样式归一化 |
| 图型方法论 | 30% | 通用形状语义、DSL 类型支持 | 缺少流程图/架构图/时序图等专属 Rubric |
| 内容质量 | 20% | 依靠模型理解和状态读取 | 没有 Brief、语义模型、内容完整性和证据审查 |
| 验收与评测 | 20% | 单元测试、部分视觉黄金基线 | 没有 Acceptance Report、黄金任务集和质量趋势 |
| 综合 | 45%-50% | 已不是简单套壳 | 尚不能证明每张图达到专业交付标准 |

## 4. 目标分层

### L1 意图与交付契约

新增 `DiagramBrief`，至少包含：目标、受众、核心问题、图型、范围、必需实体、必需关系、来源策略、视觉语气、信息密度、交付格式和验收标准。

规则：

- 简单任务由 Agent 推断并记录，不强迫用户填写表单。
- 只有会实质改变结果的关键歧义才向用户提问。
- 非平凡制图在第一次修改画板前必须建立 Brief。
- 后续审计必须引用同一 Brief，避免目标漂移。

### L2 语义内容模型

新增与坐标和颜色无关的 `DiagramModel`：实体、关系、分组、声明和证据。先验证“画什么”，再决定“怎么摆”。

首期内容审查采用确定性覆盖检查：必需实体、必需关系、重复 ID、悬空关系和 Brief 覆盖率。后续增加独立 Semantic Critic 检查事实、抽象层和表达逻辑。

### L3 图型路由与专属 SOP

为 flowchart、architecture、sequence、ERD、state、mindmap、timeline、comparison、presentation 建立独立 Profile。每个 Profile 包含：

- 适用场景与反例。
- 必需语义结构。
- 内容 Rubric。
- 默认布局与视觉 Token。
- 阻断项、警告项和建议项。
- 优秀/失败示例与自动评测样本。

### L4 绘图规划

新增 `LayoutSpec`：方向、层级、泳道、容器、阅读路径、节点密度、主次关系、视口和导出尺寸。复杂图必须在创建坐标前确定 LayoutSpec。

### L5 工具执行

在现有 CRUD 工具之上增加语义工具：

- 语义组件：`board_add_process/service/database/actor/boundary`。
- 高层布局：`board_layout_flow/hierarchy/sequence/swimlanes/radial`。
- 规范化：`board_route_edges`、`board_fit_text`、`board_normalize_styles`。
- 质量契约：`diagram_set_brief`、`diagram_get_brief`、`diagram_review_content`、`diagram_acceptance_check`。

### L6 确定性审计

强化 `reflectDiagram`：

- 结构：不可达节点、决策出口、重复关系、抽象层冲突。
- 布局：全局重心、留白、视口利用率、边线密度、主路径长度。
- 样式：同类组件 Token 偏移、颜色数量、图例需要性。
- 可访问性：WCAG 对比度、非颜色编码、最小导出字号。
- 交付：标题、图例、裁切、导出区域完整性。

### L7 独立评审

Builder、Semantic Critic 和 Visual Critic 分离。Critic 使用固定 JSON Rubric，只读、不直接修改画板；修复仍由 Builder 执行。视觉评审输入 Brief、语义摘要和真实截图，不读取 Builder 的隐藏推理。

### L8 Runtime 质量编排

新增质量阶段状态：`briefed -> modeled -> drafted -> audited -> reviewed -> accepted`。Runtime 记录每阶段产物和版本，限制无界复审，并将阻断问题与普通建议分开。

### L9 验收、评测与反馈

新增 Acceptance Gate：没有验收报告时不能宣称复杂制图“已完成”。建立黄金任务集，记录必需实体召回率、关系召回率、工具失败率、高严重度残留率、修复轮数、视觉偏好胜率、耗时与 Token 成本。

## 5. POM 实施表

| ID | Priority | Objective | Measure：增加/强化内容 | 主要落点 | 验收指标 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| P0-A1 | P0 | 固化用户目标 | 增加 `DiagramBrief` 类型、规范化和完整性检查 | `runtime-ts/src/diagramQualityContracts.ts` | 可持久化；缺失关键字段返回明确警告 | 无 |
| P0-A2 | P0 | 建立质量契约工具 | 增加 `diagram_set_brief`、`diagram_get_brief` | Tool Registry、默认工具模板 | Brief 随 checkpoint 保留；工具 Schema 严格 | P0-A1 |
| P0-A3 | P0 | 检查内容覆盖 | 增加 `DiagramModel` 和 `diagram_review_content` | Quality Contracts、Tool Registry | 必需实体/关系召回率、悬空关系、重复 ID可确定性计算 | P0-A1 |
| P0-A4 | P0 | 形成验收报告 | 增加 `diagram_acceptance_check`，输出 blocking/warning/suggestion | Quality Contracts、Runtime | Brief 或内容审查缺失时不得通过 | P0-A2/A3 |
| P0-A5 | P0 | 让 Agent 使用新流程 | 修改 system prompt：非平凡制图先 Brief，完稿内容审查后再布局审查 | `templates/runtime-defaults.json` | 新工具出现在默认 Agent；升级安装自动绑定 | P0-A2/A3/A4 |
| P0-B1 | P0 | 提高几何门禁 | 将断链、重叠、文字严重溢出、容器遮挡定义为 blocking | `diagramQuality.ts`、Acceptance | blocking 未清零不能通过 | P0-A4 |
| P0-B2 | P0 | 防止跳过验收 | Runtime 跟踪质量阶段；复杂任务结束前提示验收 | Runtime middleware | 有画板修改但无验收时最多提醒一次，不产生死循环 | P0-A4 |
| P1-01 | P1 | 图型正确 | 增加 Diagram Type Router 和 Profile 注册表 | `diagramProfiles/` | 黄金集中图型选择准确率 >= 90% | P0 |
| P1-02 | P1 | 流程图专业性 | 流程图 SOP：起止、决策出口、可达性、异常路径 | Profile、Validator | 阻断缺陷检出率 >= 95% | P1-01 |
| P1-03 | P1 | 架构图专业性 | 架构图 SOP：边界、抽象层、协议、数据/控制流、图例 | Profile、Validator | 必需维度覆盖率 >= 90% | P1-01 |
| P1-04 | P1 | 时序图专业性 | 时序图 SOP：参与者、顺序、同步/异步、错误/重试 | Profile、Validator | 关键顺序错误检出率 >= 90% | P1-01 |
| P1-05 | P1 | 数据与状态图专业性 | ERD、状态机专属 SOP | Profile、Validator | 核心结构阻断项检出率 >= 90% | P1-01 |
| P1-06 | P1 | 内容可信 | 独立 Semantic Critic，支持 evidence/confidence | Critic、Runtime | 无证据关键声明被标记；不直接修改画板 | P0-A3 |
| P2-01 | P2 | 样式稳定 | 建立 Diagram Theme Token 和语义角色样式 | `diagramThemes/`、Types | 同类元素样式漂移率 < 5% | P1-01 |
| P2-02 | P2 | 降低坐标负担 | 增加语义组件工具 | Board Tool Schema、App bridge | 常见图绘制时手写样式字段减少 60% | P2-01 |
| P2-03 | P2 | 提高布局稳定性 | 增加 flow/hierarchy/sequence/swimlane 高层布局工具 | Layout engine、App bridge | 典型图首次审计高严重度问题减少 50% | P1 Profiles |
| P2-04 | P2 | 自动收尾 | 增加 route、fit-text、normalize-styles 工具 | Layout engine | 可确定修复无需模型逐节点 patch | P2-01/03 |
| P2-05 | P2 | 真实视觉评审 | 固定 Visual Critic Rubric，强制复杂交付截图 | Prompt、Runtime | 复杂图视觉评审覆盖率 100% | P0 Gate |
| P3-01 | P3 | 可证明提升 | 建立按图型分类的黄金任务集 | `evals/diagram-quality/` | 每类至少 20 个任务 | P1 |
| P3-02 | P3 | 自动回归 | 运行内容、几何、截图和人工偏好评测 | Scripts、CI | 每次 SOP/模型变更生成对比报告 | P3-01 |
| P3-03 | P3 | 线上反馈闭环 | Run Debug 记录 SOP 版本、阶段得分和修复轨迹 | Repository、Debug UI | 可按版本查询成功率与残留问题 | P0/P1 |
| P3-04 | P3 | 防止规则漂移 | SOP/Profile/Theme 独立版本化和迁移策略 | Templates、Repository | 用户自定义与系统升级互不覆盖 | P1/P2 |

## 6. 提示词改造清单

### System Prompt

强化：

1. 非平凡制图先建立 Brief，不再直接创建坐标。
2. 区分内容审查、布局审查和视觉审查。
3. 先处理 blocking，再处理 warning，不追求无意义满分。
4. 完成前调用 Acceptance Gate；未通过时不得声称完成。
5. 信息不足时显式记录假设，关键事实根据 source policy 获取证据。

移除或避免：

- 在 system prompt 内堆积所有图型细节。
- 只写“保持美观”“确保专业”这类不可验证要求。
- 让同一轮绘制工具调用自动消耗完整审计次数。

### Architect Skill

保留通用职责和工具调用规范；新增 Brief/Model/LayoutSpec 工作流、阻断项定义和 Profile 路由。具体图型规则移入独立资源，按需加载。

### Critic Prompt

新增两个独立模板：

- `quality.semantic_critic`：只评内容正确性、完整性、抽象层和证据。
- `quality.visual_critic`：只评截图中的层级、阅读路径、密度、一致性和交付感。

Critic 必须输出固定结构，不得直接调用修改工具。

## 7. 工具演进清单

### P0 质量契约工具

| 工具 | 副作用 | 作用 |
| --- | --- | --- |
| `diagram_set_brief` | 写 checkpoint | 建立或更新本轮图形交付契约 |
| `diagram_get_brief` | 只读 | 读取当前质量目标，防止上下文压缩后丢失 |
| `diagram_review_content` | 写审查状态 | 确定性核对必需实体、关系和模型完整性 |
| `diagram_acceptance_check` | 写验收状态 | 聚合内容、布局、视觉结果，产生阻断/警告报告 |

### P1/P2 高层工具

高层工具必须与底层 `board_batch` 共存。底层工具用于精确编辑，高层工具负责稳定地产生符合 Profile 和 Theme 的操作。所有高层工具最终投影成可回放的 `BoardOperation[]`，继续兼容撤销、快照和 AI 绘制过程展示。

## 8. Runtime 机制改造

建议在 checkpoint 中增加：

```ts
middlewareState.diagramQuality = {
  brief,
  modelReview,
  layoutReview,
  semanticReview,
  visualReview,
  acceptance,
  stage,
  sopVersion,
  profileVersion
}
```

状态失效规则：

- Brief 更新：使内容、布局、视觉和验收结果失效。
- 画板实际修改：使布局、视觉和验收结果失效；内容审查是否失效由语义变更标记决定。
- 内容模型更新：使内容审查和验收失效。
- 截图后继续修改：视觉评审失效。

循环限制：

- 内容 Critic 最多 2 轮。
- 布局审计最多 3 轮，沿用现有机制。
- 视觉 Critic 最多 2 轮。
- 达到上限后保留可用成果，并在验收报告中列出未解决取舍。

## 9. 分阶段交付计划

### Phase 0：质量契约骨架

交付：P0-A1 至 P0-A5。目标是让质量目标和内容覆盖第一次成为结构化、可持久化、可测试的 Runtime 能力。

### Phase 0.5：几何阻断与 Runtime Gate

交付：P0-B1、P0-B2。目标是不能再带着明显断链、重叠或文字溢出宣称专业交付。

### Phase 1：图型专属内容质量

优先完成流程图、架构图和时序图，再扩展 ERD 与状态机。这三类最能覆盖 TuGo 当前核心用途。

### Phase 2：语义组件与视觉系统

将设计 Token、高层布局和视觉 Critic 接入，减少模型手工计算坐标和自由发挥样式。

### Phase 3：Eval 与质量运营

建立版本对比、回归门禁和线上质量数据，使 SOP 能持续优化，而不是一次性文档工程。

## 10. 完成定义

质量体系达到第一阶段可用，至少需要满足：

- 复杂制图都有结构化 Brief。
- 内容审查能确定性发现必需实体或关系遗漏。
- 完整布局审计后仍有 blocking 问题时验收失败。
- 复杂交付具有 Acceptance Report。
- 流程图、架构图、时序图各有专属 Profile。
- 每种 Profile 有自动评测案例。
- Run Debug 可以解释一张图为何通过或未通过。

达到上述条件后，TuGo 才从“带布局审计的画图 Agent”进入“具有质量控制系统的专业制图 Agent”。
