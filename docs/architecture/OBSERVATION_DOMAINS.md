# 领域观察注册与查询验收（S6.1）

状态：S6.1已验收（全量508项/兼容90项/构建通过）。范围为首个非绘图查询测试适配器及实际Runtime接入，不是S6全部完成。S6.2的画板迁移/宿主探针、S6.3修复隔离和S6.4呈现故障尚未在本项验收。

## 决策与三视图

原则沿用Kernel / TuGo Package / Platform：领域知道查询范围和业务语义，Kernel只识别通用证据及已注册执行端口，平台提供装配/持久化。不新增循环、服务进程或任意第三方插件执行器。

- **概念视图**：平台装配可信领域贡献；领域采集并声明结果覆盖；同一Agent Loop消费证据、决定是否继续；明细恢复读取持久证据，不重跑原查询。
- **逻辑视图**：`DomainAdapter`贡献稳定id/version和只读工具；`DomainObservationRegistry`检查注册/冲突、绑定真实定义对象、派生可信scope、核对返回证据身份。`DomainResult`分开record/data/note/detail；record使用S2协议，scope由宿主注入，不能来自模型。普通AJV参数检查、S4恢复控制器/调用账本、S5预算/投影不复制。
- **执行视图**：当前在同一个Node Runtime进程内，由平台通过构造函数第五个可选参数注入可信适配器；未注入时不新增工具、不改变旧构造调用。测试查询在内存中运行，无Renderer/MCP IPC或数据库查询服务。S3证据仍写入平台版本化目录，模型继续走原Provider调用路径。

选择注册贡献而非在循环里新增query名称分支，便于后续将画板检查迁入同一边界。没有因此宣称整个旧runtime.ts已经不认识board：旧产品分支仍待S6.2迁移。这里是可信进程内贡献，不是恶意代码沙箱；声明只读不能约束任意恶意宿主函数。

## 契约和调用路径

`domainObservation.ts`只依赖契约/证据协议，类型依赖S4 attempt。注册期间冻结贡献快照，输入schema/数据复制；不暴露RuntimeRepository、DOM或Electron。

```text
平台注入适配器 → 解析工具及冲突校验 → 配置快照记录id/version/tools
模型调用 → 同一AJV验证/账本 → executeObservedTool共享预算
  → 已绑定的领域观察函数 → 校验证据scope/call/session/source/执行身份
  → {data, domainEvidence, note, detail} → S3/S5投影 → 下一轮模型
  → 可选runtime_read_evidence读取已保存数据，或detail工具查询下一批源数据
```

不能通过复制工具定义/伪造handlerKey执行已注册函数；路由基于Registry内部绑定的定义对象。名字冲突（包含现有MCP/内置工具）拒绝。适配器id冲突、保留名、非法超时、非法JSON结果、错误scope和未注册明细路由均拒绝。预取消不调用领域函数。内部重试只能通过收到的S4 attempt计入同一预算；没有另造重试循环。

只有可信注册返回的record才作为类型化领域证据进入投影；普通MCP/旧工具返回同名字段不能获得此信任。原record的目标、revision、覆盖、未知总数不会再被旧适配器改成legacy范围。类型化领域结果即使很小也持久化并提供引用；大data.rows可外置，其它元数据保留。

引用的scope应用id为实际adapter.id，workspace/run/thread来自当前检查点。读取需命中可信引用注册表、匹配当前workspace/thread，且当前适配器仍注册；S3继续检查完整scope/校验和/保留期。不能把原run引用的历史事实当成当前版本验收；当前效力门禁另属S7。

## 非绘图查询fixture

`runtime-ts/tests/fixtures/queryDomain.ts`只用于测试，不安装到用户模型/工具配置，不作为生产数据库产品功能：

| 结果 | 声明和验收 |
| --- | --- |
| complete | 全部快照行；returned与已知total一致；仅此快照query check可passed |
| page | 返回本批行、来源已知total、下一批入口；最后一批仍不自动声称完整交付 |
| partial | 本批可用行、未检查覆盖及下一批入口；可省略total，不把存储行数当源总数 |
| summary | 只在显式representation=summary时返回；说明尚未交付明细，并给出detail入口 |

