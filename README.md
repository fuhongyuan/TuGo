<p align="center"><img src="assets/tugo-logo.png" width="144" alt="TuGo 图狗 Logo"></p>

# TuGo · 图狗

**把想法画出来，再把画板变成可编辑的 PPT。**

TuGo 是本地优先的 AI 无限画布桌面应用。你可以手动画图，也可以让 AI 创建和修改图表；把画板上的区域圈起来加入对话，再导出图片、PDF 或 PowerPoint。

简体中文 · [English](README.en.md) · [使用文档](docs/README.md) · [快速上手](docs/GETTING_STARTED.md)

## 能做什么

- **画图与整理**：形状、便签、文字、图片、连线、分组、平移缩放、撤销与重做。
- **与画板对话**：连接自己的模型服务，让 AI 创建流程图、架构图、思维导图并继续修改。
- **圈选作为上下文**：将一个或多个画板区域添加到对话，明确告诉 AI 要处理哪里。
- **导出交付**：PNG、JPEG、WebP、SVG、PDF、PPTX 和 draw.io；批量圈选可将每个区域导出为一张 PPT 幻灯片。
- **导入已有图表**：Mermaid，以及 PlantUML、draw.io XML 的兼容子集。
- **本地工作空间**：项目、文件夹、多会话、自动保存、版本快照与数据库备份。
- **可扩展 AI**：多个模型连接、Skills 和外部 MCP 工具。
- **个性化**：主题、语言偏好和绘画游标，默认由图狗陪你创作。

> AI 需要你自行配置模型服务；服务可能收费。TuGo 不附带模型额度，也不是离线本地大模型。图表事实、布局和导出效果仍需人工检查。

## 安装与第一次使用

从本仓库 **Releases** 页面选择与你的系统和架构匹配的附件；没有附件时请从源码启动，不要把 GitHub 的 Source code ZIP 当成安装器。

首发桌面目标为 macOS 13+ Apple Silicon。源码提供 Windows x64 打包配置，但是否提供经实机验证的 Windows 安装包、签名和公证状态，以每次 Release 说明为准。当前不承诺 Intel Mac 或 Linux 桌面支持。

1. 启动后打开 **设置 → 模型**，新增模型连接，填写模型标识、服务地址和 API Key，测试并保存。
2. 新建画板，手动画几个节点，或在聊天框输入：
   > 画一个订单处理流程图，包含下单、付款、库存检查、发货和退款分支。
3. 选择 **框选导出** 工具，拖出区域，再选择 **添加到对话** 或导出格式。
4. 需要多页 PPT 时，使用 **批量框选**，按幻灯片顺序圈出多个区域，再选择 **导出 PPT**。

详见 [快速上手](docs/GETTING_STARTED.md) 和 [图片、圈选与 PPT 教程](docs/CANVAS_AND_EXPORT.md)。互动式新手教程暂未提供。

## 从源码运行

准备 Node.js `25.2.1` 和 npm `11.6.2`（版本约束见 `.nvmrc`、`package.json`）。通过仓库的 **Code** 菜单克隆或下载源码后，在项目根目录运行：

```bash
npm ci
npm run dev
```

最终用户运行安装包不需要另装 Node.js 或 Python。源码开发需要上述工具链。

`npm run dev:web` 仅预览前端，不提供 Electron 的本地数据库、附件访问及 Agent Runtime，不能代替桌面使用。

## 数据与隐私

画板、会话与附件保存在本机；调用外部模型、Web 或 MCP 工具时，相关提示词、对话、画板内容或附件可能发送给对应服务。**本地优先不等于数据永不出设备。**

当前凭据存放在本地加密文件中，**不是系统钥匙串，也不提供抵御本机账户被攻破的保护保证**。备份与日志仍可能包含私密内容。界面中的“导出完整备份”目前仅导出 App/Runtime 两个数据库，不包含附件和凭据，不是完整换机包。

请先阅读 [隐私说明](PRIVACY.md) 和 [备份与恢复](docs/DATA_RECOVERY.md)。

## 语言与已知限制

可以跟随系统或选择英语、简体中文、繁体中文、日语、韩语、西班牙语、法语、德语、巴西葡萄牙语、俄语。**翻译覆盖仍在完善**：已接入词条缺失时回退英文，部分工具栏、弹窗或运行提示可能仍显示中文。内置提示词按简中、繁中和英文分流。

不提供云同步、多人协作或 MCP OAuth 自动登录；第三方 DSL 和 PPTX 的复杂样式不保证无损往返。详见 [已知限制](release-docs/KNOWN_LIMITATIONS.md)。

## 文档与开发

- [文档目录](docs/README.md)：上手、配置、圈选/PPT、FAQ、数据恢复。
- [开发与架构](docs/DEVELOPMENT.md)：代码结构、测试、开发入口。
- [打包手册](release-docs/PACKAGING.md) · [发布清单](docs/RELEASING.md) · [更新记录](CHANGELOG.md)。
- [贡献指南](CONTRIBUTING.md) · [问题反馈](SUPPORT.md) · [安全策略](SECURITY.md)。

## 项目沿革与许可

**TuGo 1.0.0 是首个公开版本**。

本项目采用 [Apache License 2.0](LICENSE)。项目归属见 [NOTICE](NOTICE)，第三方组件仍遵守各自许可证，见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
