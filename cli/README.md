# TuGo CLI

CLI 和桌面应用共用同一份数据、画布编辑器、导入器和快照服务。需要本机 TuGo 正在运行，以及 Node.js 18+。不使用 TuGo 中配置的 LLM：调用者（例如 Codex）生成 DSL 或编辑操作，TuGo 执行。

## 安装与 Codex

从源码运行：`node cli/tugo.cjs --help`。

安装包内的 CLI 位于 macOS `TuGo.app/Contents/Resources/cli`。安装后可执行：

```sh
node /Applications/TuGo.app/Contents/Resources/cli/install.cjs
```

安装器将命令放在 `~/.local/bin`，将自包含 Skill 放在 `${CODEX_HOME:-~/.codex}/skills/tugo-draw`。不会修改 Codex 配置、安装 Node 或覆盖现有文件；覆盖需 `--force`。可以用 `--bin-dir` 和 `--skill-dir` 自定义路径。不在 PATH 时用安装器输出的绝对路径调用。Windows 安装器生成 `tugo.cmd`。

重新开启 Codex 任务后使用 `$tugo-draw`，或直接告诉 Codex 用该 CLI。CLI 是由 Codex 的终端能力调用，不是假装注册成 MCP。也可以把 `cli/skills/tugo-draw` 加上 `scripts/tugo.cjs` 复制到自己的技能目录。[OpenAI 官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills)。

## 命令

运行 `tugo --help` 查看选项，`tugo schema` 获取批量操作的 JSON Schema。所有命令支持 `--json '{...}'` 或 `--json -`（stdin）。输出为 JSON；错误退出码为 1。文件夹使用 `--id`，画板使用 `--project`，快照额外使用 `--snapshot`。画板就是应用中的“文件/项目”。

| 命令 | 主要参数 |
| --- | --- |
| `status`, `schema` | 无 |
| `folders list/create/rename/remove` | create: name；rename: id,name；remove: id,confirm |
| `projects list/create/get/rename/move/open/remove` | create: name,可选 folder；其他: project；rename: name；move: folder（null 表示根目录）；remove: confirm |
| `board get/review/undo/redo` | project；undo/redo 仅限当前打开的画板 |
| `board apply` | project,operations，或 `--file operations.json`；可选 ifRevision |
| `board import` | project,format,content，或 `--file PATH`；默认追加，replace:true 需 confirm:true |
| `board export` | project,format，可选 region:{x,y,width,height}；必须 `--out PATH` |
| `snapshots create/list/get/remove` | project；create:name；list:source（user/agent）,page；get/remove:snapshot；remove:confirm |
| `snapshots restore` | project,snapshot,confirm；自动保存恢复前快照 |
| `snapshots export/import` | export:project,snapshot,`--out PATH`；import:project,`--file PATH`，可选 name |

导入支持 mermaid、plantuml、drawio、json；输出支持 json、mermaid、drawio、svg、png、jpeg、webp、pdf、pptx。快照导入只添加快照记录，不会直接覆盖画板，需显式 restore。快照格式兼容桌面 `.tugo-snapshot`，包含图片附件；普通画板 JSON 只有图片引用。渲染格式使用现有导出器，其图形/图片兼容性与桌面导出一致。

```sh
tugo folders create --name 'Codex 图稿'
tugo projects create --name '系统架构' --folder FOLDER_ID
tugo board import --project PROJECT_ID --format mermaid --file architecture.mmd
tugo board get --project PROJECT_ID
tugo snapshots create --project PROJECT_ID --name '初版'
tugo board apply --project PROJECT_ID --if-revision REVISION --file changes.json
tugo board export --project PROJECT_ID --format png --out architecture.png
tugo snapshots export --project PROJECT_ID --snapshot SNAPSHOT_ID --out architecture.tugo-snapshot
```

`changes.json` 示例（对象 ID 从 board get 获取）：

```json
[
  {"op":"patch_element","id":"NODE_ID","patch":{"text":"API 网关","x":200,"y":100}},
  {"op":"patch_edge","id":"EDGE_ID","patch":{"label":"HTTPS"}}
]
```

批次最多 256 项，验证全部通过后才提交；绘图基础操作包括增删改节点和线、分组、取消分组、对齐、分布和调色板。插入会重映射 ID，所以每次导入后重新 get，不要猜测 ID。创建项目默认打开它（JSON `open:false` 可关闭此行为）。

## 一致性与安全

- 仅监听 `127.0.0.1` 随机端口，凭证写入当前用户数据目录 `cli-endpoint.json`，权限 0600；拒绝带 Origin 的网页请求，不暴露模型密钥或通用 IPC/SQL 接口。拥有该用户文件权限的本机进程可调用 CLI。
- macOS 默认使用 `~/Library/Application Support/TuGo`；开发版需指定 `--data-dir .../TuGo-Dev`。也可用 `TUGO_USER_DATA`。不自动搜遍多个资料库，避免误改。
- 命令排队执行；编辑期间若桌面数据改变，会返回 `REVISION_CONFLICT`。可主动携带 `--if-revision` 防止基于旧图编辑。此版本不是多人实时协作协议。
- 超时意味着执行结果可能未知。不要盲目换 request-id 重试修改。进程内最近 256 个请求支持相同 ID、相同参数重放；应用重启后失效。CLI 不自动重试写操作。
- 删除、恢复、替换需要 `--confirm`；文件导出默认拒绝覆盖，`--force` 才覆盖指定文件。文件夹删除将画板移到根目录。
- 退出 TuGo 后 CLI 不可用；打开窗口并等 `status` 返回 ready:true。远程/云端 Codex 无法直接访问这台电脑的 CLI。

## 测试

`npm test` 覆盖命令校验和导入。`npm run test:cli` 验证本机鉴权，并使用独立数据目录启动桌面应用，实际执行 CLI 全流程并重启确认持久化。不会读取或修改日常 TuGo 资料库。
