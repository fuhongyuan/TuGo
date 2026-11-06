# 实际画板观察与证据有效性

## 责任与数据流

领域服务 `createBoardObserver` 固定输入快照，执行几何审计；Renderer 端口采集实际 DOM，返回序列化证据，不执行修复。保存事实与检查结果相互独立，检查失败不能触发写操作重放。

宿主按画板登记探针，提供文档签名、render epoch、交互/播放 pending、连接/可见/字体与图像就绪状态。每次登记具有独立身份；DOM MutationObserver 和字体 loading/loadingdone/loadingerror 更新单调场景版本。撤销到相同内容、卸载重挂及字体周期不因内容相同而复用旧结论。

## 时序门禁

1. 复制待检查文档，避免等待中外部原地修改污染报告 hash。
2. 最长等待 2500ms，间隔35ms检查，要求连续两次相同且就绪的场景 stamp。
3. 同步 DOM 采样后再次核对 stamp。
4. 发布报告前，在异步 hash 计算之后重新核对文档序列、签名、宿主 epoch、场景身份与就绪状态。
5. 读取历史报告时再次核对当前状态，不将历史通过当作永久验收。

未挂载/播放/字体未完成/异常返回 unknown；发生版本或场景竞态返回 stale。取消抛出 AbortError，不以 unknown 吞掉取消。旧适配器未提供新增可选字段时保持协议兼容，不能推断具备新宿主的场景追踪保证。

## 覆盖矩阵

| 证据 | 已检查 | 未检查 |
| --- | --- | --- |
| geometry | 数据几何、文字布局、路径等规则 | 实际像素、字体最终绘制 |
| canvas DOM | 实际文字 Range/foreignObject 边界；路径存在；路径采样与后绘制不透明图形遮挡；箭头 marker 引用；描边 none/零宽/零透明度/透明颜色及祖先透明 | 完整像素视觉、任意CSS合成/外部样式变化、细于采样间隔的遮挡 |
| pixels | 不标 passed，始终 pixel_verification=not_checked | 截图存在不等于视觉判定完成 |
| PPT | 始终 pptx_render=not_checked | 导出成功不等于 PowerPoint/WPS 实际呈现通过 |

旋转、图像和自定义裁剪等当前不足以完整判断的场景返回 unknown，而不是声称完整渲染通过。场景版本追踪是保守失效机制，可能因无害DOM变化要求重新观察；不是完整浏览器渲染引擎的替代品。

## 可重复验收

- `src/lib/boardObservationDomain.test.ts`：发布时 pending/font/identity/epoch/缺失/过期竞争及原地修改快照隔离。
- `scripts/seam-canvas.cjs`：实际 Chromium 四故障注入；透明/零宽/祖先透明描边；真实 InfiniteCanvas 播放及画板属性切换。
- `scripts/fixtures/observation-stability.ts`：实际场景上的宿主状态注入，字体未就绪/字体周期、登记切换、DOM与文档ABA、版本竞态、取消和宿主异常。字体 loading 测试使用状态覆盖与事件注入，不声称验证了真实网络字体下载全过程。
- 结果及退出码归档在 `artifacts/layered-observation/S6-4/`；S7交付调度和S8包内/性能验收仍独立待完成。

## 在途读取合并（S7.1接入进行中）

画板领域服务使用通用 `ObservationScheduler` 合并等价只读观察。键由宿主生成：应用、画板工作区、服务会话、目标、单调文档序列与完整签名、geometry/canvas_dom范围、等待策略；不是模型自报revision。请求立即固定文档快照。已完成报告不缓存为新验收结论；取消只解除当前消费者，所有消费者取消才终止共享采样。带before/fixes/directIds/causeId/repairPlan的修改因果报告不合并，以免混淆保存事实。

自动观察与模型观察都经过此领域入口，已验证一次宿主采样返回同一证据ID、不同消费者获得独立结果副本。此处只保证采样去重，不代表Runtime自动轮次和恢复预算已共享；S7.1的循环级触发、预算接线及集成验收仍未完成。

## S7.1循环侧接线

TuGo应用策略现已使用通用触发原语：交付生命周期检查、累计3次修改、一次含blocking观察或high布局问题的风险修改；不可用及3轮上限抑制自动触发。风险只从工具返回的结构化结果读取，观察后清除，不能单凭模型文字认定风险已解除。

同一证据ID只消耗一次本轮观察计数；自动与模型返回相同领域报告时不会各计一轮。读取历史报告不新增计数。startRun重置本轮收据集合；观察失败记录不可用并停止自动触发，取消向上传播。此计数是观察策略预算，不替代工具执行attempt预算；跨层统一终止及无进展策略属于S7.2。当前运行时仍串行执行模型工具批次；额外并发接线测试通过实际应用策略+领域服务验证共享采样和收据计次，不声称已引入并行Agent Loop。

## S7.2阻断反馈（进行中）

应用delivery返回结构化feedback后，通用Loop保存为下一轮system证据，丢弃本轮过早交付文本并记录observation.escalated journal。核心不识别具体图形问题。TuGo策略限制最多2轮反馈，受现有3轮观察上限及不可用状态约束；按阻断数量和问题type/refs识别重复问题，达到上限明确披露未解决、请求人工决策。报告unknown不因此伪造失败或通过；取消仍向上抛出。

此增量不等于跨层共享终止预算完成：工具修复次数、观察采样、反馈次数、上下文投影仍使用各自受控上限，尚未统一到同一run级预算对象。模型持续发工具而不尝试交付的分支仍依赖现有Loop/tool/time总上限；跨层无进展提前停止须继续实现和验收，S7.2暂不勾选。

