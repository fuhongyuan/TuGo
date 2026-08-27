import type { StructuredRunEvent } from '../api'
import type { BoardChangeStats, ChatPlan, ChatRunStatus, ChatRunSummary } from '../types'
import { describeToolActivity, nextModelStage, normalizeToolName } from './toolActivity'

const emptyChanges = (): BoardChangeStats => ({ addedElements: 0, updatedElements: 0, removedElements: 0, addedEdges: 0, updatedEdges: 0, removedEdges: 0 })
const emptyArtifacts = () => ({ snapshotsCreated: 0, snapshotIds: [] as string[], imagesCaptured: 0 })
const mergeChanges = (left: BoardChangeStats, right: BoardChangeStats): BoardChangeStats => ({
  addedElements: left.addedElements + right.addedElements,
  updatedElements: left.updatedElements + right.updatedElements,
  removedElements: left.removedElements + right.removedElements,
  addedEdges: left.addedEdges + right.addedEdges,
  updatedEdges: left.updatedEdges + right.updatedEdges,
  removedEdges: left.removedEdges + right.removedEdges,
})
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
const text = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
const toolId = (event: StructuredRunEvent, payload: Record<string, unknown>, toolName: string) => String(event.toolCallId || payload.tool_call_id || payload.call_id || `${event.sequence || 'event'}:${toolName}`)
const toolName = (payload: Record<string, unknown>) => normalizeToolName(String(payload.tool_name || payload.name || ''))
const toolInput = (payload: Record<string, unknown>) => object(payload.input || payload.arguments)
const isFailure = (payload: Record<string, unknown>) => payload.is_error === true || ['error', 'failed'].includes(String(payload.status || '').toLowerCase())
const latestCompleteSentence = (value: string) => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const matches = [...normalized.matchAll(/[^。！？.!?\n]+[。！？.!?]+/g)]
  return text(matches.at(-1)?.[0] || '')
}
const rollingPreview = (value: string, limit = 160) => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `…${normalized.slice(-(limit - 1))}`
}
const planFrom = (payload: Record<string, unknown>): ChatPlan => {
  const raw = object(payload.plan)
  const source = Object.keys(raw).length ? raw : payload
  const steps = Array.isArray(source.steps) ? source.steps.map(object) : []
  return {
    id: String(source.plan_id || source.id || 'current'),
    title: text(source.title) || '执行计划',
    status: String(source.status || 'active'),
    currentStepId: source.current_step_id ? String(source.current_step_id) : undefined,
    steps: steps.map((step, index) => ({
      id: String(step.id || `step_${index + 1}`),
      title: text(step.title || step.description || step.instruction) || `步骤 ${index + 1}`,
      instruction: text(step.instruction) || undefined,
      resultSummary: text(step.result_summary || step.resultSummary) || undefined,
      blocker: text(step.blocker) || undefined,
      status: String(step.status || 'pending'),
    })),
  }
}
const changesFor = (name: string, input: Record<string, unknown>): BoardChangeStats => {
  const changes = emptyChanges()
  const apply = (operation: Record<string, unknown>) => {
    switch (String(operation.op || operation.type || '')) {
      case 'add_element': changes.addedElements += 1; break
      case 'patch_element': changes.updatedElements += 1; break
      case 'delete_element': changes.removedElements += 1; break
      case 'add_edge': changes.addedEdges += 1; break
      case 'patch_edge': changes.updatedEdges += 1; break
      case 'delete_edge': changes.removedEdges += 1; break
      case 'group_elements':
      case 'ungroup_elements':
      case 'align_elements':
      case 'distribute_elements': changes.updatedElements += Array.isArray(operation.ids) ? operation.ids.length : 0; break
      default: break
    }
  }
  if (name === 'board_batch') {
    const operations = Array.isArray(input.operations) ? input.operations : []
    operations.forEach(value => apply(object(value)))
  } else if (name === 'board_patch_element') {
    const operation = object(input.operation)
    if (operation.op === 'patch_edge') changes.updatedEdges = 1
    else changes.updatedElements = 1
  }
  return changes
}

const hasChanges = (changes: BoardChangeStats) => Object.values(changes).some(Boolean)
export const createRunPresentation = (at = new Date().toISOString()): ChatRunStatus => ({
  phase: 'analyzing', headline: '正在启动任务', startedAt: at, lastActivityAt: at, changes: emptyChanges(), artifacts: emptyArtifacts(), milestones: [], pendingChanges: {},
})

/** Converts verbose runtime events into one honest current activity and a
 * deterministic canvas-change summary. It deliberately contains no progress
 * fraction because an agent loop has no knowable total number of steps. */
