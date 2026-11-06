# 安全升级兼容决策

用户于2026-11-03批准完整升级范围。最终结果以release-complete日志、包哈希及执行记录为准。

| 组件 | 决策与兼容约束 |
| --- | --- |
| Electron | 43.8.6补丁，不跨到45；macOS源码/包内UI、取消与崩溃恢复重测 |
| Vite/React插件 | 8.x/6.x；独立Ajv校验器规范化CommonJS默认导出，保持CSP无eval |
| Vitest | 4.1.x安全版，支持声明的Node25；5.x元数据排除Node25，不盲目选latest |
| PDF.js | 6.5.x；清理归loadingTask，加载失败也finally销毁；原PDF文本与附件测试保持 |
| Mermaid | 12.2；自有DSL黄金样例、CLI导入与实际DOM连线回归保持 |
| PptxGenJS | 保留已发布4.0.1，定向修复image-size为2.0.4；禁止audit建议的无解释降级 |
| asar/universal/EJS | 4.x/3.x/7.x覆盖旧构建链；真实打包校验API，不只看audit |
| minimatch/glob | minimatch11；asar子glob14.0.3修复取消绕过，真实glob/asar打包和产物扫描验证 |
| 直接脚本依赖 | vite-node6/esbuild0.28.2显式声明，不再依赖Vitest/Vite偶然传递安装 |

安全审计覆盖全部依赖，不能只跑omit=dev。SVG消毒、Unicode校验边界、PNG尺寸读取、PDF文本、PPT与9类导出、包内CLI、源码/产物字节一致性均为门禁。没有自动降低审计阈值或删除绘图断言。

macOS arm64为本次发布范围；Windows安装包、像素完整性及外部Office呈现未因此声明通过。依赖审计零仅指当前公开报告，不保证未来无漏洞。打包仍为本地ad-hoc、未公证，不能声称Apple正式分发信任。

干净开发环境需使用Node25/npm11；先安装锁文件依赖，再按Electron新分发包提供的`node node_modules/electron/install.js`显式安装二进制（可配置官方兼容镜像）。本轮显式安装43.8.6并核对dist/version，不依赖残留旧Electron。普通安装包已包含Electron，不要求最终用户执行开发安装步骤。
