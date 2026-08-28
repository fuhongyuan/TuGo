<p align="center"><img src="assets/tugo-logo.png" width="144" alt="TuGo 图狗 Logo"></p>

<h1 align="center">TuGo · 图狗</h1>

<p align="center"><strong>让 AI 在画布上和你一起画，再把成果变成可编辑的 PPT。</strong></p>

<p align="center">本地优先的 AI 无限画布：AI 创建和修改图表，你继续直接编辑；圈选局部作为对话上下文，再导出可交付的 PowerPoint。</p>

<p align="center">
  <a href="README.md"><img alt="简体中文" src="https://img.shields.io/badge/语言-简体中文-E53935?style=for-the-badge"></a>
  <a href="README.en.md"><img alt="English" src="https://img.shields.io/badge/Language-English-2563EB?style=for-the-badge"></a>
</p>

<p align="center"><a href="docs/GETTING_STARTED.md">快速上手</a> · <a href="docs/CANVAS_AND_EXPORT.md">圈选与 PPT 教程</a> · <a href="docs/README.md">全部文档</a></p>

![在 TuGo 中，AI 根据提示在画布上生成可继续编辑的流程图](assets/readme/ai-creates-editable-canvas.png)

## 为什么是 TuGo

TuGo 不是只把文字变成一张图片，也不是只给图形编辑器加一个聊天框。它让 AI 和你工作在同一块可直接操作的画布上：你可以手工调整、选中局部让 AI 参考、再把画板里的多个区域变成一份可继续修改的演示文稿。

| 你真正保留的东西 | 在 TuGo 里的做法 |
| --- | --- |
| 可继续工作的图 | AI 创建的是画板中的形状、文字和连线；你可以继续拖动、编辑、分组和整理。 |
| 明确的上下文 | 框选一个或多个区域，加入聊天，让 AI 知道要参考或处理哪一部分。 |
| 可交付的结果 | 选定区域可导出 PNG、SVG、PDF、draw.io 或 PPTX；批量圈选时，每个区域是一页 PPT。 |

## 从提示到交付

### 1. 让 AI 在画布上开始

提出一个问题或任务，让 AI 创建流程图、架构图、思维导图或用于解释复杂主题的视觉结构。运行时会显示计划和进度；生成后仍是一块由你掌控的画板。

![AI 在画布任务中显示可见的执行计划和状态](assets/readme/agent-work-plan.png)

### 2. 圈定要继续讨论的部分

对一块或多块区域进行批量框选。可以把选区导出，也可以选择“添加到对话”，将它们作为本轮 AI 的显式参考，而不是重新描述整张图。

![批量导出面板同时提供导出格式和添加到对话操作](assets/readme/batch-export-and-chat-context.png)

### 3. 把画布带进真实交付流程

按页序框选多个区域后导出 PPTX，每个区域会成为一页。支持的形状、文字和连线会作为 PowerPoint 对象输出；导出前后都应检查字体、裁切、布局和事实内容。

![一张由 AI 完成并已导出 PPTX 的多区域画布](assets/readme/canvas-to-pptx.png)

## 核心能力

- **无限画布，直接编辑**：形状、便签、文字、图片、连线、分组、平移缩放、撤销和重做。
- **AI 协作画图**：连接自己的模型服务，让 AI 创建、修改和整理流程图、架构图与思维导图。
- **局部作为上下文**：单个或多个选区可加入对话，帮助 AI 聚焦当前部分；它表达编辑意图，不是绝对的修改边界。
- **批量导出为演示文稿**：批量框选按顺序生成多页 PPTX；也支持 PNG、JPEG、WebP、SVG、PDF 和 draw.io。
- **导入、项目与扩展**：支持 Mermaid 及 PlantUML、draw.io XML 的兼容子集；本地项目、文件夹、多会话、自动保存、版本快照、Skills 和外部 MCP 工具。

![圈选两个画板区域，为多页导出或对话引用作准备](assets/readme/batch-select-regions.png)

