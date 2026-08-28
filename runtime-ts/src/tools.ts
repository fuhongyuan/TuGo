import AjvModule, { type ValidateFunction } from 'ajv'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Agent } from 'undici'
import type { JsonObject, RunCheckpoint, ToolDefinition } from './contracts.js'
import type { RuntimeRepository } from './repository.js'
import type { McpManager } from './mcp.js'
import { randomUUID } from 'node:crypto'
import { normalizePlan } from './plan.js'
import { buildAcceptanceReport, normalizeDiagramBrief, normalizeDiagramModel, reviewDiagramContent, type ContentReview, type DiagramBrief } from './diagramQualityContracts.js'

const compact = (value: unknown, limit = 50_000) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text.length > limit ? `${text.slice(0, limit)}…` : text }
const nonPublicIpv4 = (address: string) => {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0)
}
const nonPublicIp = (raw: string) => {
  const address = raw.toLowerCase().split('%', 1)[0].replace(/^\[|\]$/g, '')
  if (isIP(address) === 4) return nonPublicIpv4(address)
  if (isIP(address) !== 6) return true
  if (address.includes('.')) return nonPublicIpv4(address.slice(address.lastIndexOf(':') + 1))
  return address === '::' || address === '::1' || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address) || /^2001:db8/.test(address)
}
export const createPublicLookup = (resolver = lookup) => (hostname: string, options: { all?: boolean; family?: number }, callback: (error: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void) => {
  void resolver(hostname, { all: true, verbatim: true, ...(options?.family ? { family: options.family } : {}) }).then(addresses => {
    if (!addresses.length || addresses.some(item => nonPublicIp(item.address))) throw new Error('URL resolves to a non-public network address')
    const normalized = addresses.map(item => ({ address: item.address, family: item.family }))
    if (options?.all) callback(null, normalized)
    else callback(null, normalized[0].address, normalized[0].family)
  }).catch(error => callback(error instanceof Error ? error : new Error(String(error))))
}
// Validate again in the DNS lookup used by the actual socket connection. A
// preflight-only lookup leaves a DNS-rebinding window between check/connect.
const publicNetworkDispatcher = new Agent({ connect: { lookup: createPublicLookup() as never } })
const safeUrl = async (raw: unknown, resolver = lookup) => {
  const url = new URL(String(raw))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without embedded credentials are allowed')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('Only public HTTP(S) URLs are allowed')
  const addresses = isIP(hostname) ? [{ address: hostname }] : await resolver(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => nonPublicIp(item.address))) throw new Error('URL resolves to a non-public network address')
  return url
}
export const safeFetch = async (raw: unknown, init: RequestInit, maxRedirects = 5, resolver = lookup) => {
  let url = await safeUrl(raw, resolver)
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(url, { ...init, redirect: 'manual', dispatcher: publicNetworkDispatcher } as RequestInit & { dispatcher: Agent })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) throw new Error(`Redirect ${response.status} did not include a location`)
    if (redirect === maxRedirects) throw new Error('Too many redirects')
    await response.body?.cancel().catch(() => undefined)
    url = await safeUrl(new URL(location, url).toString(), resolver)
  }
  throw new Error('Too many redirects')
}
export const boundedResponseText = async (response: Response, maxBytes: number) => {
  const declared = Number(response.headers.get('content-length') || 0)
  const reader = response.body?.getReader()
  if (!reader) return { text: '', truncated: false }
  const decoder = new TextDecoder(); let bytes = 0; let text = ''; let truncated = declared > maxBytes
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - bytes
    if (remaining <= 0) { truncated = true; await reader.cancel(); break }
    const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value
    bytes += accepted.byteLength; text += decoder.decode(accepted, { stream: value.byteLength <= remaining })
    if (value.byteLength > remaining) { truncated = true; await reader.cancel(); break }
  }
  text += decoder.decode()
  return { text, truncated }
}
const plainSearchText = (value: string) => value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim()
export const searchWeb = async (query: string, count: number, signal: AbortSignal, resolver = lookup) => {
  const providers = [
    {
      name: 'bing', url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      parse: (html: string) => [...html.matchAll(/<li[^>]*class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(match => ({ url: match[1].replace(/&amp;/g, '&'), title: plainSearchText(match[2]) })),
    },
    {
      name: 'duckduckgo', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      parse: (html: string) => [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => ({ url: match[1].replace(/&amp;/g, '&'), title: plainSearchText(match[2]) })),
    },
  ]
  const failures: string[] = []
  for (const provider of providers) {
    try {
      const response = await safeFetch(provider.url, { signal, headers: { 'User-Agent': 'Mozilla/5.0 TuGo/2.0' } }, 5, resolver)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const { text } = await boundedResponseText(response, 1_000_000)
      const results = provider.parse(text).filter(item => /^https?:\/\//i.test(item.url) && item.title).slice(0, count)
      if (results.length) return { query, provider: provider.name, results }
      failures.push(`${provider.name}: no results parsed`)
    } catch (error) {
      if (signal.aborted) throw error
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`Web search unavailable (${failures.join('; ')})`)
}

export type HostToolBridge = (name: string, args: JsonObject, context: JsonObject, signal: AbortSignal, timeoutMs: number) => Promise<unknown>

export type ToolErrorCategory = 'validation' | 'timeout' | 'unavailable' | 'execution'

// Tool failures are part of the Agent protocol, not just display strings.
// Keeping the category on the Error lets Runtime offer a bounded correction
// only for malformed arguments, while a timeout or unavailable renderer ends
// predictably instead of burning model loops on a retry that cannot work.
export class ToolExecutionError extends Error {
  constructor(message: string, readonly category: ToolErrorCategory, readonly repairable = false) {
    super(message)
    this.name = 'ToolExecutionError'
  }
}

export class ToolRegistry {
  private ajv = new (AjvModule as unknown as new (options?: JsonObject) => { compile(schema: JsonObject): ValidateFunction; errorsText(errors?: unknown, options?: JsonObject): string })({ allErrors: true, strict: false })
  private validators = new Map<string, ValidateFunction>()
  constructor(private repository: RuntimeRepository, private mcp: McpManager, private bridge: HostToolBridge) {}

  async resolve(agentId: string) {
    const builtin = this.repository.toolsForAgent(agentId)
    const external = await this.mcp.tools(this.repository.mcpForAgent(agentId) as never[])
    return [...builtin, ...external]
  }
  validate(tool: ToolDefinition, args: JsonObject) {
    let validator = this.validators.get(tool.name)
    if (!validator) { const compiled = this.ajv.compile(tool.inputSchema); this.validators.set(tool.name, compiled); validator = compiled }
    const valid = validator(args)
    if (!valid) {
      // The provider's generic AJV wording gives a model no reliable path to
      // repair its call. board_batch is the most common large mutation tool,
      // so return its exact canonical contract as a tool result instead.
      if (tool.name === 'board_batch' && !Array.isArray((args as JsonObject).operations)) {
        throw new ToolExecutionError('board_batch 未执行：必须传入顶层非空 operations 数组。请立刻重发同一个工具调用，参数格式为 {"description":"简短说明","operations":[{"op":"add_element","element":{...}}]}；不要只传 description，也不要把 operations 放进 data、input、payload 或 project_id 中。', 'validation', true)
      }
      throw new ToolExecutionError(`工具 ${tool.name} 参数不合法：${this.ajv.errorsText(validator.errors, { separator: '; ' })}`, 'validation', true)
    }
  }
  private normalizeCanvasText(value: unknown) {
    return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\\r\\n|\\n|\\r/g, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
  }
  private normalizeElementFields(value: JsonObject): JsonObject {
    const textAlign = ['left', 'center', 'right'].includes(String(value.textAlign)) ? String(value.textAlign) : undefined
    const verticalAlign = ['top', 'middle', 'bottom'].includes(String(value.verticalAlign)) ? String(value.verticalAlign) : undefined
    const fontWeight = String(value.fontWeight ?? '').toLowerCase() === 'bold' || Number(value.fontWeight) >= 600 ? 'bold' : value.fontWeight === undefined ? undefined : 'normal'
    const fontStyle = String(value.fontStyle ?? '').toLowerCase() === 'italic' ? 'italic' : value.fontStyle === undefined ? undefined : 'normal'
    const textDecoration = value.textDecoration === undefined ? undefined : /underline/i.test(String(value.textDecoration)) ? 'underline' : 'none'
    return { ...value, ...(value.text !== undefined || value.label !== undefined || value.title !== undefined ? { text: this.normalizeCanvasText(value.text ?? value.label ?? value.title) } : {}), ...(textAlign ? { textAlign } : {}), ...(verticalAlign ? { verticalAlign } : {}), ...(fontWeight ? { fontWeight } : {}), ...(fontStyle ? { fontStyle } : {}), ...(textDecoration ? { textDecoration } : {}) }
  }
  private normalizeArguments(tool: ToolDefinition, args: JsonObject): JsonObject {
    if (tool.name === 'board_patch_element') {
      const operation = args.operation && typeof args.operation === 'object' ? args.operation as JsonObject : undefined
      if (operation?.op === 'patch_element' && operation.patch && typeof operation.patch === 'object') return { ...args, operation: { ...operation, patch: this.normalizeElementFields(operation.patch as JsonObject) } }
      return args
    }
    if (tool.name !== 'board_batch') return args
    // OpenAI-compatible providers do not agree on a single function-argument
    // shape.  GLM/Qwen in particular often wrap the schema in data/input or
    // serialize the operation array. Canonicalize before AJV validation so a
    // recoverable presentation difference never becomes invalid_tool_calls.
    let candidate: JsonObject = args
    for (const key of ['data', 'input', 'arguments', 'payload'] as const) {
      const nested = candidate[key]
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) candidate = { ...candidate, ...(nested as JsonObject) }
    }
    const rawOperations = candidate.operations ?? candidate.operation ?? candidate.ops ?? candidate.actions ?? candidate.items
    let parsedOperations: unknown = rawOperations
    if (typeof parsedOperations === 'string') {
      try { parsedOperations = JSON.parse(parsedOperations) } catch { /* validation below gives the actionable error */ }
    }
    const rawList = Array.isArray(parsedOperations) ? parsedOperations : parsedOperations && typeof parsedOperations === 'object' ? [parsedOperations] : undefined
    if (!rawList) return candidate
    // Keep only canonical keys before strict schemas are evaluated.  Wrapper
    // keys (data/input/ops) are model transport noise, not tool parameters.
    const { data: _data, input: _input, arguments: _arguments, payload: _payload, operation: _operation, ops: _ops, actions: _actions, items: _items, project_id: _projectIdSnake, projectId: _projectId, board_id: _boardId, boardId: _boardIdCamel, ...canonical } = candidate
    candidate = { ...canonical, operations: rawList as JsonObject[] }
    let nodeIndex = 0
    const operations = (candidate.operations as JsonObject[]).map((operation, index) => {
      if (operation.op === 'add_element') {
        const element = operation.element && typeof operation.element === 'object' ? operation.element as JsonObject : {}
        const style = element.style && typeof element.style === 'object' ? element.style as JsonObject : {}
        const rawShape = String(element.kind || element.shape || element.type || 'rectangle')
        const kind = ['rounded', 'roundRect', 'rounded-rect', 'rounded-rectangle'].includes(rawShape) ? 'rounded_rectangle' : rawShape === 'rect' ? 'rectangle' : rawShape
        return { ...operation, element: this.normalizeElementFields({
          ...element, id: String(element.id || operation.id || `node_${nodeIndex++}`), kind,
          text: this.normalizeCanvasText(element.text ?? element.label ?? element.title ?? ''),
          x: Number(element.x ?? 0), y: Number(element.y ?? 0), width: Number(element.width ?? 180), height: Number(element.height ?? 90),
          fill: element.fill || style.fill || style.fillColor, stroke: element.stroke || style.stroke || style.strokeColor,
          strokeWidth: element.strokeWidth ?? style.strokeWidth, textColor: element.textColor || style.textColor || style.fontColor,
          fontSize: element.fontSize ?? style.fontSize, fontWeight: element.fontWeight || style.fontWeight, fontStyle: element.fontStyle || style.fontStyle,
          borderRadius: element.borderRadius ?? style.borderRadius, textAlign: element.textAlign || style.textAlign,
          verticalAlign: element.verticalAlign || style.verticalAlign,
          textDecoration: element.textDecoration || style.textDecoration,
        }) }
      }
      if (operation.op === 'add_edge') {
        const edge = operation.edge && typeof operation.edge === 'object' ? operation.edge as JsonObject
          : operation.element && typeof operation.element === 'object' ? operation.element as JsonObject
            : operation
        const style = edge.style && typeof edge.style === 'object' ? edge.style as JsonObject : {}
        const from = String(edge.from || edge.source || '')
        const to = String(edge.to || edge.target || '')
        if (!from || !to) throw new ToolExecutionError(`board_batch 第 ${index + 1} 项连线缺少 from/to`, 'validation', true)
        const startArrow = edge.startArrow ?? style.startArrow ?? edge.arrowStart
        const endArrow = edge.endArrow ?? style.endArrow ?? edge.arrowEnd
        return { ...operation, edge: {
          ...edge, id: String(edge.id || operation.id || `edge_${randomUUID()}`), from, to,
          stroke: edge.stroke || style.stroke, strokeWidth: edge.strokeWidth ?? style.strokeWidth,
          strokeStyle: edge.strokeStyle || style.strokeStyle,
          startArrow: startArrow === true ? 'arrow' : startArrow === false ? 'none' : startArrow,
          endArrow: endArrow === true ? 'arrow' : endArrow === false ? 'none' : endArrow || 'arrow',
          routing: edge.routing || style.routing, opacity: edge.opacity ?? style.opacity,
        } }
      }
      if (operation.op === 'patch_element' && operation.patch && typeof operation.patch === 'object') return { ...operation, patch: this.normalizeElementFields(operation.patch as JsonObject) }
      if (operation.op) return operation
      if (operation.type === 'create_node') {
        const id = String(operation.id || `node_${nodeIndex++}`)
        return { op: 'add_element', element: { id, kind: String(operation.node_type || operation.kind || 'rectangle'), text: String(operation.title || operation.text || ''), x: Number(operation.x || 0), y: Number(operation.y || 0), width: Number(operation.width || 180), height: Number(operation.height || 90) } }
      }
      if (operation.type === 'create') {
        const nestedNode = operation.node && typeof operation.node === 'object' ? operation.node as JsonObject : undefined
        if (nestedNode) {
          const style = nestedNode.style && typeof nestedNode.style === 'object' ? nestedNode.style as JsonObject : {}
          const rawShape = String(nestedNode.shape || nestedNode.kind || 'rectangle')
          const kind = rawShape === 'rounded' || rawShape === 'roundRect' ? 'rounded_rectangle' : rawShape === 'rect' ? 'rectangle' : rawShape
          return { op: 'add_element', element: { id: String(nestedNode.id || `node_${nodeIndex++}`), kind, text: String(nestedNode.label || nestedNode.text || nestedNode.title || ''), x: Number(nestedNode.x || 0), y: Number(nestedNode.y || 0), width: Number(nestedNode.width || 180), height: Number(nestedNode.height || 90), fill: nestedNode.fill || style.fillColor, stroke: nestedNode.stroke || style.strokeColor, textColor: nestedNode.fontColor || style.fontColor } }
        }
        const nestedEdge = operation.edge && typeof operation.edge === 'object' ? operation.edge as JsonObject : undefined
        if (nestedEdge) return { op: 'add_edge', edge: { id: String(nestedEdge.id || `edge_${randomUUID()}`), from: String(nestedEdge.from || nestedEdge.source || ''), to: String(nestedEdge.to || nestedEdge.target || ''), label: String(nestedEdge.label || ''), endArrow: nestedEdge.arrow === false ? 'none' : 'arrow' } }
        const id = String(operation.id || `node_${nodeIndex++}`)
        const style = operation.style && typeof operation.style === 'object' ? operation.style as JsonObject : {}
        return { op: 'add_element', element: { id, kind: String(operation.shape || 'rectangle'), text: String(operation.text || operation.title || ''), x: Number(operation.x || 0), y: Number(operation.y || 0), width: Number(operation.width || 180), height: Number(operation.height || 90), fill: style.fillColor, stroke: style.strokeColor, strokeWidth: style.strokeWidth } }
      }
      if (operation.type === 'create_edge') return { op: 'add_edge', edge: { id: String(operation.id || `edge_${randomUUID()}`), from: String(operation.source_node_id || operation.from || ''), to: String(operation.target_node_id || operation.to || ''), label: String(operation.label || ''), endArrow: operation.arrow === false ? 'none' : 'arrow' } }
      if (operation.type === 'addNode') {
        const data = operation.data && typeof operation.data === 'object' ? operation.data as JsonObject : {}
        const rawShape = String(data.shape || operation.kind || 'rectangle'); const kind = rawShape === 'rect' ? 'rectangle' : rawShape === 'rounded' ? 'rounded_rectangle' : rawShape
        return { op: 'add_element', element: { id: String(operation.id || `node_${nodeIndex++}`), kind, text: String(data.label || data.text || ''), x: Number(operation.x || 0), y: Number(operation.y || 0), width: Number(operation.width || 180), height: Number(operation.height || 90) } }
      }
      if (operation.type === 'addEdge') {
        const data = operation.data && typeof operation.data === 'object' ? operation.data as JsonObject : {}
        return { op: 'add_edge', edge: { id: String(operation.id || `edge_${randomUUID()}`), from: String(data.source || operation.from || ''), to: String(data.target || operation.to || ''), label: String(data.label || ''), endArrow: 'arrow' } }
      }
      return operation
    })
    const pick = (value: JsonObject, allowed: string[]) => Object.fromEntries(Object.entries(value).filter(([key, item]) => allowed.includes(key) && item !== undefined))
    const elementKeys = ['id','kind','x','y','width','height','text','fill','stroke','strokeWidth','strokeStyle','fillOpacity','opacity','textColor','fontSize','fontFamily','fontWeight','fontStyle','textDecoration','textAlign','verticalAlign','rotation','borderRadius','zIndex','groupId','locked','metadata']
    const edgeKeys = ['id','from','to','label','stroke','strokeWidth','strokeStyle','startArrow','endArrow','routing','opacity','zIndex','controlPoints','freeStart','freeEnd','fromAnchor','toAnchor','metadata']
    const cleanOperations = operations.map(operation => {
      if (operation.op === 'add_element') return { op: operation.op, element: pick(operation.element && typeof operation.element === 'object' ? operation.element as JsonObject : {}, elementKeys) }
      if (operation.op === 'patch_element') return { op: operation.op, id: operation.id, patch: pick(operation.patch && typeof operation.patch === 'object' ? operation.patch as JsonObject : {}, elementKeys) }
      if (operation.op === 'add_edge') return { op: operation.op, edge: pick(operation.edge && typeof operation.edge === 'object' ? operation.edge as JsonObject : {}, edgeKeys) }
      if (operation.op === 'patch_edge') return { op: operation.op, id: operation.id, patch: pick(operation.patch && typeof operation.patch === 'object' ? operation.patch as JsonObject : {}, edgeKeys) }
      return operation
    })
    return JSON.parse(JSON.stringify({ ...candidate, operations: cleanOperations })) as JsonObject
  }
  async execute(tool: ToolDefinition, args: JsonObject, checkpoint: RunCheckpoint, signal: AbortSignal, options: { repair?: boolean } = {}): Promise<unknown> {
    const controller = new AbortController()
    const timeoutMs = Math.max(1, Number(tool.timeoutMs || 30_000))
    let rejectBoundary!: (error: Error) => void
    const boundary = new Promise<never>((_, reject) => { rejectBoundary = reject })
    const abort = () => { const error = new DOMException('Cancelled', 'AbortError'); rejectBoundary(error); controller.abort(signal.reason) }
    const timer = setTimeout(() => { const error = new ToolExecutionError(`工具 ${tool.name} 执行超时（${timeoutMs}ms）`, 'timeout'); rejectBoundary(error); controller.abort(error) }, timeoutMs)
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([this.executeInternal(tool, args, checkpoint, controller.signal, options), boundary])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
  private async executeInternal(tool: ToolDefinition, args: JsonObject, checkpoint: RunCheckpoint, signal: AbortSignal, options: { repair?: boolean } = {}): Promise<unknown> {
    if (options.repair !== false) args = this.normalizeArguments(tool, args)
    // project_id used to be part of the public model schema. Accept it from
    // historical checkpoints, but never let it choose a board: the thread is
    // the sole authority for board scope.
    if (tool.name.startsWith('board_')) {
      const suppliedProjectId = String(args.project_id || args.projectId || '')
      if (suppliedProjectId && checkpoint.projectId && suppliedProjectId !== checkpoint.projectId) throw new Error('画板工具 project_id 与当前会话绑定不一致')
      const { project_id: _projectId, projectId: _projectIdCamel, ...withoutProjectId } = args
      args = withoutProjectId
    }
    // Older saved conversations and a few providers can omit the new purpose
    // field. Preserve execution compatibility while still emitting a useful
    // activity label; new prompts/schema instruct models to provide their own.
    const supportsDescription = Boolean((tool.inputSchema.properties as JsonObject | undefined)?.description)
    if (!String(args.description || '').trim() && tool.source !== 'mcp' && supportsDescription) args = { ...args, description: `执行：${tool.description}` }
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.map(String) : []
    // Compatibility for an old persisted tool definition that still exposed
    // project_id. Its value is supplied only to AJV, never to the model or the
    // functional board handler.
    const validationArgs = required.includes('project_id') && tool.name.startsWith('board_') ? { ...args, project_id: checkpoint.projectId } : args
    this.validate(tool, validationArgs)
    // `description` is an observable intent for the activity feed. It is not
    // part of the functional payload consumed by a built-in handler or MCP.
    const { description: _purpose, ...executionArgs } = args
    if (tool.source === 'mcp') return this.mcp.call(tool, executionArgs, signal)
    if (tool.name.startsWith('board_')) {
      if (!checkpoint.projectId) throw new Error('当前会话未绑定画板，无法执行画板操作')
      // The renderer bridge still receives the ID because it needs to locate
      // state, but it is injected here rather than model-controlled.
      return this.bridge(tool.name, { ...executionArgs, project_id: checkpoint.projectId }, { project_id: checkpoint.projectId, conversation_id: checkpoint.conversationId, thread_id: checkpoint.threadId, run_id: checkpoint.runId, tool_timeout_ms: tool.timeoutMs }, signal, tool.timeoutMs)
    }
    if (tool.handlerKey === 'plan') { checkpoint.plan = normalizePlan(executionArgs, checkpoint.plan); return { ok: true, plan: checkpoint.plan } }
    if (tool.handlerKey === 'diagram-quality') {
      const middlewareState = checkpoint.middlewareState || {}
      const quality = middlewareState.diagramQuality && typeof middlewareState.diagramQuality === 'object' && !Array.isArray(middlewareState.diagramQuality) ? middlewareState.diagramQuality as JsonObject : {}
      if (tool.name === 'diagram_set_brief') {
        const brief = normalizeDiagramBrief(executionArgs)
        checkpoint.middlewareState = { ...middlewareState, diagramQuality: { brief, stage: 'briefed', sopVersion: '1.0.0' } }
        return { ok: true, brief, findings: brief.objective && brief.audience && brief.keyQuestion ? [] : ['目标、受众和核心问题是 Brief 的必填质量信息。'], message: 'Diagram Brief 已保存；后续内容审查和验收将以此为准。' }
      }
      if (tool.name === 'diagram_get_brief') return { ok: true, brief: quality.brief || null, stage: quality.stage || 'unbriefed', sop_version: quality.sopVersion || '1.0.0' }
      if (tool.name === 'diagram_review_content') {
        const brief = quality.brief as DiagramBrief | undefined
        if (!brief) throw new Error('尚未建立 Diagram Brief；请先调用 diagram_set_brief')
        const model = normalizeDiagramModel(objectArg(executionArgs.model))
        const contentReview = reviewDiagramContent(brief, model)
        checkpoint.middlewareState = { ...middlewareState, diagramQuality: { ...quality, model, contentReview, acceptance: undefined, stage: contentReview.passed ? 'content-reviewed' : 'content-blocked' } }
        return { ok: true, model, content_review: contentReview }
      }
      if (tool.name === 'diagram_acceptance_check') {
        const brief = quality.brief as DiagramBrief | undefined
        const contentReview = quality.contentReview as ContentReview | undefined
        const acceptance = buildAcceptanceReport({ brief, contentReview, layoutReview: objectArg(executionArgs.layout_review), visualReview: objectArg(executionArgs.visual_review), requireVisualReview: executionArgs.require_visual_review === true })
        checkpoint.middlewareState = { ...middlewareState, diagramQuality: { ...quality, layoutReview: executionArgs.layout_review, visualReview: executionArgs.visual_review, acceptance, stage: acceptance.stage } }
        return { ok: true, acceptance }
      }
      throw new Error(`Unknown diagram quality tool: ${tool.name}`)
    }
    if (tool.handlerKey === 'load-skill') {
      const allowed = this.repository.threadMetadata(checkpoint.threadId).allowed_skill_ids
      const allowedSkillIds = Array.isArray(allowed) ? allowed.map(String) : undefined
      if (allowedSkillIds && !allowedSkillIds.includes(String(executionArgs.skill_id || ''))) throw new Error('此 Skill 未在当前画板项目中启用')
      const skill = this.repository.boundSkillContent(checkpoint.agentId, String(executionArgs.skill_id || ''))
      if (!skill) throw new Error('Skill 不存在、未启用或未绑定当前 Agent')
      // Skill IDs are implementation details. Return its display name so the
      // conversation can describe useful work rather than exposing SQLite IDs.
      return { skill_id: executionArgs.skill_id, skill_name: skill.name, skill_slug: skill.slug, content: skill.content, resources: skill.resources }
    }
    if (tool.handlerKey === 'skill-create') return this.repository.createSkillForEditorThread(checkpoint.threadId, String(executionArgs.name || ''), String(executionArgs.summary || ''), String(executionArgs.content || ''))
    if (tool.handlerKey === 'skill-get-name') return this.repository.skillNameForEditorThread(checkpoint.threadId)
    if (tool.handlerKey === 'skill-set-name') return this.repository.setSkillNameForEditorThread(checkpoint.threadId, String(executionArgs.name || ''), executionArgs.summary === undefined ? undefined : String(executionArgs.summary))
    if (tool.handlerKey === 'skill-list-files') return this.repository.skillFileListForThread(checkpoint.threadId)
    if (tool.handlerKey === 'skill-read-file') return this.repository.readSkillFileForThread(checkpoint.threadId, String(executionArgs.path || ''))
    if (tool.handlerKey === 'skill-write-file') return this.repository.writeSkillFileForThread(checkpoint.threadId, String(executionArgs.path || ''), String(executionArgs.content || ''))
    if (tool.handlerKey === 'skill-replace-text') return this.repository.replaceSkillTextForThread(checkpoint.threadId, String(executionArgs.path || ''), String(executionArgs.old_text || ''), String(executionArgs.new_text || ''))
    if (tool.handlerKey === 'skill-delete-file') return this.repository.deleteSkillFileForThread(checkpoint.threadId, String(executionArgs.path || ''))
    if (tool.handlerKey === 'read-file') return this.repository.readAttachmentText(String(executionArgs.attachment_id || ''))
    if (tool.handlerKey === 'view-image') return this.repository.inspectImage(String(executionArgs.attachment_id || ''))
    if (tool.handlerKey === 'web-fetch') {
      const response = await safeFetch(executionArgs.url, { signal, headers: { 'User-Agent': 'TuGo/2.0' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const type = String(response.headers.get('content-type') || '').toLowerCase()
      if (type && !/^(text\/|application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml))/.test(type)) throw new Error(`Unsupported web content type: ${type}`)
      const body = await boundedResponseText(response, 512_000)
      return { url: response.url, status: response.status, content: compact(body.text), truncated: body.truncated || body.text.length > 50_000 }
    }
    if (tool.handlerKey === 'web-search') {
      const query = String(executionArgs.query || ''); const count = Math.max(1, Math.min(Number(executionArgs.max_results || 5), 10))
      return searchWeb(query, count, signal)
    }
    throw new Error(`No builtin handler for ${tool.name}`)
  }
}

const objectArg = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
