import type { BootstrapStatus, TuGoConfig, ChatAttachment } from './types'
import { effectiveLanguage, promptLanguageFor } from './i18n'

export type StructuredRunEvent = {
  type: string
  payload: Record<string, unknown>
  sequence?: number
  toolCallId?: string
  eventId?: string
}

export type RunFailure = {
  error_code?: string
  phase?: string
  retryable?: boolean
  user_message?: string
  user_action?: string
  technical_detail?: string
  message?: string
  error_category?: string
  provider_error?: Record<string, unknown>
}

export class TuGoRunError extends Error {
  failure: RunFailure

  constructor(failure: RunFailure) {
    super(failure.user_action || failure.message || failure.technical_detail || 'Agent 运行失败')
    this.name = 'TuGoRunError'
    this.failure = failure
  }
}

export type ModelRecord = { model_id: string; name: string; provider_id: string; model: string; display_name: string; is_default?: boolean; enabled?: boolean; extra_config?: { base_url?: string; context_window?: number; max_output_tokens?: number; vision_capable?: boolean; probe_status?: string; [key: string]: unknown }; has_secrets?: boolean }
export type AgentRecord = {
  agent_id: string; name: string; display_name: string; description?: string; model_id?: string; tool_groups?: string[]; tool_names?: string[]; skills?: string[]; soul?: string
  mcp_connection_ids?: string[]
  mcp_bindings?: Array<{ connection_id: string; allowlist: string[] }>
  mcp_endpoints?: Array<{ endpoint_id: string; name: string; url: string; credential_type: string; enabled: boolean }>
}
export type McpRecord = { credential_id: string; connection_id: string; name: string; url: string; transport: string; description?: string; credential_type?: string; enabled?: boolean; has_credentials?: boolean; header_names?: string[]; env_names?: string[]; args?: string[]; binding_count?: number }
export type SkillResource = { path: string; content: string }
export type SkillRecord = { skill_id: string; name: string; slug: string; description?: string; published_version_id?: string; version?: string; enabled?: boolean; resource_count?: number; built_in?: boolean }
export type SkillEditorSession = { thread_id: string; agent_id?: string; skill_id: string | null; name?: string; description?: string; enabled?: boolean; messages?: Array<{ role: 'user' | 'assistant'; content: string }> }

export type AiConfiguration = { model?: ModelRecord; lead?: AgentRecord; collaborators: AgentRecord[]; connections: McpRecord[]; skill?: SkillRecord; skillContent?: string }

export class TuGoApi {
  private config: TuGoConfig

  constructor(config: TuGoConfig) { this.config = config }

