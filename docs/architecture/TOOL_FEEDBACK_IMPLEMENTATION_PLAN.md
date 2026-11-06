# 工具契约与反馈：首版落地设计

日期：2026-11-04。状态：待实施。上位设计：[完整概念设计](TOOL_CONTRACT_OBSERVATION_DESIGN.md)。

## 0. 先看这一页

**首版不重写工具系统。给现有执行链加一个契约绑定入口和一份反馈投影，先接两种画板写工具。**

| 问题 | 首版决定 |
| --- | --- |
| 接哪些工具？ | `board_batch`、`board_patch_element`；`board_observe`/`board_get_observation`提供证据关联 |
| 声明放哪里？ | TuGo 包集中注册，运行时只消费通用类型 |
| 执行怎么改？ | 继续使用 ToolRegistry 和 executeObservedTool，不增加执行器或重试循环 |
| 观察怎么改？ | 复用现有 observeBoard、side_effects、changes、DOM 探针，不新建万能观察器 |
| 给模型什么？ | 原业务结果＋简短 tool_feedback，明确提交、影响、待检查和重试限制 |
| 其它工具怎么办？ | 保持旧执行，获得保守基础契约；不强迫迁移 handler |
| 怎么证明有用？ | 固定算法/观察频率，比较不同反馈方式，不把路由优化收益算进来 |

首版不包含：全工具重写、数据库迁移、新 RPC、后台任务系统、生产画板通用回执查询、像素/审美评分、自动修复策略升级。

## 1. 已看过代码，真正要补的缺口

1. `runtime-ts/src/tools.ts` 已有工具解析、参数校验、执行、宿主桥接，不缺执行入口。
2. `runtime-ts/src/toolExecutor.ts` 与 `recoveryPolicy.ts` 已有恢复预算、可信契约和未知写入保护，不再建设第二套。
3. `src/lib/boardObservationDomain.ts` 已能比较前后路径，返回 `route_changed`、字号适配、直接/间接对象，**不需要重写影响检测算法**。
4. `runtime-ts/src/observation.ts` 当前还通过工具名集合识别写操作，并从参数推断受影响对象；这部分应逐步由注册契约和领域结果接替。
5. `src/App.tsx` 当前在 `await persistProjectDocument(...)` 后调用 `observeBoard(...)`，它们共用外围 catch：**观察失败时，已经确认保存的事实有丢失到通用错误中的风险**。这是首版必须封住的具体边界。
6. `playbackOperations` 目前可能已经附加自动修复 patch，再据此生成 directIds；首版要区分“原请求直接修改”与“已有有界修复造成的修改”，不能混成全部直接修改。

以上是当前源码结构和风险分析，不表示这些风险在每次调用中都会触发。

## 2. 只加四个文件，修改现有接线

### 2.1 新增文件

| 路径 | 内容 | 不做什么 |
| --- | --- | --- |
| `runtime-ts/src/toolContract.ts` | 通用契约类型、默认契约、绑定校验 | 不导入 TuGo、Electron、DOM |
| `runtime-ts/src/toolFeedback.ts` | 回执归一化、受限反馈投影 | 不调用工具、不调度修复、不另做存储 |
| `runtime-ts/src/tugo/toolContracts.ts` | TuGo 工具契约绑定、已有结果到通用反馈的适配 | 不改 Agent Loop、不负责重试 |
| `src/lib/boardToolFeedback.ts` | 纯函数：原始操作＋已有观察 → 直接修改/修复修改/已测影响 | 不重复寻路、不读 DOM、不写画板 |

文件名为落地建议，不是已创建的运行模块。

### 2.2 修改文件

