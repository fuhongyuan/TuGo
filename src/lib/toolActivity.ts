import type { ChatRunStatus } from '../types'

export type ToolActivityState = 'running' | 'completed'
export type ToolActivityDescriptor = {
  name: string
  phase: ChatRunStatus['phase']
  stage: string
  category: 'planning' | 'reading' | 'researching' | 'editing' | 'reviewing' | 'saving' | 'preparing' | 'external' | 'working'
  label: string
}

const object = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch { return {} }
  }
  return {}
}
const text = (value: unknown, limit = 140) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
const count = (value: unknown) => Array.isArray(value) ? value.length : 0
const completedPurpose = (purpose: string) => purpose
  .replace(/^(?:执行|操作)[:：]\s*/, '')
  .replace(/^正在/, '')
  .replace(/[。；;，,]+$/, '')

export const normalizeToolName = (toolName: string) => toolName
  .replace(/^mcp_[^_]+(?:_[^_]+)*_board_/, 'board_')
  .replace(/_[a-f0-9]{8}$/i, '')

const metaFor = (name: string, source = ''): Omit<ToolActivityDescriptor, 'name' | 'label'> & { running: string; completed: string } => {
  switch (name) {
    case 'board_get_state': return { phase: 'reading', category: 'reading', stage: '正在读取画板', running: '读取当前画板结构', completed: '已读取当前画板' }
    case 'board_query_elements': return { phase: 'reading', category: 'reading', stage: '正在定位画板内容', running: '查询相关图形和连线', completed: '已完成画板内容查询' }
    case 'board_create_snapshot': return { phase: 'waiting', category: 'saving', stage: '正在保存版本', running: '保存当前画板快照', completed: '已保存画板快照' }
    case 'board_list_snapshots': return { phase: 'reading', category: 'reading', stage: '正在查找历史版本', running: '查询画板历史快照', completed: '已读取历史快照列表' }
    case 'board_get_snapshot': return { phase: 'reading', category: 'reading', stage: '正在读取历史版本', running: '读取指定画板快照', completed: '已读取画板快照' }
    case 'board_review_quality': return { phase: 'reviewing', category: 'reviewing', stage: '正在检查画面质量', running: '检查布局、连线和文字可读性', completed: '已完成画面质量检查' }
    case 'board_capture_image': return { phase: 'reviewing', category: 'reviewing', stage: '正在生成画面预览', running: '截取画板画面', completed: '已生成画板截图' }
    case 'board_export_pptx': return { phase: 'finalizing', category: 'saving', stage: '正在生成 PPT', running: '整理页面并生成可编辑 PPT', completed: '已生成可下载的 PPT' }
    case 'board_batch': return { phase: 'editing', category: 'editing', stage: '正在批量修改画板', running: '执行一组画板修改', completed: '已完成画板编辑' }
    case 'board_patch_element': return { phase: 'editing', category: 'editing', stage: '正在调整图形', running: '修改画板元素或连线', completed: '已修改画板元素' }
    case 'board_patch_dsl': return { phase: 'editing', category: 'editing', stage: '正在插入图表', running: '插入并渲染 DSL 图形', completed: '已插入 DSL 图形' }
    case 'board_optimize_layout': return { phase: 'editing', category: 'editing', stage: '正在优化布局', running: '优化节点位置和连线路由', completed: '已完成布局优化' }
    case 'board_undo': return { phase: 'editing', category: 'editing', stage: '正在撤销修改', running: '撤销最近一次画板操作', completed: '已撤销画板操作' }
    case 'board_redo': return { phase: 'editing', category: 'editing', stage: '正在恢复修改', running: '重做最近一次画板操作', completed: '已重做画板操作' }
    case 'plan': return { phase: 'analyzing', category: 'planning', stage: '正在规划任务', running: '制定或更新执行计划', completed: '已更新执行计划' }
    case 'load_skill': return { phase: 'analyzing', category: 'preparing', stage: '正在准备专业能力', running: '加载所需 Skill', completed: '已加载所需 Skill' }
    case 'read_file': return { phase: 'reading', category: 'reading', stage: '正在读取附件', running: '读取导入文件', completed: '已读取导入文件' }
    case 'view_image': return { phase: 'reviewing', category: 'reviewing', stage: '正在查看图片', running: '查看图片附件', completed: '已查看图片附件' }
    case 'web_search': return { phase: 'researching', category: 'researching', stage: '正在搜索资料', running: '搜索相关网页资料', completed: '已完成网页搜索' }
    case 'web_fetch': return { phase: 'researching', category: 'researching', stage: '正在阅读资料', running: '读取参考网页', completed: '已读取参考网页' }
    default: return source === 'mcp'
      ? { phase: 'waiting', category: 'external', stage: '正在调用外部工具', running: name ? `调用 ${name}` : '调用外部工具', completed: name ? `${name} 已完成` : '外部工具已完成' }
      : { phase: 'waiting', category: 'working', stage: '正在执行操作', running: name ? `执行 ${name}` : '执行当前操作', completed: name ? `${name} 已完成` : '当前操作已完成' }
  }
}

