import { describe, expect, it } from 'vitest'
import { insertDslDocument, parseDrawIo, parseMermaid, parsePlantUml, toMermaid } from './dsl'
import { mermaidGoldenFixtures } from './mermaidGoldenFixtures'
import { emptyDocument } from '../types'

describe('DSL adapters', () => {
  it('keeps every advertised Mermaid grammar in the shared golden import corpus parseable', () => {
    for (const fixture of mermaidGoldenFixtures) {
      const board = parseMermaid(fixture.source)
      expect(board.elements.length).toBeGreaterThan(0)
      expect(board.elements.some(item => item.text === fixture.grammar)).toBe(false)
    }
  })
  it('inserts a DSL diagram without replacing existing board content or ids', () => {
    const current = {
      ...emptyDocument(),
      elements: [{ id: 'existing', kind: 'rectangle' as const, x: 20, y: 80, width: 160, height: 70, text: '已有内容', fill: '#fff', stroke: '#334155', strokeWidth: 2, fontSize: 16 }],
    }
    const imported = parseMermaid('flowchart LR\nA[导入 A] --> B[导入 B]')
    const merged = insertDslDocument(current, imported)

    expect(merged.elements).toHaveLength(3)
    expect(merged.elements.find(item => item.id === 'existing')?.text).toBe('已有内容')
    expect(merged.elements.filter(item => item.text.startsWith('导入')).every(item => item.id !== 'A' && item.id !== 'B')).toBe(true)
    expect(merged.edges).toHaveLength(1)
    expect(merged.edges[0].from).not.toBe('A')
    expect(merged.elements.find(item => item.text === '导入 A')!.x).toBeGreaterThan(180)
  })

  it('maps Mermaid nodes and edges to board objects', () => {
    const board = parseMermaid('flowchart LR\n%% tugo:palette vivid\nA[需求] -->|拆解| B{评审}\nB --> C((完成))')
    expect(board.elements).toHaveLength(3)
    expect(board.edges).toHaveLength(2)
    expect(board.paletteId).toBe('vivid')
    expect(toMermaid(board)).toContain('A -->|拆解| B')
  })

  it('keeps complete Mermaid labels, Chinese text and HTML line breaks', () => {
    const board = parseMermaid(`flowchart LR
      P[应用框架（第 5.3 节）] --> T[Effects（计算如何改环境）]
      T --> G[反应式共效果<br/>局部空间可组合性]
      G -.-> C[服务层<br/>一致性 · 转换]
      C --> N[结论：可用作结构化推理]`)
    expect(board.elements.map(item => item.text)).toEqual([
      '应用框架（第 5.3 节）', 'Effects（计算如何改环境）', '反应式共效果\n局部空间可组合性', '服务层\n一致性 · 转换', '结论：可用作结构化推理',
    ])
    expect(board.edges).toHaveLength(4)
  })

  it('renders Mermaid subgraphs as frames and expands chained and fan-in edges', () => {
    const board = parseMermaid(`%%{init: {"theme":"base"}}%%
flowchart LR
  subgraph Effects["可逆效果（时间维度）"]
    E1["变换 + 显式逆<br/>Γ → Γ × (Γ → Γ)"]
    E2["效应上下文 ∂Γ"]
    E3["track 追踪 · recover 恢复"]
    E4["效果独立性"]
  end
  subgraph Coeffects["反应式共效果（空间维度）"]
    C1["依赖上下文 Σ"]
    C2["规范 d + 满足谓词 σ ⊨ d"]
    C3["notify 三分类"]
    C4["隔离（realm）+ 拦截"]
  end
  subgraph Unify["上下文范式"]
    U1["统一上下文类型 Γ∞"]
    U2["观测等价 ≃ → 效果独立性"]
  end
  E1 --> E2 --> E3 --> E4
  C1 --> C2 --> C3 --> C4
  E4 & C4 --> U1 --> U2`)

    expect(board.elements.filter(item => item.kind === 'frame').map(item => item.text)).toEqual(['可逆效果（时间维度）', '反应式共效果（空间维度）', '上下文范式'])
    expect(board.elements.filter(item => item.kind === 'frame').every(item => !item.locked)).toBe(true)
    expect(board.elements.filter(item => item.kind !== 'frame')).toHaveLength(10)
    expect(board.elements.some(item => item.text === 'subgraph' || item.text === 'end')).toBe(false)
    expect(board.edges).toHaveLength(9)
    const e1 = board.elements.find(item => item.id === 'E1')!
    const e4 = board.elements.find(item => item.id === 'E4')!
    const c1 = board.elements.find(item => item.id === 'C1')!
    expect(e4.x).toBeGreaterThan(e1.x)
    expect(c1.y).toBeGreaterThan(e1.y)
    expect(board.edges.filter(edge => edge.to === 'U1').map(edge => edge.from).sort()).toEqual(['C4', 'E4'])
  })

  it('uses flowchart direction and grows cards for long Mermaid labels', () => {
    const board = parseMermaid(`flowchart TB
      P["Preservation<br/>规则保持注册表良构"]
      T["时间可组合性（全局）<br/>恢复精确性：累积器恰好撤出本纤维贡献<br/>终态恢复：卸载后状态=从未加载"]
      S["空间可组合性（全局）<br/>排序：依赖者先激活、提供者后卸载<br/>一致性：转换全程绑定同一解析"]
      G["Progress<br/>无死锁（守卫必释放）· 终止（有限步达静止）"]
      C["Confluence<br/>任意调度→同一静止状态<br/>= 按依赖序一次性静态装配的结果"]
      P --> T & S
      T & S --> G --> C
      C --> R["推论：Cordis 应用可当作静态装配来推理"]`)
    const node = (id: string) => board.elements.find(item => item.id === id)!
    expect(node('T').y).toBeGreaterThan(node('P').y)
    expect(node('S').y).toBe(node('T').y)
    expect(node('G').y).toBeGreaterThan(node('T').y)
    expect(node('C').y).toBeGreaterThan(node('G').y)
    expect(node('R').y).toBeGreaterThan(node('C').y)
    expect(node('T').height).toBeGreaterThan(92)
    expect(board.edges).toHaveLength(6)
  })

  it('keeps every subgraph member inside its own frame for TB diagrams', () => {
    const board = parseMermaid(`flowchart TB
      subgraph Core["Cordis 核心库"]
        E["ctx.effect"]
        C["ctx.set / ctx.get"]
        L["ctx.use → fiber"]
        A["ctx[key] Proxy"]
      end
      subgraph Loader["组件加载器"]
        D1["声明式配置树"]
        D2["配置对账 reconciliation"]
        D3["热模块替换 HMR"]
      end
      subgraph App["应用框架"]
        K["Koishi 聊天机器人框架"]
      end
      E & C --> L --> A
      A --> D1 --> D2 & D3
      D2 & D3 --> K`)
    const frames = new Map(board.elements.filter(item => item.kind === 'frame').map(item => [String(item.metadata?.mermaidSubgraph), item]))
    for (const element of board.elements.filter(item => item.groupId)) {
      const frame = frames.get(element.groupId!.replace(/^group_/, ''))!
      expect(element.x).toBeGreaterThanOrEqual(frame.x)
      expect(element.y).toBeGreaterThanOrEqual(frame.y)
      expect(element.x + element.width).toBeLessThanOrEqual(frame.x + frame.width)
      expect(element.y + element.height).toBeLessThanOrEqual(frame.y + frame.height)
    }
    expect(frames.get('App')!.y).toBeGreaterThan(frames.get('Loader')!.y)
  })

  it('parses Mermaid state diagrams without turning syntax into ordinary nodes', () => {
    const board = parseMermaid(`stateDiagram-v2
      direction LR
      [*] --> INACTIVE: O-Insert
      INACTIVE: INACTIVE(ζ)
      INACTIVE --> RELOADING: L-Begin<br/>依赖满足
      RELOADING: RELOADING(i, g, ω)
      RELOADING --> RELOADING: L-Iter<br/>迭代执行效果
      RELOADING --> ACTIVE: L-Finish<br/>全部效果已安装
      RELOADING --> UNLOADING: L-Divert（目标变化）/ L-Raise（失败）
      ACTIVE: ACTIVE(g, ω)
      ACTIVE --> UNLOADING: L-Leave<br/>目标变化，停止提供
      UNLOADING: UNLOADING(g, ω, ζ)
      UNLOADING --> INACTIVE: L-Unload<br/>守卫通过，应用累积器
      UNLOADING --> RELOADING: 卸载后目标仍非⊥（惯性链式）
      INACTIVE --> [*]: O-Remove`)
    const normal = board.elements.filter(item => !item.metadata?.mermaidStatePseudo)
    expect(normal.map(item => item.text)).toEqual(['INACTIVE(ζ)', 'RELOADING(i, g, ω)', 'ACTIVE(g, ω)', 'UNLOADING(g, ω, ζ)'])
    expect(board.elements.some(item => item.text === 'stateDiagram-v2' || item.text === 'direction' || item.text === '[*]')).toBe(false)
    expect(board.elements.filter(item => item.metadata?.mermaidStatePseudo)).toHaveLength(2)
    expect(board.edges).toHaveLength(9)
    expect(board.edges.find(item => item.from === 'RELOADING' && item.to === 'RELOADING')?.label).toBe('L-Iter\n迭代执行效果')
    expect(normal[1].x).toBeGreaterThan(normal[0].x)
  })

  it('keeps named and composite Mermaid state declarations as states', () => {
    const board = parseMermaid(`stateDiagram-v2
      [*] --> Idle
      state "等待输入" as Idle
      state Processing {
        [*] --> Work
      }
      Idle --> Processing`)
    expect(board.elements.map(item => item.text)).toEqual(expect.arrayContaining(['等待输入', 'Processing', 'Work']))
    expect(board.elements.some(item => item.text === 'state')).toBe(false)
  })

  it('imports sequence diagrams as participants, lifelines and timed messages', () => {
    const board = parseMermaid(`sequenceDiagram
      autonumber
      participant U as 用户 / Web 客户端
      participant G as API 网关
      participant A as 认证服务
      U->>G: POST /login 用户名与密码
      G->>A: 转发登录请求
      A-->>G: 返回 Access Token
      G->>G: 写入审计日志`)
    const participants = board.elements.filter(item => item.metadata?.mermaidSequenceParticipant)
    const messages = board.edges.filter(edge => edge.metadata?.mermaidSequenceMessage)
    expect(participants.map(item => item.text)).toEqual(['用户 / Web 客户端', 'API 网关', '认证服务'])
    expect(board.elements.some(item => item.text === 'participant' || item.text === 'autonumber')).toBe(false)
    expect(board.edges.filter(edge => edge.metadata?.mermaidSequenceLifeline)).toHaveLength(3)
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ from: '', to: '', label: '1. POST /login 用户名与密码', arrowEnd: true })
    expect(messages[2].strokeStyle).toBe('dashed')
    expect(messages[3].routing).toBe('curve')
  })

  it('accepts JSON-style literal newlines and keeps free sequence edges on insertion', () => {
    const source = 'sequenceDiagram\\n  autonumber\\n  participant U as 用户\\n  participant G as 网关\\n  U->>G: 登录\\n  G-->>U: 成功'
    const imported = parseMermaid(source)
    expect(imported.elements.filter(item => item.metadata?.mermaidSequenceParticipant)).toHaveLength(2)
    expect(imported.edges.filter(edge => edge.metadata?.mermaidSequenceMessage)).toHaveLength(2)
    const inserted = insertDslDocument(emptyDocument(), imported)
    expect(inserted.edges.filter(edge => edge.metadata?.mermaidSequenceLifeline)).toHaveLength(2)
    expect(inserted.edges.filter(edge => edge.metadata?.mermaidSequenceMessage)).toHaveLength(2)
    expect(inserted.edges.every(edge => !edge.freeStart || (Number.isFinite(edge.freeStart.x) && Number.isFinite(edge.freeStart.y)))).toBe(true)
  })

  it('uses horizontal subgraphs named as lanes as a readable swimlane diagram', () => {
    const board = parseMermaid(`flowchart LR
      subgraph C[客户端泳道]
        C1[用户提交订单]
        C2[展示下单结果]
      end
      subgraph G[网关泳道]
        G1[API 网关]
        G2[认证与限流]
      end
      subgraph S[业务服务泳道]
        S1[订单服务]
        S2[校验库存与价格]
        S3[创建订单]
      end
      C1 --> G1 --> G2 --> S1 --> S2
      S2 --> S3
      S3 --> C2`)
    const frames = board.elements.filter(item => item.kind === 'frame')
    expect(frames.map(item => item.text)).toEqual(['客户端泳道', '网关泳道', '业务服务泳道'])
    expect(frames[1].x).toBeGreaterThan(frames[0].x)
    expect(frames[2].x).toBeGreaterThan(frames[1].x)
    const c1 = board.elements.find(item => item.id === 'C1')!
    const c2 = board.elements.find(item => item.id === 'C2')!
    const g1 = board.elements.find(item => item.id === 'G1')!
    expect(c2.y).toBeGreaterThan(c1.y)
    expect(g1.x).toBeGreaterThan(c1.x)
    for (const element of board.elements.filter(item => item.groupId)) {
      const frame = frames.find(item => item.id === element.groupId)!
      expect(element.x).toBeGreaterThanOrEqual(frame.x)
      expect(element.x + element.width).toBeLessThanOrEqual(frame.x + frame.width)
      expect(element.y).toBeGreaterThanOrEqual(frame.y)
      expect(element.y + element.height).toBeLessThanOrEqual(frame.y + frame.height)
    }
  })

  it('maps every Mermaid 11 diagram grammar to its own editable visual model', () => {
    const samples: Array<[string, string]> = [
      ['classDiagram', 'class User {\n+name\n+login()\n}\nUser <|-- Admin'],
      ['erDiagram', 'USER ||--o{ ORDER : places'],
      ['journey', 'section 登录\n访问首页: 5: 用户\n输入密码: 2: 用户'],
      ['gantt', 'section 发布\n开发: done, d1, 2026-01-01, 3d'],
      ['pie', '"已完成": 80\n"待处理": 20'],
      ['gitGraph', 'commit id: "init"\nbranch feature\ncheckout feature\ncommit id: "work"'],
      ['mindmap', 'root((主题))\n  子主题\n    细节'],
      ['timeline', '2026-01 : 立项\n2026-02 : 发布'],
      ['quadrantChart', 'x-axis 低 --> 高\ny-axis 低 --> 高\nA: [0.3, 0.8]'],
      ['requirementDiagram', 'requirement login {\n id: 1\n text: 登录\n}'],
      ['kanban', 'Todo\n  [任务 A]\nDone\n  [任务 B]'],
      ['xychart-beta', 'x-axis [A, B]\nbar [1, 2]'],
      ['sankey-beta', 'A,B,10\nA,C,5'],
      ['architecture-beta', 'service api(server)[API]\nservice db(database)[DB]\napi --> db'],
      ['block-beta', 'columns 2\na b\nc d'],
      ['packet-beta', '0-7: "Header"\n8-15: "Type"'],
      ['radar', 'axis Speed, 0, 100\naxis Quality, 0, 100\ncurve A { 80, 60 }'],
      ['treemap', 'root\n  branch\n    leaf'],
      ['C4Context', 'Person(user, "用户")\nSystem(app, "应用")\nRel(user, app, "使用")'],
      ['C4Container', 'Container(api, "API")'],
      ['C4Component', 'Component(service, "服务")'],
      ['C4Dynamic', 'Rel(user, api, "请求")'],
      ['C4Deployment', 'Deployment_Node(server, "服务器")'],
      ['zenuml', 'A->B: hello'],
    ]
    for (const [grammar, body] of samples) {
      const board = parseMermaid(`${grammar}\n${body}`)
      expect(board.elements.some(item => item.metadata?.mermaidDiagram === grammar)).toBe(true)
      expect(board.elements.some(item => item.text === grammar)).toBe(false)
      // A special grammar must never degrade into the old source-line grid.
      const cards = board.elements.filter(item => !item.metadata?.mermaidTitle && item.kind !== 'text')
      expect(cards.length).toBeGreaterThan(0)
    }

    const classBoard = parseMermaid('classDiagram\nclass User {\n+name\n}\nUser <|-- Admin')
    expect(classBoard.elements.find(item => item.text.startsWith('User'))?.text).toContain('name')
    expect(classBoard.edges).toHaveLength(1)
    const journey = parseMermaid('journey\nsection 登录\n访问首页: 5: 用户')
    expect(journey.elements.some(item => item.metadata?.mermaidJourneyStage)).toBe(true)
    const gantt = parseMermaid('gantt\nsection 发布\n开发: done, d1, 2026-01-01, 3d')
    expect(gantt.elements.some(item => item.metadata?.mermaidGanttAxis)).toBe(true)
    const timeline = parseMermaid('timeline\n2026-01 : 立项\n2026-02 : 发布')
    expect(timeline.edges.some(edge => edge.metadata?.mermaidTimelineAxis)).toBe(true)
    const quadrant = parseMermaid('quadrantChart\nx-axis 低 --> 高\nA: [0.3, 0.8]')
    expect(quadrant.edges.filter(edge => edge.from === '' && edge.to === '')).toHaveLength(2)
    const sankey = parseMermaid('sankey-beta\nA,B,10\nA,C,5')
    expect(sankey.edges.map(edge => edge.strokeWidth).sort((a, b) => b - a)[0]).toBeGreaterThan(2)
    const kanban = parseMermaid('kanban\nTodo\n  [任务 A]\nDone\n  [任务 B]')
    expect(kanban.elements.filter(item => item.metadata?.mermaidKanbanColumn)).toHaveLength(2)
    const mindmap = parseMermaid('mindmap\nroot((主题))\n  子主题\n    细节')
    expect(mindmap.edges).toHaveLength(2)
  })

  it('unwraps JSON-wrapped mindmap payloads instead of importing JSON keys as cards', () => {
    const wrapped = JSON.stringify({
      source: 'mindmap',
      root: 'Agent Harness 系统设计',
      children: [
        { title: '1. 基础分层', children: [{ title: 'L1' }, { title: 'L2' }, { title: 'L3' }] },
        { title: '2. 工具层', children: [{ title: 'T0' }, { title: 'T1' }] },
      ],
    })
    const board = parseMermaid(wrapped)
    expect(board.elements.some(item => item.text.includes('source:'))).toBe(false)
    expect(board.elements.find(item => item.text === 'Agent Harness 系统设计')?.kind).toBe('ellipse')
    expect(board.elements.map(item => item.text)).toContain('L3')
    expect(board.edges).toHaveLength(7)
  })

  it('forgives unindented numbered mindmap branches and balances them around the root', () => {
    const board = parseMermaid(`mindmap
  root((Agent Harness 压测测试用例设计))
1. 瞬时算力要求
   L1 低算力：单轮聊天 / 短上下文
   L2 中算力：多轮对话 / 中等上下文
2. 工具调用负载
   T0 无工具：仅模型生成
   T1 轻工具：1 次调用 / 快速返回
3. 沙箱依赖
   S0 不依赖沙箱：纯服务端执行
4. 任务并发数量
   C1 基线并发：1 / 低并发`)
    const root = board.elements.find(item => item.text === 'Agent Harness 压测测试用例设计')!
    const compute = board.elements.find(item => item.text === '1. 瞬时算力要求')!
    const tools = board.elements.find(item => item.text === '2. 工具调用负载')!
    const l1 = board.elements.find(item => item.text.startsWith('L1 低算力'))!
    expect(root.kind).toBe('ellipse')
    expect(compute.x).toBeLessThan(root.x)
    expect(tools.x).toBeGreaterThan(root.x)
    expect(l1.x).toBeLessThan(compute.x)
    expect(board.edges).toHaveLength(10)
    expect(board.edges.every(edge => edge.endArrow === 'none' && edge.routing === 'curve')).toBe(true)
  })

  it('keeps advanced Mermaid structures semantic instead of flattening them into source rows', () => {
    const architecture = parseMermaid(`architecture-beta
      group cloud(cloud)[云端]
      service api(server)[API] in cloud
      service db(database)[数据库] in cloud
      api:R --> L:db: 查询`)
    expect(architecture.elements.some(item => item.text === '云端' && item.kind === 'frame')).toBe(true)
    expect(architecture.elements.map(item => item.text)).toEqual(expect.arrayContaining(['API', '数据库']))
    expect(architecture.edges[0]).toMatchObject({ label: '查询' })

    const treemap = parseMermaid(`treemap-beta
      产品
        增长: 60
        平台
          运行时: 25
          画布: 15`)
    const product = treemap.elements.find(item => item.text === '产品')!
    const platform = treemap.elements.find(item => item.text === '平台')!
    expect(product.kind).toBe('frame')
    expect(platform.kind).toBe('frame')
    expect(platform.x).toBeGreaterThanOrEqual(product.x)
    expect(treemap.elements.some(item => item.text.includes('增长\n60'))).toBe(true)

    const radar = parseMermaid(`radar
      axis 质量, 0, 100
      axis 速度, 0, 100
      axis 成本, 0, 100
      curve 当前 { 90, 55, 70 }`)
    expect(radar.elements.filter(item => item.metadata?.mermaidRadarCurve === '当前')).toHaveLength(3)
    expect(radar.edges.filter(edge => edge.metadata?.mermaidRadarCurve === '当前')).toHaveLength(3)

    const requirements = parseMermaid(`requirementDiagram
      functionalRequirement login {
        id: R1
        text: 用户登录
      }
      requirement audit {
        id: R2
        text: 记录审计
      }
      login - traces -> audit`)
    expect(requirements.elements.some(item => item.text.includes('用户登录'))).toBe(true)
    expect(requirements.edges[0]).toMatchObject({ label: 'traces' })
  })

  it('renders pie and XY diagrams as charts rather than a list of value cards', () => {
    const pie = parseMermaid('pie\n"完成": 80\n"处理中": 20')
    expect(pie.elements.filter(item => item.metadata?.mermaidPieSlice)).toHaveLength(2)
    expect(pie.elements.filter(item => item.metadata?.mermaidPieSlice).every(item => item.width === 278 && item.text === '')).toBe(true)
    const xy = parseMermaid('xychart-beta\nx-axis [一月, 二月, 三月]\nbar [12, 28, 20]\nline [16, 18, 31]')
    expect(xy.elements.filter(item => item.metadata?.mermaidXyLabel)).toHaveLength(3)
    expect(xy.elements.filter(item => item.metadata?.mermaidXyPoint)).toHaveLength(3)
    expect(xy.edges.filter(edge => edge.metadata?.mermaidXyLine)).toHaveLength(2)
  })

  it('renders Gantt sections and Git branches as time-oriented visual structures', () => {
    const gantt = parseMermaid(`gantt
      section 开发
      设计: done, d1, 2026-01-01, 2d
      实现: active, d2, 2026-01-03, 4d
      section 发布
      灰度: 2026-01-06, 2d`)
    expect(gantt.elements.filter(item => item.metadata?.mermaidGanttSection)).toHaveLength(2)
    expect(gantt.elements.filter(item => item.text === '实现')[1].x).toBeGreaterThan(gantt.elements.filter(item => item.text === '设计')[1].x)
    const git = parseMermaid(`gitGraph
      commit id: "init"
      branch feature
      checkout feature
      commit id: "work"
      checkout main
      commit id: "release"
      merge feature`)
    expect(git.elements.filter(item => item.metadata?.mermaidGitBranch)).toHaveLength(2)
    expect(git.elements.filter(item => item.metadata?.mermaidGitRail)).toHaveLength(2)
    expect(git.edges.some(edge => edge.label === 'merge')).toBe(true)
  })

  it('renders C4 people, systems and boundaries with their native visual hierarchy', () => {
    const c4 = parseMermaid(`C4Container
      Person(user, "用户")
      System_Boundary(app, "业务系统") {
        Container(api, "API")
        ContainerDb(db, "数据库")
      }
      Rel(user, api, "调用")
      Rel(api, db, "读取")`)
    expect(c4.elements.find(item => item.text === '用户')?.kind).toBe('actor')
    expect(c4.elements.some(item => item.text === '业务系统' && item.metadata?.mermaidC4Boundary)).toBe(true)
    expect(c4.elements.find(item => item.text === '数据库')?.kind).toBe('database')
    expect(c4.edges).toHaveLength(2)
  })

  it('maps PlantUML style DSL', () => {
    const board = parsePlantUml('@startuml\ncomponent "客户端" as app\ncomponent "服务" as api\napp --> api : HTTP\n@enduml')
    expect(board.elements.map(item => item.text)).toEqual(['客户端', '服务'])
    expect(board.edges[0].label).toBe('HTTP')
  })

  it('keeps a draw.io XML adapter', () => {
    const board = parseDrawIo('<mxGraphModel><root><mxCell id="a" vertex="1" value="A"><mxGeometry x="1" y="2" width="120" height="60"/></mxCell></root></mxGraphModel>')
    expect(board.elements[0]).toMatchObject({ id: 'a', text: 'A', x: 1, y: 2 })
  })

  it('round-trips TuGo visual styles through Mermaid DSL', () => {
    const board = parseMermaid('flowchart LR\nA[开始] --> B[完成]')
    board.paletteId = 'nature'
    board.elements[0] = { ...board.elements[0], kind: 'hexagon', width: 240, fill: '#FDE2E4', stroke: '#C96D75', strokeWidth: 4, strokeStyle: 'dotted', fillOpacity: .65, zIndex: 8, fontSize: 22, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'top', groupId: 'group_1', locked: true }
    board.edges[0] = { ...board.edges[0], stroke: '#7C6CF2', strokeWidth: 3, strokeStyle: 'dashed', startArrow: 'circle', endArrow: 'diamond', routing: 'elbow', controlPoints: [{ x: 260, y: 100 }, { x: 260, y: 260 }], opacity: .7 }
    const restored = parseMermaid(toMermaid(board))
    expect(restored.elements[0]).toMatchObject({ kind: 'hexagon', width: 240, fill: '#FDE2E4', strokeStyle: 'dotted', fillOpacity: .65, zIndex: 8, fontSize: 22, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'top', groupId: 'group_1', locked: true })
    expect(restored.paletteId).toBe('nature')
    expect(restored.edges[0]).toMatchObject({ stroke: '#7C6CF2', strokeStyle: 'dashed', startArrow: 'circle', endArrow: 'diamond', routing: 'elbow', controlPoints: [{ x: 260, y: 100 }, { x: 260, y: 260 }], opacity: .7 })
  })

  it('reads draw.io shape and connector styles', () => {
    const board = parseDrawIo('<mxGraphModel><root><mxCell id="a" vertex="1" value="DB" style="shape=cylinder3;fillColor=FDE2E4;strokeColor=C96D75;strokeWidth=3;dashed=1;fillOpacity=50"><mxGeometry width="120" height="80"/></mxCell><mxCell id="b" vertex="1" value="B"><mxGeometry x="200" width="120" height="80"/></mxCell><mxCell id="e" edge="1" source="a" target="b" style="edgeStyle=orthogonalEdgeStyle;endArrow=diamond;strokeWidth=4"/></root></mxGraphModel>')
    expect(board.elements[0]).toMatchObject({ kind: 'database', fill: '#FDE2E4', stroke: '#C96D75', strokeWidth: 3, strokeStyle: 'dashed', fillOpacity: .5 })
    expect(board.edges[0]).toMatchObject({ routing: 'elbow', endArrow: 'diamond', strokeWidth: 4 })
  })
})