| 路径 | 具体改动 |
| --- | --- |
| `runtime-ts/src/runtimeApplication.ts` | ApplicationToolPort 增加可选 `contractFor(tool)`；保留旧接口 |
| `runtime-ts/src/tools.ts` | 在 resolve 后为可信工具绑定契约；保留现有 execute 路径与参数规范化 |
| `runtime-ts/src/runtime.ts` | 装配 TuGo 契约解析器；不把画板规则写进通用执行器 |
| `runtime-ts/src/toolExecutionPolicies.ts` | 集中解析最终执行契约，复用已有宿主配置与安全默认 |
| `runtime-ts/src/agentLoop.ts` | 在既有结果处理处调用通用投影；执行失败也生成基础反馈；不新增 board_* 分支 |
| `runtime-ts/src/tugo/runtimeApplication.ts` | 沿用现有 recordResult/主动观察/交付钩子，关联 callId 与后续观察 |
| `runtime-ts/src/observation.ts` | 对已迁移工具消费契约和领域报告；未迁移写工具仍走现有集合，不能漏观察 |
| `src/App.tsx` | 分开保存 ACK 和观察错误；在原始操作被追加修复 patch 前保存直接操作身份 |
| `src/lib/boardObservationDomain.ts` | 只在需要时补充影响总数/明细引用，继续复用已有比较；不改检查阈值 |

默认不修改 `boardRenderProbe.ts`、路由算法、导出器、数据库表和模型工具参数 Schema。缺陷修复若确有必要，另列变更，不能混进反馈实验。

## 3. 接口：不用大型抽象类

下面是首版接口草案。`ToolDefinition`、`ExecutionContract`、`ExecutionState`、`JsonObject`沿用仓库现有类型。

```ts
type ToolContract = {
  version: 1
  effect: 'read' | 'write' | 'unknown'
  observation: 'receipt' | 'board_change' | 'board_evidence'
  errors: ReadonlyArray<{ code: string; category: string }>
}

type BoundToolContract = {
  contract: ToolContract
  execution?: ExecutionContract  // 仅可信宿主绑定可提供
  classifyError?: (error: unknown) => {
    category: string
    outcome: ExecutionState
  }
}

interface ApplicationToolPort {
  // 原 resolve / validate / execute 保留
  contractFor?(tool: ToolDefinition): BoundToolContract | undefined
}
```

已有名称、说明、参数和超时继续放 ToolDefinition，不复制成另一份。使用提示继续由现有 description/提示词机制提供，不增加一套提示词加载器。

观察 profile 由应用包解释和接线，Kernel 只处理通用回执/反馈；不能让 Kernel 因 profile 字符串自行调用画板工具。

绑定规则：

- 使用 resolve 返回的实际工具对象建立绑定，例如 WeakMap；不能仅靠名字，把同名外部工具升级成可信画板工具。
- MCP 工具默认 effect unknown、receipt 观察；MCP 注解不能生成可信 ExecutionContract。
- 最终执行契约统一由现有 `toolExecutionPolicies.ts` 解析：显式可信宿主策略优先，之后才是可信注册绑定、原平台默认。冲突配置在装配时拒绝，不在各层分别猜测。
- 旧工具没有绑定时使用保守基础契约，但不能撤销原有可信只读工具的安全恢复能力。
- `board_batch` / `board_patch_element`：effect write、idempotency none、statusQuery false；不因新增接口而声称具备生产回执查询。
- 错误声明是词汇表，不是完备异常列表；未声明异常仍捕获为 unknown。分类器不能覆盖执行器已确认的成功回执，也不能自己执行重试。

## 4. 执行返回：加字段，不替换旧结果

Renderer 原结果保留 `ok`、`operation`、计数和 `observation`。新增可选元数据：

```ts
type BoardExecutionMetadata = {
  version: 1
  call_id: string
  persistence: 'acknowledged' | 'unknown'
  requested_ids: string[]
  repair_ids: string[]
  observation_state: 'available' | 'unavailable'
  observation_error?: { code: string; safe_message: string }
}
```

通过现有 respondToolCall 正常结果中的 `execution_metadata` 返回，不加新 IPC 通道。call_id 来自宿主调用上下文；CLI 没有 Runtime callId 时沿用桥接身份并明确来源，不伪装成 Runtime 回执。Runtime 校验实际绑定身份，不接受模型提供的 ID。

