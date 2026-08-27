import { describe, expect, it, vi } from 'vitest'
import { appendProcessEvent, copyTextToClipboard, isStaleConversationSaveError, restoreAssistantMessage } from './App'
import type { ChatMessage } from './types'

describe('renderer event recovery', () => {
  it('treats a save racing with project deletion as stale work, not a user error', () => {
    expect(isStaleConversationSaveError(new Error('会话不存在'))).toBe(true)
    expect(isStaleConversationSaveError(new Error('项目不存在'))).toBe(true)
    expect(isStaleConversationSaveError(new Error('磁盘写入失败'))).toBe(false)
  })

  it('copies through the synchronous renderer clipboard path used by messages and debug', async () => {
    const copy = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy })
    await copyTextToClipboard('payload')
    expect(copy).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
  })

  it('rebuilds only the latest completed process output after restart', () => {
    const message: ChatMessage = { id: 'assistant-a', role: 'assistant', content: '', pending: true, threadId: 'thread-a', runId: 'run-a', createdAt: new Date().toISOString() }
    const restored = restoreAssistantMessage(message, [
      { event_id: 'event-1', sequence: 1, type: 'session.started', payload: {} },
      { event_id: 'event-2', sequence: 2, type: 'agent.tool_use', tool_call_id: 'tool-a', payload: { tool_name: 'board_patch_element', input: { id: 'node-a' } } },
      { event_id: 'event-3', sequence: 3, type: 'agent.tool_result', tool_call_id: 'tool-a', payload: { tool_name: 'board_patch_element', status: 'success' } },
      { event_id: 'event-4', sequence: 4, type: 'agent.message.completed', payload: { content: '已经完成画板修改。' } },
      { event_id: 'event-5', sequence: 5, type: 'session.completed', payload: { status: 'success' } },
    ])
    expect(restored).toMatchObject({ pending: false, content: '已经完成画板修改。' })
    expect(restored.process?.at(-1)).toEqual(expect.objectContaining({ kind: 'thinking', detail: '已经完成画板修改。', status: 'success' }))
    expect(restored.process?.every(item => item.status !== 'running')).toBe(true)
  })

  it('only marks a non-terminal restored run interrupted', () => {
    const message: ChatMessage = { id: 'assistant-a', role: 'assistant', content: '', pending: true, threadId: 'thread-a', runId: 'run-a', createdAt: new Date().toISOString() }
    const restored = restoreAssistantMessage(message, [{ event_id: 'event-1', sequence: 1, type: 'session.started', payload: {} }])
    expect(restored).toMatchObject({ pending: false, content: '上一次 AI 操作在应用关闭前中断。' })
  })

  it('keeps the process model bounded for 500 streaming text events', () => {
    const message: ChatMessage = { id: 'assistant-a', role: 'assistant', content: 'done', pending: true, threadId: 'thread-a', runId: 'run-a', createdAt: new Date().toISOString() }
    const events: Array<Record<string, unknown>> = [{ event_id: 'start', sequence: 1, type: 'session.started', payload: {} }]
    for (let sequence = 2; sequence <= 501; sequence += 1) events.push({ event_id: `delta-${sequence}`, sequence, type: 'agent.message.delta', payload: { delta: 'x' } })
    events.push({ event_id: 'done', sequence: 502, type: 'session.completed', payload: {} })
    const restored = restoreAssistantMessage(message, events)
    expect(restored.process?.length).toBeLessThanOrEqual(8)
    expect(restored.process?.at(-1)).toMatchObject({ kind: 'thinking', status: 'success' })
  })

  it('keeps the previous action at an llm boundary and replaces it on real output', () => {
    const tool = appendProcessEvent([], { type: 'agent.tool_use', toolCallId: 'tool-a', sequence: 1, payload: { tool_name: 'board_patch_element', purpose: '正在调整登录按钮' } })
    const started = appendProcessEvent(tool, { type: 'llm.call.started', sequence: 2, payload: { call_id: 'llm-b' } })
    expect(started).toEqual(tool)
    const streamed = appendProcessEvent(started, { type: 'agent.message.delta', sequence: 3, payload: { call_id: 'llm-b', delta: '继续优化间距' } })
    expect(streamed.at(-1)).toEqual(expect.objectContaining({ detail: '继续优化间距', status: 'running' }))
  })

  it('shows reasoning only until content starts and replaces prior llm turns', () => {
    const reasoning = appendProcessEvent([], { type: 'agent.message.delta', sequence: 1, payload: { call_id: 'llm-a', reasoning_delta: '检查布局' } })
    const content = appendProcessEvent(reasoning, { type: 'agent.message.delta', sequence: 2, payload: { call_id: 'llm-a', delta: '正在修正对齐' } })
    const nextTurn = appendProcessEvent(content, { type: 'agent.message.delta', sequence: 3, payload: { call_id: 'llm-b', delta: '准备完成' } })
    expect(reasoning[0]).toMatchObject({ label: '模型思考', detail: '检查布局' })
    expect(content[0]).toMatchObject({ label: '模型回应', detail: '正在修正对齐' })
    expect(nextTurn.at(-1)).toEqual(expect.objectContaining({ detail: '准备完成' }))
  })

  it('bounds the visible process transcript while reasoning streams for a long time', () => {
    const first = appendProcessEvent([], { type: 'agent.message.delta', sequence: 1, payload: { call_id: 'llm-long', reasoning_delta: 'a'.repeat(900) } })
    const next = appendProcessEvent(first, { type: 'agent.message.delta', sequence: 2, payload: { call_id: 'llm-long', reasoning_delta: 'b'.repeat(900) } })
    expect(next).toHaveLength(1)
    expect(next[0].detail).toHaveLength(1200)
    expect(next[0].detail?.startsWith('…')).toBe(true)
    expect(next[0].detail?.endsWith('b'.repeat(900))).toBe(true)
  })

  it('renders internal tools as work outcomes and preserves MCP descriptions', () => {
    const loaded = appendProcessEvent([], { type: 'agent.tool_use', toolCallId: 'skill', sequence: 1, payload: { tool_name: 'load_skill', tool_source: 'builtin', purpose: '加载画板绘制规范', input: { skill_id: 'tugo-architect' } } })
    const completed = appendProcessEvent(loaded, { type: 'agent.tool_result', toolCallId: 'skill', sequence: 2, payload: { tool_name: 'load_skill', tool_source: 'builtin', input: { skill_id: 'tugo-architect' }, content: JSON.stringify({ skill_name: '画布架构师' }), status: 'success' } })
    const mcp = appendProcessEvent([], { type: 'agent.tool_use', toolCallId: 'mcp', sequence: 3, payload: { tool_name: 'company_lookup', tool_source: 'mcp', tool_description: '查询客户档案', input: {} } })
    const nextModel = appendProcessEvent(completed, { type: 'agent.message.delta', sequence: 4, payload: { call_id: 'llm-after-tool', delta: '已完成准备，开始绘制。' } })
    expect(loaded).toEqual([expect.objectContaining({ id: 'skill', detail: '加载画板绘制规范', status: 'running' })])
    expect(completed[0]).toMatchObject({ label: '准备专业能力', detail: '已加载所需 Skill「画布架构师」', status: 'success' })
    expect(completed).toHaveLength(1)
    expect(nextModel.at(-1)).toEqual(expect.objectContaining({ kind: 'thinking', detail: '已完成准备，开始绘制。' }))
    expect(mcp[0]).toMatchObject({ label: '调用 company_lookup', detail: '查询客户档案' })
  })
})