AI 不限于技术图：下面是根据“大明王朝如何覆亡”的提问生成的可编辑归因图。它展示的是产品的实际画布结果，不应替代史实核查。

![AI 将复杂历史主题整理为画布上的可编辑归因图](assets/readme/ai-explains-a-complex-topic.jpg)

## 参考图片，重画为可编辑图

如果本轮配置的是**支持视觉输入的模型**，可以将一张流程图截图、白板照片或场景图作为聊天附件，让 AI 用画板元素重画其结构。它不是把原图嵌进画布：目标是生成可继续移动、修改和导出的形状、文字与连线。

![视觉模型参考一张驾驶照片，并在右侧用可编辑画布元素复刻场景结构；所有车牌均已脱敏](assets/readme/vision-image-to-editable-canvas-redacted.png)

使用时请先在 **设置 → 模型** 确认模型支持视觉，再将图片作为聊天附件发送；仅把图片放入画布不会自动成为模型输入。可直接这样提示：`参考附件图片，在当前画板中用可编辑节点和连线重画其主要结构。无法辨认的内容标为“待确认”，不要猜测。`

上传前请先移除或遮挡车牌、面孔、证件、地址和商业机密等敏感信息。详细步骤见 [图片、圈选与 PPT 教程](docs/CANVAS_AND_EXPORT.md#将图片加入画布)。

## 快速开始

从本仓库的 **Releases** 页面下载与你的系统和架构匹配的安装包。没有安装包时，请从源码运行；GitHub 的 Source code ZIP 不是安装器。

首发桌面目标为 macOS 13+ Apple Silicon。源码提供 Windows x64 打包配置；Windows 安装包是否经过实机验证、是否签名，以每次 Release 的说明为准。当前不承诺 Intel Mac 或 Linux 桌面支持。

1. 打开 **设置 → 模型**，新增模型连接，填写模型标识、服务地址和 API Key，测试并保存。
2. 新建画板，在聊天框输入：`画一个订单处理流程图，包含下单、付款、库存检查、发货和退款分支。`
3. 用 **框选导出** 工具选定内容，选择 **添加到对话** 或一种导出格式。
4. 要生成多页 PPT：使用 **批量框选**，按页序圈出多个区域，选择 **导出 PPT**。

完整说明见 [快速上手](docs/GETTING_STARTED.md) 和 [图片、圈选与 PPT 教程](docs/CANVAS_AND_EXPORT.md)。

## 本地优先，也由你选择模型

画板、会话和附件存放在本机；你自行配置模型服务、模型标识与 API Key。调用外部模型、Web 或 MCP 工具时，相关提示词、对话、画板内容或附件可能发送到对应服务。**本地优先不等于数据永不离开设备。**

TuGo 不附带模型额度，也不是离线本地大模型。请在使用前阅读 [隐私说明](PRIVACY.md) 和 [备份与恢复](docs/DATA_RECOVERY.md)，并始终复核 AI 生成的事实、布局和导出结果。

## 从源码运行

需要 Node.js `25.2.1` 与 npm `11.6.2`（见 `.nvmrc`、`package.json`）：

```bash
npm ci
npm run dev
```

`npm run dev:web` 仅预览前端，不提供 Electron 的本地数据库、附件访问或 Agent Runtime，不能代替桌面使用。安装包用户不需要另装 Node.js 或 Python。

## 文档、贡献与许可

- [文档目录](docs/README.md)：上手、模型配置、圈选/PPT、FAQ 和数据恢复。
- [开发与架构](docs/DEVELOPMENT.md) · [打包手册](release-docs/PACKAGING.md) · [发布清单](docs/RELEASING.md) · [更新记录](CHANGELOG.md)。
- [贡献指南](CONTRIBUTING.md) · [问题反馈](SUPPORT.md) · [安全策略](SECURITY.md) · [已知限制](release-docs/KNOWN_LIMITATIONS.md)。

**TuGo 1.0.0 是首个公开版本**，采用 [Apache License 2.0](LICENSE)。项目归属见 [NOTICE](NOTICE)，第三方组件仍遵守各自许可证，详见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
