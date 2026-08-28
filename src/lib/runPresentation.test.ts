import { describe, expect, it } from 'vitest'
import { createRunPresentation, reduceRunPresentation, runDurationLabel, runIsQuiet, runTokenLabel, summarizeRunPresentation } from './runPresentation'

describe('run presentation', () => {
  it('never derives fake progress from a sequence of runtime events', () => {
    const start = '2026-08-23T04:00:00.000Z'
    const status = reduceRunPresentation(createRunPresentation(start), {
      type: 'agent.tool_use', toolCallId: 'batch-1', payload: {
        tool_name: 'board_batch', input: { description: '补充服务节点', operations: [
          { op: 'add_element' }, { op: 'add_edge' }, { op: 'patch_element' },
        ] },
      },
    }, start)
    expect(status.headline).toBe('正在批量修改画板')
    expect(status.activity).toMatchObject({ label: '补充服务节点', category: 'editing' })
    expect(status).not.toHaveProperty('progress')
    const completed = reduceRunPresentation(status, {
      type: 'agent.tool_result', toolCallId: 'batch-1', payload: { tool_name: 'board_batch', content: { applied: 3 } },
    }, '2026-08-23T04:00:01.000Z')
    expect(summarizeRunPresentation(completed)?.text).toContain('新增 1 个节点')
    expect(summarizeRunPresentation(completed)?.text).toContain('新增 1 条连线')
    expect(summarizeRunPresentation(completed)?.text).toContain('调整 1 个图形')
    const nextModelCall = reduceRunPresentation(completed, { type: 'llm.call.started', payload: {} }, '2026-08-23T04:00:02.000Z')
    expect(nextModelCall.phase).toBe('analyzing')
    expect(nextModelCall.headline).toBe('正在检查画板修改')
    expect(nextModelCall.activity).toMatchObject({ label: '正在检查画板修改', status: 'running' })
  })

  it('does not count a failed mutation and surfaces quiet-but-alive work honestly', () => {
    const start = '2026-08-23T04:00:00.000Z'
    const started = reduceRunPresentation(createRunPresentation(start), {
      type: 'agent.tool_use', toolCallId: 'batch-1', payload: { tool_name: 'board_batch', input: { operations: [{ op: 'add_element' }] } },
    }, start)
    const failed = reduceRunPresentation(started, {
      type: 'agent.tool_result', toolCallId: 'batch-1', payload: { tool_name: 'board_batch', is_error: true },
    }, '2026-08-23T04:00:02.000Z')
    expect(summarizeRunPresentation(failed)).toBeUndefined()
    expect(runIsQuiet(failed, new Date('2026-08-23T04:00:11.000Z').getTime())).toBe(true)
  })

  it('aggregates repeated reads into one current activity instead of a visible log', () => {
    const start = '2026-08-23T04:00:00.000Z'
    const first = reduceRunPresentation(createRunPresentation(start), { type: 'agent.tool_use', payload: { tool_name: 'board_get_state', input: {} } }, start)
    const second = reduceRunPresentation(first, { type: 'agent.tool_use', payload: { tool_name: 'board_query_elements', input: {} } }, '2026-08-23T04:00:01.000Z')
    expect(second.headline).toBe('正在定位画板内容')
    expect(second.milestones).toEqual([])
  })

  it('uses streamed model content as a compact narration instead of exposing reasoning', () => {
    const start = '2026-08-23T04:00:00.000Z'
    const content = reduceRunPresentation(createRunPresentation(start), { type: 'agent.message.delta', payload: { delta: '我会先整理核心节点，再补充它们之间的关系。' } }, start)
    expect(content).toMatchObject({ narration: '我会先整理核心节点，再补充它们之间的关系。' })
    const reasoning = reduceRunPresentation(content, { type: 'agent.message.delta', payload: { reasoning_delta: 'private chain of thought' } }, start)
    expect(reasoning.narration).toBe(content.narration)
  })

  it('keeps reasoning and unfinished content visibly moving between concrete actions', () => {
    const start = '2026-08-23T04:00:00.000Z'
    const call = reduceRunPresentation(createRunPresentation(start), { type: 'llm.call.started', payload: { call_id: 'llm-1' } }, start)
    expect(call.activity).toMatchObject({ id: 'llm-1', status: 'running' })
    const reasoning = reduceRunPresentation(call, { type: 'agent.message.delta', payload: { call_id: 'llm-1', reasoning_delta: '先检查入口节点和鉴权服务之间的关系' } }, '2026-08-23T04:00:01.000Z')
    expect(reasoning.reasoningPreview).toContain('入口节点')
    expect(reasoning.lastActivityAt).toBe('2026-08-23T04:00:01.000Z')
    const content = reduceRunPresentation(reasoning, { type: 'agent.message.delta', payload: { call_id: 'llm-1', delta: '接下来调整登录流程中的异常' } }, '2026-08-23T04:00:02.000Z')
    expect(content.liveNarration).toBe('接下来调整登录流程中的异常')
    expect(content.narration).toBeUndefined()
  })

  it('presents a named tool before its complete arguments are ready', () => {
    const status = reduceRunPresentation(createRunPresentation(), {
      type: 'agent.tool_preparing', toolCallId: 'batch-1', payload: { tool_name: 'board_batch', tool_source: 'builtin' },
    })
    expect(status).toMatchObject({ headline: '准备批量修改画板', activity: { id: 'batch-1', label: '准备执行一组画板修改', status: 'running', toolName: 'board_batch' } })
    const preview = reduceRunPresentation(status, {
      type: 'agent.tool_arguments.delta', toolCallId: 'batch-1', payload: { tool_name: 'board_batch', preview: '补充登录异常分支' },
    })
    expect(preview.toolPreview).toBe('准备：补充登录异常分支')
    expect(preview.activity).toEqual(status.activity)
  })

  it('keeps narration visible across tool and model events instead of flashing it', () => {
    const start = '2026-08-23T04:00:00.000Z'
    const narrated = reduceRunPresentation(createRunPresentation(start), { type: 'agent.message.delta', payload: { delta: '先补充入口节点，再连接核心服务。' } }, start)
    const tool = reduceRunPresentation(narrated, { type: 'agent.tool_use', payload: { tool_name: 'board_batch', purpose: '补充入口节点', input: { operations: [{ op: 'add_element' }] } } }, '2026-08-23T04:00:00.050Z')
    const result = reduceRunPresentation(tool, { type: 'agent.tool_result', payload: { tool_name: 'board_batch', purpose: '补充入口节点' } }, '2026-08-23T04:00:00.100Z')
    const nextCall = reduceRunPresentation(result, { type: 'llm.call.started', payload: {} }, '2026-08-23T04:00:00.150Z')
    expect(tool).toMatchObject({ headline: '正在批量修改画板', narration: '先补充入口节点，再连接核心服务。', activity: { label: '补充入口节点', status: 'running' } })
    expect(result).toMatchObject({ headline: '正在检查画板修改', narration: '先补充入口节点，再连接核心服务。', activity: { label: '已完成：补充入口节点', status: 'completed' } })
    expect(nextCall).toMatchObject({ headline: '正在检查画板修改', narration: '先补充入口节点，再连接核心服务。', activity: { label: '正在检查画板修改', status: 'running' } })
  })

  it('presents steering, retry, plan, context maintenance and terminal events explicitly', () => {
    const start = '2026-08-23T04:00:00.000Z'
    let status = reduceRunPresentation(createRunPresentation(start), { type: 'run.steered', payload: { count: 2 } }, start)
    expect(status).toMatchObject({ headline: '正在应用新的指引', activity: { label: '已接收 2 条补充指引' } })
    status = reduceRunPresentation(status, { type: 'llm.call.failed', payload: { call_id: 'retry', recoverable: true, error_category: 'rate_limit' } }, start)
    expect(status).toMatchObject({ headline: '正在恢复模型响应', activity: { status: 'recovering' } })
    status = reduceRunPresentation(status, { type: 'context.summarization.started', payload: {} }, start)
    expect(status.headline).toBe('正在整理对话上下文')
    status = reduceRunPresentation(status, { type: 'context.summarization.completed', payload: {} }, start)
    expect(status.activity).toMatchObject({ label: '已整理对话上下文', status: 'completed' })
    status = reduceRunPresentation(status, { type: 'plan.step.started', payload: { step_id: 's1', step: { title: '调整网关连线' } } }, start)
    expect(status.activity?.label).toBe('正在进行：调整网关连线')
    status = reduceRunPresentation(status, { type: 'plan.step.completed', payload: { step_id: 's1', step: { title: '调整网关连线' } } }, start)
    expect(status.activity).toMatchObject({ label: '已完成计划步骤：调整网关连线', status: 'completed' })
    status = reduceRunPresentation(status, { type: 'plan.completed', payload: {} }, start)
    expect(status).toMatchObject({ headline: '正在整理任务结果', activity: { label: '执行计划已完成' } })
    status = reduceRunPresentation(status, { type: 'session.completed', payload: {} }, start)
    expect(status.headline).toBe('任务已完成')
  })

  it('retains the latest structured plan after later tool activity', () => {
    const start = '2026-08-23T04:00:00.000Z'
    const planned = reduceRunPresentation(createRunPresentation(start), {
      type: 'plan.snapshot', payload: {
        plan_id: 'plan-1', title: '整理网关图', status: 'active', current_step_id: 's2', steps: [
          { id: 's1', title: '读取现有节点', status: 'completed' },
          { id: 's2', title: '调整网关连线', instruction: '将入口接到网关', status: 'in_progress' },
          { id: 's3', title: '检查布局', status: 'pending' },
        ],
      },
    }, start)
    const afterTool = reduceRunPresentation(planned, {
      type: 'agent.tool_use', payload: { tool_name: 'board_batch', input: { operations: [{ op: 'patch_edge' }] } },
    }, '2026-08-23T04:00:01.000Z')
    expect(afterTool.plan?.id).toBe('plan-1')
    expect(afterTool.plan?.currentStepId).toBe('s2')
    expect(afterTool.plan?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 's1', status: 'completed' }),
      expect.objectContaining({ id: 's2', title: '调整网关连线', instruction: '将入口接到网关', status: 'in_progress' }),
    ]))
  })

  it('summarizes successful canvas operations, artifacts, duration and token usage without another model call', () => {
    const start = '2026-08-23T04:00:00.000Z'
    let status = reduceRunPresentation(createRunPresentation(start), { type: 'agent.tool_use', toolCallId: 'batch', payload: { tool_name: 'board_batch', input: { operations: [
      { op: 'add_element', element: { id: 'a' } },
      { op: 'patch_element', id: 'b', patch: { x: 10 } },
      { op: 'delete_edge', id: 'e1' },
      { op: 'add_edge', edge: { id: 'e2' } },
      { op: 'align_elements', ids: ['a', 'b'] },
    ] } } }, start)
    status = reduceRunPresentation(status, { type: 'agent.tool_result', toolCallId: 'batch', payload: { tool_name: 'board_batch', status: 'success' } }, start)
    status = reduceRunPresentation(status, { type: 'agent.tool_use', toolCallId: 'snapshot', payload: { tool_name: 'board_create_snapshot', input: { name: '第一版' } } }, start)
    status = reduceRunPresentation(status, { type: 'agent.tool_result', toolCallId: 'snapshot', payload: { tool_name: 'board_create_snapshot', status: 'success', content: { snapshot_id: 'snapshot-1', snapshot_name: '第一版' } } }, start)
    status = reduceRunPresentation(status, { type: 'session.completed', payload: { duration_ms: 24_400, usage: { inputTokens: 1200, outputTokens: 345, totalTokens: 1545, cachedInputTokens: 800 } } }, '2026-08-23T04:00:24.400Z')
    const summary = summarizeRunPresentation(status)
    expect(summary).toMatchObject({ durationMs: 24_400, usage: { totalTokens: 1545 }, artifacts: { snapshotsCreated: 1 } })
    expect(summary?.artifacts.snapshotIds).toEqual(['snapshot-1'])
    expect(summary?.text).toContain('新增 1 个节点')
    expect(summary?.text).toContain('调整 3 个图形')
    expect(summary?.text).toContain('新增 1 条连线')
    expect(summary?.text).toContain('移除 1 条连线')
    expect(summary?.text).toContain('保存 1 个快照')
    expect(runDurationLabel(summary?.durationMs)).toBe('24 秒')
    expect(runTokenLabel(summary?.usage?.totalTokens)).toBe('1.5K tokens')
  })
})
