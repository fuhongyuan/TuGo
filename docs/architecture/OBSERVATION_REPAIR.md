# S6.3：只读观察、修复候选与新版本复检

状态：S6.3已验收，整体18/27；详细证据以OpenSpec执行记录和勾选清单为准。本设计不把“建议/尝试修复”当作已经保存，也不把几何复检当作DOM或像素验收。

## 边界和状态

```text
读观察 → boardObservationDomain → 几何/宿主端口 → 证据（不调用修复/保存/历史操作）
写操作 → 得到用户操作候选文档 → boardRepair规划 → 一次提交/保存ACK
         → confirmRepair确认候选身份/实际形状 → 新版本observeBoard
         → 原写入事实 + 修复回执 + 几何/渲染检查各自报告
```

- `repairNewNodes`保留兼容名称，但只产生RepairPlan：候选document/patches、提议/拒绝/跳过记录及本地预算。不会保存、提交、操作撤销历史，所有输出初始`persisted=false`。
- `confirmRepair`不执行写入，只接受当前进程注册的原计划句柄。内部保存候选快照，不能用克隆/模型JSON或改动公开fixes字段伪造候选身份。收到保存ACK且实际形状匹配才将proposed转为applied/persisted=true。
- 缺少ACK或版本不匹配为unknown/persisted=false，不代表已经证明未写入；先核对状态，不重放。rejected/skipped不能因主操作保存成功而被转成applied。
- 实际App和CLI均在保存ACK之后确认，并把用户操作与修复放在同一历史提交中。失败不自动回滚或重试；错误保留plan/cause ID并说明结果未知，沿用S4保守执行恢复。

这不是分布式事务或任意第三方代码沙箱。ACK由可信宿主提供，不接受模型自报；计划句柄为过程内状态，进程丢失后不能靠JSON复原成已确认回执。旧API字段type/refs/persisted/message仍保留。

## 权限与预算

只处理本次add_element真正新增的前景节点；App/CLI同时传入操作前文档，避免把同ID覆盖误当新增对象。保留位置、宽度、文字、配置字号和关系，只允许向下增高。排除图像/旋转对象、锁定、layoutLocked、preserveSize、未授权ID、未知或循环父链；继承当前父级及操作前父级锁定。

默认硬上限：8个目标、48个增长候选、每个最多24px，按4px增长。较小预算可以进一步收紧，超上限参数不能放大硬边界；耗尽显式skipped，不当作已处理。修复审计另限256元素、512连线及64,000文字字符；超过时在布局计算前显式skipped，不克隆大型候选快照，不偷偷只检查一部分后声称安全。此为本层预算，不代替S7的跨层总预算，也不声称同步几何检查有精确耗时保证。

检查父级余量、兄弟/独立文字空间，并使用已接受的临时候选尺寸检查后续候选，防止多个增长相互碰撞。最终比较全图高严重度回退；审计覆盖达到上限或检查失败时拒绝候选。额外检查全部实际路径（包括语义关系图未覆盖的自由连线），不让扩高遮住自由线；拒绝记录保留提议高度、冲突对象refs和原因。拒绝只拒绝自动修复，不撤销用户本来的合法操作。

## 因果链与复检

```text
原工具/CLI cause_id
 → repair_plan.id + budget.usedCandidates
 → action.repair_id / proposal / state
 → before_revision、after_revision（内容hash）
 → verification_ref（新观察ID）
 → verification.geometry/render + content_hash/document_seq
```

摘要也返回cause_id和repair_plan，不再丢掉顶层因果关联。只有applied且persisted的回执计入“已应用修复”；保存成功但几何/渲染未知仍分别报告，不能据未知重放原写操作。

确认用精确形状快照（元素、边、palette、展示区域），派生DSL缓存/视口不作为形状确认依据；hash用于关联，不作为ABA有效性证明。CLI保存后如果宿主仅重建了派生缓存，会以同形状的实际保存版本复检；真实形状变化仍报告stale。新观察的verification明确针对observed_document，不是被拒候选的质量证明。

自动修复后的立即检查为geometry，render仍not_checked；实际DOM由既有观察生命周期另外取得，像素/Office仍未验证。修复回执记录历史应用事实，后续撤销/重做使旧观察整体stale，即使内容hash恢复相同也不能复用验收。S7仍负责统一升级、多报告关联与交付门禁。

## 验收

- 只读观察可接受深冻结业务文档，不调用boardRepair、提交、持久化或历史写函数。
- 候选初始未保存，锁/继承锁/权限/旧ID/空间不足/预算/自由线碰撞均受保护。
- 拒绝候选即使收到主操作ACK也不能变成已应用；无ACK/错版本保留unknown，伪造计划拒绝。
- 单次提交包含用户操作及修复，一个undo同时撤销；redo后的旧报告仍stale。
- 实际CLI到Renderer验证修复回执、保存版本、只读观察、锁定保护、单步撤销/重做及因果复检；保存ACK失败不会重复保存。

失败/红测和修复记录均保留在S6-3目录。安装包、Node25、性能及外部Office显示未在本阶段验收；S6.4/S7/S8仍未完成。