export const reduceRunPresentation = (previous: ChatRunStatus | undefined, event: StructuredRunEvent, at = new Date().toISOString()): ChatRunStatus => {
  const current = previous || createRunPresentation(at)
  const payload = object(event.payload)
  const type = String(event.type || '').toLowerCase()
  const next: ChatRunStatus = { ...current, lastActivityAt: at, changes: { ...current.changes }, artifacts: { ...(current.artifacts || emptyArtifacts()), snapshotIds: [...(current.artifacts?.snapshotIds || [])] }, milestones: [...current.milestones], pendingChanges: { ...(current.pendingChanges || {}) } }
  if (type === 'session.started') return { ...next, phase: 'analyzing', headline: '正在理解你的需求', detail: undefined }
  if (type === 'llm.call.started') {
    const recentCanvas = current.lastCanvasActivityAt && new Date(at).getTime() - new Date(current.lastCanvasActivityAt).getTime() < 5_000
    // Starting the next model turn must not erase the last meaningful action.
    // Clear only its private delta buffer; the readable narration and completed
    // tool headline stay visible until something more informative arrives.
    const headline = recentCanvas || current.narration || current.activity || hasChanges(next.changes)
      ? nextModelStage(current.activity?.category)
      : '正在理解你的需求'
    return { ...next, phase: 'analyzing', headline, narrationBuffer: '', reasoningBuffer: '', liveNarration: undefined, reasoningPreview: undefined, toolPreview: undefined, activity: { id: String(payload.call_id || event.toolCallId || `model:${event.sequence || 'current'}`), label: headline, status: 'running', category: 'working' } }
  }
  if (type === 'agent.message.delta' && text(payload.reasoning_delta)) {
    const reasoningBuffer = `${current.reasoningBuffer || ''}${String(payload.reasoning_delta)}`.slice(-600)
    return { ...next, phase: 'analyzing', headline: '正在分析画板和下一步操作', reasoningBuffer, reasoningPreview: rollingPreview(reasoningBuffer), activity: { id: String(payload.call_id || event.toolCallId || `model:${event.sequence || 'current'}`), label: '正在分析画板和下一步操作', status: 'running', category: 'working' } }
  }
  if (type === 'agent.message.delta' && text(payload.delta)) {
    const narrationBuffer = `${current.narrationBuffer || ''}${String(payload.delta)}`.slice(-500)
    const complete = latestCompleteSentence(narrationBuffer).slice(-180)
    const recentCanvas = current.lastCanvasActivityAt && new Date(at).getTime() - new Date(current.lastCanvasActivityAt).getTime() < 5_000
    return { ...next, narrationBuffer, liveNarration: rollingPreview(narrationBuffer), ...(complete ? { narration: complete } : {}), phase: recentCanvas ? 'editing' : current.phase }
  }
  if (type === 'agent.tool_preparing') {
    const name = toolName(payload); const id = toolId(event, payload, name)
    const descriptor = describeToolActivity({ toolName: name, source: text(payload.tool_source), state: 'running' })
    const label = `准备${descriptor.label.replace(/^正在/, '').replace(/^准备/, '')}`
    return { ...next, phase: descriptor.phase, headline: descriptor.stage.replace(/^正在/, '准备'), toolPreview: undefined, activity: { id, label, status: 'running', toolName: descriptor.name, category: descriptor.category } }
  }
  if (type === 'agent.tool_arguments.delta') {
    const preview = text(payload.preview)
    return preview ? { ...next, toolPreview: `准备：${preview}` } : next
  }
  if (type === 'agent.tool_cancelled') {
    const id = toolId(event, payload, toolName(payload))
    if (current.activity?.id !== id) return next
    return { ...next, phase: 'analyzing', headline: '正在调整执行方式', toolPreview: undefined, activity: { ...current.activity, label: '正在调整工具调用', status: 'recovering' } }
  }
  if (type === 'agent.tool_use') {
    const name = toolName(payload); const input = toolInput(payload); const id = toolId(event, payload, name)
    const descriptor = describeToolActivity({ toolName: name, source: text(payload.tool_source), input, purpose: text(payload.purpose || input.description), state: 'running' })
    const pending = changesFor(name, input)
    if (hasChanges(pending)) next.pendingChanges![id] = pending
    // A tool call means the preceding model turn is complete. Promote even an
    // unpunctuated short sentence now, and retain it for the duration of work.
    const narration = text(current.narrationBuffer).slice(-180) || current.narration
    return { ...next, phase: descriptor.phase, headline: descriptor.stage, detail: undefined, toolPreview: undefined, activity: { id, label: descriptor.label, status: 'running', toolName: descriptor.name, category: descriptor.category }, ...(narration ? { narration } : {}) }
  }
  if (type === 'agent.tool_result') {
    const name = toolName(payload); const id = toolId(event, payload, name)
    const pending = next.pendingChanges?.[id] || changesFor(name, toolInput(payload))
    delete next.pendingChanges?.[id]
    if (!isFailure(payload) && hasChanges(pending)) {
      next.changes = mergeChanges(next.changes, pending)
      next.lastCanvasActivityAt = at
    }
    if (!isFailure(payload) && name === 'board_review_quality' && !next.milestones.includes('已完成画面质量检查')) next.milestones.push('已完成画面质量检查')
    if (!isFailure(payload) && name === 'board_optimize_layout' && !next.milestones.includes('已优化图形布局')) next.milestones.push('已优化图形布局')
    const input = toolInput(payload)
    const rememberedPurpose = current.activity?.id === id && current.activity.status === 'running' ? current.activity.label : ''
    const descriptor = describeToolActivity({ toolName: name, source: text(payload.tool_source), input, result: payload.content, purpose: text(payload.purpose || input.description) || rememberedPurpose, state: 'completed' })
    const recovering = payload.recoverable === true || payload.status === 'recovering'
    if (isFailure(payload) || recovering) return { ...next, phase: 'analyzing', headline: recovering ? '正在修正工具调用' : '当前操作未完成', detail: undefined, activity: { id, label: recovering ? `正在修正：${current.activity?.label || descriptor.label}` : `未完成：${current.activity?.label || descriptor.label}`, status: recovering ? 'recovering' : 'failed', toolName: descriptor.name, category: descriptor.category } }
    if (name === 'board_create_snapshot') {
      next.artifacts.snapshotsCreated += 1
      const snapshotId = text(object(payload.content).snapshot_id)
      if (snapshotId && !next.artifacts.snapshotIds?.includes(snapshotId)) next.artifacts.snapshotIds = [...(next.artifacts.snapshotIds || []), snapshotId]
    }
    return { ...next, phase: descriptor.phase, headline: nextModelStage(descriptor.category), detail: undefined, activity: { id, label: descriptor.label, status: 'completed', toolName: descriptor.name, category: descriptor.category } }
  }
  if (type === 'run.steered') {
    const count = Array.isArray(payload.instructions) ? payload.instructions.length : Number(payload.count || 1)
    return { ...next, phase: 'analyzing', headline: '正在应用新的指引', activity: { id: `steer:${event.sequence || 'current'}`, label: `已接收 ${Math.max(1, count)} 条补充指引`, status: 'completed', category: 'planning' } }
  }
  if (type.startsWith('plan.')) {
    const plan = planFrom(payload)
    next.plan = plan.steps.length ? plan : current.plan
  }
  if (type === 'plan.step.started') {
    const step = object(payload.step)
    const title = text(step.title || step.description || step.instruction)
    const label = title ? `正在进行：${title}`.slice(0, 120) : '正在执行下一步'
    return { ...next, phase: 'analyzing', headline: '正在按计划处理', activity: { id: String(payload.step_id || `plan:${event.sequence || 'step'}`), label, status: 'running' } }
  }
  if (type === 'plan.step.completed') {
    const step = object(payload.step); const title = text(step.title || step.description || step.instruction)
    return { ...next, headline: '正在准备下一步', activity: { id: String(payload.step_id || `plan:${event.sequence || 'step'}`), label: title ? `已完成计划步骤：${title}`.slice(0, 160) : '已完成当前计划步骤', status: 'completed', category: 'planning' } }
  }
  if (type === 'plan.step.blocked') {
    const step = object(payload.step); const title = text(step.title || step.description || step.instruction)
    return { ...next, headline: '计划执行遇到问题', activity: { id: String(payload.step_id || `plan:${event.sequence || 'step'}`), label: title ? `未完成计划步骤：${title}`.slice(0, 160) : '当前计划步骤未完成', status: 'failed', category: 'planning' } }
  }
  if (type === 'plan.completed') return { ...next, headline: '正在整理任务结果', activity: { id: 'plan:complete', label: '执行计划已完成', status: 'completed', category: 'planning' } }
  if (type === 'plan.abandoned') return { ...next, headline: '正在调整执行方式', activity: { id: 'plan:abandoned', label: '原执行计划已结束', status: 'completed', category: 'planning' } }
  if (type === 'plan.snapshot' || type === 'plan.updated') return next
  if (type === 'context.summarization.started') return { ...next, phase: 'analyzing', headline: '正在整理对话上下文', activity: { id: 'context:summary', label: '压缩较早的对话内容，保留任务目标和未完成事项', status: 'running', category: 'preparing' } }
  if (type === 'context.summarization.completed') return { ...next, headline: '正在继续当前任务', activity: { id: 'context:summary', label: '已整理对话上下文', status: 'completed', category: 'preparing' } }
  if (type === 'context.summarization.degraded') return { ...next, headline: '正在继续当前任务', activity: { id: 'context:summary', label: '已使用本地摘要继续任务', status: 'completed', category: 'preparing' } }
  if (type === 'llm.call.failed') {
    const recoverable = payload.recoverable === true
    const category = text(payload.error_category)
    const label = category === 'middleware_rewrite' ? '正在调整生成结果' : recoverable ? '模型响应中断，正在自动重试' : '模型调用未完成'
    return { ...next, phase: 'analyzing', headline: recoverable ? '正在恢复模型响应' : '模型响应失败', activity: { id: String(payload.call_id || `model:${event.sequence || 'failed'}`), label, status: recoverable ? 'recovering' : 'failed', category: 'working' } }
  }
  if (type === 'agent.message.completed') return { ...next, phase: 'finalizing', headline: '正在整理结果' }
  if (type === 'session.completed') {
    const usage = object(payload.usage)
    const inputTokens = Number(usage.inputTokens || usage.input_tokens || 0)
    const outputTokens = Number(usage.outputTokens || usage.output_tokens || 0)
    const totalTokens = Number(usage.totalTokens || usage.total_tokens || inputTokens + outputTokens)
    const cachedInputTokens = Number(usage.cachedInputTokens || usage.cached_input_tokens || 0)
    const measuredUsage = inputTokens || outputTokens || totalTokens || cachedInputTokens
      ? { inputTokens, outputTokens, totalTokens, cachedInputTokens }
      : undefined
    const measuredDuration = Number(payload.duration_ms || 0)
    const fallbackDuration = Math.max(0, new Date(at).getTime() - new Date(next.startedAt).getTime())
    return { ...next, phase: 'finalizing', headline: '任务已完成', usage: measuredUsage, durationMs: measuredDuration || fallbackDuration, activity: next.activity ? { ...next.activity, status: next.activity.status === 'failed' ? 'failed' : 'completed' } : undefined }
  }
  if (type === 'session.failed') return { ...next, phase: 'waiting', headline: '任务未完成', activity: next.activity ? { ...next.activity, status: 'failed' } : { id: 'run:failed', label: text(payload.user_action || payload.message) || '运行过程中遇到错误', status: 'failed', category: 'working' } }
  if (type === 'session.interrupted') return { ...next, phase: 'waiting', headline: '任务已停止', activity: { id: 'run:interrupted', label: '已停止本次操作', status: 'completed', category: 'working' } }
  return next
}

