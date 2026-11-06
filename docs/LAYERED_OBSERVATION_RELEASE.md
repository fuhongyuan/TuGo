# 分层观察交付与回退

日期：2026-11-03。验收清单以OpenSpec tasks.md与execution-log.md为准。

## 安装包与安全性质

Apple Silicon ZIP：`release/TuGo-1.0.0-20261103-layered-observation-security-arm64.zip`。SHA-256：`fee6494d51cc176f59d06732d208d1dc8703ccb8fdd1571411fbfef2d3ab0586`，见 `artifacts/layered-observation/release-complete/delivery-sha256.txt`。源码与包内关键Runtime/主进程JS逐字节比对见package-identity.json；安全扫描见scan.log。

本地ad-hoc签名，未做Apple开发者身份签名或公证，不宣称Gatekeeper/企业分发正式信任；不建议关闭系统安全保护。没有自动安装至/Applications，也没有修改用户现有生产应用。安装由用户决定。

## 能力边界

- 观察仍区分执行事实、geometry/DOM、像素与外部PPT；像素与PowerPoint/WPS实际显示不因DOM通过而标通过。
- CPU密集几何按软8ms片段让出，单条极端复杂边不是硬实时8ms保证；实际46 Seam图取消/性能数据见S8-2-cooperative。
- 会话正常结束不表示画面验收通过；查看delivery_verification.passed/scope/reasons。
- 不自动更换模型或调用真实模型服务验收；测试提供者为确定性fixture。

## 数据副本验证

离线复制实际TuGo的两个SQLite与附件目录到700权限临时目录，文件重定位后只启动Repository，不启动Agent/宿主/网络模型，不复制runtime-secrets.json。验证4个模型、5个Skill等已有配置行、99个已引用附件；缺失引用0；原生产文件hash不变。自定义Prompt/MCP在实际副本无对应行时不编造覆盖，另由联合fixture验证；其数量与结果见release-complete/copy-compat.log。

内置未修改提示词允许跟随版本升级，用户修改行必须原样保留。首次副本测试将内置提示词updated_at更新误当用户配置变化，失败保留；最终按user_modified范围验证，不忽略真正用户配置。

## 升级和回退步骤（未自动执行）

1. 升级前退出TuGo，备份完整原profile、附件、配置及原应用；保持目录权限。备份凭据文件应加密保管，不上传至日志/版本库。
2. 新版先用独立profile确认，再由用户决定是否替换应用。不要在原profile同时运行新旧两个版本。
3. 需要回退时退出新版，保留新版profile的完整副本，再恢复升级前应用与**同一时点**完整profile到原路径；不得混搭旧SQLite与新附件/配置。
4. 凭据的本地加密可能依赖账户及profile路径，不能假设复制到新路径或新设备即可解密；本轮未导出或重写用户凭据。
5. 新增证据目录和checkpoint字段为加法；保留证据和调用账本，不因旧版不识别就删除。未知写结果必须人工核对，回退不是重放授权，也不是分布式exactly-once保证。

本轮验证了隔离副本及fixture，不自动执行生产升级/降级；历史备份与源码工作区原改动不回滚。未自动Git提交、推送或OpenSpec归档。

## 历史发布阻断：补充全依赖审计（升级前）

生产依赖的定向兼容更新已将`npm audit --omit=dev`归零；但仅看该命令不够：前端/PPT库虽声明为devDependencies，仍进入打包产物。全依赖审计发现DOMPurify、image-size等产品链风险，以及Electron补丁和测试/构建工具风险。当时的ZIP仅用于隔离验收，未作为安全发布包交付。

当时完整修复涉及PPT解析器、Mermaid、Vitest等主版本变更，已请求范围确认；用户随后批准，修复及最终复验见下文和最终执行记录。完整审计原始输出见release-verified/all-dependency-audit.json。不要用生产依赖审计0或release:scan成功代替该安全结论。

### 2026-11-03 已获批升级实施

用户已批准完整安全升级。当前选择Electron43.8.6、Mermaid12、Vitest4.1.x（支持Node25，不选排除Node25的Vitest5）、Vite8/React插件6、PDF.js6.5.x；显式声明原脚本已使用的vite-node/esbuild，避免依赖旧Vitest/Vite的偶然传递安装。

PptxGenJS本体已是4.0.1且没有更高已发布修复版，因此采用其image-size解析器2.0.4定向覆盖并验证真实PPT导出，而不是照审计建议降级PPT库。构建链采用asar4/universal3/EJS7与minimatch11；asar的glob定向修复至14.0.3。覆盖必须通过真实打包和安全扫描，而不是仅改变审计数字。

兼容代码：PDF.js6资源销毁转到PDFDocumentLoadingTask，加载失败也清理；移除已不存在的isEvalSupported配置。Vite8对Ajv CommonJS默认导出的形状不同，独立生成器规范化一层默认导出；保持CSP无eval，并补充160/161个Unicode码点限制测试。旧失败日志保留，最终状态以release-complete当前源码与新包证据为准。

### 完整安全修复结果的验收规则

审计以最终`release-complete/all-audit.json`为准，必须包含全部依赖而非仅omit=dev。测试/构建脚本的直接依赖显式声明（含esbuild已修复版0.28.2）；PDF.js6、独立Ajv校验器、实际PPT图像尺寸读取均有回归。首次缺少esbuild及Vite8默认导出错误的诊断日志保留，不以单元通过替代生产构建CLI测试。

升级前快照与旧node_modules保留在私有临时备份；它们不属于安装包，不会恢复到生产目录。交付仅使用重新生成、扫描及包内GUI/CLI通过的ZIP；旧风险版本的包测试不算本次通过。

封版补强包括：异步几何期间字体/场景变更使整份报告stale；取消后的旧回执/旧事件不得污染下一轮；旧pending会话快照不得盖掉终态。UI自动化先等真正终态与composer空闲，再连续测试3轮取消/队列完成，避免把正常排队误当取消失败。最终通过与哈希仅以release-complete为准，所有诊断失败保留。

## 最终验收（2026-11-03）

最终证据统一位于`artifacts/layered-observation/release-complete/`，results.json的18个门禁全部退出0。全量590/590（63文件）、兼容93/93；构建、CLI、原生canvas、46 Seam、Electron、打包、签名/fuses扫描、包内GUI与CLI、包内真实PDF全部通过。源码/包内GUI及PDF验收均连续3轮取消和队列完成。全依赖及生产依赖审计漏洞总数均0（当日锁定树，不代表未来永久无漏洞）。包内编译文件与当前产物逐字节一致。

同S1方法/Node22无观察p50=16.68ms、p95=21.80ms，对基线p95约-29.83%，低于34.168ms上限；采样RSS峰值366100480字节（约+24.33%，不隐藏增长）。实际DOM观察30次p95=2779.5ms，稳定取消37ms、未稳定取消28.8ms；该指标不是模型网络延迟或外部Office效果。详见comparison.json、observation-performance.json。

实际数据副本检查通过：原文件未修改、99个附件无缺失、4个模型及5个Skill配置保留；非空自定义MCP/Prompt由联合fixture补充验证。回退步骤见上文。本轮既有失败保留为诊断，不作为当前通过依据。完成状态为27/27，未自动归档、提交或覆盖生产安装。

## 后续版本

本文保留原版本验收事实。后续已完成通用上下文生命周期改造，最新包和验收见 `docs/CONTEXT_LIFECYCLE_RELEASE.md` 与 `docs/architecture/CONTEXT_LIFECYCLE_PLAN.md`；不将本文旧包作为最新交付。