注入“后端只想给summary但请求为detail”的故障会拒绝，而不是静默改写representation。query模式/已知总数由测试宿主配置，不由模型制造。没有自动从明细降级成汇总；本层也不会替用户改变条件。

**两种分页不能混淆**：runtime_read_evidence的storedTotal仅为本次已保存数据；detail入口用于再次查询源数据的下一批。未知来源总数的350行fixture先取得100行，引用取回第99行不增加源查询次数；随后detail查100–104行才增加一次源查询。sourceRange始终partial且没有虚构total。

## 验收与局限

正常测试包含注册冲突/复制定义拒绝/预取消/scope篡改、四类范围、未知total、完整逐页恢复、明细不静默汇总。

真实Runtime模拟模型在无画板绑定/无Renderer的同一循环运行四类查询，校验S4账本、S3类型化持久证据和模型内容；另有大结果引用恢复与后续源查询闭环。未创建第二套Loop。完整构建和测试结果见OpenSpec执行记录及S6-1指纹。

本项不提供实际外部数据库接入，不证明任意第三方adapter无副作用，不包含当前画板DOM/像素/Office验收。S6.2–S8、Node25及包内验证仍必须后续执行。

## S6.2 首批历史记录：领域/Renderer端口分离

本节保留首批部分实施时的状态：当时6.2未勾选、16/27。后续当前状态见下节，不删除当时失败。

- `boardObservationProtocol.ts`：可序列化的RenderEvidence/RenderStamp/BoardRenderPort，端口不传HTMLElement或原生场景句柄；默认无呈现宿主明确返回unsupported/unknown、coverage=none，不以导出图代替实时DOM。
- `boardObservationDomain.ts`：独立createBoardObserver实例保存会话、版本序列和不可变观察；消费端口、组织几何/副作用/版本失效；保留原有修复及分页函数，未在本轮改动修复策略。
- `boardRenderProbe.ts`：Renderer宿主唯一原生采样实现，管理挂载回调、DOM/绘制顺序/marker/文字边界、稳定等待与当前场景stamp。仍明确像素和外部PPT未验证。
- `boardObservation.ts`：桌面装配和旧导出兼容facade，只创建默认领域服务并注入live端口，App/Canvas现有导入不变。

概念上，领域拥有“检查/证据效力”，宿主拥有“实际场景采样”；逻辑上通过序列化测量与stamp协作；执行上桌面两者仍在Renderer进程内，Node单测可直接实例化无UI领域服务。此处的Node单测不是安装包内CLI能力已接入的证明。

本批增加6项Node环境测试：无document可运行、无UI拒绝DOM且不冒充通过、显式geometry-only、实例证据及ABA隔离、序列化stamp改变/隐藏失效、预取消、禁止领域文件直接导入Renderer原生类型。无UI/取消只在本服务入口验证，跨进程取消仍由后续调度集成验收。

源码全量514测试、兼容90测试及完整构建通过；46节点实际DOM和四类故障注入也通过。**原生画板完整交互回归未通过**：首次激光坐标断言错误，复测同位置找不到laser；同批仅替换回迁移前观察模块的隔离对照也失败，但位于后续嵌套连线文字编辑断言。对照只能说明该交互套件在迁移前实现下也未全通过，不能据此宣布激光失败根因已定位/修复。完整日志在S6-2目录，原测试和断言均未削弱。

首批之后的剩余事项（后续结果见下节）：Agent Loop中的board观察调度、PNG/PPT结果物化及相关硬编码归入TuGo应用边界；将注册贡献接到画板路径；无UI的运行时/包内入口实际验收；查清并恢复原生完整交互回归。完成前不标6.2通过，不进入6.3完成状态。

## S6.2 后续验收：循环应用边界已接通

S6.2验收时整体17/27；S6.3后续验收见OBSERVATION_REPAIR.md，最新进度以执行记录为准。本节替代上节“进行中”的当前状态；历史失败日志不删除。实际验收结果见execution-log.md及S6-2最终源码指纹。