这个 metadata 是本次保存 ACK 的报告，**不是跨重启可查询的幂等回执服务**。

### 保存与观察严格分开

```text
应用修改
  ├─ 保存未取得 ACK → persistence unknown；禁止自动重放
  └─ 保存取得 ACK → 立即固定“已确认保存”的事实
                         ├─ observeBoard 成功 → 返回已有 observation
                         └─ observeBoard 失败 → 仍返回保存成功
                                                + observation unavailable
```

不能把保存成功后的观察异常重新抛成“整个写工具未执行”。若调用已经取消/超时，迟到 ACK 走现有晚到证据路径，不恢复旧调用或再次应用修改。

对于保存前失败，只有输入/权限校验等明确的 not_started 才报告未开始。不要通过匹配错误文本猜测保存是否发生。

首版保留现有原子 board_batch 语义，不新增部分提交；测试中的非原子故障仅用来验证通用保护，不宣称真实 board_batch 会部分执行。

## 5. LLM 最终收到什么

原业务结果保留，附加 `tool_feedback`；已有 observation 的 findings 不再复制一次，避免重复占用上下文。

```json
{
  "version": 1,
  "execution": {
    "state": "succeeded",
    "persistence": "acknowledged"
  },
  "impact": {
    "requested_ids": ["node-A"],
    "repair_ids": [],
    "measured_related_ids": ["edge-AB", "edge-AC"],
    "scope": "reported_changes_not_exhaustive"
  },
  "observation": {
    "state": "pending_live_check",
    "geometry": "passed",
    "render": "not_checked",
    "blocking_total": 0
  },
  "policy": {
    "replay_original_write": "forbidden",
    "next": "wait_for_or_request_current_observation"
  }
}
```

这是示例，不是真实画板检测结果。`blocking_total:0` 只表示已有检查未报告阻断，不等于实际画面通过。`next` 是可选应对提示，不是新的用户授权。

当已有主动观察返回 DOM 遮挡时，通过既有观察消息补充“当前版本有 blocker、对象 refs、证据 ID”，不对同一个 callId 再追加第二份 tool result。

具体投影规则：

1. requested_ids 来自原始操作；修复追加 patch 单列 repair_ids。
2. measured_related_ids 来自已有 side_effects/changes，不通过扫描所有参数猜测。
3. 仅被识别为候选影响、没有实际变化证据的对象不能写入 measured_related_ids。
4. 缺少前态不报告“新增/消失”；字号适配等当前状态发现不能被说成本次调用导致。
5. 保存 ACK、几何检查、DOM 检查、像素检查分开；pending/unknown/stale 不折叠为 passed。
6. 摘要最多列 5 个代表对象/问题，但保留完整数量、范围和可取回引用；无法存明细就明确不可取回，不给假引用。
7. 新版影响详情先放 EvidencePort payload；不向严格的 ObservationRecord v1 随意添加字段。

## 6. 整条接线，只有这一条

```text
ToolRegistry.resolve → 绑定契约
          ↓
AgentLoop → 原 executeObservedTool → 原 ToolRegistry.execute
                                         ↓
                                  原宿主桥接 / App
                                         ↓
                            修改 → 保存 ACK → 已有几何观察
                                         ↓
                              原结果 + execution_metadata
          ↓
原结果处理 → TuGo 适配 → 通用 tool_feedback 投影 → LLM
          ↓
原主动观察调度 → 已有实际 DOM 检查 → 补充当前证据 → LLM
```

异常同样走原 executeObservedTool 的分类/恢复控制，再形成基础反馈。只有一个恢复预算，没有新增工具内部重试。

首版**不改变**主动观察最多轮数、触发频率、检查阈值、自动修复规则、取消语义和现有交付门禁。否则无法判断收益来自反馈还是更频繁的检查。

