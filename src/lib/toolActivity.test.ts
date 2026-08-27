import { describe, expect, it } from 'vitest'
import { describeToolActivity, nextModelStage } from './toolActivity'

const builtinCases = [
  ['board_get_state', '正在读取画板', 'reading'],
  ['board_query_elements', '正在定位画板内容', 'reading'],
  ['board_create_snapshot', '正在保存版本', 'saving'],
  ['board_list_snapshots', '正在查找历史版本', 'reading'],
  ['board_get_snapshot', '正在读取历史版本', 'reading'],
  ['board_review_quality', '正在检查画面质量', 'reviewing'],
  ['board_capture_image', '正在生成画面预览', 'reviewing'],
  ['board_batch', '正在批量修改画板', 'editing'],
  ['board_patch_element', '正在调整图形', 'editing'],
  ['board_patch_dsl', '正在插入图表', 'editing'],
  ['board_optimize_layout', '正在优化布局', 'editing'],
  ['board_undo', '正在撤销修改', 'editing'],
  ['board_redo', '正在恢复修改', 'editing'],
  ['plan', '正在规划任务', 'planning'],
  ['load_skill', '正在准备专业能力', 'preparing'],
  ['read_file', '正在读取附件', 'reading'],
  ['view_image', '正在查看图片', 'reviewing'],
  ['web_search', '正在搜索资料', 'researching'],
  ['web_fetch', '正在阅读资料', 'researching'],
] as const

describe('tool activity registry', () => {
  it.each(builtinCases)('covers %s with a specific stage and category', (toolName, stage, category) => {
    const descriptor = describeToolActivity({ toolName, state: 'running' })
    expect(descriptor.stage).toBe(stage)
    expect(descriptor.category).toBe(category)
    expect(descriptor.label).not.toMatch(/执行 (?:board_|read_file|view_image|web_)/)
  })

  it('uses purpose for work and structured output for a useful completion', () => {
    const running = describeToolActivity({ toolName: 'board_query_elements', input: { description: '定位 API 网关相关连线' }, state: 'running' })
    const completed = describeToolActivity({ toolName: 'board_query_elements', input: { description: '定位 API 网关相关连线' }, result: { total: 7, element_total: 2, edge_total: 5 }, state: 'completed' })
    expect(running.label).toBe('定位 API 网关相关连线')
    expect(completed.label).toBe('已完成：定位 API 网关相关连线（找到 7 项：2 个图形，5 条连线）')
  })

  it('keeps external MCP tools identifiable and never exposes a generic builtin name', () => {
    const running = describeToolActivity({ toolName: 'company_lookup', source: 'mcp', purpose: '查询客户档案', state: 'running' })
    const completed = describeToolActivity({ toolName: 'company_lookup', source: 'mcp', result: { summary: '找到客户' }, state: 'completed' })
    expect(running).toMatchObject({ stage: '正在调用外部工具', label: '查询客户档案', category: 'external' })
    expect(completed.label).toBe('company_lookup 已完成')
  })

  it('derives the next model stage from the completed work category', () => {
    expect(nextModelStage('reading')).toBe('正在分析读取结果')
    expect(nextModelStage('editing')).toBe('正在检查画板修改')
    expect(nextModelStage('reviewing')).toBe('正在评估检查结果')
    expect(nextModelStage('researching')).toBe('正在整理参考信息')
  })
})
