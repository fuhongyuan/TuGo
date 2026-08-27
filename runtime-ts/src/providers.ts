import { randomUUID } from 'node:crypto'
import type { FinishReason, JsonObject, ModelRequest, ModelStreamEvent, ProviderCapability, RuntimeMessage, ToolCall, ToolDefinition, Usage } from './contracts.js'
import { ModelProviderError, providerCategoryForStatus } from './errors.js'

export { ModelProviderError } from './errors.js'

type ProviderAdapter = { stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> }

const asObject = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const normalizeFinishReason = (raw: unknown): FinishReason => {
  const value = String(raw || '').toLowerCase()
  if (['stop', 'end_turn', 'stop_sequence', 'completed', 'finish_reason_stop'].includes(value)) return 'stop'
  if (['tool_calls', 'tool_use', 'function_call', 'malformed_function_call'].includes(value)) return 'tool_calls'
  if (['length', 'max_tokens', 'max_output_tokens', 'incomplete'].includes(value)) return 'length'
  if (['content_filter', 'safety', 'blocked', 'recitation', 'refusal', 'prohibited_content'].includes(value)) return 'content_filter'
  return 'unknown'
}
const normalizeUsage = (input: unknown, output: unknown, total: unknown, cached?: unknown): Usage => {
  const inputTokens = Number(input || 0); const outputTokens = Number(output || 0)
  return { inputTokens, outputTokens, totalTokens: Number(total || inputTokens + outputTokens), cachedInputTokens: Number(cached || 0) }
}
const parseStreamJson = (data: string) => {
  try { return JSON.parse(data) as JsonObject }
  catch { throw new ModelProviderError('Model stream contained malformed JSON', undefined, undefined, 'malformed_response') }
}
const parseArguments = (raw: string): JsonObject => {
  try { const value = JSON.parse(raw || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('arguments must be an object'); return value as JsonObject }
  catch (error) { throw new ModelProviderError(`Invalid tool arguments: ${error instanceof Error ? error.message : String(error)}; raw=${raw.slice(0, 1000)}`, undefined, undefined, 'malformed_response') }
}
const parsePythonLikeArguments = (raw: string) => {
  const json = `{${raw
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*=/g, '$1"$2":')
    .replace(/(^|,\s*)([A-Za-z_]\w*)\s*=/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null') }}`
  return parseArguments(json)
}
const parseAssignmentArguments = (raw: string) => {
  const args: JsonObject = {}; let cursor = 0
  while (cursor < raw.length) {
    while (cursor < raw.length && /[\s,]/.test(raw[cursor])) cursor += 1
    const key = raw.slice(cursor).match(/^([A-Za-z_]\w*)\s*=/)
    if (!key) break
    cursor += key[0].length
    const start = cursor; const opening = raw[cursor]
    if (opening === '"' || opening === "'") {
      const quote = opening; cursor += 1
      while (cursor < raw.length) { if (raw[cursor] === '\\') cursor += 2; else if (raw[cursor++] === quote) break }
    } else if (opening === '[' || opening === '{') {
      const closing = opening === '[' ? ']' : '}'; let depth = 0; let quote = ''
      while (cursor < raw.length) {
        const char = raw[cursor++]
        if (quote) { if (char === '\\') cursor += 1; else if (char === quote) quote = ''; continue }
        if (char === '"' || char === "'") quote = char
        else if (char === opening) depth += 1
        else if (char === closing && --depth === 0) break
      }
    } else while (cursor < raw.length && !/\s/.test(raw[cursor])) cursor += 1
    const value = raw.slice(start, cursor).trim()
    try { args[key[1]] = JSON.parse(value) } catch { args[key[1]] = value.replace(/^['"]|['"]$/g, '') }
  }
  return args
}
export const parseTextToolCalls = (content: string): { text: string; calls: ToolCall[] } => {
  const calls: ToolCall[] = []
  let text = content
  const functionStyle = /<tool_call>\s*([A-Za-z_]\w*)\s*\(([\s\S]*?)\)\s*(?:<\/tool_call>)?/g
  text = text.replace(functionStyle, (_, name: string, raw: string) => {
    const argumentsValue = parsePythonLikeArguments(raw)
    calls.push({ id: `call_${randomUUID()}`, name, rawArguments: JSON.stringify(argumentsValue), arguments: argumentsValue })
    return ''
  })
  const xmlStyle = /<tool_call>\s*<function=([^>]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g
  text = text.replace(xmlStyle, (_, name: string, body: string) => {
    const args: JsonObject = {}
    for (const match of body.matchAll(/<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g)) {
      const raw = match[2].trim()
      try { args[match[1].trim()] = JSON.parse(raw) } catch { args[match[1].trim()] = raw }
    }
    calls.push({ id: `call_${randomUUID()}`, name: name.trim(), arguments: args })
    return ''
  })
  const jsonEnvelopeStyle = /<tool_call>\s*(\{[\s\S]*\})\s*(?:<\/tool_call>|$)/g
  text = text.replace(jsonEnvelopeStyle, (full: string, raw: string) => {
    try {
      const envelope = parseArguments(raw)
      const name = typeof envelope.name === 'string' ? envelope.name.trim() : ''
      const args = asObject(envelope.arguments)
      if (!name || !Object.keys(args).length) return full
      calls.push({ id: `call_${randomUUID()}`, name, rawArguments: JSON.stringify(args), arguments: args })
      return ''
    } catch { return full }
  })
  const assignmentStyle = /<tool_call>\s*([A-Za-z_]\w*)\s+([\s\S]*?)(?:<\/tool_call>|$)/g
  text = text.replace(assignmentStyle, (full: string, name: string, raw: string) => {
    const args = parseAssignmentArguments(raw)
    if (!Object.keys(args).length) return full
    calls.push({ id: `call_${randomUUID()}`, name, rawArguments: JSON.stringify(args), arguments: args })
    return ''
  })
  const bareStyle = /\b([A-Za-z_]\w*)\s*\(\s*(\{[\s\S]*\})\s*\)\s*$/
  text = text.replace(bareStyle, (_, name: string, raw: string) => {
    calls.push({ id: `call_${randomUUID()}`, name, rawArguments: raw, arguments: parseArguments(raw) })
    return ''
  })
  return { text: text.trim(), calls }
}
const endpoint = (base: unknown, suffix: string, fallback: string) => {
  // An explicitly configured base URL is authoritative.  Providers and
  // gateways use /v1, /v2, /v3, or no version path at all; silently appending
  // /v1 turned e.g. https://host/v2 into https://host/v2/v1/chat/completions.
  // Only the built-in fallback carries the protocol's default version.
  const value = String(base || fallback).trim().replace(/\/$/, '')
  if (value.endsWith(suffix)) return value
  return `${value}${suffix}`
}
const configuredPath = (extra: JsonObject, fallback: string) => {
  const value = String(extra.api_path || '').trim()
  if (!value) return fallback
  return value.startsWith('/') ? value : `/${value}`
}
const retryAfterMs = (response: Response) => {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
}
const throwHttp = async (response: Response, onDebug?: ModelRequest['onDebug']) => {
  const body = (await response.text()).slice(0, 4000)
  const requestId = response.headers.get('x-oneapi-request-id') || response.headers.get('x-request-id') || response.headers.get('request-id') || undefined
  onDebug?.({ direction: 'response.complete', streaming: false, error: true, status: response.status, body: body || response.statusText, ...(requestId ? { request_id: requestId } : {}) })
  throw new ModelProviderError(`Model API ${response.status}: ${body || response.statusText}`, response.status, retryAfterMs(response), providerCategoryForStatus(response.status), { status: response.status, category: providerCategoryForStatus(response.status), body: body || response.statusText, requestId })
}

async function* sse(response: Response, onFrame?: (frame: JsonObject) => void): AsyncGenerator<{ event?: string; data: string }> {
  if (!response.body) throw new Error('Model API returned no response body')
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
  while (true) {
    const { done, value } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || ''
    for (const frame of frames) {
      let event: string | undefined; const data: string[] = []
      for (const line of frame.split(/\r?\n/)) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trimStart()) }
      if (data.length) { const joined = data.join('\n'); onFrame?.({ event: event || null, data: joined }); yield { event, data: joined } }
    }
    if (done) break
  }
    if (buffer.trim()) { const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); if (data) { onFrame?.({ event: null, data }); yield { data } } }
}

const debugRequest = (request: ModelRequest, url: string, init: { headers?: Record<string, string>; body?: string }) => request.onDebug?.({ direction: 'request', url, method: 'POST', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null })
const debugResponse = (request: ModelRequest, response: Response, frames: JsonObject[]) => {
  request.onDebug?.({ direction: 'response', status: response.status, headers: Object.fromEntries(response.headers.entries()) })
  // Keep transport frames in memory only. Run Debug records one reconstructed
  // response after the stream ends; persisting every SSE frame makes traces
  // enormous without adding useful model-level information.
  return (frame: JsonObject) => { frames.push(frame) }
}
const completeDebugResponse = (request: ModelRequest, frames: JsonObject[]) => {
  if (!frames.length) return
  const payloads = frames.map(frame => { try { return JSON.parse(String(frame.data || '')) as JsonObject } catch { return { data: frame.data } as JsonObject } }).filter(payload => String(payload.data || '') !== '[DONE]')
  const text: string[] = []; const reasoning: string[] = []; const toolCalls: JsonObject[] = []; let usage: JsonObject | undefined; let finishReason = ''
  const addText = (value: unknown, target: string[]) => { if (typeof value === 'string' && value) target.push(value) }
  for (const payload of payloads) {
    const choices = Array.isArray(payload.choices) ? payload.choices as JsonObject[] : []
    for (const choice of choices) { const delta = asObject(choice.delta); addText(delta.content, text); addText(delta.reasoning_content ?? delta.reasoning, reasoning); if (choice.finish_reason) finishReason = String(choice.finish_reason); for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls as JsonObject[] : []) toolCalls.push(call) }
    addText(payload.delta, text); addText(payload.text, text); addText(payload.thinking, reasoning)
    const response = asObject(payload.response); const responseOutput = Array.isArray(response.output) ? response.output as JsonObject[] : []
    for (const item of responseOutput) { if (item.type === 'message') for (const part of Array.isArray(item.content) ? item.content as JsonObject[] : []) addText(part.text, text); if (item.type === 'function_call') toolCalls.push(item) }
    for (const candidate of Array.isArray(payload.candidates) ? payload.candidates as JsonObject[] : []) { const content = asObject(candidate.content); for (const part of Array.isArray(content.parts) ? content.parts as JsonObject[] : []) { addText(part.text, text); if (part.functionCall) toolCalls.push(asObject(part.functionCall)) } if (candidate.finishReason) finishReason = String(candidate.finishReason) }
    if (payload.usage || payload.usageMetadata) usage = asObject(payload.usage || payload.usageMetadata)
  }
  request.onDebug?.({ direction: 'response.complete', streaming: true, frame_count: frames.length, content: text.join(''), ...(reasoning.length ? { reasoning: reasoning.join('') } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(usage ? { usage } : {}), ...(finishReason ? { finish_reason: finishReason } : {}) })
}

const isLastUser = (messages: RuntimeMessage[], index: number) => {
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) if (messages[cursor].role === 'user') return cursor === index
  return false
}
const attachmentsForMessage = (messages: RuntimeMessage[], index: number, attachments: ModelRequest['attachments'] = []) => {
  const ids = messages[index].attachmentIds
  if (ids?.length) return attachments.filter(item => ids.includes(item.attachmentId))
  const hasBindings = messages.some(message => message.attachmentIds?.length)
  return !hasBindings && isLastUser(messages, index) ? attachments : []
}
const openAiMessages = (messages: RuntimeMessage[], attachments: ModelRequest['attachments'] = []) => messages.map((message, index) => {
  if (message.role === 'assistant' && message.toolCalls?.length) return { role: 'assistant', content: message.content || null, ...(message.reasoning ? { reasoning_content: message.reasoning } : {}), tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) }, ...asObject(call.providerMetadata?.openaiToolCall) })) }
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  const messageAttachments = attachmentsForMessage(messages, index, attachments)
  if (message.role === 'user' && messageAttachments.length) return { role: 'user', content: [
    { type: 'text', text: message.content },
    ...messageAttachments.map(item => ({ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.dataBase64}` } })),
  ] }
  return { role: message.role, content: message.content }
})
const normalizeSchema = (schema: JsonObject): JsonObject => {
  const out: JsonObject = { ...schema }
  // Gemini requires an explicit `type` on every property that has an `enum`.
  // OpenAI tolerates the omission, but being explicit costs nothing.
  if (Array.isArray(out.enum) && !out.type) out.type = 'string'
  // `const` is not understood by Gemini; normalise to a single-value enum.
  if ('const' in out && !Array.isArray(out.enum)) { const constVal = out.const; delete out.const; out.type = out.type || 'string'; out.enum = [constVal] }
  if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
    const props: JsonObject = {}
    for (const [key, value] of Object.entries(out.properties as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) props[key] = normalizeSchema(value as JsonObject)
      else props[key] = value as any
    }
    out.properties = props
  }
  if (out.items && typeof out.items === 'object' && !Array.isArray(out.items)) out.items = normalizeSchema(out.items as JsonObject)
  return out
}
const normalizeTools = (tools: ToolDefinition[]) => tools.map(tool => ({ ...tool, inputSchema: normalizeSchema(tool.inputSchema) }))

const openAiTools = (tools: ToolDefinition[]) => tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
const toolMarkerIndex = (text: string, tools: ToolDefinition[]) => {
  const indexes = [text.indexOf('<tool_call>')]
  for (const tool of tools) {
    const escaped = tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`\\b${escaped}\\s*\\(`).exec(text)
    if (match) indexes.push(match.index)
  }
  return indexes.filter(index => index >= 0).sort((a, b) => a - b)[0] ?? -1
}

class OpenAiChatAdapter implements ProviderAdapter {
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const extra = request.model.runtime_extra
    const url = endpoint(extra.base_url, configuredPath(extra, '/chat/completions'), 'https://api.openai.com/v1')
    const toolChoice = 'auto'
    const nonStreamingTools = false
    // Do not manufacture a fake credential when a key is absent.  Besides
    // producing a misleading provider-side 401, it prevents unauthenticated
    // OpenAI-compatible local endpoints from being used at all.  A custom
    // Authorization header (if configured) still takes precedence below.
    const apiKey = String(extra.api_key || '')
    const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...asObject(extra.headers) as Record<string, string> }
    const body = JSON.stringify({ model: request.model.model, messages: openAiMessages(request.messages, request.attachments), ...(request.tools.length ? { tools: openAiTools(normalizeTools(request.tools)), tool_choice: toolChoice, parallel_tool_calls: false } : {}), stream: !nonStreamingTools, ...(!nonStreamingTools ? { stream_options: { include_usage: true } } : {}), max_tokens: request.maxOutputTokens, ...(asObject(extra.request_options)) })
    debugRequest(request, url, { headers, body }); const response = await fetch(url, { method: 'POST', signal: request.signal, headers, body }); const responseFrames: JsonObject[] = []; const frameDebug = debugResponse(request, response, responseFrames)
    if (!response.ok) await throwHttp(response, request.onDebug)
    if (nonStreamingTools) {
      const payload = await response.json() as JsonObject
      request.onDebug?.({ direction: 'response.complete', streaming: false, body: payload })
      const choice = asObject((payload.choices as unknown[])?.[0]); const message = asObject(choice.message)
      const content = typeof message.content === 'string' ? message.content : ''
      const parsed = parseTextToolCalls(content)
      if (parsed.text) yield { type: 'text-delta', delta: parsed.text }
      for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls as JsonObject[] : []) {
        const fn = asObject(raw.function); const argumentsText = String(fn.arguments || '{}')
        const signature = raw.thought_signature || raw.thoughtSignature
        yield { type: 'tool-call', call: { id: String(raw.id || `call_${randomUUID()}`), name: String(fn.name || ''), rawArguments: argumentsText, arguments: parseArguments(argumentsText), ...(signature ? { providerMetadata: { openaiToolCall: { thought_signature: signature } } } : {}) } }
      }
      for (const call of parsed.calls) yield { type: 'tool-call', call }
      const usage = asObject(payload.usage)
      if (Object.keys(usage).length) yield { type: 'usage', usage: normalizeUsage(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, asObject(usage.prompt_tokens_details).cached_tokens) }
      const rawReason = String(choice.finish_reason || '')
      yield { type: 'finish', reason: normalizeFinishReason(rawReason), rawReason }
      return
    }
    const calls = new Map<number, { id: string; name: string; arguments: string; idStable: boolean; signature?: unknown }>()
    let textBuffer = ''
    let holdingToolSyntax = false
    const announcedCallIndexes = new Set<number>()
    let finishReason = ''
    for await (const frame of sse(response, frameDebug)) {
      if (frame.data === '[DONE]') break
      const payload = parseStreamJson(frame.data)
      const usage = asObject(payload.usage)
      if (Object.keys(usage).length) yield { type: 'usage', usage: normalizeUsage(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, asObject(usage.prompt_tokens_details).cached_tokens) }
      const choice = asObject((payload.choices as unknown[])?.[0]); finishReason = String(choice.finish_reason || finishReason)
      const delta = asObject(choice.delta)
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning-delta', delta: reasoning }
      if (typeof delta.content === 'string' && delta.content) {
        if (!request.tools.length) yield { type: 'text-delta', delta: delta.content }
        else {
          textBuffer += delta.content
          const marker = toolMarkerIndex(textBuffer, request.tools)
          if (marker >= 0) {
            if (marker > 0) yield { type: 'text-delta', delta: textBuffer.slice(0, marker) }
            textBuffer = textBuffer.slice(marker); holdingToolSyntax = true
          } else if (!holdingToolSyntax && textBuffer.length > 96) {
            const safe = textBuffer.slice(0, -96); textBuffer = textBuffer.slice(-96)
            if (safe) yield { type: 'text-delta', delta: safe }
          }
        }
      }
      for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls as JsonObject[] : []) {
        const index = Number(raw.index || 0); const current = calls.get(index) || { id: String(raw.id || `call_${randomUUID()}`), name: '', arguments: '', idStable: Boolean(raw.id) }; const fn = asObject(raw.function)
        if (raw.id) { current.id = String(raw.id); current.idStable = true } ; if (fn.name) current.name += String(fn.name); if (fn.arguments) current.arguments += String(fn.arguments)
        current.signature = raw.thought_signature || raw.thoughtSignature || current.signature; calls.set(index, current)
        if (current.idStable && current.name && request.tools.some(tool => tool.name === current.name) && !announcedCallIndexes.has(index)) {
          announcedCallIndexes.add(index)
          yield { type: 'tool-call-started', call: { id: current.id, name: current.name } }
        }
        if (current.idStable && announcedCallIndexes.has(index) && typeof fn.arguments === 'string' && fn.arguments) yield { type: 'tool-call-arguments-delta', call: { id: current.id, name: current.name }, delta: fn.arguments }
      }
    }
    completeDebugResponse(request, responseFrames)
    const textCalls = request.tools.length ? parseTextToolCalls(textBuffer) : { text: textBuffer, calls: [] }
    if (textCalls.text) yield { type: 'text-delta', delta: textCalls.text }
    for (const call of [...calls.values()]) yield { type: 'tool-call', call: { id: call.id, name: call.name, rawArguments: call.arguments, arguments: parseArguments(call.arguments), ...(call.signature ? { providerMetadata: { openaiToolCall: { thought_signature: call.signature } } } : {}) } }
    for (const call of textCalls.calls) yield { type: 'tool-call', call }
    yield { type: 'finish', reason: normalizeFinishReason(finishReason), rawReason: finishReason }
  }
}

class OpenAiResponsesAdapter implements ProviderAdapter {
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const extra = request.model.runtime_extra; const url = endpoint(extra.base_url, configuredPath(extra, '/responses'), 'https://api.openai.com/v1')
    const input = request.messages.flatMap<JsonObject>((message, index): JsonObject[] => {
      if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.toolCallId, output: message.content }]
      if (message.role === 'assistant' && message.toolCalls?.length) return [
        ...(Array.isArray(message.providerMetadata?.openAiResponseItems) ? message.providerMetadata.openAiResponseItems as JsonObject[] : []),
        ...(message.content ? [{ role: 'assistant', content: message.content }] : []),
        ...message.toolCalls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) })),
      ]
      const messageAttachments = attachmentsForMessage(request.messages, index, request.attachments)
      return [{ role: message.role, content: message.role === 'user' && messageAttachments.length ? [
        { type: 'input_text', text: message.content },
        ...messageAttachments.map(item => ({ type: 'input_image', image_url: `data:${item.mimeType};base64,${item.dataBase64}` })),
      ] : message.content }]
    })
    const apiKey = String(extra.api_key || '')
    const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...asObject(extra.headers) as Record<string, string> }
    const body = JSON.stringify({ model: request.model.model, input, stream: true, max_output_tokens: request.maxOutputTokens, tools: normalizeTools(request.tools).map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })), ...(asObject(extra.request_options)) })
    debugRequest(request, url, { headers, body }); const response = await fetch(url, { method: 'POST', signal: request.signal, headers, body }); const responseFrames: JsonObject[] = []; const frameDebug = debugResponse(request, response, responseFrames)
    if (!response.ok) await throwHttp(response, request.onDebug)
    const calls = new Map<string, { id: string; name: string; arguments: string }>(); const replayItems = new Map<string, JsonObject>()
    let rawFinishReason = ''
    for await (const frame of sse(response, frameDebug)) {
      if (frame.data === '[DONE]') break
      const payload = parseStreamJson(frame.data); const type = String(payload.type || frame.event || '')
      if (type === 'response.output_text.delta') yield { type: 'text-delta', delta: String(payload.delta || '') }
      else if (type === 'response.reasoning_summary_text.delta') yield { type: 'reasoning-delta', delta: String(payload.delta || '') }
      else if (type === 'response.output_item.added') { const item = asObject(payload.item); const itemKey = String(item.item_id || item.id || randomUUID()); if (item.type === 'function_call') { const call = { id: String(item.call_id || item.id || randomUUID()), name: String(item.name || ''), arguments: String(item.arguments || '') }; calls.set(itemKey, call); if (call.name) yield { type: 'tool-call-started', call: { id: call.id, name: call.name } } } else if (item.type === 'reasoning') replayItems.set(itemKey, structuredClone(item)) }
      else if (type === 'response.function_call_arguments.delta') { const key = String(payload.item_id || ''); const call = calls.get(key); const delta = String(payload.delta || ''); if (call) { call.arguments += delta; if (delta) yield { type: 'tool-call-arguments-delta', call: { id: call.id, name: call.name }, delta } } }
      else if (type === 'response.output_item.done') { const item = asObject(payload.item); const key = String(item.item_id || item.id || ''); const call = calls.get(key); if (call && item.arguments) call.arguments = String(item.arguments); if (item.type === 'reasoning' && key) replayItems.set(key, structuredClone(item)) }
      else if (type === 'response.completed') { const completed = asObject(payload.response); const usage = asObject(completed.usage); rawFinishReason = String(completed.status || 'completed'); yield { type: 'usage', usage: normalizeUsage(usage.input_tokens, usage.output_tokens, usage.total_tokens, asObject(usage.input_tokens_details).cached_tokens) } }
      else if (type === 'response.incomplete') rawFinishReason = 'incomplete'
      else if (type === 'error' || type === 'response.failed') throw new ModelProviderError(String(asObject(payload.error).message || 'Responses API failed'), undefined, undefined, 'unknown')
    }
    completeDebugResponse(request, responseFrames)
    for (const call of calls.values()) yield { type: 'tool-call', call: { id: call.id, name: call.name, rawArguments: call.arguments, arguments: parseArguments(call.arguments) } }
    if (replayItems.size) yield { type: 'provider-metadata', metadata: { openAiResponseItems: [...replayItems.values()] } }
    yield { type: 'finish', reason: normalizeFinishReason(rawFinishReason), rawReason: rawFinishReason }
  }
}

class AnthropicAdapter implements ProviderAdapter {
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const extra = request.model.runtime_extra; const base = String(extra.base_url || 'https://api.anthropic.com').replace(/\/$/, '')
    const systems = request.messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n')
    const nonSystem = request.messages.filter(item => item.role !== 'system')
    const messages = nonSystem.map((item, index) => {
      const messageAttachments = attachmentsForMessage(nonSystem, index, request.attachments)
      const replayBlocks = Array.isArray(item.providerMetadata?.anthropicContentBlocks) ? item.providerMetadata.anthropicContentBlocks as JsonObject[] : []
      return item.role === 'tool' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.toolCallId, content: item.content }] } : item.role === 'assistant' && replayBlocks.length ? { role: 'assistant', content: replayBlocks } : item.role === 'assistant' && item.toolCalls?.length ? { role: 'assistant', content: [{ type: 'text', text: item.content }, ...item.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))] } : item.role === 'user' && messageAttachments.length ? { role: 'user', content: [
        ...messageAttachments.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataBase64 } })),
        { type: 'text', text: item.content },
      ] } : { role: item.role, content: item.content }
    })
    const defaultPath = base.endsWith('/v1') ? '/messages' : '/v1/messages'
    const url = `${base}${configuredPath(extra, defaultPath)}`; const headers = { 'Content-Type': 'application/json', 'x-api-key': String(extra.api_key || ''), 'anthropic-version': String(extra.anthropic_version || '2023-06-01'), ...asObject(extra.headers) as Record<string, string> }
    const body = JSON.stringify({ model: request.model.model, system: systems, messages, max_tokens: request.maxOutputTokens, stream: true, tools: normalizeTools(request.tools).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })), ...asObject(extra.request_options) })
    debugRequest(request, url, { headers, body }); const response = await fetch(url, { method: 'POST', signal: request.signal, headers, body }); const responseFrames: JsonObject[] = []; const frameDebug = debugResponse(request, response, responseFrames)
    if (!response.ok) await throwHttp(response, request.onDebug)
    const calls = new Map<number, { id: string; name: string; arguments: string }>(); const contentBlocks = new Map<number, JsonObject>()
    let rawFinishReason = ''
    for await (const frame of sse(response, frameDebug)) {
      if (frame.data === '[DONE]') break
      const payload = parseStreamJson(frame.data); const type = String(payload.type || frame.event || ''); const index = Number(payload.index || 0)
      if (type === 'content_block_start') {
        const block = structuredClone(asObject(payload.content_block)); contentBlocks.set(index, block)
        if (block.type === 'tool_use') { const call = { id: String(block.id || randomUUID()), name: String(block.name || ''), arguments: '' }; calls.set(index, call); if (call.name) yield { type: 'tool-call-started', call: { id: call.id, name: call.name } } }
      }
      else if (type === 'content_block_delta') {
        const delta = asObject(payload.delta); const block = contentBlocks.get(index)
        if (delta.type === 'text_delta') { const value = String(delta.text || ''); if (block) block.text = String(block.text || '') + value; yield { type: 'text-delta', delta: value } }
        if (delta.type === 'thinking_delta') { const value = String(delta.thinking || ''); if (block) block.thinking = String(block.thinking || '') + value; yield { type: 'reasoning-delta', delta: value } }
        if (delta.type === 'signature_delta' && block) block.signature = String(block.signature || '') + String(delta.signature || '')
        if (delta.type === 'input_json_delta') { const call = calls.get(index); const value = String(delta.partial_json || ''); if (call) { call.arguments += value; if (value) yield { type: 'tool-call-arguments-delta', call: { id: call.id, name: call.name }, delta: value } } }
      }
      else if (type === 'message_start' || type === 'message_delta') { const usage = asObject(type === 'message_start' ? asObject(payload.message).usage : payload.usage); if (type === 'message_delta') rawFinishReason = String(asObject(payload.delta).stop_reason || rawFinishReason); if (Object.keys(usage).length) yield { type: 'usage', usage: normalizeUsage(usage.input_tokens, usage.output_tokens, undefined, usage.cache_read_input_tokens) } }
      else if (type === 'error') throw new ModelProviderError(String(asObject(payload.error).message || 'Anthropic API failed'), undefined, undefined, 'unknown')
    }
    completeDebugResponse(request, responseFrames)
    for (const call of calls.values()) yield { type: 'tool-call', call: { id: call.id, name: call.name, rawArguments: call.arguments, arguments: parseArguments(call.arguments) } }
    if (contentBlocks.size) {
      for (const [index, call] of calls) { const block = contentBlocks.get(index); if (block) block.input = parseArguments(call.arguments) }
      yield { type: 'provider-metadata', metadata: { anthropicContentBlocks: [...contentBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) } }
    }
    yield { type: 'finish', reason: normalizeFinishReason(rawFinishReason), rawReason: rawFinishReason }
  }
}

class GeminiAdapter implements ProviderAdapter {
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const extra = request.model.runtime_extra; const base = String(extra.base_url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
    const url = `${base}/models/${encodeURIComponent(request.model.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(String(extra.api_key || ''))}`
    const system = request.messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n')
    const nonSystem = request.messages.filter(item => item.role !== 'system')
    const contents = nonSystem.map((item, index) => {
      const messageAttachments = attachmentsForMessage(nonSystem, index, request.attachments)
      return { role: item.role === 'assistant' ? 'model' : 'user', parts: item.role === 'tool' ? [{ functionResponse: { name: item.name || 'tool', response: { content: item.content } } }] : item.role === 'assistant' && item.toolCalls?.length ? [
        ...(item.content ? [{ text: item.content }] : []), ...item.toolCalls.map(call => ({ functionCall: { name: call.name, args: call.arguments }, ...asObject(call.providerMetadata?.geminiPart) })),
      ] : item.role === 'user' && messageAttachments.length ? [
        { text: item.content }, ...messageAttachments.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.dataBase64 } })),
      ] : [{ text: item.content }] }
    })
    const headers = { 'Content-Type': 'application/json', ...asObject(extra.headers) as Record<string, string> }
    const body = JSON.stringify({ systemInstruction: system ? { parts: [{ text: system }] } : undefined, contents, ...(request.tools.length ? { tools: [{ functionDeclarations: normalizeTools(request.tools).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }] } : {}), generationConfig: { maxOutputTokens: request.maxOutputTokens }, ...asObject(extra.request_options) })
    debugRequest(request, url, { headers, body }); const response = await fetch(url, { method: 'POST', signal: request.signal, headers, body }); const responseFrames: JsonObject[] = []; const frameDebug = debugResponse(request, response, responseFrames)
    if (!response.ok) await throwHttp(response, request.onDebug)
    let rawFinishReason = ''
    for await (const frame of sse(response, frameDebug)) {
      if (frame.data === '[DONE]') break
      const payload = parseStreamJson(frame.data); const candidate = asObject((payload.candidates as unknown[])?.[0]); const parts = asObject(candidate.content).parts; rawFinishReason = String(candidate.finishReason || rawFinishReason)
      for (const part of Array.isArray(parts) ? parts as JsonObject[] : []) { if (part.text) yield { type: part.thought === true ? 'reasoning-delta' : 'text-delta', delta: String(part.text) }; const call = asObject(part.functionCall); if (call.name) yield { type: 'tool-call', call: { id: `call_${randomUUID()}`, name: String(call.name), arguments: asObject(call.args), ...(part.thoughtSignature ? { providerMetadata: { geminiPart: { thoughtSignature: part.thoughtSignature } } } : {}) } } }
      const usage = asObject(payload.usageMetadata); if (Object.keys(usage).length) yield { type: 'usage', usage: normalizeUsage(usage.promptTokenCount, usage.candidatesTokenCount, usage.totalTokenCount, usage.cachedContentTokenCount) }
    }
    completeDebugResponse(request, responseFrames)
    yield { type: 'finish', reason: normalizeFinishReason(rawFinishReason), rawReason: rawFinishReason }
  }
}

export class ProviderRegistry {
  private readonly openAi = new OpenAiChatAdapter()
  capabilities(providerId: string): ProviderCapability {
    const id = providerId.toLowerCase()
    if (id === 'openai_responses') return { text: true, tools: true, reasoning: true, vision: true, streaming: true, usage: true }
    if (id === 'anthropic' || id === 'claude') return { text: true, tools: true, reasoning: true, vision: true, streaming: true, usage: true }
    if (id === 'google' || id === 'gemini') return { text: true, tools: true, reasoning: true, vision: true, streaming: true, usage: true }
    if (['openai', 'openai-compatible', 'deepseek', 'qwen', 'zhipu', 'glm', 'minimax', 'mimo', 'vllm', 'mindie'].includes(id)) return { text: true, tools: true, reasoning: true, vision: true, streaming: true, usage: true }
    throw new Error(`Unsupported model provider: ${providerId}`)
  }
  adapter(providerId: string): ProviderAdapter {
    const id = providerId.toLowerCase()
    if (id === 'openai_responses') return new OpenAiResponsesAdapter()
    if (id === 'anthropic' || id === 'claude') return new AnthropicAdapter()
    if (id === 'google' || id === 'gemini') return new GeminiAdapter()
    if (['openai', 'openai-compatible', 'deepseek', 'qwen', 'zhipu', 'glm', 'minimax', 'mimo', 'vllm', 'mindie'].includes(id)) return this.openAi
    throw new Error(`Unsupported model provider: ${providerId}`)
  }
  stream(request: ModelRequest) { return this.adapter(request.model.provider_id).stream(request) }
  async test(model: ModelRequest['model'], signal: AbortSignal) {
    const probeTool: ToolDefinition = {
      name: 'tugo_probe', description: 'Return the supplied value to verify structured tool calling.', source: 'builtin', timeoutMs: 1_000,
      inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string', const: 'ok' } }, additionalProperties: false },
    }
    let text = ''; let toolCall = false; let finish = 'unknown'
    for await (const event of this.stream({
      model,
      messages: [{ role: 'system', content: 'You are a connection probe. Call tugo_probe with value "ok". Do not answer with prose.' }, { role: 'user', content: 'Run the probe now.' }],
      tools: [probeTool], maxOutputTokens: 64, signal,
    })) {
      if (event.type === 'text-delta') text += event.delta
      else if (event.type === 'tool-call' && event.call.name === probeTool.name && event.call.arguments.value === 'ok') toolCall = true
      else if (event.type === 'finish') finish = event.reason
    }
    if (!toolCall) throw new ModelProviderError(`模型能够响应，但没有完成工具调用探测${text.trim() ? `：${text.trim().slice(0, 160)}` : `（finish=${finish}）`}`, undefined, undefined, 'malformed_response')
    return { ok: true, agent_ready: true, stages: { generation: 'success', streaming: 'success', tool_calling: 'success' }, message: '文本生成、流式响应和工具调用均通过' }
  }
}