观察的成功/失败处理与写入记录分开；反馈投影失败时保留原结果和明确降级信息，不能重跑工具。存储故障无法保证新证据落盘时必须如实报告，不能承诺引用可查询。

## 7. 兼容、配置与回退

- 模式：`off` / `shadow` / `compact`，由可信运行配置注入，不放进模型工具参数，不要求新数据库表。
- off：不附加新模型反馈；保留必要的保存 ACK/未知写入保护。
- shadow：收集和校验反馈，保存测试证据，但不改变发给模型的内容。
- compact：附加简短反馈；保留现有原业务字段和观察入口。
- 同一次 run 固定模式和绑定，不因模型文字要求动态改变。
- 未迁移工具沿用旧路径。`observation.ts` 的旧写工具集合要等覆盖清单全部迁移并通过测试后再删除。
- 历史 checkpoint、tool result、没有 metadata 的旧宿主均可读取；没有 ACK 证据时不能补造 acknowledged。
- 对外 CLI 返回保持加法兼容；新字段不得破坏旧脚本和快照格式。
- 回退增强反馈不关闭执行安全和现有观察门禁，不重放旧操作，也不删除历史证据。

## 8. 开发顺序和验收

以下均为待实施任务，本轮没有完成代码。

| 步骤 | 开发内容 | 必过验收 |
| --- | --- | --- |
| S1 | 契约类型、TuGo 绑定、Legacy/MCP 默认 | 同名 MCP 不获得可信绑定；旧工具原样执行；Kernel 不新增 TuGo 导入 |
| S2 | 保存 ACK 与观察失败分离；直接/修复操作分离 | 保存成功后注入 observeBoard 异常：保存次数为 1；返回已保存/观察失败，不重放 |
| S3 | 原观察结果到反馈的纯函数投影 | 路径变化、修复对象、未知/过期/未检查、摘要总数与引用均准确；不重复计算路径 |
| S4 | 接入现有结果与主动观察消息；shadow/compact | 每个 call 恰有一个工具结果；取消/迟到/重启保持现有语义；反馈失败不重复写入 |
| S5 | 固定任务的闭环对照 | 比较 off/compact/按需明细，模型/布局/检查频率一致；测错误动作而非解释好不好看 |
| S6 | 通过实验后才扩大迁移和交付 | 全量、兼容、CLI、画布、Seam、原生窗口、打包、包内测试、审计；生产数据不用于写测试 |

测试文件落点：

- 新增 `runtime-ts/tests/toolContract.test.ts`、`runtime-ts/tests/toolFeedback.test.ts`。
- 新增 `src/lib/boardToolFeedback.test.ts`：纯函数差异和归责。
- 扩展 `runtime-ts/tests/runtime.test.ts`：一次写入、反馈降级、调用配对和主动观察关联。
- 扩展现有 `boardObservationDomain.test.ts`：实际变化与当前状态发现分离、证据过期。
- 原生 Electron fixture：保存 ACK 后观察异常；实际标题遮挡；未挂载 Renderer。不能仅靠 mock 代替宿主验证。

第一批必须覆盖的 8 个场景：普通成功；节点移动引发路径变化；修改文字触发有界修复；真实标签遮挡；保存成功而观察失败；未知写入超时；观察过期；旧工具/MCP 未迁移。

交付前硬门槛：无重复写入、无跨画板证据、无未检查却通过、无工具请求/结果缺配对；原有门禁全部通过。收益实验按上位设计第 12 节执行，不因安全测试通过就宣称 LLM 决策改善。

## 9. 首版做完，用户能感受到什么

以前主要看到：“移动成功”，之后靠 LLM 再猜要不要查。

首版希望做到：“移动已保存；两条关联线发生变化；几何检查通过，实际渲染尚未检查；不要重放移动。后续观察发现标签遮挡时，明确提供问题对象和证据。”

**先把工具造成的变化交代清楚，再验证 LLM 是否因此做得更好。不是先造一个通用工具框架，再找应用场景。**
