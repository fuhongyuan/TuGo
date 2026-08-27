import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelProviderError, parseTextToolCalls, ProviderRegistry } from '../src/providers.js'
import type { ModelRequest, ModelStreamEvent } from '../src/contracts.js'

afterEach(() => vi.unstubAllGlobals())

const request = (providerId = 'openai'): ModelRequest => ({
  model: { model_id: 'model', provider_id: providerId, model: 'vision-model', display_name: 'Vision', runtime_extra: { api_key: 'secret', base_url: 'https://model.example/v1' } },
  messages: [
    { role: 'user', content: 'inspect this' },
    { role: 'assistant', content: '', reasoning: 'considering', toolCalls: [{ id: 'call-1', name: 'inspect', arguments: { id: 1 } }] },
    { role: 'tool', name: 'inspect', toolCallId: 'call-1', content: '{"ok":true}' },
    { role: 'user', content: 'continue' },
  ],
  tools: [], maxOutputTokens: 128, signal: new AbortController().signal,
  attachments: [{ attachmentId: 'attachment-1', name: 'image.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
})
const collect = async (value: ModelRequest) => { const events: ModelStreamEvent[] = []; for await (const event of new ProviderRegistry().stream(value)) events.push(event); return events }

describe('Provider request mapping', () => {
  it('uses an explicit compatible base URL exactly, including non-v1 versions', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))
    const value = request(); value.model.runtime_extra.base_url = 'https://model.example/v3/'
    await collect(value)
    expect(urls).toEqual(['https://model.example/v3/chat/completions'])
  })

  it('does not invent a v1 path for an explicit compatible base URL', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))
    const value = request(); value.model.runtime_extra.base_url = 'https://model.example'
    await collect(value)
    expect(urls).toEqual(['https://model.example/chat/completions'])
  })

  it('uses a configured gateway path while retaining the shared base URL', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))
    const value = request('openai_responses'); value.model.runtime_extra.api_path = '/chat/responses'
    await collect(value)
    expect(urls).toEqual(['https://model.example/v1/chat/responses'])
  })

  it('keeps an Anthropic connection on the same versioned base URL', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))
    await collect(request('anthropic'))
    expect(urls).toEqual(['https://model.example/v1/messages'])
  })

  it('parses GLM assignment-style textual tool calls', () => {
    const parsed = parseTextToolCalls('<tool_call>board_batch project_id="project-1" operations=[{"type":"create","node":{"id":"start","label":"开始"}}]')
    expect(parsed.text).toBe('')
    expect(parsed.calls[0]).toMatchObject({ name: 'board_batch', arguments: { project_id: 'project-1', operations: [{ type: 'create', node: { id: 'start', label: '开始' } }] } })
  })
  it('parses GLM JSON-envelope textual tool calls', () => {
    const parsed = parseTextToolCalls('<tool_call> {"name":"board_batch","arguments":{"project_id":"project-1","operations":[{"type":"addNode","id":"start","data":{"label":"开始"}}]}}')
    expect(parsed.text).toBe('')
    expect(parsed.calls[0]).toMatchObject({ name: 'board_batch', arguments: { project_id: 'project-1', operations: [{ type: 'addNode', id: 'start', data: { label: '开始' } }] } })
    expect(parsed.calls[0].rawArguments).toBe(JSON.stringify(parsed.calls[0].arguments))
  })
  it('parses GLM function calls with assignment arguments and unquoted object keys', () => {
    const parsed = parseTextToolCalls('<tool_call>board_batch(project_id="project-1", operations=[{type: "create", node: {id: "start", label: "开始"}}])')
    expect(parsed.text).toBe('')
    expect(parsed.calls[0]).toMatchObject({ name: 'board_batch', arguments: { project_id: 'project-1', operations: [{ type: 'create', node: { id: 'start', label: '开始' } }] } })
  })
  it('sends images only with the latest user message and replays OpenAI tool calls', async () => {
    let body: Record<string, unknown> = {}
    const value = request(); value.messages[1].toolCalls![0].providerMetadata = { openaiToolCall: { thought_signature: 'sig-openai' } }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))
    for await (const _event of new ProviderRegistry().stream(value)) { /* consume */ }
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[1]).toMatchObject({ role: 'assistant', reasoning_content: 'considering' })
    expect((messages[1].tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ thought_signature: 'sig-openai' })
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
    expect(Array.isArray(messages[0].content)).toBe(false)
    expect(messages[3].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]))
  })

  it('uses native Responses function call history and input_image blocks', async () => {
    let body: Record<string, unknown> = {}
    const value = request('openai_responses'); value.messages[1].providerMetadata = { openAiResponseItems: [{ type: 'reasoning', id: 'reason-1', encrypted_content: 'opaque' }] }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }))
    for await (const _event of new ProviderRegistry().stream(value)) { /* consume */ }
    const input = body.input as Array<Record<string, unknown>>
    expect(input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call-1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' }),
      expect.objectContaining({ type: 'reasoning', id: 'reason-1', encrypted_content: 'opaque' }),
    ]))
    expect(input.at(-1)?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'input_image' })]))
  })

  it('re-materializes images on the historical user message that owns the reference', async () => {
    let body: Record<string, unknown> = {}; const value = request()
    value.messages[0].attachmentIds = ['attachment-1']; value.messages[3].attachmentIds = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }))
    await collect(value)
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]))
    expect(Array.isArray(messages[3].content)).toBe(false)
  })

  it('records one reconstructed streaming response instead of individual SSE frames', async () => {
    const debug: Record<string, unknown>[] = []; const value = request(); value.onDebug = entry => debug.push(entry)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"O"}}]}\n\ndata: {"choices":[{"delta":{"content":"K"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
    await collect(value)
    expect(debug.some(entry => entry.direction === 'response.frame')).toBe(false)
    expect(debug.find(entry => entry.direction === 'response.complete')).toMatchObject({ content: 'OK', streaming: true })
  })

  it('normalizes Responses text, reasoning, tools, usage and finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}',
      'data: {"type":"response.output_text.delta","delta":"hello"}',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","item_id":"item-1","call_id":"call-2","name":"inspect","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"id\\":2}"}',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"input_tokens_details":{"cached_tokens":3}}}}',
    ].join('\n\n') + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
    const events = await collect(request('openai_responses'))
    expect(events).toEqual(expect.arrayContaining([
      { type: 'reasoning-delta', delta: 'think' }, { type: 'text-delta', delta: 'hello' },
      { type: 'tool-call-started', call: { id: 'call-2', name: 'inspect' } },
      { type: 'tool-call-arguments-delta', call: { id: 'call-2', name: 'inspect' }, delta: '{"id":2}' },
      expect.objectContaining({ type: 'tool-call', call: expect.objectContaining({ name: 'inspect', arguments: { id: 2 } }) }),
      { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 3 } },
      { type: 'finish', reason: 'stop', rawReason: 'completed' },
    ]))
  })

  it('normalizes Anthropic text, reasoning, tools, usage and finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-a","name":"inspect"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":3}"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
    ].join('\n\n') + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
    const events = await collect(request('anthropic'))
    expect(events).toEqual(expect.arrayContaining([
      { type: 'reasoning-delta', delta: 'think' }, { type: 'text-delta', delta: 'hello' },
      { type: 'tool-call-started', call: { id: 'call-a', name: 'inspect' } },
      { type: 'tool-call-arguments-delta', call: { id: 'call-a', name: 'inspect' }, delta: '{"id":3}' },
      expect.objectContaining({ type: 'tool-call', call: expect.objectContaining({ name: 'inspect', arguments: { id: 3 } }) }),
      { type: 'finish', reason: 'tool_calls', rawReason: 'tool_use' },
    ]))
    expect(events.filter(event => event.type === 'usage')).toHaveLength(2)
  })

  it('normalizes Gemini text, reasoning, tools, usage and finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"think","thought":true},{"text":"hello"},{"functionCall":{"name":"inspect","args":{"id":4}},"thoughtSignature":"sig-gemini"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":6,"totalTokenCount":14,"cachedContentTokenCount":2}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
    const events = await collect(request('gemini'))
    expect(events).toEqual(expect.arrayContaining([
      { type: 'reasoning-delta', delta: 'think' }, { type: 'text-delta', delta: 'hello' },
      expect.objectContaining({ type: 'tool-call', call: expect.objectContaining({ name: 'inspect', arguments: { id: 4 }, providerMetadata: { geminiPart: { thoughtSignature: 'sig-gemini' } } }) }),
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14, cachedInputTokens: 2 } },
      { type: 'finish', reason: 'stop', rawReason: 'STOP' },
    ]))
  })

  it('replays native Gemini thought signatures on later tool turns', async () => {
    let body: Record<string, unknown> = {}; const value = request('gemini')
    value.messages[1].toolCalls![0].providerMetadata = { geminiPart: { thoughtSignature: 'sig-native' } }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }))
    await collect(value)
    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    expect(contents[1].parts[0]).toMatchObject({ functionCall: { name: 'inspect', args: { id: 1 } }, thoughtSignature: 'sig-native' })
  })

  it('waits for a stable compatible-provider call id before announcing a tool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"inspect"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"stable-call","function":{"arguments":"{\\"id\\":2}"}}]},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
    const value = request()
    value.tools = [{ name: 'inspect', description: 'inspect', source: 'builtin', inputSchema: { type: 'object' } }]
    const events = await collect(value)
    expect(events.filter(event => event.type === 'tool-call-started')).toEqual([
      { type: 'tool-call-started', call: { id: 'stable-call', name: 'inspect' } },
    ])
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-call', call: expect.objectContaining({ id: 'stable-call', name: 'inspect' }) }),
    ]))
  })

  it('maps compatible Provider capabilities and malformed stream errors', async () => {
    expect(new ProviderRegistry().capabilities('qwen')).toMatchObject({ tools: true, reasoning: true, vision: true, usage: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {bad json}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })))
    await expect(collect(request('qwen'))).rejects.toMatchObject<ModelProviderError>({ category: 'malformed_response' })
  })

  it('retains a failed HTTP response body and request id for Run Debug', async () => {
    const debug: Record<string, unknown>[] = []
    const value = request(); value.onDebug = entry => debug.push(entry)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"unsupported image format"}}', {
      status: 400,
      headers: { 'x-oneapi-request-id': 'request-vision-1' },
    })))
    await expect(collect(value)).rejects.toMatchObject<ModelProviderError>({
      status: 400,
      providerDetail: { requestId: 'request-vision-1', body: expect.stringContaining('unsupported image format') },
    })
    expect(debug).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'response.complete', status: 400, error: true, body: expect.stringContaining('unsupported image format'), request_id: 'request-vision-1' }),
    ]))
  })

  it('propagates Provider cancellation', async () => {
    const controller = new AbortController(); const value = request(); value.signal = controller.signal
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))))
    const pending = collect(value); controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not accept a malformed generation response as Ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } })))
    await expect(new ProviderRegistry().test(request().model, new AbortController().signal)).rejects.toThrow()
  })

  it('probes the configured model through streaming generation and tool calling', async () => {
    let url = ''; let init: RequestInit = {}
    vi.stubGlobal('fetch', vi.fn(async (value: string, options: RequestInit) => { url = value; init = options; return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"probe","function":{"name":"tugo_probe","arguments":"{\\"value\\":\\"ok\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }))
    await expect(new ProviderRegistry().test(request().model, new AbortController().signal)).resolves.toMatchObject({ ok: true, agent_ready: true, stages: { generation: 'success', streaming: 'success', tool_calling: 'success' } })
    expect(url).toBe('https://model.example/v1/chat/completions')
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer secret' } })
  })
})