const resultSuffix = (name: string, input: Record<string, unknown>, result: Record<string, unknown>) => {
  if (name === 'board_get_state') {
    const board = object(result.board || result)
    const elements = Number(board.element_count || count(board.elements) || count(board.nodes))
    const edges = Number(board.edge_count || count(board.edges))
    return elements || edges ? `（${elements} 个图形，${edges} 条连线）` : ''
  }
  if (name === 'board_query_elements') {
    const elements = Number(result.element_total || count(result.elements))
    const edges = Number(result.edge_total || count(result.edges))
    const total = Number(result.total || elements + edges)
    return total ? `（找到 ${total} 项：${elements} 个图形，${edges} 条连线）` : '（未找到匹配内容）'
  }
  if (name === 'board_create_snapshot') {
    const snapshotName = text(result.snapshot_name || input.name, 60)
    return snapshotName ? `「${snapshotName}」` : ''
  }
  if (name === 'board_list_snapshots') {
    const total = Number(result.total || count(result.items))
    return `（${total} 个版本）`
  }
  if (name === 'board_get_snapshot') {
    const snapshot = object(result.snapshot)
    const snapshotName = text(snapshot.name, 60)
    return snapshotName ? `「${snapshotName}」` : ''
  }
  if (name === 'board_review_quality') {
    const reflection = object(result.layout_reflection)
    const issues = Array.isArray(reflection.issues) ? reflection.issues.length : 0
    return reflection.checked === true ? issues ? `（发现 ${issues} 项建议）` : '（未发现明显问题）' : ''
  }
  if (name === 'board_capture_image') {
    const attachment = object(result.attachment)
    const fileName = text(attachment.name || result.file_name, 60)
    return fileName ? `「${fileName}」` : ''
  }
  if (name === 'board_export_pptx') {
    const attachment = object(result.attachment)
    const pages = Number(result.page_count || count(input.regions))
    const fileName = text(attachment.name || result.name, 60)
    return `${pages ? `（${pages} 页）` : ''}${fileName ? `「${fileName}」` : ''}`
  }
  if (name === 'board_batch') {
    const operations = Number(result.applied || result.operation_count || count(input.operations))
    return operations ? `（${operations} 项修改）` : ''
  }
  if (name === 'board_optimize_layout') {
    const operations = Number(result.applied || result.operation_count || count(result.operations))
    return operations ? `（调整 ${operations} 项）` : ''
  }
  if (name === 'board_patch_dsl') {
    const kind = text(input.kind, 20)
    return kind ? `（${kind}）` : ''
  }
  if (name === 'load_skill') {
    const skillName = text(result.skill_name || input.skill_name, 48)
    return skillName ? `「${skillName}」` : ''
  }
  if (name === 'web_search') {
    const results = count(result.results)
    return results ? `（找到 ${results} 条结果）` : ''
  }
  if (name === 'web_fetch' && result.truncated === true) return '（内容已截取）'
  if (name === 'plan') {
    const steps = count(input.steps)
    return steps ? `（${steps} 个步骤）` : ''
  }
  return ''
}

export const describeToolActivity = (options: {
  toolName: string
  source?: string
  input?: Record<string, unknown>
  result?: unknown
  purpose?: string
  state: ToolActivityState
}): ToolActivityDescriptor => {
  const name = normalizeToolName(options.toolName)
  const input = options.input || {}
  const result = object(options.result)
  const meta = metaFor(name, options.source)
  const purpose = text(options.purpose || input.description, 180)
  const label = options.state === 'running'
    ? purpose || meta.running
    : purpose
      ? `已完成：${completedPurpose(purpose)}${resultSuffix(name, input, result)}`
      : `${meta.completed}${resultSuffix(name, input, result)}`
  return { name, phase: meta.phase, stage: meta.stage, category: meta.category, label }
}

export const nextModelStage = (category?: ToolActivityDescriptor['category']) => {
  switch (category) {
    case 'planning': return '正在准备执行计划'
    case 'reading': return '正在分析读取结果'
    case 'researching': return '正在整理参考信息'
    case 'editing': return '正在检查画板修改'
    case 'reviewing': return '正在评估检查结果'
    case 'saving': return '正在继续处理画板'
    case 'preparing': return '正在应用专业能力'
    case 'external': return '正在处理外部工具结果'
    default: return '正在继续处理任务'
  }
}

/** Short category label used by the retained diagnostic/process timeline. */
export const toolPresentation = (toolName: string, source = '') => {
  const descriptor = describeToolActivity({ toolName, source, state: 'running' })
  return source === 'mcp' ? descriptor.label : descriptor.stage.replace(/^正在/, '')
}
