# 分层观察协议 v1（S2）

状态：S2通用协议/纯策略与S3持久证据/分页已验收；S4已将执行观察/安全恢复接入真实工具调用，完整Loop投影/领域迁移/交付仍由S5–S7完成，不能把本页当成已上线声明。

## 边界

- `runtime-ts/src/observationProtocol.ts`：JSON证据协议和运行时校验，不导入DOM、Electron、TuGo或数据库。
- `runtime-ts/src/recoveryPolicy.ts`：纯策略与共享预算，不实际执行工具、重试或启动定时器。
- `runtime-ts/src/legacyObservation.ts`：迁移适配。旧 `ok:true`/模型自报passed不能建立当前证据效力；执行状态只接受执行器额外提供的确认回执。源结果不改变。

## 证据

ObservationRecord 包含 schemaVersion、scope（application/workspace/run）、source（component/layer）、target（id/revision/session/可选rendererVersion）、时间、execution、validity、range、checks、findings、treatments、references、可选causeId。

执行状态与质量结论独立：修改保存但render unknown时，仍保持succeeded，不能据观察失败重放原写操作。未检查、未知、过期以及部分/分页/汇总交付都不能推导成完整通过。

范围 returned/total 描述该结果的数据条目，total可未知。complete若带total则必须相等且不能带nextRef；不能编造未知总数。检查名称、问题ID、处理ID不重复；拒绝的处理persisted不能为true。每项检查声明coverage；passed仅覆盖声明的检查，不代表业务语义、像素或Office显示均通过。

validateObservation 校验结构和语义并返回脱离输入引用的JSON副本；未知字段、协议版本、非法状态和不可序列化值拒绝。observationVerdict独立推导stale/needs_action/unverified/passed，不能由模型输入passed字段控制。

## 策略与预算

ExecutionContract.origin必须来自平台可信配置才可用于自动恢复；MCP行为注解应映射为untrusted，不构成幂等保证。缺失契约默认升级；暂时失败的已确认未执行/可信只读调用才可重试，未知写入优先query_status，缺少核对能力和有效幂等保证则升级。

RecoveryBudget用id、owner、maxAttempts、startedAt/deadline和attempt IDs表示；序列化后继续同一预算，不由每层另建预算。consumeRecoveryBudget拒绝错误责任方、重复attempt、取消、耗尽或非法时钟。执行器必须在工具实际调用前持久化预算消费；该动作接入属于S4，不由纯策略函数隐式完成。status查询同样消耗预算。Retry-After和实际调度在执行器实现。

## 兼容

旧观察可保留检查声明、问题与过期状态，但validity默认unknown；重新通过可信来源采集后再建立新记录。旧摘要遗漏阻断时添加明确的incomplete问题，不掩盖完整数量。旧工具schema/调用回执不改名不覆盖；S2仅提供迁移接口，实际调用链迁移由后续步骤验收。

## 验证

```sh
npm test -- --run runtime-ts/tests/observationProtocol.test.ts runtime-ts/tests/recoveryPolicy.test.ts runtime-ts/tests/legacyObservation.test.ts runtime-ts/tests/boardToolSchemas.test.ts runtime-ts/tests/observation.test.ts runtime-ts/tests/diagramQualityContracts.test.ts src/lib/boardObservation.test.ts
npm run runtime:ts:build
```

## S3 已验收的证据端口（尚未集成运行时）

`evidencePort.ts` 是无宿主依赖端口；`fileEvidenceStore.ts` 是平台文件适配器，存放在调用者传入的独立版本目录，不修改既有 Runtime 数据库或凭据。当前支持受控scope、不可覆盖发布、校验和、过期/配额和已知凭据拒绝；scope与secretValues由可信宿主提供，不接受模型自报权限。

格式为formatVersion=1的逐记录文件。损坏或未知格式拒绝读取，不自动重写；历史记录在重启后可读取，但当前目标有效性仍需外部版本核对。错误不含原始结果和秘密内容；存储失败不更改业务回执。

**3.1/3.2 已验收：**使用固定版本 proper-lockfile 4.1.2（已有依赖提升为正式运行依赖）的互斥租约，固定 stale=10000ms/update=2000ms，锁竞争返回busy；不能由不同调用者修改租约参数。持锁后清理中断临时文件，使用独占硬链接发布不可变记录，并同步文件和父目录。活跃租约不被抢占；子进程被SIGKILL后，过期租约可回收，已发布记录保持可读。旧原型无归属的.write-lock保守返回busy，不擅自删除。

此适配器面向本机POSIX文件系统，不宣称网络盘、Windows目录fsync或分布式fencing保证；发生租约compromised时停止提交并报告不可用。持久化不是业务exactly-once承诺。scope来自可信宿主，引用校验不替代用户身份认证；同源进程内任意恶意代码不在隔离保证范围内。

**尚未完成：**后续Runtime集成。S3.3分页/投影接口已验收，见下节；实际接入状态以任务台账为准。

静态字段和Bearer/sk模式只能识别部分敏感内容；宿主必须提供其管理的已知秘密值，后续接入时验证轮换后的秘密不会泄漏。不能声称任意文本中的未知凭据均可自动识别。

## S3 可逆分页视图

`readEvidenceView(port, ref, trustedScope, request)`只调用证据端口的get，不做写入或清理。例如：

```ts
const view = await readEvidenceView(store, ref, scope, {
  path: ['rows'], offset: 0, limit: 100, findingOffset: 0, findingLimit: 5,
})
// view.page.nextOffset 非null时使用同一ref/scope/path继续取回；
// view.findings.nextOffset 独立分页，不随数据分页丢失问题总数。
```

path只能选择原始payload的自有字段，拒绝原型路径、无效页码和越界limit；每页最多100项，问题页最多50项。数组按元素、文本按Unicode码点、对象按键值对分页；不静默做业务汇总。页内storedTotal只表示存储中实际可取回数量，sourceRange继续表达查询源是否完整/分页/部分，总数未知时不编造。

每个视图保留证据引用、观察ID、执行回执、目标版本、检查范围和完整问题计数；旧摘要可用可选findingTotals表达声明的总量，校验时不得小于实际问题数量。隐藏的阻断仍阻断验收，只有警告而细节缺失也不判为完整通过。已存问题细节不足时不能通过分页凭空恢复，应重新观察。

S3只保证可追溯分页，不保证任意单项都小于模型token预算；例如一个对象键可能持有很大的值。按模型预算进一步选取、外置与降级属于S5。宿主还需在S4–S7接通真实调用链，不能把库级测试当成最终上线验收。

[S4真实执行接入与恢复语义](OBSERVATION_EXECUTION.md)：包含可信契约、共享预算、未知回执、取消/晚到与重启边界。