### S7.2共享上限增量

唯一Agent Loop新增持久化runActionBudget，context_projection、observation、observation_feedback和每次外层tool_attempt先预留同一计数并flush checkpoint，再启动动作。预算按runId绑定，保留deadline/used/byLayer；相同run恢复不重置，取消不扣费。默认上限取maxToolCalls+maxLoops，可通过可信middleware.maxProcessingActions配置（1–2000），原有各层上限仍是更严格的子约束。

共享上限耗尽以明确失败终止，不启动新写入、不回滚已保存内容；它不是工具幂等账本的替代物。当前仍待将工具内部重试成本与该总上限直接绑定、补齐持续修复分支的无进展提前终止及恢复组合验收，因此S7.2依然不勾选。

### S7.2终止规则完成接线

共享计数已移至执行器durable before事件，而非仅invoke：外层尝试、beginInternalAttempt和query_status都先预留run预算；late_result不扣新尝试。模型重试的投影也扣共享计数。耗尽后不启动对应业务或状态查询；保留unknown执行事实，不因为核对预算不足重放写入。

TuGo记录每个新采样ID的阻断数量及问题type/refs签名；连续两次新复检与上一份问题相同（共3份独立证据）触发stopReason。历史读取不增加无进展次数，无阻断新采样清除该计数；新run重新建立阶段预算。通用Loop在下一轮模型调用前和工具invoke前消费应用停止原因，明确失败结束，已保存业务不回滚。保守签名可能因问题摘要未体现局部改善而要求人工决策；这是停止保护，不是渲染通过判定，也不替代S7.3可信当前证据门禁。

## S7.3可信交付门禁

TuGo交付策略对lastObservationId重新调用受信宿主getObservation；宿主核对当前版本/场景后，运行时再检查目标project、报告ID、session/document_seq/hash/renderer身份、geometry与render双passed、完整阻断数0、无blocking明细、DOM覆盖及scene_token。缺失信息按未验收，不向旧结果隐式补passed。模型文字/参数/历史boardDeliveryGate值都不构成凭据；每次交付检查先清空旧通过，要求新查结果。

审计通过通用application.deliveryEvidence端口进入delivery.checked journal和session.completed.delivery_verification，关联run、最后修改callId、observationId、版本hash、渲染器、责任方及反馈/观察轮次。核心不导入图形门禁实现。session.completed.status=success仅指运行协议正常结束，不代表画板质量通过；必须读取delivery_verification.passed及scope。缺证据/过期/范围不足可重新观察（有预算时），否则最终附明确未验收说明，不能据此验收画面。

门禁范围仅geometry_and_canvas_dom，pixels/PPT明确not_checked。不锁定用户画板，也不保证验收之后未来编辑仍有效；后续使用旧报告时宿主会再次失效核对。运行时信任平台装配的宿主回调，不防御已被攻陷的宿主进程。当前实现不是签名证明或分布式一致性协议。

## S8.2实测驱动的未稳定快速路径

新增35次真实46节点观察性能fixture，首次测试发现未稳定等待100ms和25ms取消分别耗时约2145ms/2043ms，超过2秒fixture保护。原因是领域观察在等待宿主前已同步执行完整几何审计，AbortSignal不能抢占这段CPU工作。

产品修正：检查前若宿主明确pending、字体未就绪、隐藏或断开，暂不执行几何/间接路径/字号审计，先做有界宿主等待。报告geometry=not_checked、verification_level=unverified；即使本次等待期间场景恢复，不能将仅有DOM通过提升为完整通过，需下一次观察补足几何。稳定场景仍执行原几何和DOM检查，不以性能为由跳过正常验收。未知宿主状态不自动伪造几何结论。

初次失败与产品修正前后日志全部保留。竞态fixture明确初始就绪、采样后才变pending/字体状态，保留发布时stale断言；新增初始pending→渲染恢复也不假通过断言。同步稳定大图的计算仍非硬实时可抢占，不据此声称任意大图都能在25ms取消。

### 2026-11-03 稳定场景协作式几何计算

实测分离阶段：46节点总观察约2252ms，而宿主DOM测量约144–148ms，主要阻塞在同步几何/路由阶段，而非DOM采样。为保持字体测量语义，不把审计迁到使用不同字体环境的Worker。

路由与审计改用同一确定性Generator计算步骤：同步API仍完整耗尽同一序列，async API按约8ms计算片段让出事件循环，在片段边界检查AbortSignal。领域只读观察采用async API，修改前后间接路径审计也采用同一路径；布局与导出等原同步调用保持兼容。取消finally关闭Generator，丢弃未完成纯计算，不写业务。

一致性测试逐项比较46节点同步/异步全部路径与完整审计报告；不通过缩小审计范围、改变字体度量、减少采样或吞掉问题加速。稳定/未稳定场景均新增25ms取消实测，保留2秒fixture保护。四次完整运算的一致性单测总时限为20秒，不是放宽取消上限。片段以路由边和审计迭代为边界，单条极端复杂边仍不可硬实时抢占，不能宣称任意大图8ms硬上限。

协作让出期间的字体/场景有效性补强：领域服务在几何前记录宿主scene_token；若几何执行期间环境变更，即使最终DOM已经稳定，也将本次几何及render标stale，要求新观察，不能把旧字体下的几何和新DOM拼成完整通过。新增“最终DOM稳定但初始场景版本不同”的回归断言。封版须以delivery-final新包与性能复验为准。
