import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InfiniteCanvas } from '../src/components/InfiniteCanvas'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMermaid } from '../src/lib/dsl'
import { renderRegionSvg } from '../src/lib/exportDocument'

const root = await mkdtemp(join(tmpdir(), 'tugo-mermaid-layout-'))
const samples = {
  flow: `flowchart LR
subgraph input[输入与校验]
A[用户请求] --> B{校验通过?}
end
subgraph core[处理服务]
C[任务规划] --> D[执行任务]
C --> E[并行检索]
D --> F[汇总结果]
E --> F
end
subgraph output[交付]
G[生成报告] --> H[完成]
end
B -->|通过| C
B -->|失败| I[返回错误]
F --> G`,
  state: 'stateDiagram-v2\ndirection LR\n[*] --> Idle\nIdle --> Running: 启动\nRunning --> Waiting: 等待输入\nWaiting --> Running: 继续\nRunning --> Failed: 失败\nFailed --> Idle: 重试\nRunning --> Done: 完成\nDone --> [*]',
  entity: 'classDiagram\nclass Request {\n+id: string\n+payload: string\n}\nclass Agent\nclass Tool\nclass Result\nRequest --> Agent\nAgent --> Tool\nTool --> Result\nAgent --> Result',
}
for (const [name, source] of Object.entries(samples)) {
  const document = parseMermaid(source)
  const width = Math.max(...document.elements.map(element => element.x + element.width), ...document.edges.flatMap(edge => (edge.controlPoints || []).map(point => point.x))) + 96
  const height = Math.max(...document.elements.map(element => element.y + element.height), ...document.edges.flatMap(edge => (edge.controlPoints || []).map(point => point.y))) + 96
  await writeFile(join(root, `${name}.svg`), renderRegionSvg(document, { x: 0, y: 0, width, height }))
  const zoom = Math.min(1, 1500 / width, 780 / height)
  document.viewport = { x: 30, y: 60, zoom }
  const noop = () => {}
  const markup = renderToStaticMarkup(React.createElement(InfiniteCanvas, { document, onCommit: noop, onUndo: noop, onRedo: noop, canUndo: false, canRedo: false, selectedIds: [], onSelect: noop, onExportRegion: noop, onBatchExportRegions: noop, onAddImage: noop, onDropImages: noop, onAddToChat: noop }))
  await writeFile(join(root, `${name}.html`), `<html data-theme="light"><style>${await readFile('src/styles.css', 'utf8')}html,body{margin:0;width:100%;height:100%}.canvas-shell{height:100vh}</style>${markup}</html>`)
}
console.log(root)