### 职责与执行位置

- `agentLoop.ts`：唯一的AgentRuntimeCore，管理模型/工具循环、S4账本/预算、S5投影、事件/取消；无board/PPT名字判断，无Renderer/Electron导入。平台和应用通过端口协作，不再由循环根据产品工具名挑选业务处理。
- `runtimeApplication.ts`：通用可信应用贡献契约及domain-only工具宿主。生命周期观察请求、结果物化、交付说明、工具故障策略由贡献提供；模型参数不能注册贡献。观察触发阈值仍沿用产品规则，S7的统一去重/共享终止门禁尚未完成。
- `tugo/runtimeApplication.ts`：TuGo拥有画板绑定提示、变更/观察状态、观察请求、交付复核、审计上限、PNG/PPT物化及宿主故障解释。仅拿到物化所需的窄存储服务；不持有第二个Agent循环。
- `runtime.ts`：平台装配兼容入口TuGoRuntime，继承同一个Core，创建既有ToolRegistry及TuGo贡献；旧构造调用和模型/MCP/Skills资源保持。`toolErrors.ts`保持旧Error导出的对象身份，`promptLocale.ts`提供纯语言标识；通用循环不再导入产品提示词表。
- `requiresVision`为宿主提供的工具能力元数据；通用模态策略不再硬编码截图工具名称。旧用户/MCP注解不因此获得安全重试/幂等保证。
- 前端继续使用上节领域服务/BoardRenderPort/Renderer探针装配；原生句柄只在宿主。无UI领域入口返回unsupported，不拿导出图片冒充实时证据。

应用端口属于可信进程内装配，不是恶意代码沙箱。AgentRuntimeCore仍使用既有Repository/Provider/MCP适配；此项不宣称全仓库Kernel/平台存储/资源seed已完成独立SDK拆分。旧projectId字段保留为兼容工作区绑定，未迁移用户数据格式。

### 已执行的闭环验收

同一个Core既运行无应用实例的查询fixture，也通过TuGoRuntime装配执行绘图、观察、截图；生产实现仅一处循环。新增源边界测试禁止Core直接依赖产品工具/观察模块、board/PPT常量或DOM/Electron；默认generic宿主无隐式产品工具/观察器。

无UI故障注入在实际循环先确认保存，再让live观察不可用：保存工具计数1、观察计数1，不调用截图/PPT导出，已保存账本保持succeeded，最终明确“观察服务不可用/未验证”。PNG/PPT物化用例分别核对二进制移除、截图不当下载附件、PPT只生成/绑定一次。Node几何/unsupported服务测试与真实DOM故障注入继续保留。

### 原生输入故障的定位与修复范围

`canvas-input-diagnostic.log`捕获了脚本未发送的大量额外指针坐标，以及编辑器焦点移出；失败位置随输入时序变化，包含激光、拖动和文字编辑。仅使用setIgnoreMouseEvents的试验仍失败，未据此算修复。

最终修改只在测试harness：每次sendInputEvent前声明本次坐标，在测试页面捕获阶段隔离未声明的指针输入；忽略窗口失焦产生的外来focusout，且不反复向已聚焦窗口抢焦点。原生注入API、业务操作和原断言不变；`native-assertion-parity.json`校验全部assert行文本与顺序一致。一次通过记录隔离210个额外事件，复测在0个额外事件时也完整通过；没有通过删除失败断言获得成功。

这是自动化输入归属的修复，不是宣称修改了产品激光算法或任意真实鼠标/窗口失焦行为。测试仅承诺隔离后的原生注入交互，外部硬件与窗口激活行为不在本套覆盖中；发布阶段仍须重跑并单独报告范围。此前失败和迁移前对照全部保留。

最终全量519项/兼容91项/构建、CLI实际观察与失效、隔离原生交互两次、实际DOM及四故障注入均通过。未执行新安装包、Node25、外部Office显示或性能验收；S6.3后续状态见OBSERVATION_REPAIR.md；S6.4和S7/S8仍未完成。
