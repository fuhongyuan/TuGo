/**
 * Canonical Mermaid import corpus.  Keep one minimal valid example for every
 * grammar TuGo claims to translate into editable native canvas objects.
 * Parser, UI-import and future visual-golden suites must consume this list.
 */
export const mermaidGoldenFixtures: Array<{ grammar: string; source: string }> = [
  { grammar: 'flowchart', source: 'flowchart LR\nA[开始] --> B{判断}\nB --> C[完成]' },
  { grammar: 'sequenceDiagram', source: 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: 请求\nB-->>A: 响应' },
  { grammar: 'stateDiagram-v2', source: 'stateDiagram-v2\n[*] --> Idle\nIdle --> Done\nDone --> [*]' },
  { grammar: 'classDiagram', source: 'classDiagram\nclass User {\n+name\n+login()\n}\nUser <|-- Admin' },
  { grammar: 'erDiagram', source: 'erDiagram\nUSER ||--o{ ORDER : places' },
  { grammar: 'journey', source: 'journey\nsection 登录\n访问首页: 5: 用户' },
  { grammar: 'gantt', source: 'gantt\nsection 发布\n开发: done, d1, 2026-01-01, 3d' },
  { grammar: 'pie', source: 'pie\n"已完成": 80\n"待处理": 20' },
  { grammar: 'gitGraph', source: 'gitGraph\ncommit id: "init"\nbranch feature\ncheckout feature\ncommit id: "work"' },
  { grammar: 'mindmap', source: 'mindmap\nroot((主题))\n  子主题\n    细节' },
  { grammar: 'timeline', source: 'timeline\n2026-01 : 立项\n2026-02 : 发布' },
  { grammar: 'quadrantChart', source: 'quadrantChart\nx-axis 低 --> 高\ny-axis 低 --> 高\nA: [0.3, 0.8]' },
  { grammar: 'requirementDiagram', source: 'requirementDiagram\nrequirement login {\n id: 1\n text: 登录\n}' },
  { grammar: 'kanban', source: 'kanban\nTodo\n  [任务 A]\nDone\n  [任务 B]' },
  { grammar: 'xychart-beta', source: 'xychart-beta\nx-axis [A, B]\nbar [1, 2]' },
  { grammar: 'sankey-beta', source: 'sankey-beta\nA,B,10\nA,C,5' },
  { grammar: 'architecture-beta', source: 'architecture-beta\nservice api(server)[API]\nservice db(database)[DB]\napi --> db' },
  { grammar: 'block-beta', source: 'block-beta\ncolumns 2\na b\nc d' },
  { grammar: 'packet-beta', source: 'packet-beta\n0-7: "Header"\n8-15: "Type"' },
  { grammar: 'radar', source: 'radar\naxis Speed, 0, 100\naxis Quality, 0, 100\ncurve A { 80, 60 }' },
  { grammar: 'treemap', source: 'treemap\nroot\n  branch\n    leaf' },
  ...['C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment'].map(grammar => ({ grammar, source: `${grammar}\nPerson(user, "用户")\nSystem(app, "应用")\nRel(user, app, "使用")` })),
  { grammar: 'zenuml', source: 'zenuml\nA->B: hello' },
]