export const summarizeRunPresentation = (status: ChatRunStatus | undefined): ChatRunSummary | undefined => {
  if (!status) return undefined
  const parts: string[] = []
  const changes = status.changes || emptyChanges()
  const artifacts = status.artifacts || emptyArtifacts()
  if (changes.addedElements) parts.push(`新增 ${changes.addedElements} 个节点`)
  if (changes.updatedElements) parts.push(`调整 ${changes.updatedElements} 个图形`)
  if (changes.removedElements) parts.push(`移除 ${changes.removedElements} 个图形`)
  if (changes.addedEdges) parts.push(`新增 ${changes.addedEdges} 条连线`)
  if (changes.updatedEdges) parts.push(`调整 ${changes.updatedEdges} 条连线`)
  if (changes.removedEdges) parts.push(`移除 ${changes.removedEdges} 条连线`)
  if (artifacts.snapshotsCreated) parts.push(`保存 ${artifacts.snapshotsCreated} 个快照`)
  const hasUsage = Boolean(status.usage && (status.usage.totalTokens || status.usage.inputTokens || status.usage.outputTokens))
  return parts.length || status.milestones.length || hasUsage || status.durationMs !== undefined
    ? { text: [...parts, ...status.milestones].join(' · '), changes, artifacts, usage: status.usage, durationMs: status.durationMs, milestones: status.milestones }
    : undefined
}

export const runElapsedLabel = (status: ChatRunStatus, now = Date.now()) => {
  const elapsed = Math.max(0, Math.floor((now - new Date(status.startedAt).getTime()) / 1000))
  return elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
}

export const runDurationLabel = (durationMs = 0) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export const runTokenLabel = (total = 0) => total < 1000
  ? `${total} tokens`
  : `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}K tokens`

export const runIsQuiet = (status: ChatRunStatus, now = Date.now()) => now - new Date(status.lastActivityAt).getTime() >= 8_000