  updateConfig(config: TuGoConfig) { this.config = config }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const runtime = window.tugo?.runtime
    if (!runtime) throw new Error('TuGo Agent Runtime 仅在桌面应用中可用')
    let body: unknown
    if (typeof init.body === 'string') body = JSON.parse(init.body)
    else if (init.body instanceof FormData) throw new Error('Embedded Runtime 不接受未转换的表单请求')
    return runtime.request<T>('runtime.http', { method: String(init.method || 'GET'), path, body } as Record<string, unknown>)
  }
  private items<T>(value: unknown, keys: string[]) {
    if (Array.isArray(value)) return value as T[]
    const object = value as Record<string, unknown> | null
    for (const key of [...keys, 'data', 'results']) {
      const candidate = object?.[key]
      if (Array.isArray(candidate)) return candidate as T[]
      if (candidate && typeof candidate === 'object') {
        for (const nestedKey of keys) {
          const nested = (candidate as Record<string, unknown>)[nestedKey]
          if (Array.isArray(nested)) return nested as T[]
        }
      }
    }
    return []
  }
  async ping() { return this.request<{ status?: string }>('/health') }
  async listModels() { return this.request<unknown>('/api/models?page_size=100').then(value => this.items<ModelRecord>(value, ['items', 'models'])) }
  async getDefaultModel() {
    const models = await this.listModels()
    return models.find(item => item.is_default) || models.find(item => item.enabled !== false)
  }
  async listProviders() { return this.request<unknown>('/api/models/providers').then(value => this.items<Record<string, unknown>>(value, ['providers', 'items'])) }
  async saveModel(input: { modelId?: string; providerId: string; model: string; displayName: string; apiKey: string; baseUrl?: string; apiPath?: string; contextWindow?: number; maxOutputTokens?: number; visionCapable?: boolean; isDefault?: boolean }) {
    const extra_config: Record<string, string | number | boolean> = {
      context_window: Number(input.contextWindow || 128000),
      max_output_tokens: Number(input.maxOutputTokens || 32768),
      vision_capable: input.visionCapable !== false,
    }
    if (input.apiKey) extra_config.api_key = input.apiKey
    if (input.baseUrl) extra_config.base_url = input.baseUrl
    if (input.apiPath) extra_config.api_path = input.apiPath
    // A human-defined connection name is the identity at the UI layer: the
    // same model may legitimately be exposed by staging, production and a
    // self-hosted endpoint.
    const name = `tugo-${input.displayName || input.model}-${input.providerId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120)
    const models = await this.listModels()
    const existing = input.modelId ? models.find(item => item.model_id === input.modelId) : undefined
    const body = { name, provider_id: input.providerId, model: input.model, display_name: input.displayName || input.model, description: 'TuGo AI 模型', enabled: true, is_default: input.isDefault ?? existing?.is_default ?? models.length === 0, ...(Object.keys(extra_config).length ? { extra_config } : {}) }
    try {
      return await this.request<ModelRecord>(existing ? `/api/models/${existing.model_id}` : '/api/models', { method: existing ? 'PUT' : 'POST', body: JSON.stringify(body) })
    } catch (error) {
      if (existing && /\b404\b|not found/i.test(error instanceof Error ? error.message : String(error))) {
        return this.request<ModelRecord>('/api/models', { method: 'POST', body: JSON.stringify(body) })
      }
      throw error
    }
  }
  // Compatibility for integrations/tests written before multi-model support.
  async saveSingleModel(input: { modelId?: string; providerId: string; model: string; displayName: string; apiKey: string; baseUrl?: string; apiPath?: string; contextWindow?: number; maxOutputTokens?: number; visionCapable?: boolean }) {
    return this.saveModel({ ...input, isDefault: true })
  }
  async setDefaultModel(model: ModelRecord) {
    return this.request<ModelRecord>(`/api/models/${encodeURIComponent(model.model_id)}`, { method: 'PUT', body: JSON.stringify({ name: model.name, provider_id: model.provider_id, model: model.model, display_name: model.display_name, enabled: model.enabled !== false, is_default: true, extra_config: model.extra_config || {} }) })
  }
  testModel(modelId: string) { return this.request<Record<string, unknown>>('/api/models/test', { method: 'POST', body: JSON.stringify({ model_id: modelId }) }) }
  deleteModel(modelId: string) { return this.request<{ deleted: boolean }>(`/api/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' }) }
  async revealModelKey(modelId: string) { return (await this.request<{ api_key?: string }>(`/api/models/${encodeURIComponent(modelId)}/api-key`)).api_key || '' }
  async getAiConfiguration(): Promise<AiConfiguration> {
    const [models, agents, connections, skills] = await Promise.all([
      this.listModels(),
      this.request<unknown>('/api/agents?page_size=100').then(value => this.items<AgentRecord>(value, ['items', 'agents'])),
      this.request<unknown>('/api/mcp/credentials?page_size=100').then(value => this.items<McpRecord>(value, ['items', 'credentials'])),
      this.request<unknown>('/api/skill-packages?page_size=100&scope=custom').then(value => this.items<SkillRecord>(value, ['items'])),
    ])
    const lead = agents.find(item => item.name === 'tugo-architect')
    const skill = skills.find(item => item.slug === 'tugo-architect' || item.name === 'tugo-architect')
    let skillContent: string | undefined
    if (skill?.published_version_id) {
      try { skillContent = (await this.request<{ content: string }>(`/api/skills/${encodeURIComponent(skill.published_version_id)}/content`)).content } catch { /* summary remains available */ }
    }
    return { model: models.find(item => item.model_id === lead?.model_id) || models.find(item => item.is_default), lead, collaborators: [], connections, skill, skillContent }
  }
  async inspectBootstrap(): Promise<BootstrapStatus> {
    try {
      await this.ping()
      const [models, mcps, skills, agents] = await Promise.all([
        this.listModels(),
        this.request<unknown>('/api/mcp/credentials?page_size=100').then(value => this.items<McpRecord>(value, ['items'])),
        this.request<unknown>('/api/skill-packages?page_size=100&scope=custom').then(value => this.items<SkillRecord>(value, ['items'])),
        this.request<unknown>('/api/agents?page_size=100').then(value => this.items<AgentRecord>(value, ['items'])),
      ])
      const lead = agents.find(item => item.name === 'tugo-architect')
      const requiredCanvasTools = ['board_get_state', 'board_batch', 'board_patch_element', 'board_patch_dsl']
      const requiredSkills = ['tugo-architect', 'diagram-semantics', 'diagram-composition', 'source-to-diagram']
      return {
        l4: 'ready', model: models.some(item => Boolean(item.model) && item.enabled !== false) ? 'ready' : 'missing',
        // Canvas operations are built-in Runtime tools. This field remains for
        // UI compatibility and now means that the embedded tool set is ready.
        mcp: 'ready',
        skill: requiredSkills.every(slug => skills.some(item => item.slug === slug)) ? 'ready' : 'missing',
        agent: lead && requiredCanvasTools.every(name => (lead.tool_names || []).includes(name)) && requiredSkills.every(slug => (lead.skills || []).includes(slug) || (lead.skills || []).some(id => skills.some(skill => skill.skill_id === id && skill.slug === slug))) ? 'ready' : 'missing',
      }
    } catch (error) {
      return { l4: 'error', model: 'missing', mcp: 'missing', skill: 'missing', agent: 'missing', message: error instanceof Error ? error.message : String(error) }
    }
  }
  async bootstrapResources(modelId: string) {
    return this.request<{ agent: AgentRecord; skill: SkillRecord }>('/api/runtime/bootstrap', { method: 'POST', body: JSON.stringify({ model_id: modelId }) })
  }
  async createThread(agentId: string, conversationTitle: string, projectId: string, conversationId: string, allowedSkillIds?: string[]) {
    return this.request<{ thread_id: string }>('/api/threads', {
      method: 'POST',
      body: JSON.stringify({
        assistant_id: agentId,
        metadata: {
          source: 'tugo',
          title: conversationTitle,
          display_name: conversationTitle,
          project_type: 'visual_board',
          project_id: projectId,
          conversation_id: conversationId,
          ...(allowedSkillIds === undefined ? {} : { allowed_skill_ids: allowedSkillIds }),
        },
      }),
    })
  }
  async updateThreadSkillScope(threadId: string, allowedSkillIds: string[]) {
    return this.request<{ updated: boolean }>(`/api/threads/${encodeURIComponent(threadId)}/metadata`, { method: 'PUT', body: JSON.stringify({ allowed_skill_ids: allowedSkillIds }) })
  }
  async seedThreadContext(threadId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>, replaceActiveRun = false) {
    return this.request<{ seeded: boolean }>(`/api/threads/${encodeURIComponent(threadId)}/context`, { method: 'PUT', body: JSON.stringify({ messages, replace_active_run: replaceActiveRun }) })
  }
  async cancelRun(threadId: string, runId: string) {
    const runtime = window.tugo?.runtime
    if (!runtime) throw new Error('TuGo Agent Runtime 仅在桌面应用中可用')
    return runtime.request<void>('run.cancel', { thread_id: threadId, run_id: runId })
  }
  steerRun(runId: string, content: string, clientRequestId: string) {
    const runtime = window.tugo?.runtime
    if (!runtime) throw new Error('Embedded Runtime 不可用')
    return runtime.request<{ accepted: boolean; pending?: number }>('run.steer', { run_id: runId, content, client_request_id: clientRequestId })
  }
  async cancelActiveRun(threadId: string) {
    const thread = await this.threadStatus(threadId)
    if (thread.active_run_id) await this.cancelRun(threadId, thread.active_run_id)
  }
  threadStatus(threadId: string) { return this.request<{ thread_id: string; active_run_id?: string; subscription_id?: string; status?: string }>(`/api/threads/${encodeURIComponent(threadId)}?include_values=false`) }
  async importAttachment(path: string) { return this.request<{ attachment_id: string; name: string; size: number; mime_type?: string }>('/api/attachments/import', { method: 'POST', body: JSON.stringify({ path }) }) }
  attachmentImage(attachmentId: string) { return this.request<{ attachment_id: string; name: string; mime_type: string; data_url: string }>(`/api/attachments/${encodeURIComponent(attachmentId)}/image`) }
  attachmentDownload(attachmentId: string) { return this.request<{ attachment_id: string; name: string; mime_type: string; data_url: string }>(`/api/attachments/${encodeURIComponent(attachmentId)}/download`) }
  async deleteAttachment(attachmentId: string) { return this.request<{ deleted: boolean }>(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }) }
  async listSkills() { return this.request<unknown>('/api/skill-packages?page_size=100&scope=custom').then(value => this.items<SkillRecord>(value, ['items'])) }
  skillContent(skillId: string) { return this.request<{ content: string }>(`/api/skills/${encodeURIComponent(skillId)}/content`) }
  skillResources(skillId: string) { return this.request<{ items: SkillResource[] }>(`/api/skills/${encodeURIComponent(skillId)}/resources`) }
  saveSkill(input: { skillId?: string; name: string; description: string; content: string; resources?: SkillResource[] }) { return this.request<SkillRecord>(input.skillId ? `/api/skills/${encodeURIComponent(input.skillId)}` : '/api/skills', { method: input.skillId ? 'PUT' : 'POST', body: JSON.stringify(input) }) }
  deleteSkill(skillId: string) { return this.request<{ deleted: boolean }>(`/api/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }) }
  setSkillEnabled(skillId: string, enabled: boolean) { return this.request<SkillRecord>(`/api/skills/${encodeURIComponent(skillId)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }) }
  renameSkill(skillId: string, name: string) { return this.request<SkillRecord>(`/api/skills/${encodeURIComponent(skillId)}/name`, { method: 'PUT', body: JSON.stringify({ name }) }) }
  createSkillEditorSession(skillId?: string) { return this.request<SkillEditorSession>('/api/skill-editor/sessions', { method: 'POST', body: JSON.stringify(skillId ? { skill_id: skillId } : {}) }) }
  skillEditorSession(threadId: string) { return this.request<SkillEditorSession>(`/api/skill-editor/sessions/${encodeURIComponent(threadId)}`) }
  async runtimeJournal(threadId: string, runId: string) { return this.request<{ items: Array<Record<string, unknown>> }>('/api/runtime/journal', { method: 'POST', body: JSON.stringify({ thread_id: threadId, run_id: runId, limit: 2000 }) }) }
  async runtimeDebug(threadId: string, runId: string) { return this.request<{ items: Array<Record<string, unknown>> }>('/api/runtime/debug', { method: 'POST', body: JSON.stringify({ thread_id: threadId, run_id: runId, limit: 1000 }) }) }
  async runtimeTrace(threadId: string, runId: string) { return this.request<{ run_id: string | null; failure: Record<string, unknown> | null; loops: Array<{ loop_index: number; model: Array<Record<string, unknown>>; middleware: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>>; run: Array<Record<string, unknown>> }> }>('/api/runtime/trace', { method: 'POST', body: JSON.stringify({ thread_id: threadId, run_id: runId }) }) }
  // This is used to restore visible process cards after an app restart, not
  // to export an entire debug journal.  A 5,000-event response contains full
  // model payloads and made startup fan out into multi-GB worker allocations.
  async runtimeEvents(threadId: string, runId: string, limit = 600) { return this.request<{ items: Array<Record<string, unknown>> }>('/api/runtime/events', { method: 'POST', body: JSON.stringify({ thread_id: threadId, run_id: runId, limit }) }) }
  async listMcp() { return this.request<unknown>('/api/mcp/credentials?page_size=100').then(value => this.items<McpRecord>(value, ['items', 'credentials'])) }
  saveMcp(input: { connectionId?: string; name: string; transport: string; target: string; description?: string; enabled: boolean; headers?: Record<string, string>; env?: Record<string, string>; args?: string[] }) {
    return this.request<McpRecord>(input.connectionId ? `/api/mcp/credentials/${encodeURIComponent(input.connectionId)}` : '/api/mcp/credentials', { method: input.connectionId ? 'PUT' : 'POST', body: JSON.stringify({ name: input.name, transport: input.transport, url_or_command: input.target, description: input.description || '', enabled: input.enabled, headers: input.headers || {}, env: input.env || {}, args: input.args || [] }) })
  }
  deleteMcp(connectionId: string) { return this.request<{ deleted: boolean }>(`/api/mcp/credentials/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }) }
  testMcp(connectionId: string) { return this.request<{ ok: boolean; tools: Array<{ name: string; exposed_name: string; description: string }> }>('/api/mcp/test', { method: 'POST', body: JSON.stringify({ connection_id: connectionId }) }) }
  bindAgentMcp(agentId: string, connections: Array<{ connection_id: string; allowlist: string[] }>) { return this.request<AgentRecord>(`/api/agents/${encodeURIComponent(agentId)}/mcp-endpoints`, { method: 'PUT', body: JSON.stringify({ connections }) }) }
  async streamChat(threadId: string, agentId: string, content: string, onText: (value: string) => void, signal: AbortSignal, onTitle?: (title: string) => void, onRunId?: (runId: string) => void, onActivity?: () => void, onEvent?: (event: StructuredRunEvent) => void, attachments: ChatAttachment[] = [], modelId?: string) {
    return this.streamEmbedded(threadId, agentId, content, onText, signal, onTitle, onRunId, onActivity, onEvent, attachments, modelId)
  }

  private async streamEmbedded(threadId: string, agentId: string, content: string, onText: (value: string) => void, signal: AbortSignal, onTitle?: (title: string) => void, onRunId?: (runId: string) => void, onActivity?: () => void, onEvent?: (event: StructuredRunEvent) => void, attachments: ChatAttachment[] = [], modelId?: string) {
    const runtime = window.tugo?.runtime
    if (!runtime) throw new Error('Embedded Runtime 不可用')
    const subscriptionId = `stream_${crypto.randomUUID()}`
    let accumulated = ''
    let liveCallId = ''
    let liveCallBase = ''
    let runId = ''
    let terminalError: Error | null = null
    const pickText = (value: unknown): string => {
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.map(pickText).join('')
      if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>
        for (const key of ['delta', 'text', 'content', 'title']) { const text = pickText(object[key]); if (text) return text }
      }
      return ''
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        removeEvent(); removeEnd(); signal.removeEventListener('abort', abort)
        error ? reject(error) : resolve(accumulated)
      }
      const removeEvent = runtime.onEvent(({ subscriptionId: incoming, event }) => {
        if (incoming !== subscriptionId) return
        onActivity?.()
        const type = String(event.type || '').toLowerCase()
        const payload = (event.payload || {}) as Record<string, unknown>
        onEvent?.({ type, payload, sequence: Number(event.sequence) || undefined, toolCallId: String(event.tool_call_id || '').trim() || undefined, eventId: String(event.event_id || '').trim() || undefined })
        if (type === 'session.started') {
          runId = String(event.run_id || payload.run_id || '')
          if (runId) onRunId?.(runId)
        } else if (type === 'session.title' || type.endsWith('.title')) {
          const title = pickText(payload.title || payload)
          if (title) onTitle?.(title)
        } else if (type === 'agent.message.delta') {
          const callId = String(payload.call_id || event.tool_call_id || '')
          if (callId && callId !== liveCallId) { liveCallId = callId; liveCallBase = accumulated }
          const text = pickText(payload.delta)
          if (text) { accumulated += text; onText(accumulated) }
        } else if (type === 'agent.message.completed') {
          const text = pickText(payload.content)
          if ('content' in payload) { accumulated = text; onText(accumulated) }
        } else if (type === 'llm.call.failed') {
          if (payload.discard_output === true && liveCallId) { accumulated = liveCallBase; liveCallId = ''; onText(accumulated) }
        } else if (type === 'session.failed') {
          terminalError = new TuGoRunError({
            error_code: pickText(payload.error_code),
            phase: pickText(payload.phase),
            retryable: payload.retryable === true,
            user_message: pickText(payload.user_message),
            user_action: pickText(payload.user_action),
            technical_detail: pickText(payload.technical_detail || payload.error_detail),
            message: pickText(payload.message),
            error_category: pickText(payload.error_category),
            provider_error: payload.provider_error && typeof payload.provider_error === 'object'
              ? payload.provider_error as Record<string, unknown>
              : undefined,
          })
        } else if (type === 'session.interrupted') {
          terminalError = new DOMException(pickText(payload.message) || '已取消本次 AI 操作', 'AbortError')
        }
      })
      const removeEnd = runtime.onStreamEnd(({ subscriptionId: incoming }) => {
        if (incoming === subscriptionId) finish(terminalError || undefined)
      })
      const abort = () => {
        if (runId) void runtime.request('run.cancel', { run_id: runId })
        finish(new DOMException(signal.reason === 'timeout' ? 'AI 长时间没有响应，已自动停止本次操作。' : '已取消本次 AI 操作。', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      runtime.request<{ run_id: string }>('run.start', { thread_id: threadId, agent_id: agentId, content, subscription_id: subscriptionId, attachment_ids: attachments.map(item => item.attachmentId), prompt_locale: promptLanguageFor(effectiveLanguage(this.config.language)), ...(modelId ? { model_id: modelId } : {}) })
        .then(result => { runId = result.run_id; onRunId?.(runId); if (signal.aborted) abort() })
        .catch(error => finish(error instanceof Error ? error : new Error(String(error))))
    })
  }
}
