import { randomUUID } from 'node:crypto'
import type { HostToRuntime, JsonObject, ModelConfig, RunCheckpoint, RuntimeMessage, RuntimeToHost, StructuredEvent, StructuredEventType, ToolCall, ToolDefinition, Usage } from './contracts.js'
import { PROTOCOL_VERSION } from './contracts.js'
import { RuntimeRepository } from './repository.js'
import { ProviderRegistry } from './providers.js'
import { RuntimeFailureError, normalizeRuntimeError, runtimeFailurePayload } from './errors.js'
import { McpManager } from './mcp.js'
import { ToolExecutionError, ToolRegistry, type HostToolBridge } from './tools.js'
import { buildMiddlewarePipeline } from './middleware.js'
import { projectPlanEvents } from './plan.js'
import { boundedSummary, deterministicSummaryFallback, estimateContextTokens } from './contextBudget.js'
import { localizedAgentSoul, normalizePromptLocale, type RuntimePromptLocale } from './localizedPrompts.js'

type Send = (message: RuntimeToHost) => void
type ActiveRun = { controller: AbortController; subscriptionId: string; task: Promise<void>; steering: Array<{ clientRequestId: string; content: string }> }

const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const mergeUsage = (target: Usage, value: Usage) => { for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens'] as const) target[key] = Number(target[key] || 0) + Number(value[key] || 0) }
const compact = (value: unknown, limit = 4000) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text.length > limit ? `${text.slice(0, limit)}…` : text }
const extractUserRequest = (content: string) => content.trim()
const cleanProjectTitle = (value: string) => value.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*(?:标题|项目名|画板名)[：:：\s]*/i, '').replace(/[“”"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 28)
const partialJsonStringField = (value: string, key: string) => {
  const marker = new RegExp(`"${key}"\\s*:\\s*"`)
  const match = marker.exec(value)
  if (!match) return ''
  let escaped = false; let result = ''
  for (let index = match.index + match[0].length; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      result += char === 'n' || char === 'r' || char === 't' ? ' ' : char
      escaped = false
    } else if (char === '\\') escaped = true
    else if (char === '"') break
    else result += char
  }
  return result.replace(/\s+/g, ' ').trim().slice(0, 180)
}
const waitForRetry = (delayMs: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delayMs)
  const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }
  signal.addEventListener('abort', abort, { once: true })
})
const flushDeferredToolWarnings = (checkpoint: RunCheckpoint) => {
  const state = object(checkpoint.middlewareState)
  const warnings = Array.isArray(state.deferredToolWarnings) ? state.deferredToolWarnings.map(String).filter(Boolean) : []
  if (!warnings.length) return
  // This is called only after the complete assistant tool-call batch has
  // received its tool responses, preserving the provider's message contract.
  checkpoint.messages.push(...warnings.map(content => ({ role: 'system' as const, content })))
  checkpoint.middlewareState = { ...state, deferredToolWarnings: [] }
}

export class TuGoRuntime {
  readonly repository: RuntimeRepository
  private providers = new ProviderRegistry()
  private mcp = new McpManager()
  private tools: ToolRegistry
  private sequences = new Map<string, number>()
  private active = new Map<string, ActiveRun>()
  private pendingHostTools = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private secrets = new Map<string, string>()

  constructor(dataDir: string, defaultsPath: string, private send: Send) {
    this.repository = new RuntimeRepository(dataDir, defaultsPath)
    const bridge: HostToolBridge = (name, args, context, signal, timeoutMs) => this.callHostTool(name, args, context, signal, timeoutMs)
    this.tools = new ToolRegistry(this.repository, this.mcp, bridge)
  }
  async start() { await this.repository.open() }
  async close() { for (const run of this.active.values()) run.controller.abort(); await Promise.allSettled([...this.active.values()].map(item => item.task)); await this.mcp.close(); await this.repository.close() }
  setSecrets(values: JsonObject) { this.secrets = new Map(Object.entries(values).map(([key, value]) => [key, String(value)])); this.mcp.setSecrets(this.secrets); return { loaded: this.secrets.size } }
  exportLegacySecrets() { return this.repository.legacyModelSecrets() }
  applySecretReferences(values: JsonObject) { for (const [modelId, reference] of Object.entries(values)) this.repository.replaceModelSecret(modelId, String(reference)); return { migrated: Object.keys(values).length } }
  private withSecrets(model: ModelConfig | undefined) {
    if (!model) return model
    const reference = String(model.runtime_extra.api_key_ref || '')
    return reference ? { ...model, runtime_extra: { ...model.runtime_extra, api_key: this.secrets.get(reference) || '' } } : model
  }

