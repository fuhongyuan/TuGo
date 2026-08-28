# 开发与架构

[文档目录](README.md) · [贡献指南](../CONTRIBUTING.md)

## 本地启动

使用 Node.js 25.2.1、npm 11.6.2，在源码根目录运行：

```bash
npm ci
npm run dev
```

`npm run dev:web` 仅预览前端，不提供完整 Electron/Runtime 能力。开发和安装版的数据目录应分别使用，不要用唯一真实数据副本测试迁移。

## 结构

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx` | 项目、画板、聊天、设置状态 |
| `src/components/` | SVG 画布、属性面板、导出界面 |
| `src/lib/` | 几何、DSL、文档导出、运行状态展示 |
| `src/i18n.ts`、`src/i18nContext.tsx` | 界面词条与语言上下文 |
| `electron/` | 窗口、IPC、本地数据、附件和 Runtime 托管 |
| `runtime-ts/src/` | Agent、Provider、MCP、工具与数据库 |
| `templates/` | Runtime 默认配置和 Skill 资源 |
| `assets/` | 图狗 Logo 与图标 |
| `scripts/` | 开发、测试、打包与发布辅助 |

`BoardDocument` 保存元素、连线、DSL 与视口。Renderer 使用 Electron bridge；Agent Runtime 在 Worker 中运行，以 IPC 交换事件与画板操作，不开放本地 HTTP 服务。

## 测试入口

| 命令 | 用途 |
| --- | --- |
| `npm run build` | TypeScript、Runtime 与 Vite 构建 |
| `npm test` | 单元及 Runtime 测试 |
| `npm run test:compat` | Provider/MCP/Runtime 协议测试 |
| `npm run test:electron` | 隔离桌面 E2E，会启动 Electron |
| `npm run test:visual` | PPTX 视觉检查，需要 LibreOffice |
| `npm run test:scale` | 规模基准 |
| `npm run verify:release` | 全部源码门禁 |
| `npm run verify:package` | macOS ZIP 打包、扫描及打包态 E2E |

视觉检查可用 `SOFFICE` 环境变量指定 LibreOffice 路径。测试需要的 GUI 和回环网络能力应在运行环境中可用。

测试存在不等于当前提交已通过。PR 与发布说明必须记录实际结果，未运行或失败的门禁不能标记为已验证。

按 [发布清单](RELEASING.md) 验证最终提交与产物；文档整理本身不推送代码或创建 Release。
