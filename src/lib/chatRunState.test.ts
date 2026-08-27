import { describe, expect, it } from 'vitest'
import { assistantRunPresentation, buildAgentRunRequest, finalizeAssistantRunError, mergeSteeredUserMessages, queueRunPresentation } from './chatRunState'
import type { ChatMessage } from '../types'
import { TuGoRunError } from '../api'

const pendingMessage = (): ChatMessage => ({
  id: 'assistant', role: 'assistant', content: '', pending: true, createdAt: new Date(0).toISOString(),
  process: [{ id: 'thinking', kind: 'thinking', label: '正在理解需求', status: 'running' }],
})

describe('chat run terminal state', () => {
  it('shapes references and explicit Skill suggestions into the durable agent request', () => {
    const request = buildAgentRunRequest('', [], [{ kind: 'element', id: 'node-a' } as never], [{ skill_id: 'skill-a', name: '架构图' } as never])
    expect(request.userContent).toBe('请查看引用的画布内容。')
    expect(request.agentContent).toContain('@架构图')
    expect(request.agentContent).toContain('[用户引用的画布内容]')
  })

  it('places accepted steering instructions before the active assistant reply exactly once', () => {
    const messages = [{ id: 'user-a', role: 'user' as const, content: '开始', createdAt: '' }, pendingMessage()]
    const first = mergeSteeredUserMessages(messages, 'assistant', [{ client_request_id: 'request-a', content: '优先对齐' }], () => 'generated')
    expect(first.messages.map(message => message.id)).toEqual(['user-a', 'steer_request-a', 'assistant'])
    expect(mergeSteeredUserMessages(first.messages, 'assistant', [{ client_request_id: 'request-a', content: '优先对齐' }], () => 'generated').additions).toEqual([])
  })

  it('closes process cards and never reports a cancelled run as a board update', () => {
    const controller = new AbortController(); controller.abort('user')
    const result = finalizeAssistantRunError(pendingMessage(), new DOMException('Cancelled', 'AbortError'), controller.signal)
    expect(result).toMatchObject({ pending: false, content: '已取消本次 AI 操作。', process: [{ status: 'error' }] })
    expect(result.content).not.toContain('画板已更新')
  })

  it('uses the inactivity message for a timed-out run', () => {
    const controller = new AbortController(); controller.abort('timeout')
    expect(finalizeAssistantRunError(pendingMessage(), new DOMException('Cancelled', 'AbortError'), controller.signal).content).toContain('长时间没有响应')
  })

  it('uses the structured recovery action instead of parsing technical text', () => {
    const controller = new AbortController()
    const error = new TuGoRunError({ error_code: 'MODEL_AUTHENTICATION', phase: 'model', retryable: false, user_action: '请检查这个模型的 API Key。', technical_detail: '401 invalid token' })
    const result = finalizeAssistantRunError(pendingMessage(), error, controller.signal)
    expect(result.content).toBe('请检查这个模型的 API Key。')
    expect(result.content).not.toContain('401')
  })

  it('shows an identified failure reason before its recovery action', () => {
    const controller = new AbortController()
    const error = new TuGoRunError({
      error_code: 'IMAGE_INPUT_FORMAT_UNSUPPORTED',
      phase: 'model',
      retryable: false,
      user_message: '模型服务无法接受当前图片输入格式。',
      user_action: '请检查网关是否支持 image_url 和 Base64 图片。',
      technical_detail: 'unsupported content type image_url',
    })
    const result = finalizeAssistantRunError(pendingMessage(), error, controller.signal)
    expect(result.content).toBe('模型服务无法接受当前图片输入格式。\n\n请检查网关是否支持 image_url 和 Base64 图片。')
    expect(result.content).not.toContain('unsupported content type')
  })

  it('uses one explicit user-facing terminal state vocabulary', () => {
    expect(assistantRunPresentation(pendingMessage())).toMatchObject({ state: 'running', label: '执行中' })
    expect(assistantRunPresentation({ ...pendingMessage(), pending: false, content: '已取消本次 AI 操作。' })).toMatchObject({ state: 'cancelled', label: '已取消' })
    expect(assistantRunPresentation({ ...pendingMessage(), pending: false, content: 'AI 长时间没有响应，已自动停止本次操作。' })).toMatchObject({ state: 'timed_out', label: '已超时' })
    expect(assistantRunPresentation({ ...pendingMessage(), pending: false, content: '完成了。', process: [] })).toMatchObject({ state: 'completed', label: '已完成' })
  })

  it('distinguishes queued work from an instruction already handed to the active run', () => {
    expect(queueRunPresentation()).toMatchObject({ state: 'queued', label: '已排队', detail: '当前任务结束后自动发送' })
    expect(queueRunPresentation('awaiting')).toMatchObject({ state: 'awaiting', label: '已引导', detail: '正在等待当前任务接收' })
  })
})
