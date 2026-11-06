# 长思考回传的上下文预算回退修复

日期：2026-11-03。范围：修复分层观察发布后的预算误拦截，不回滚原有观察、幂等恢复和证据机制。

## 研究结论

- 字节不是token；把所有UTF-8字节按一个token估算，是保守上界，不是模型服务的实际用量。
- 工具循环中的推理内容不能为了过预算随意删掉。DeepSeek官方明确要求工具请求后续完整回传reasoning_content：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。不同模型有不同回传规则，不能以一个未知模型的tokenizer冒充另一个模型的计量。
- OpenAI的官方说明指出output/completion usage包含模型生成的token，不仅是可见正文：[Counting tokens](https://developers.openai.com/api/docs/guides/token-counting)。因此，对同一配置下、已被Runtime记录的原样输出回传，可使用该次completion usage作为计量依据；本轮不把累计usage、缓存命中量或用户自报数字当作依据。
- Claude有自己的[Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)及推理块规则。此次没有调用真实计数API，也没有把Chat Completions的推导强套到Claude/Gemini签名块上。

## 实现与边界

1. `runtime-ts/src/outputUsageBudget.ts`产生受信计量凭据：模型/配置指纹、响应指纹、调用ID和单次输出用量。只对原样回传的Chat Completions助手消息生效，额外保留10%及协议封装余量；不减少下一轮输出预留，不调大窗口，不放宽95%安全比例。
2. 凭据保存在checkpoint的有界outputUsageLedger（128条）中，不向模型开放修改。逐条消耗匹配次数，重复调用ID不重复抵扣。模型/配置、正文、思考或调用参数改变即不再匹配。无计量、非法/明显不完整计量、未知或签名元数据均退回原字节上界。
3. 用户输入、系统约束、工具定义、新工具结果、图片和新增指引照常计入。完整思考/工具调用/结果配对保持不变。此次修复不是历史摘要，不删除或截断任务约束，不重新执行已提交操作。
4. 老版本失败会话的兼容路径严格限于：原始受信checkpoint、单个成功模型响应、单个助手消息、原配置快照相同、调用和正文与持久回执匹配、单次输出用量与checkpoint统计一致。原循环没有改写reasoning，诊断日志的8K前缀须与完整checkpoint一致。多响应累计、种入的会话文本、配置变化及不匹配回执均不猜测迁移。该路径不修改生产profile；真正写入发生在用户运行新版时。
5. `ContextProjectionError`独立归类为`CONTEXT_BUDGET_EXCEEDED/context_budget`，明确“本次模型请求尚未发送”。运行生命周期status不再混为HTTP状态，界面只显示100–599的整数HTTP码。旧失败消息仍是历史记录，不因修复被改写。

## 验收

最终命令、退出码和日志位于`artifacts/context-budget-repair/`；`verify.sh`记录主流程，`results.json`及`manifest.json`在全部验收后封存。

- 新增10项回归：完整长思考回传、工具配对、原安全预算准入、真正超限拦截、缺usage停止、跨配置/消息修改失效、序列化及重复凭据、防不可信旧记录迁移、旧失败恢复不重放工具、本地错误分类。原有断言不放宽。
- 对实际失败数据只读加载到内存，不打开生产Repository、不调用模型、不打印用户正文：原149404/121600；原样输出计量节省45211，其他分区不变时104193；该记录的旧版本恢复条件及配置匹配成立。见read-only-legacy-check.json。
- 首次全量受沙箱禁止监听127.0.0.1影响，598项通过/2项MCP测试失败，原日志在sandbox-denied；授权放开本机监听后重新执行全量，不删除或跳过MCP用例。
- 修复后的全量600/600、兼容96/96，构建、CLI、46Seam、Electron、打包、签名/fuses扫描、包内GUI/CLI及源码/包内编译字节比对均通过。源码及包内UI采用三轮取消/排队验收。

## 发布说明

修复包另命名为`TuGo-1.0.0-20261103-context-budget-fix-arm64.zip`，不替换先前已交付的日期包。新包仍为Apple Silicon、本地ad-hoc签名、未公证；没有自动安装、提交或覆盖用户生产数据。不能据此声称任意模型具有精确tokenizer，或像素/外部Office已验证；不能保证无usage的第三方网关永不触发保守拦截。

## 后续版本

本文保留原版本验收事实。后续已完成通用上下文生命周期改造，最新包和验收见 `docs/CONTEXT_LIFECYCLE_RELEASE.md` 与 `docs/architecture/CONTEXT_LIFECYCLE_PLAN.md`；不将本文旧包作为最新交付。