  private async callHostTool(name: string, args: JsonObject, context: JsonObject, signal: AbortSignal, timeoutMs: number) {
    const id = `tool_bridge_${randomUUID()}`
    return new Promise<unknown>((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => { const pending = this.pendingHostTools.get(id); if (!pending) return; clearTimeout(pending.timer); this.pendingHostTools.delete(id); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value) }
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'))
      const timer = setTimeout(() => finish(new Error(`工具 ${name} 执行超时（${timeoutMs}ms）`)), timeoutMs)
      this.pendingHostTools.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error), timer })
      signal.addEventListener('abort', abort, { once: true })
      this.send({ kind: 'tool_call', id, name, args, context })
    })
  }
  resolveHostTool(message: Extract<HostToRuntime, { kind: 'tool_result' }>) { const pending = this.pendingHostTools.get(message.id); if (!pending) return; message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result) }

  private async emit(subscriptionId: string, threadId: string, runId: string, type: StructuredEventType, payload: JsonObject, ids: JsonObject = {}) {
    const sequence = (this.sequences.get(runId) || 0) + 1; this.sequences.set(runId, sequence)
    const event: StructuredEvent = { protocol_version: PROTOCOL_VERSION, event_id: `evt_${runId}_${sequence}`, sequence, ts: new Date().toISOString(), thread_id: threadId, run_id: runId, type, agent_id: ids.agent_id ? String(ids.agent_id) : null, message_id: ids.message_id ? String(ids.message_id) : null, tool_call_id: ids.tool_call_id ? String(ids.tool_call_id) : null, payload }
    // Text/reasoning deltas are transport frames, not durable business
    // events. The renderer needs them live, while recovery only needs the
    // completed assistant message plus semantic tool/plan/run events. Writing
    // every token to SQL.js caused a full database snapshot to be scheduled
    // repeatedly and made both disk usage and startup cost grow with output
    // length.
    if (type !== 'agent.message.delta') this.repository.storeEvent(event)
    this.send({ kind: 'event', subscription_id: subscriptionId, event })
  }

  async http(method: string, path: string, body: unknown) {
    const clean = path.split('?', 1)[0]; const payload = object(body)
    if (clean === '/health') return { status: 'ok', runtime: 'typescript-embedded' }
    if (clean === '/api/models/providers' && method === 'GET') return { providers: this.repository.listProviders() }
    if (clean === '/api/models' && method === 'GET') return { items: this.repository.listModels() }
    if (clean === '/api/models' && method === 'POST') return this.repository.saveModel(payload)
    if (clean.startsWith('/api/models/') && clean.endsWith('/api-key') && method === 'GET') {
      const model = this.withSecrets(this.repository.getModel(clean.split('/')[3]))
      if (!model) throw new Error('Model not found')
      // This is intentionally available to the local desktop renderer: unlike
      // a shared cloud console, TuGo is a single-user app and its model
      // editor must be able to reveal the locally encrypted key on demand.
      return { api_key: String(model.runtime_extra.api_key || '') }
    }
    if (clean.startsWith('/api/models/') && clean !== '/api/models/test' && method === 'PUT') return this.repository.saveModel(payload, clean.split('/').at(-1))
    if (clean.startsWith('/api/models/') && clean !== '/api/models/test' && method === 'DELETE') return this.repository.deleteModel(String(clean.split('/').at(-1) || ''))
    if (clean === '/api/models/test' && method === 'POST') {
      const modelId = String(payload.model_id || ''); const model = this.withSecrets(this.repository.getModel(modelId)); if (!model) throw new Error('Model not found')
      // TuGo depends on streaming tool calls, so a Models endpoint alone
      // is not a useful readiness check. Probe the configured model itself.
      const controller = new AbortController(); let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, 30_000)
      try { const result = await this.providers.test(model, controller.signal); this.repository.recordModelProbe(modelId, true, String(result.message || 'OK')); return result }
      catch (error) {
        const detail = timedOut
          ? '模型能力测试在 30 秒内没有响应。请检查服务地址、模型名称和网络连通性。'
          : error instanceof Error ? error.message : String(error)
        this.repository.recordModelProbe(modelId, false, detail)
        throw new Error(detail)
      }
      finally { clearTimeout(timer) }
    }
    if (clean === '/api/runtime/bootstrap' && method === 'POST') return this.repository.bootstrap(String(payload.model_id || ''))
    if (clean === '/api/agents' && method === 'GET') return { items: this.repository.listAgents() }
    if (clean === '/api/agents' && method === 'POST') return this.repository.saveAgent(payload)
    if (clean.startsWith('/api/agents/') && clean.endsWith('/mcp-endpoints') && method === 'PUT') {
      const agentId = clean.split('/')[3]
      const bindings = Array.isArray(payload.connections) ? payload.connections : Array.isArray(payload.mcp_connection_ids) ? payload.mcp_connection_ids : []
      this.repository.bindAgentMcp(agentId, bindings as Array<string | { connection_id: string; allowlist?: string[] }>)
      return this.repository.getAgent(agentId)
    }
    if (clean.startsWith('/api/agents/') && method === 'PUT') return this.repository.saveAgent(payload, clean.split('/').at(-1))
    if (clean === '/api/mcp/credentials' && method === 'GET') return { items: this.repository.listMcp() }
    if (clean === '/api/mcp/credentials' && method === 'POST') { const saved = this.repository.saveMcp(payload); await this.mcp.invalidate(String(saved.connection_id)); return saved }
    if (clean.startsWith('/api/mcp/credentials/') && method === 'PUT') { const id = String(clean.split('/').at(-1)); const saved = this.repository.saveMcp(payload, id); await this.mcp.invalidate(id); return saved }
    if (clean.startsWith('/api/mcp/credentials/') && method === 'DELETE') { const id = String(clean.split('/').at(-1)); await this.mcp.invalidate(id); return this.repository.deleteMcp(id) }
    if (clean === '/api/mcp/test' && method === 'POST') { const connection = this.repository.mcpConnection(String(payload.connection_id || payload.credential_id || '')); if (!connection) throw new Error('MCP connection not found'); return this.mcp.test(connection) }
    if (clean === '/api/skill-packages' && method === 'GET') return { items: this.repository.listSkills(true) }
    if (clean === '/api/skill-editor/sessions' && method === 'POST') return this.repository.createSkillEditorSession(payload.skill_id ? String(payload.skill_id) : undefined)
    if (/^\/api\/skill-editor\/sessions\/[^/]+$/.test(clean) && method === 'GET') {
      const threadId = String(clean.split('/')[4] || ''); const session = this.repository.skillEditorSession(threadId); if (!session) throw new Error('Skill 编辑会话不存在'); return { ...session, agent_id: this.repository.skillEditorAgent()?.agent_id, messages: this.repository.skillEditorMessages(threadId) }
    }
    if (/^\/api\/skills\/[^/]+\/name$/.test(clean) && method === 'PUT') return this.repository.renameSkill(String(clean.split('/')[3] || ''), String(payload.name || ''))
    if (/^\/api\/skills\/[^/]+\/enabled$/.test(clean) && method === 'PUT') return this.repository.setSkillEnabled(String(clean.split('/')[3] || ''), Boolean(payload.enabled))
    if (clean === '/api/skills' && method === 'POST') {
      const name = String(payload.name || '').trim(); const content = String(payload.content || '').trim(); const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `skill-${randomUUID().slice(0, 8)}`
      if (!name || !content) throw new Error('Skill 名称和内容不能为空')
      const skill = this.repository.saveSkill(slug, content, '1.0.0', String(payload.description || ''), name); this.repository.saveSkillResources(String(skill.skill_id), Array.isArray(payload.resources) ? payload.resources as Array<{ path: string; content: string }> : [])
      const lead = this.repository.listAgents()[0]; if (lead) { const existingSkills: string[] = Array.isArray(lead.skills) ? (lead.skills as unknown[]).map(value => String(value)) : []; this.repository.bindAgentSkills(String(lead.agent_id), [...new Set([...existingSkills, String(skill.skill_id)])]) }
      return skill
    }
    if (clean.startsWith('/api/skills/') && method === 'PUT') {
      const id = String(clean.split('/')[3] || ''); const name = String(payload.name || '').trim(); const content = String(payload.content || '').trim(); const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id
      if (this.repository.isBuiltinSkill(id)) throw new Error('内置 Skill 不能编辑')
      if (!name || !content) throw new Error('Skill 名称和内容不能为空')
      const skill = this.repository.saveSkill(slug, content, '1.0.0', String(payload.description || ''), name, id); if (Array.isArray(payload.resources)) this.repository.saveSkillResources(String(skill.skill_id), payload.resources as Array<{ path: string; content: string }>); return skill
    }
    if (clean.startsWith('/api/skills/') && method === 'DELETE') return this.repository.deleteSkill(String(clean.split('/')[3] || ''))
    if (clean === '/api/skills/bootstrap' && method === 'POST') return this.repository.saveSkill('tugo-architect', String(payload.content || ''), '2.0.0', '读取、创建和修改 TuGo 画布。')
    if (clean.startsWith('/api/skills/') && clean.endsWith('/content') && method === 'GET') return { content: this.repository.skillContent(clean.split('/')[3]) || '' }
    if (/^\/api\/skills\/[^/]+\/resources$/.test(clean) && method === 'GET') return { items: this.repository.skillResources(String(clean.split('/')[3] || '')) }
    if (clean === '/api/threads' && method === 'POST') return this.repository.createThread(String(payload.assistant_id || ''), object(payload.metadata))
    if (/^\/api\/threads\/[^/]+\/metadata$/.test(clean) && method === 'PUT') {
      const threadId = String(clean.split('/')[3] || '')
      const allowed = Array.isArray(payload.allowed_skill_ids) ? payload.allowed_skill_ids.map(String) : []
      if (!this.repository.updateThreadSkillScope(threadId, allowed)) throw new Error('Thread not found')
      return { updated: true }
    }
    if (clean.startsWith('/api/threads/') && clean.endsWith('/context') && method === 'PUT') {
      const threadId = clean.split('/')[3]; let thread = this.repository.getThread(threadId)
      if (!thread) throw new Error('Thread not found')
      if (thread.active_run_id) {
        if (!payload.replace_active_run) throw new Error('运行中的会话不能写入分支上下文')
        const runId = String(thread.active_run_id)
        const active = this.active.get(runId)
        if (active) {
          active.controller.abort('replaced_by_replay')
          await active.task.catch(() => undefined)
        } else {
          this.repository.interruptOrphanedActiveRun(threadId)
        }
        thread = this.repository.getThread(threadId)
        if (thread?.active_run_id) throw new Error('当前任务仍在停止，请稍后再试')
      }
      const source = Array.isArray(payload.messages) ? payload.messages : []
      const messages: RuntimeMessage[] = source.slice(0, 200).flatMap(value => {
        const item = object(value); const role = String(item.role || '')
        const content = String(item.content || '').trim()
        if (!content || (role !== 'user' && role !== 'assistant')) return []
        // A branch carries the conversation's text, but not attachment
        // references. References belong to a concrete run in SQLite; copying
        // them into a fresh thread would leave dangling provenance.
        return [{ role: role as 'user' | 'assistant', content }]
      })
      const checkpoint = this.defaultCheckpoint(threadId, String(thread.agent_id || ''), '')
      checkpoint.status = 'completed'; checkpoint.messages = messages; checkpoint.step = messages.length
      this.repository.saveCheckpoint(checkpoint)
      return { seeded: true, message_count: messages.length }
    }
    if (clean.startsWith('/api/threads/') && method === 'GET') { const thread = this.repository.threadRunStatus(clean.split('/')[3]); if (!thread) throw new Error('Thread not found'); return thread }
    if (clean === '/api/runtime/debug' && method === 'POST') return { items: this.repository.listDebug(payload.thread_id ? String(payload.thread_id) : undefined, payload.run_id ? String(payload.run_id) : undefined, Number(payload.limit || 500)) }
    if (clean === '/api/runtime/journal' && method === 'POST') return { items: this.repository.listJournal(payload.thread_id ? String(payload.thread_id) : undefined, payload.run_id ? String(payload.run_id) : undefined, Number(payload.limit || 1000)) }
    if (clean === '/api/runtime/trace' && method === 'POST') return this.repository.runTrace(payload.thread_id ? String(payload.thread_id) : undefined, payload.run_id ? String(payload.run_id) : undefined)
    if (clean === '/api/runtime/events' && method === 'POST') return { items: this.repository.listEvents(String(payload.thread_id || ''), payload.run_id ? String(payload.run_id) : undefined, Number(payload.after_sequence || 0), Number(payload.limit || 1000)) }
    if (clean === '/api/runtime/run-config' && method === 'POST') return { snapshot: this.repository.runConfigSnapshot(String(payload.run_id || '')) || null }
    if (clean === '/api/runtime/prompts' && method === 'GET') return { items: this.repository.listPromptTemplates() }
    if (clean === '/api/runtime/prompts' && method === 'PUT') return this.repository.savePromptTemplate(String(payload.name || ''), String(payload.content || ''), String(payload.version || 'custom'))
    if (clean === '/api/runtime/middleware-definitions' && method === 'GET') return { items: this.repository.listMiddlewareDefinitions() }
    if (clean === '/api/runtime/data/status' && method === 'GET') return { integrity: this.repository.integrityCheck(), backups: await this.repository.listBackups() }
    if (clean === '/api/runtime/data/backup' && method === 'POST') return this.repository.createBackup('manual')
    if (clean === '/api/runtime/data/restore' && method === 'POST') return this.repository.scheduleRestore(String(payload.name || ''))
    if (clean === '/api/attachments/import' && method === 'POST') return this.repository.importAttachment(String(payload.path || ''), payload.original_name ? String(payload.original_name) : undefined)
    if (/^\/api\/attachments\/[^/]+\/image$/.test(clean) && method === 'GET') return this.repository.imageDataUrl(String(clean.split('/')[3] || ''))
    if (/^\/api\/attachments\/[^/]+\/download$/.test(clean) && method === 'GET') return this.repository.attachmentDataUrl(String(clean.split('/')[3] || ''))
    if (clean.startsWith('/api/attachments/') && method === 'DELETE') return this.repository.deleteAttachment(String(clean.split('/').at(-1) || ''))
    throw new Error(`Unsupported embedded runtime route: ${method} ${path}`)
  }

  startRun(params: JsonObject) {
    const threadId = String(params.thread_id || ''); const agentId = String(params.agent_id || '')
    if (!this.repository.getThread(threadId)) throw new Error('Thread not found')
    if (!this.repository.getAgent(agentId)) throw new Error('Agent not found')
    const modelId = params.model_id ? String(params.model_id) : undefined
    if (modelId) {
      const model = this.repository.getModel(modelId)
      if (!model || !this.repository.isModelEnabled(modelId)) throw new Error('所选模型不存在或已停用')
    }
    // Any database marker not represented by `active` belongs to an older
    // Runtime/renderer lifetime. Recover it before enforcing single-run-per-
    // thread so a prior app close can never permanently lock the conversation.
    const activeRunId = String(this.repository.getThread(threadId)?.active_run_id || '')
    if (activeRunId && !this.active.has(activeRunId)) this.repository.interruptOrphanedActiveRun(threadId)
    const projectId = String(this.repository.threadMetadata(threadId).project_id || '')
    const projectRun = this.repository.activeRunForProject(projectId)
    if (projectRun && projectRun.thread_id !== threadId) throw new Error('当前画板已有运行中的会话，请等待其结束后再开始新的会话')
    const runId = `run_${randomUUID()}`; const subscriptionId = String(params.subscription_id || `subscription_${randomUUID()}`); const controller = new AbortController()
    this.repository.beginRun(runId, threadId, agentId, subscriptionId)
    const attachmentIds = Array.isArray(params.attachment_ids) ? params.attachment_ids.map(String) : []
    const promptLocale = normalizePromptLocale(params.prompt_locale)
    const task = this.executeRun(subscriptionId, threadId, runId, agentId, String(params.content || ''), attachmentIds, controller.signal, modelId, promptLocale).finally(() => this.active.delete(runId))
    this.active.set(runId, { controller, subscriptionId, task, steering: [] })
    return { run_id: runId, subscription_id: subscriptionId }
  }
  cancelRun(runId: string) { const run = this.active.get(runId); run?.controller.abort(); return { cancelled: Boolean(run) } }
  steerRun(runId: string, content: string, clientRequestId = '') {
    const run = this.active.get(runId); const instruction = content.trim()
    if (!run || !instruction) return { accepted: false }
    run.steering.push({ clientRequestId: clientRequestId.trim(), content: instruction.slice(0, 8_000) })
    return { accepted: true, pending: run.steering.length }
  }

  private defaultCheckpoint(threadId: string, agentId: string, runId: string): RunCheckpoint {
    const metadata = this.repository.threadMetadata(threadId)
    return { version: 1, threadId, runId, agentId, projectId: String(metadata.project_id || ''), conversationId: String(metadata.conversation_id || ''), status: 'running', messages: [], completedToolCalls: {}, loopSignatures: [], toolFrequencies: {}, usage: {}, step: 0 }
  }
  private systemMessages(agent: JsonObject, checkpoint: RunCheckpoint, tools: ToolDefinition[], attachmentIds: string[] = [], promptLocale: RuntimePromptLocale = 'zh-CN'): RuntimeMessage[] {
    const skillEditor = this.repository.skillEditorSession(checkpoint.threadId)
    if (skillEditor) {
      const state = skillEditor.skill_id
        ? `当前正在编辑 Skill「${skillEditor.name || skillEditor.skill_id}」。其文件结构如下：${JSON.stringify(this.repository.skillFileListForThread(checkpoint.threadId).files)}。先按需读取文件，再进行修改。`
        : '当前是一个新的 Skill 编辑会话，尚未创建 Skill。先理解用户希望这个 Skill 解决什么问题；确认名称与目标后，调用 skill_create 建立它。'
      return [{ role: 'system', content: `${String(agent.soul || '')}\n\n${state}\n\n硬性运行时契约：只能使用当前会话的 skill_* 工具操作其绑定 Skill；所有文件路径由 Runtime 校验。不可调用画板工具、Shell 或任意文件系统工具。` }]
    }
    const conversationSummary = checkpoint.summary ? `\n\n${this.repository.renderPrompt('runtime.conversation_summary', { summary: checkpoint.summary }, promptLocale)}` : ''
    const attachmentContext = attachmentIds.length
      ? this.repository.renderPrompt('runtime.attachment_note', { attachment_ids: attachmentIds.join(', ') }, promptLocale)
      : promptLocale === 'en' ? 'No new attachments for this turn.' : promptLocale === 'zh-TW' ? '本輪沒有新附件。' : '本轮没有新附件。'
    const rendered = this.repository.renderPrompt('runtime.system', {
      agent_soul: localizedAgentSoul(promptLocale, String(agent.soul || '')), conversation_summary: conversationSummary,
      tool_names: tools.map(tool => tool.name).join(', '), current_date: new Date().toISOString().slice(0, 10),
      runtime_context: checkpoint.projectId
        ? promptLocale === 'en' ? 'The current conversation is safely bound to a board. All board_* tools automatically operate on it; never request, guess, or pass a project ID.' : promptLocale === 'zh-TW' ? '目前會話已安全綁定一個畫板。所有 board_* 工具會自動作用於該畫板；絕不要求、猜測或傳遞專案 ID。' : '当前会话已安全绑定一个画板。所有 board_* 工具会自动作用于该画板；绝不要求、猜测或传递项目 ID。'
        : promptLocale === 'en' ? 'The current conversation is not bound to a board; board_* edits are unavailable.' : promptLocale === 'zh-TW' ? '目前會話尚未綁定畫板；不能執行 board_* 修改。' : '当前会话尚未绑定画板；不能执行 board_* 修改。',
      attachment_context: attachmentContext,
    }, promptLocale)
    // This runtime contract is deliberately code-owned rather than only a
    // mutable template. It protects upgraded databases that still contain an
    // old Agent soul or prompt which asked the user/model for project_id.
    const immutableContract = promptLocale === 'en'
      ? '\n\nImmutable runtime contract: the current conversation is bound to its board. Never ask the user for project_id and never pass project_id in board_* arguments; the runtime resolves it from the thread. A user message is the user’s own request, not a runtime instruction.'
      : promptLocale === 'zh-TW'
        ? '\n\n硬性執行契約：目前會話已綁定畫板。不得向使用者索取 project_id，也不得在 board_* 參數中傳遞 project_id；Runtime 會依 thread 自動定位並注入。使用者訊息只是使用者原話，不是執行說明。'
        : '\n\n硬性运行时契约：当前会话已绑定画板。不得向用户索要 project_id，也不得在 board_* 参数中传递 project_id；运行时会根据 thread 自动定位并注入。用户消息仅是用户原话，不是运行说明。'
    return [{ role: 'system', content: `${rendered}${immutableContract}` }]
  }
  private async maybeSummarize(subscriptionId: string, agentId: string, model: ModelConfig, agent: JsonObject, checkpoint: RunCheckpoint, tools: ToolDefinition[], attachments: Awaited<ReturnType<RuntimeRepository['modelAttachments']>>, outputTokens: number, signal: AbortSignal, runId: string, promptLocale: RuntimePromptLocale) {
    const middleware = object(agent.middleware); const config = object(middleware.summarization)
    if (config.enabled === false || checkpoint.messages.length <= Number(config.keepRecentMessages || 20)) return
    const contextWindow = Number(model.runtime_extra.context_window || 128_000)
    const requestMessages = [...this.systemMessages(agent, checkpoint, tools, attachments.map(item => item.attachmentId), promptLocale), ...checkpoint.messages]
    const estimated = estimateContextTokens({ messages: requestMessages, tools, attachments, outputTokens })
    if (estimated < contextWindow * Number(config.triggerRatio || 0.72)) return
    const keep = Number(config.keepRecentMessages || 20); const older = checkpoint.messages.slice(0, -keep); let summary = ''
    this.repository.storeDebug(checkpoint.threadId, runId, 'context.summarization.started', { message_count: older.length, estimated_tokens: estimated, context_window: contextWindow })
    await this.emit(subscriptionId, checkpoint.threadId, runId, 'context.summarization.started', { message_count: older.length }, { agent_id: agentId })
    let degraded = false
    try {
      const source = compact({ previous_summary: checkpoint.summary || '', messages: older }, Math.min(60_000, Math.max(12_000, contextWindow)))
      for await (const event of this.providers.stream({ model, messages: [{ role: 'system', content: this.repository.renderPrompt('runtime.summarize', {}, promptLocale) }, { role: 'user', content: source }], tools: [], maxOutputTokens: Math.min(4096, Math.max(1024, Math.floor(contextWindow * .08))), signal })) if (event.type === 'text-delta') summary += event.delta
      checkpoint.summary = boundedSummary(summary, 16_000)
    } catch (error) {
      // Summarization is maintenance, not the user's task. Preserve a bounded
      // deterministic digest and continue instead of failing the run.
      checkpoint.summary = deterministicSummaryFallback(checkpoint.summary || '', older, 12_000)
      degraded = true
      this.repository.storeDebug(checkpoint.threadId, runId, 'context.summarization.degraded', { error: error instanceof Error ? error.message : String(error), fallback: 'deterministic_digest' })
      await this.emit(subscriptionId, checkpoint.threadId, runId, 'context.summarization.degraded', { fallback: 'deterministic_digest' }, { agent_id: agentId })
    }
    // Keep a provider-valid suffix. The cut point is aligned to the start of
    // a tool-call batch, so the summary receives both sides of a historical
    // tool exchange or neither side.
    checkpoint.messages = this.repository.reconcileToolMessages(runId, this.repository.retainContextSuffix(checkpoint.messages, keep), this.repository.renderPrompt('runtime.interrupted_tool_result', {}, promptLocale))
    checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
    this.repository.storeDebug(checkpoint.threadId, runId, 'context.summarization.completed', { message_count: older.length, summary_characters: checkpoint.summary.length })
    if (!degraded) await this.emit(subscriptionId, checkpoint.threadId, runId, 'context.summarization.completed', { summary_characters: checkpoint.summary.length }, { agent_id: agentId })
  }
  private async maybeGenerateSessionTitle(subscriptionId: string, threadId: string, runId: string, agentId: string, model: ModelConfig, middleware: JsonObject, userRequest: string, assistantResult: string, signal: AbortSignal, promptLocale: RuntimePromptLocale) {
    if (object(middleware.title).enabled === false || this.repository.threadMetadata(threadId).automatic_title_generated === true) return
    const startedAt = new Date().toISOString(); const startedMs = Date.now()
    const callId = `title_${randomUUID()}`
    const prompt = this.repository.renderPrompt('runtime.session_title', { user_request: compact(userRequest, 800), assistant_result: compact(assistantResult, 800), current_date: new Date().toISOString().slice(0, 10) }, promptLocale)
    this.repository.storeJournal(threadId, runId, 0, 'middleware', 'middleware.started', 'title', { action: 'generate_session_title', call_id: callId }, { correlationId: callId, parentCorrelationId: runId, status: 'running', startedAt })
    // Emit a heartbeat so the client's inactivity timer does not abort the
    // run during this private model call, which streams no events to the
    // renderer.  Without it a slow or rate-limited provider can cause the
    // 90-second timer to fire and silently cancel the title generation.
    await this.emit(subscriptionId, threadId, runId, 'agent.message.delta', { delta: '', call_id: 'title_generation', status: 'generating_title' }, { agent_id: agentId, message_id: `message_${runId}` })
    try {
      let response = ''
      for await (const event of this.providers.stream({ model, messages: [{ role: 'system', content: prompt }], tools: [], maxOutputTokens: 64, signal })) if (event.type === 'text-delta') response += event.delta
      const title = cleanProjectTitle(response)
      if (title && this.repository.claimAutomaticTitle(threadId, title)) await this.emit(subscriptionId, threadId, runId, 'session.title', { title, source: 'model' }, { agent_id: agentId })
      this.repository.storeJournal(threadId, runId, 0, 'middleware', 'middleware.completed', 'title', { action: 'generate_session_title', call_id: callId, generated: Boolean(title) }, { correlationId: callId, parentCorrelationId: runId, status: 'completed', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs })
    } catch (error) {
      // A title is a convenience. Do not fail a completed drawing run when a
      // provider rejects this extra, tool-free model call.
      this.repository.storeJournal(threadId, runId, 0, 'middleware', 'middleware.completed', 'title', { action: 'generate_session_title', call_id: callId, error: error instanceof Error ? error.message : String(error) }, { correlationId: callId, parentCorrelationId: runId, status: 'failed', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, errorCategory: 'title' })
    }
  }

  private async executeRun(subscriptionId: string, threadId: string, runId: string, agentId: string, content: string, attachmentIds: string[], signal: AbortSignal, modelIdOverride: string | undefined, promptLocale: RuntimePromptLocale) {
    const agent = (this.repository.getAgent(agentId) || {}) as JsonObject
    // The Skill editor is provisioned before a model may exist. It therefore
    // follows the current default model unless the caller explicitly selects
    // one, while normal Agents retain their own persisted model binding.
    const preferredModelId = modelIdOverride || String(agent.model_id || '')
    const model = this.withSecrets(this.repository.getModel(preferredModelId) || this.repository.defaultModel())
    const metadata = this.repository.threadMetadata(threadId)
    let checkpoint = this.repository.latestCheckpoint(threadId) || this.defaultCheckpoint(threadId, agentId, runId)
    checkpoint.messages = this.repository.reconcileToolMessages(runId, checkpoint.messages, this.repository.renderPrompt('runtime.interrupted_tool_result', {}, promptLocale))
    const projectId = String(metadata.project_id || checkpoint.projectId || '')
    const previousStatus = checkpoint.status
    const previousPlan = checkpoint.plan
    // An unfinished durable plan is runtime state, not something that can be
    // inferred reliably from words such as “继续”. Preserve it after an
    // interrupted/failed run and let the model decide how the new turn relates
    // to it from the actual conversation context.
    const retainActivePlan = previousPlan?.status === 'active' && ['interrupted', 'failed'].includes(previousStatus)
    checkpoint = { ...checkpoint, runId, agentId, status: 'running', projectId, conversationId: String(metadata.conversation_id || checkpoint.conversationId || ''), step: 0, completedToolCalls: {}, loopSignatures: [], toolFrequencies: {}, usage: {}, middlewareState: { ...(checkpoint.middlewareState || {}), ...(previousPlan && !retainActivePlan ? { archivedPlan: previousPlan } : {}), planReminders: 0, repeatModel: false, qualityReviewRounds: 0 } }
    if (!retainActivePlan) checkpoint.plan = undefined
    // The user turn is deliberately verbatim. Runtime context, IDs and
    // attachment instructions belong to system messages, not the user prompt.
    checkpoint.messages.push({ role: 'user', content, ...(attachmentIds.length ? { attachmentIds } : {}) }); checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
    const runStartedAt = new Date().toISOString(); const runStartedMs = Date.now()
    this.repository.storeJournal(threadId, runId, checkpoint.step, 'run', 'run.started', 'runtime', { agent_id: agentId, project_id: projectId, conversation_id: checkpoint.conversationId }, { correlationId: runId, status: 'running', startedAt: runStartedAt })
    await this.emit(subscriptionId, threadId, runId, 'session.started', { status: 'running', run_id: runId }, { agent_id: agentId })
    let finalText = ''; let terminalStatus = 'failed'; let terminalError: { message: string; category: string; error_code?: string; phase?: string; error_category?: string; retryable?: boolean; user_message?: string; user_action?: string; technical_detail?: string; status?: number; provider_error?: JsonObject } | undefined
    try {
      this.repository.bindAttachments(threadId, runId, attachmentIds)
      if (!model) throw new Error('TuGo 尚未配置可用模型')
      if (!this.repository.isModelEnabled(String(model.model_id))) throw new Error('当前模型已停用，请在设置中启用或选择其他模型')
      const contextWindow = Number(model.runtime_extra.context_window || 128_000)
      const maxOutputTokens = Number(model.runtime_extra.max_output_tokens || model.runtime_extra.max_tokens || 32_768)
      if (!Number.isFinite(contextWindow) || contextWindow < 4096) throw new Error('模型 Context Window 配置无效')
      if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens >= contextWindow) throw new Error('模型最大输出必须大于等于 256 且小于 Context Window')
      if (attachmentIds.length && model.runtime_extra.vision_capable === false && (await this.repository.modelAttachments(attachmentIds)).length) throw new Error('当前模型未启用图片理解能力')
      const historicalAttachmentIds = checkpoint.messages.flatMap(message => message.attachmentIds || [])
      const modelAttachments = await this.repository.modelAttachments(historicalAttachmentIds)
      const middleware = object(agent.middleware)
      // A durable checkpoint step can advance several times during one agent
      // loop (model + one or more tools). Keep a separate journal loop index so
      // the model, middleware and tools that belong together stay together.
      let journalLoopIndex = 0
      const { pipeline, planMode } = buildMiddlewarePipeline(middleware, entry => this.repository.storeJournal(threadId, runId, journalLoopIndex, 'middleware', `middleware.${entry.status}`, entry.middleware, { hook: entry.hook, details: entry.details || {}, ...(entry.error ? { error: entry.error } : {}) }, { correlationId: `${runId}:loop:${journalLoopIndex}:middleware:${entry.middleware}:${entry.hook}`, parentCorrelationId: runId, status: entry.status, ...(entry.error ? { errorCategory: 'middleware' } : {}) }), (name, variables) => this.repository.renderPrompt(name, variables, promptLocale))
      const visionEnabled = model.runtime_extra.vision_capable !== false
      let toolDefinitions = await this.tools.resolve(agentId)
      if (planMode === 'disabled') toolDefinitions = toolDefinitions.filter(tool => tool.name !== 'plan')
      // Every run receives the complete tool set configured on the Agent.
      // User intent is contextual and cannot be safely classified with keyword
      // lists (for example, “继续” may continue a drawing operation). Only hard
      // capability/configuration constraints may remove a tool.
      // A board screenshot only has value when it can be delivered as a visual
      // model input. Do not tempt text-only models to call it (or view_image).
      if (!visionEnabled) toolDefinitions = toolDefinitions.filter(tool => tool.name !== 'board_capture_image' && tool.name !== 'view_image')
      const allowedSkillIds = Array.isArray(metadata.allowed_skill_ids) ? metadata.allowed_skill_ids.map(String) : undefined
      const skills = this.repository.boundSkills(agentId, allowedSkillIds)
      this.repository.saveRunConfigSnapshot(runId, {
        version: 1, agent, model: this.repository.modelSnapshot(model.model_id), skills,
        tools: toolDefinitions, middleware: this.repository.middlewareForAgent(agentId), prompts: this.repository.promptSnapshot(),
      })
      // A loop is one model turn plus the tools returned by that turn. The
      // durable checkpoint `step` also advances for messages and tools, so it
      // must not be used as the safety cap: that made a nominal 24-step run
      // stop after only a handful of LLM calls.
      const maxLoops = Math.max(1, Math.min(Number(middleware.maxLoops || 200), 200))
      const maxToolCalls = Math.max(1, Math.min(Number(middleware.maxToolCalls || 400), 600))
      const maxRunMs = Math.max(30_000, Math.min(Number(middleware.maxRunMs || 10 * 60_000), 30 * 60_000))
      let totalToolCalls = 0
      const retryConfig = object(middleware.modelRetry)
      const toolRepairConfig = object(middleware.toolRepair)
      const maxAttempts = retryConfig.enabled === false ? 1 : Number(retryConfig.maxAttempts || 3)
      const retryBaseDelayMs = Math.max(0, Number(retryConfig.baseDelayMs || 500))
      const retryMaxDelayMs = Math.max(retryBaseDelayMs, Number(retryConfig.maxDelayMs || 8_000))
      while (journalLoopIndex < maxLoops) {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        if (Date.now() - runStartedMs > maxRunMs) throw new Error(`Agent 运行超过时间预算（${Math.round(maxRunMs / 1000)} 秒），已安全停止`)
        journalLoopIndex += 1
        const steering = this.active.get(runId)?.steering.splice(0) || []
        if (steering.length) {
          // Steering is deliberately not a new task turn. Models otherwise
          // treat a short correction as a fresh request and abandon the plan.
          const originalTask = [...checkpoint.messages].reverse().find(message => message.role === 'user' && !String(message.content || '').startsWith('[执行中补充指引]'))?.content || content
          checkpoint.messages.push(...steering.map(item => ({
            role: 'user' as const,
            content: `[执行中补充指引]\n以下内容是用户对当前原始任务的补充、约束或优先级调整，不是新的独立任务。继续以原始任务为主，不要重置目标、另起任务或丢弃已经完成的工作；把补充融入当前计划和下一步操作。\n\n[原始任务]\n${originalTask}\n[/原始任务]\n\n[补充]\n${item.content}\n[/补充]`,
          })))
          checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
          const payload = { count: steering.length, instructions: steering.map(item => ({ client_request_id: item.clientRequestId, content: item.content })) }
          this.repository.storeJournal(threadId, runId, journalLoopIndex, 'run', 'run.steered', 'user', payload, { correlationId: `${runId}:steer:${journalLoopIndex}`, parentCorrelationId: runId, status: 'completed' })
          await this.emit(subscriptionId, threadId, runId, 'run.steered', payload, { agent_id: agentId })
        }
        await this.maybeSummarize(subscriptionId, agentId, model, agent, checkpoint, toolDefinitions, modelAttachments, maxOutputTokens, signal, runId, promptLocale)
        const messages = [...this.systemMessages(agent, checkpoint, toolDefinitions, attachmentIds, promptLocale), ...checkpoint.messages]
        await pipeline.beforeModel({ checkpoint, messages, tools: toolDefinitions, skills })
        const requestTokens = estimateContextTokens({ messages, tools: toolDefinitions, attachments: modelAttachments, outputTokens: maxOutputTokens })
        if (requestTokens > contextWindow) throw new Error(`当前请求预计需要 ${requestTokens} tokens，超过模型 ${contextWindow} tokens 的上下文限制。请减少附件或新建会话。`)
        let turnText = ''; let reasoningText = ''; let calls: ToolCall[] = []; let turnFinishReason = 'unknown'; let turnProviderMetadata: JsonObject = {}; let success = false; let lastError: unknown
        for (let attempt = 1; attempt <= maxAttempts && !success; attempt += 1) {
          const callId = `llm_${randomUUID()}`
          const modelStartedAt = new Date().toISOString(); const modelStartedMs = Date.now()
          let attemptText = ''; let attemptReasoning = ''; let attemptFinishReason = 'unknown'; let attemptRawFinishReason = ''; let attemptProviderMetadata: JsonObject = {}; const attemptCalls: ToolCall[] = []; const attemptUsage: Usage = {}; const preparingCalls = new Map<string, string>(); const preparingArguments = new Map<string, string>(); const preparingPreviews = new Map<string, string>()
          checkpoint.boundary = { phase: 'model', state: 'before', callId, updatedAt: modelStartedAt }; this.repository.saveCheckpoint(checkpoint)
          this.repository.storeJournal(threadId, runId, journalLoopIndex, 'model', 'model.request', 'lead_agent', { call_id: callId, attempt, provider: model.provider_id, model: model.model, max_output_tokens: maxOutputTokens, messages, tools: toolDefinitions }, { correlationId: callId, parentCorrelationId: runId, status: 'running', startedAt: modelStartedAt })
          await this.emit(subscriptionId, threadId, runId, 'llm.call.started', { call_id: callId, attempt, loop: journalLoopIndex }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: callId })
          try {
            const providerDebug = (entry: JsonObject) => this.repository.storeJournal(threadId, runId, journalLoopIndex, 'model', `model.http.${String(entry.direction || 'event')}`, 'provider', entry, { correlationId: callId, parentCorrelationId: runId, status: 'running' })
            for await (const event of this.providers.stream({ model, messages, tools: toolDefinitions, maxOutputTokens, signal, attachments: modelAttachments, onDebug: providerDebug })) {
              if (event.type === 'text-delta' && event.delta) { attemptText += event.delta; await this.emit(subscriptionId, threadId, runId, 'agent.message.delta', { delta: event.delta, attempt, call_id: callId }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: callId }) }
              else if (event.type === 'reasoning-delta' && event.delta) { attemptReasoning += event.delta; await this.emit(subscriptionId, threadId, runId, 'agent.message.delta', { delta: '', reasoning_delta: event.delta, attempt, call_id: callId }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: callId }) }
              else if (event.type === 'tool-call-started') {
                preparingCalls.set(event.call.id, event.call.name)
                const tool = toolDefinitions.find(item => item.name === event.call.name)
                await this.emit(subscriptionId, threadId, runId, 'agent.tool_preparing', { tool_name: event.call.name, tool_description: tool?.description || '', tool_source: tool?.source || 'builtin', status: 'preparing' }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: event.call.id })
              }
              else if (event.type === 'tool-call-arguments-delta') {
                const raw = `${preparingArguments.get(event.call.id) || ''}${event.delta}`.slice(0, 8_000)
                preparingArguments.set(event.call.id, raw)
                const preview = partialJsonStringField(raw, 'description')
                if (preview && preview !== preparingPreviews.get(event.call.id)) {
                  preparingPreviews.set(event.call.id, preview)
                  await this.emit(subscriptionId, threadId, runId, 'agent.tool_arguments.delta', { tool_name: event.call.name, preview, status: 'preparing' }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: event.call.id })
                }
              }
              else if (event.type === 'tool-call') {
                if (!preparingCalls.has(event.call.id)) {
                  preparingCalls.set(event.call.id, event.call.name)
                  const tool = toolDefinitions.find(item => item.name === event.call.name)
                  await this.emit(subscriptionId, threadId, runId, 'agent.tool_preparing', { tool_name: event.call.name, tool_description: tool?.description || '', tool_source: tool?.source || 'builtin', status: 'preparing' }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: event.call.id })
                }
                attemptCalls.push(event.call)
              }
              else if (event.type === 'usage') mergeUsage(attemptUsage, event.usage)
              else if (event.type === 'provider-metadata') attemptProviderMetadata = { ...attemptProviderMetadata, ...event.metadata }
              else if (event.type === 'finish') { attemptFinishReason = event.reason; attemptRawFinishReason = String(event.rawReason || event.reason) }
            }
            if (attemptFinishReason === 'content_filter') {
              for (const [toolCallId, toolName] of preparingCalls) await this.emit(subscriptionId, threadId, runId, 'agent.tool_cancelled', { tool_name: toolName, reason: 'content_filter' }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: toolCallId })
              const suppressed = attemptCalls.map(call => call.name); attemptCalls.length = 0
              const explanation = this.repository.renderPrompt('runtime.safety_termination', { reason: attemptRawFinishReason || attemptFinishReason }, promptLocale)
              const hadSafetyText = Boolean(attemptText.trim())
              attemptText = [attemptText.trim(), explanation].filter(Boolean).join('\n\n')
              this.repository.storeDebug(threadId, runId, 'model.safety_termination', { reason: attemptRawFinishReason || attemptFinishReason, suppressed_tools: suppressed })
              await this.emit(subscriptionId, threadId, runId, 'agent.message.delta', { delta: `${hadSafetyText ? '\n\n' : ''}${explanation}`, attempt, call_id: callId }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: callId })
            }
            turnText = attemptText; reasoningText = attemptReasoning; calls = attemptCalls; turnFinishReason = attemptFinishReason; turnProviderMetadata = attemptProviderMetadata; finalText += attemptText; mergeUsage(checkpoint.usage, attemptUsage)
            success = true
            const modelFinishedAt = new Date().toISOString(); checkpoint.boundary = { phase: 'model', state: 'after', callId, updatedAt: modelFinishedAt }; this.repository.saveCheckpoint(checkpoint)
            this.repository.storeJournal(threadId, runId, journalLoopIndex, 'model', 'model.response', 'lead_agent', { call_id: callId, attempt, finish_reason: attemptFinishReason, reasoning: compact(reasoningText, 20_000), text: compact(turnText, 20_000), tool_calls: calls, usage: attemptUsage }, { correlationId: callId, parentCorrelationId: runId, status: 'completed', startedAt: modelStartedAt, finishedAt: modelFinishedAt, durationMs: Date.now() - modelStartedMs, inputTokens: attemptUsage.inputTokens, outputTokens: attemptUsage.outputTokens })
          } catch (error) {
            for (const [toolCallId, toolName] of preparingCalls) await this.emit(subscriptionId, threadId, runId, 'agent.tool_cancelled', { tool_name: toolName, reason: 'model_retry' }, { agent_id: agentId, message_id: `message_${runId}`, tool_call_id: toolCallId })
            mergeUsage(checkpoint.usage, attemptUsage)
            const normalized = normalizeRuntimeError(error, 'model', { hasImageAttachments: modelAttachments.length > 0 })
            if (normalized.disableVision) this.repository.recordModelVisionCapability(model.model_id, false, normalized.technical_detail)
            const failure = new RuntimeFailureError(normalized, error)
            lastError = failure; const failureMessage = normalized.technical_detail; const recoverable = attempt < maxAttempts && normalized.retryable
            const modelFinishedAt = new Date().toISOString(); checkpoint.boundary = { phase: 'model', state: 'after', callId, updatedAt: modelFinishedAt }; this.repository.saveCheckpoint(checkpoint)
            const failurePayload = runtimeFailurePayload(normalized)
            this.repository.storeDebug(threadId, runId, 'llm.call.failed', { attempt, error: failureMessage, ...failurePayload }); this.repository.storeJournal(threadId, runId, journalLoopIndex, 'model', 'model.error', 'lead_agent', { call_id: callId, attempt, error: failureMessage, ...failurePayload }, { correlationId: callId, parentCorrelationId: runId, status: 'failed', startedAt: modelStartedAt, finishedAt: modelFinishedAt, durationMs: Date.now() - modelStartedMs, inputTokens: attemptUsage.inputTokens, outputTokens: attemptUsage.outputTokens, errorCategory: normalized.category }); await this.emit(subscriptionId, threadId, runId, 'llm.call.failed', { attempt, call_id: callId, discard_output: true, error_detail: failureMessage, recoverable, ...failurePayload }, { agent_id: agentId, tool_call_id: callId })
            if (!recoverable) break
            messages.push({ role: 'system', content: this.repository.renderPrompt('runtime.retry', {}, promptLocale) })
            const exponential = Math.min(retryMaxDelayMs, retryBaseDelayMs * (2 ** (attempt - 1)))
            await waitForRetry(Math.max(exponential, Number(normalized.retryAfterMs || 0)), signal)
          }
        }
        if (!success) throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Model call failed'))
        const planBeforeMiddleware = checkpoint.plan ? structuredClone(checkpoint.plan) : undefined
        const modelResult = { checkpoint, text: turnText, calls }
        await pipeline.afterModel(modelResult)
        turnText = modelResult.text; calls = modelResult.calls
        if (JSON.stringify(planBeforeMiddleware) !== JSON.stringify(checkpoint.plan) && checkpoint.plan) for (const event of projectPlanEvents(planBeforeMiddleware, checkpoint.plan)) await this.emit(subscriptionId, threadId, runId, event.type, event.payload, { agent_id: agentId, message_id: `message_${runId}` })
        if (object(checkpoint.middlewareState).repeatModel === true) { if (turnText) await this.emit(subscriptionId, threadId, runId, 'llm.call.failed', { call_id: 'middleware', discard_output: true, recoverable: true, error_category: 'middleware_rewrite' }, { agent_id: agentId }); finalText = ''; checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint); continue }
        checkpoint.messages.push({ role: 'assistant', content: turnText, reasoning: reasoningText || undefined, toolCalls: calls, ...(Object.keys(turnProviderMetadata).length ? { providerMetadata: turnProviderMetadata } : {}) }); checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
        if (!calls.length) {
          // A steering request can arrive while the provider is finishing a
          // tool-free answer. Do not mark that run complete and strand the
          // request in memory: yield into one more loop, where the durable
          // consumption block at the top emits `run.steered` and presents it
          // to the model as the next user turn.
          if (this.active.get(runId)?.steering.length) continue
          if (finalText) await this.emit(subscriptionId, threadId, runId, 'agent.message.completed', { content: finalText, last_turn_content: turnText }, { agent_id: agentId, message_id: `message_${runId}` })
          await this.maybeGenerateSessionTitle(subscriptionId, threadId, runId, agentId, model, middleware, extractUserRequest(content), finalText, signal, promptLocale)
          checkpoint.status = 'completed'; checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint); await this.emit(subscriptionId, threadId, runId, 'session.completed', { status: 'success', finish_reason: turnFinishReason, usage: checkpoint.usage, duration_ms: Date.now() - runStartedMs }, { agent_id: agentId }); terminalStatus = 'completed'; break
        }
        // Persist the entire batch before executing the first call.  If the
        // process, window, or IPC bridge disappears after this point, startup
        // recovery can still emit a matching result for every id.
        this.repository.registerToolCalls(runId, threadId, calls, call => {
          const definition = toolDefinitions.find(item => item.name === call.name)
          return call.name.startsWith('board_') || definition?.source === 'mcp'
        })
        for (const call of calls) {
          totalToolCalls += 1
          if (totalToolCalls > maxToolCalls) throw new Error(`Agent 已达到工具调用预算（${maxToolCalls} 次），已安全停止`)
          const tool = toolDefinitions.find(item => item.name === call.name)
          if (!tool) {
            const message = `模型调用了未授权工具：${call.name}`
            this.repository.completeToolCall(runId, call.id, 'failed', { content: this.repository.renderPrompt('runtime.tool_error', { message }, promptLocale) }, { message })
            checkpoint.messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: this.repository.renderPrompt('runtime.tool_error', { message }, promptLocale) })
            checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
            throw new Error(message)
          }
          const messageId = `message_${runId}`
          const purpose = String(call.arguments.description || '')
          // registerToolCalls is idempotent, but a repeated provider frame is
          // not permission to repeat a canvas/MCP side effect.  Only the
          // caller that atomically changes pending -> running may execute it.
          if (!this.repository.beginToolCall(runId, call.id)) {
            const recorded = this.repository.toolCallResult(runId, call.id)
            const recordedResult = object(recorded ? JSON.parse(String(recorded.result_json || '{}')) : {})
            const recordedContent = String(recordedResult.content || '该工具调用已被记录，未重复执行。')
            checkpoint.messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: recordedContent })
            checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
            this.repository.storeDebug(threadId, runId, 'tool.duplicate_suppressed', { tool_name: call.name, tool_call_id: call.id, recorded_status: String(recorded?.status || 'missing') })
            await this.emit(subscriptionId, threadId, runId, 'agent.tool_result', { tool_name: call.name, tool_description: tool.description, purpose, tool_source: tool.source, input: call.arguments, content: recordedContent, status: 'success', is_error: false, duplicate_suppressed: true }, { agent_id: agentId, message_id: messageId, tool_call_id: call.id })
            continue
          }
          try { await pipeline.beforeTool({ checkpoint, call }) }
          catch (error) {
            // A middleware can deliberately reject a call (for example a hard
            // loop limit). The provider still requires a matching tool result
            // before this checkpoint is ever reused in a later user turn.
            const message = error instanceof Error ? error.message : String(error)
            const resultContent = this.repository.renderPrompt('runtime.tool_error', { message }, promptLocale)
            this.repository.completeToolCall(runId, call.id, 'failed', { content: resultContent }, { message, phase: 'middleware' })
            checkpoint.messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: resultContent })
            checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
            await this.emit(subscriptionId, threadId, runId, 'agent.tool_result', { tool_name: call.name, tool_description: tool.description, purpose, tool_source: tool.source, input: call.arguments, content: message, status: 'error', is_error: true }, { agent_id: agentId, message_id: messageId, tool_call_id: call.id })
            throw error
          }
          const toolStartedAt = new Date().toISOString(); const toolStartedMs = Date.now()
          checkpoint.boundary = { phase: 'tool', state: 'before', toolCallId: call.id, toolName: call.name, sideEffect: call.name.startsWith('board_') || tool.source === 'mcp', updatedAt: toolStartedAt }; this.repository.saveCheckpoint(checkpoint)
          this.repository.storeJournal(threadId, runId, journalLoopIndex, 'tool', 'tool.request', call.name, { tool_call_id: call.id, purpose: String(call.arguments.description || ''), input: call.arguments }, { correlationId: call.id, parentCorrelationId: runId, status: 'running', startedAt: toolStartedAt })
          await this.emit(subscriptionId, threadId, runId, 'agent.tool_use', { tool_name: call.name, tool_description: tool.description, purpose, tool_source: tool.source, input: call.arguments, status: 'running' }, { agent_id: agentId, message_id: messageId, tool_call_id: call.id })
          try {
            const previousPlan = checkpoint.plan ? structuredClone(checkpoint.plan) : undefined
            const reviewCapReached = call.name === 'board_review_quality' && Number(object(checkpoint.middlewareState).qualityReviewRounds || 0) >= 3
            const rawResult = reviewCapReached
              ? { ok: true, skipped: true, message: '本轮任务的画布质量审计已达到 3 次上限；请停止审计并基于已有结果完成答复。' }
              : await this.tools.execute(tool, call.arguments, checkpoint, signal, { repair: toolRepairConfig.enabled !== false })
            // The renderer returns the PNG only across this one IPC boundary.
            // Materialize it as a managed attachment, then let the Agent use
            // the normal view_image tool to opt into visual context.
            let result = rawResult
            if (call.name === 'board_capture_image') {
              const capture = object(rawResult)
              const imageBase64 = String(capture.image_base64 || '')
              if (!visionEnabled) throw new Error('当前模型未启用图片理解能力，不能查看画布截图')
              if (!imageBase64 || imageBase64.length > 8 * 1024 * 1024) throw new Error('画布截图无效或过大，请缩小截图范围后重试')
              const attachment = await this.repository.importGeneratedImage(imageBase64, String(call.arguments.name || '画布截图'))
              const { image_base64: _imageBase64, ...safeCapture } = capture
              // A screenshot is internal visual context, not a deliverable. Keep
              // it in the controlled attachment store for view_image, but do not
              // bind or surface it as a downloadable conversation artifact.
              result = { ...safeCapture, attachment, message: `截图已准备好用于视觉校验。如需查看实际视觉效果，请调用 view_image 并传入 attachment_id=${attachment.attachment_id}。` }
            }
            if (call.name === 'board_export_pptx') {
              const exported = object(rawResult)
              const pptxBase64 = String(exported.pptx_base64 || '')
              if (!pptxBase64 || pptxBase64.length > 56 * 1024 * 1024) throw new Error('PPT 导出结果无效或过大，请减少页面数量或范围后重试')
              const attachment = await this.repository.importGeneratedFile(pptxBase64, String(exported.name || call.arguments.name || 'TuGo 演示稿.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
              this.repository.bindAttachment(checkpoint.threadId, runId, attachment.attachment_id, 'tool')
              const { pptx_base64: _pptxBase64, ...safeExport } = exported
              result = { ...safeExport, attachment, message: `已生成 ${Number(exported.page_count || 0)} 页可编辑 PPT：“${attachment.name}”。` }
            }
            checkpoint.completedToolCalls[call.id] = result; this.repository.completeToolCall(runId, call.id, 'succeeded', { content: compact(result), result }); checkpoint.messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: compact(result) })
            // Quality is a deliberate end-of-draft action. A drawing commonly
            // spans several mutations (nodes, edges, labels); those tool calls
            // must never trigger a review or spend its budget. Only the
            // read-only board_review_quality tool returns an audit, and each
            // call is one bounded review round.
            const reflection = object(result).layout_reflection as JsonObject | undefined
            const issues = reflection && Array.isArray(reflection.issues) ? reflection.issues : []
            if (call.name === 'board_review_quality' && reflection?.checked === true) {
              const state = object(checkpoint.middlewareState)
              const round = Number(state.qualityReviewRounds || 0) + 1
              checkpoint.middlewareState = { ...state, qualityReviewRounds: round }
              const summary = String(reflection.summary || '布局检查发现可读性问题。')
              checkpoint.messages.push({ role: 'system', content: round < 3
                ? `画布质量审计（第 ${round}/3 轮）：${summary}${issues.length ? ' 请结合审计详情和用户意图，决定是否调用 board_optimize_layout 或局部编辑修复；修复后如仍需确认，再主动调用 board_review_quality。' : ' 审计没有发现问题，可以结束。'}`
                : `画布质量审计已达到 3 轮上限：${summary} 不要再继续审计或反复优化；保留当前可用结果，并在最终答复中简要说明仍存在的取舍。` })
            }
            if (call.name === 'view_image') {
              const attachmentId = String(call.arguments.attachment_id || '')
              if (attachmentId && !modelAttachments.some(item => item.attachmentId === attachmentId)) {
                modelAttachments.push(...await this.repository.modelAttachments([attachmentId]))
                checkpoint.messages.push({ role: 'user', content: this.repository.renderPrompt('runtime.view_image_materialized', { attachment_id: attachmentId }, promptLocale), attachmentIds: [attachmentId] })
              }
            }
            checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
            const attachment = object(result).attachment
            await this.emit(subscriptionId, threadId, runId, 'agent.tool_result', { tool_name: call.name, tool_description: tool.description, purpose, tool_source: tool.source, input: call.arguments, content: compact(result), status: 'success', is_error: false, ...(call.name !== 'board_capture_image' && attachment && typeof attachment === 'object' ? { attachment } : {}) }, { agent_id: agentId, message_id: messageId, tool_call_id: call.id })
            const toolFinishedAt = new Date().toISOString(); checkpoint.boundary = { phase: 'tool', state: 'after', toolCallId: call.id, toolName: call.name, sideEffect: call.name.startsWith('board_') || tool.source === 'mcp', updatedAt: toolFinishedAt }; this.repository.saveCheckpoint(checkpoint)
            this.repository.storeJournal(threadId, runId, journalLoopIndex, 'tool', 'tool.response', call.name, { tool_call_id: call.id, purpose, status: 'success', output: compact(result) }, { correlationId: call.id, parentCorrelationId: runId, status: 'completed', startedAt: toolStartedAt, finishedAt: toolFinishedAt, durationMs: Date.now() - toolStartedMs })
            if (call.name === 'plan' && checkpoint.plan) for (const event of projectPlanEvents(previousPlan, checkpoint.plan)) await this.emit(subscriptionId, threadId, runId, event.type, event.payload, { agent_id: agentId, message_id: messageId, tool_call_id: call.id })
          } catch (error) {
            if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
              const content = this.repository.renderPrompt('runtime.interrupted_tool_result', {}, promptLocale)
              this.repository.completeToolCall(runId, call.id, call.name.startsWith('board_') || tool.source === 'mcp' ? 'uncertain' : 'interrupted', { content }, { reason: 'cancelled' })
              checkpoint.messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content }); checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
              this.repository.storeJournal(threadId, runId, journalLoopIndex, 'tool', 'tool.interrupted', call.name, { tool_call_id: call.id, status: 'interrupted' }, { correlationId: call.id, parentCorrelationId: runId, status: 'interrupted', startedAt: toolStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - toolStartedMs })
              throw error
            }
            const message = error instanceof Error ? error.message : String(error)
            const toolFailure = error instanceof ToolExecutionError ? error : undefined
            const repairable = toolRepairConfig.enabled !== false && toolFailure?.repairable === true
            const state = object(checkpoint.middlewareState)
            const repairs = object(state.toolRepairAttempts)
            const repairKey = call.name
            const repairAttempt = Number(repairs[repairKey] || 0) + (repairable ? 1 : 0)
            const repairLimit = Math.max(0, Number(toolRepairConfig.maxAttempts || 2))
            const willRetry = repairable && repairAttempt <= repairLimit
            if (repairable) checkpoint.middlewareState = { ...state, toolRepairAttempts: { ...repairs, [repairKey]: repairAttempt } }
            const resultContent = this.repository.renderPrompt('runtime.tool_error', { message }, promptLocale)
            this.repository.completeToolCall(runId, call.id, 'failed', { content: resultContent }, { message, recoverable: willRetry })
            checkpoint.messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: resultContent })
            // Tool messages must remain directly after the matching assistant
            // call. The correction instruction is deliberately appended only
            // after that valid tool-result pair.
            if (willRetry) checkpoint.messages.push({ role: 'system', content: `刚才 ${call.name} 的参数无法执行，正在进行第 ${repairAttempt}/${repairLimit} 次修正。请根据工具错误提示重新调用；不要只解释，也不要重复相同参数。` })
            checkpoint.step += 1; this.repository.saveCheckpoint(checkpoint)
            await this.emit(subscriptionId, threadId, runId, 'agent.tool_result', { tool_name: call.name, tool_description: tool.description, purpose, tool_source: tool.source, input: call.arguments, content: message, status: willRetry ? 'recovering' : 'error', is_error: !willRetry, recoverable: willRetry, error_category: toolFailure?.category || 'execution', ...runtimeFailurePayload(normalizeRuntimeError(error, 'tool')) }, { agent_id: agentId, message_id: messageId, tool_call_id: call.id })
            const toolFinishedAt = new Date().toISOString(); checkpoint.boundary = { phase: 'tool', state: 'after', toolCallId: call.id, toolName: call.name, sideEffect: call.name.startsWith('board_') || tool.source === 'mcp', updatedAt: toolFinishedAt }; this.repository.saveCheckpoint(checkpoint)
            this.repository.storeJournal(threadId, runId, journalLoopIndex, 'tool', 'tool.error', call.name, { tool_call_id: call.id, purpose, status: 'error', error: message, error_category: toolFailure?.category || 'execution' }, { correlationId: call.id, parentCorrelationId: runId, status: 'failed', startedAt: toolStartedAt, finishedAt: toolFinishedAt, durationMs: Date.now() - toolStartedMs, errorCategory: toolFailure?.category || 'execution' })
            // A board bridge failure cannot be repaired by asking the model to
            // try another canvas tool: all of them target the same missing
            // Renderer.  Stop immediately so a Run never burns through 20+
            // LLM loops while neither the canvas nor chat can make progress.
            if (call.name.startsWith('board_') && /TuGo 窗口不可用|Renderer 异常退出/.test(message)) {
              throw new Error('画板窗口不可用，本次操作未执行。请重新打开 TuGo 后再试。')
            }
          }
        }
        flushDeferredToolWarnings(checkpoint)
        checkpoint.messages = this.repository.reconcileToolMessages(runId, checkpoint.messages, this.repository.renderPrompt('runtime.interrupted_tool_result', {}, promptLocale))
        this.repository.saveCheckpoint(checkpoint)
      }
      if (terminalStatus !== 'completed') throw new Error(`Agent 已达到最大执行循环数（${maxLoops} 次 LLM 调用）`)
    } catch (error) {
      // Also close the remainder of a persisted batch when a call aborts or
      // fails early.  This is intentionally done before marking the run
      // terminal, so the checkpoint is always provider-valid on the next turn.
      checkpoint.messages = this.repository.reconcileToolMessages(runId, checkpoint.messages, this.repository.renderPrompt('runtime.interrupted_tool_result', {}, promptLocale))
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) { checkpoint.status = 'interrupted'; terminalError = { message: '用户取消运行', category: 'cancelled' }; this.repository.saveCheckpoint(checkpoint); await this.emit(subscriptionId, threadId, runId, 'session.interrupted', { status: 'interrupted', message: '已取消', usage: checkpoint.usage, duration_ms: Date.now() - runStartedMs }, { agent_id: agentId }); terminalStatus = 'interrupted' }
      else { const failure = normalizeRuntimeError(error); const message = failure.technical_detail; const contract = runtimeFailurePayload(failure); terminalError = { message, category: failure.category, ...contract }; checkpoint.status = 'failed'; this.repository.saveCheckpoint(checkpoint); this.repository.storeDebug(threadId, runId, 'runtime.exception', { error: message, stack: error instanceof Error ? error.stack : undefined, ...contract }); await this.emit(subscriptionId, threadId, runId, 'session.failed', { status: 'failed', error_type: error instanceof Error ? error.name : 'Error', error_detail: message, message: failure.user_message, usage: checkpoint.usage, duration_ms: Date.now() - runStartedMs, ...contract }, { agent_id: agentId }); terminalStatus = 'failed' }
    } finally {
      const runFinishedAt = new Date().toISOString()
      this.repository.storeJournal(threadId, runId, checkpoint.step, 'run', 'run.finished', 'runtime', { status: terminalStatus, usage: checkpoint.usage, ...(terminalError ? { error: terminalError.message, error_detail: terminalError } : {}) }, { correlationId: runId, status: terminalStatus, startedAt: runStartedAt, finishedAt: runFinishedAt, durationMs: Date.now() - runStartedMs, inputTokens: checkpoint.usage.inputTokens, outputTokens: checkpoint.usage.outputTokens, ...(terminalError ? { errorCategory: terminalError.category } : {}) })
      this.repository.finishRun(runId, terminalStatus, terminalError)
      await this.emit(subscriptionId, threadId, runId, 'stream.end', { status: terminalStatus }, { agent_id: agentId })
      await this.repository.flush(); this.send({ kind: 'stream_end', subscription_id: subscriptionId, run_id: runId }); this.sequences.delete(runId)
    }
  }
}
