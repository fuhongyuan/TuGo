import type { CanvasReference, ChatMessage, ChatSkillMention } from '../types'
import { presentRunError } from './errorPresentation'

export const assistantRunPresentation = (message: ChatMessage) => {
  if (message.pending) return { state: 'running' as const, label: '执行中' }
  const text = String(message.content || '')
  if (/^已取消本次 AI 操作/.test(text)) return { state: 'cancelled' as const, label: '已取消' }
  if (/^AI 长时间没有响应/.test(text)) return { state: 'timed_out' as const, label: '已超时' }
  if (message.process?.some(item => item.status === 'error') || /^(?:运行失败|应用内运行服务暂时不可用|本次操作的上下文出现异常|上一项操作仍在收尾)/.test(text)) return { state: 'failed' as const, label: '未完成' }
  return { state: 'completed' as const, label: '已完成' }
}

export const queueRunPresentation = (status?: 'queued' | 'awaiting') => status === 'awaiting'
  ? { state: 'awaiting' as const, label: '已引导', detail: '正在等待当前任务接收' }
  : { state: 'queued' as const, label: '已排队', detail: '当前任务结束后自动发送' }

/** Deterministic request shaping belongs outside the React workspace so the
 * runtime contract can be tested without mounting the full canvas UI. */
export const buildAgentRunRequest = (content: string, attachments: unknown[], references: CanvasReference[], skills: ChatSkillMention[]) => {
  const userContent = content.trim() || (attachments.length ? '请查看附件。' : '请查看引用的画布内容。')
  const referenceContext = references.length ? `\n\n[用户引用的画布内容]\n${references.map(reference => JSON.stringify(reference)).join('\n')}\n[/用户引用的画布内容]` : ''
  const skillContext = skills.length ? `建议优先使用 Skill：${skills.map(skill => `@${skill.name}`).join('、')}。如适用，请先加载并遵循这些 Skill。\n\n` : ''
  return { userContent, agentContent: `${skillContext}${userContent}${referenceContext}` }
}

export const mergeSteeredUserMessages = (messages: ChatMessage[], assistantId: string, instructions: Array<Record<string, unknown>>, createId: () => string) => {
  const additions: ChatMessage[] = instructions.flatMap(item => {
    const content = String(item.content || '').trim(); const requestId = String(item.client_request_id || '').trim()
    const id = requestId ? `steer_${requestId}` : createId()
    return !content || messages.some(message => message.id === id) ? [] : [{ id, role: 'user' as const, content, createdAt: new Date().toISOString() }]
  })
  if (!additions.length) return { messages, additions }
  const assistantIndex = messages.findIndex(message => message.id === assistantId)
  return { additions, messages: assistantIndex < 0 ? [...messages, ...additions] : [...messages.slice(0, assistantIndex), ...additions, ...messages.slice(assistantIndex)] }
}

export const finalizeAssistantRunError = (message: ChatMessage, error: unknown, signal: AbortSignal): ChatMessage => {
  const presentation = presentRunError(error, signal)
  return {
    ...message,
    pending: false,
    process: (message.process || []).map(item => ({ ...item, status: 'error' as const })),
    content: presentation.state === 'failed' ? presentation.message : (message.content || presentation.message),
  }
}
