import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundedResponseText, createPublicLookup, safeFetch, searchWeb, ToolExecutionError, ToolRegistry } from '../src/tools.js'
import type { RuntimeRepository } from '../src/repository.js'
import type { McpManager } from '../src/mcp.js'
import type { RunCheckpoint, ToolDefinition } from '../src/contracts.js'

afterEach(() => vi.unstubAllGlobals())

describe('safe web access', () => {
  it('revalidates DNS at socket lookup time and rejects mixed public/private answers', async () => {
    const lookup = createPublicLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] as never)
    await expect(new Promise((resolve, reject) => lookup('rebind.example', {}, (error, address) => error ? reject(error) : resolve(address)))).rejects.toThrow('non-public')
  })
  it('rejects redirects from a public URL into a private network', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } }))
    vi.stubGlobal('fetch', fetchMock)
    const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    await expect(safeFetch('https://example.com/start', {}, 5, resolver as never)).rejects.toThrow('non-public network address')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a hostname that DNS resolves into a private network before fetching', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    const resolver = vi.fn(async () => [{ address: '10.0.0.8', family: 4 }])
    await expect(safeFetch('https://rebind.example/path', {}, 5, resolver as never)).rejects.toThrow('non-public network address')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops reading a web response at the byte boundary', async () => {
    const response = new Response(new TextEncoder().encode('1234567890'), { headers: { 'Content-Type': 'text/plain' } })
    await expect(boundedResponseText(response, 5)).resolves.toEqual({ text: '12345', truncated: true })
  })

  it('falls back to a second search provider and returns normalized public results', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('primary unavailable'))
      .mockResolvedValueOnce(new Response('<a class="result__a" href="https://example.com/result">A &amp; B</a>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    await expect(searchWeb('fixture', 5, new AbortController().signal, resolver as never)).resolves.toEqual({ query: 'fixture', provider: 'duckduckgo', results: [{ url: 'https://example.com/result', title: 'A & B' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('tool execution boundary', () => {
  const checkpoint: RunCheckpoint = { version: 1, threadId: 'thread', runId: 'run', agentId: 'agent', projectId: 'project', conversationId: 'conversation', status: 'running', messages: [], completedToolCalls: {}, loopSignatures: [], usage: {}, step: 0 }
  const tool: ToolDefinition = { name: 'board_get_state', description: 'state', source: 'builtin', handlerKey: 'board-bridge', timeoutMs: 15, inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } } } }

  it('uses ToolDefinition.timeoutMs for a host tool', async () => {
    const registry = new ToolRegistry({} as RuntimeRepository, {} as McpManager, (_name, _args, _context, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })))
    await expect(registry.execute(tool, { project_id: 'project' }, checkpoint, new AbortController().signal)).rejects.toMatchObject({ name: 'ToolExecutionError', category: 'timeout', repairable: false, message: expect.stringContaining('15ms') })
  })

  it('propagates user cancellation instead of reporting a timeout', async () => {
    const registry = new ToolRegistry({} as RuntimeRepository, {} as McpManager, (_name, _args, _context, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })))
    const controller = new AbortController(); const pending = registry.execute({ ...tool, timeoutMs: 1000 }, { project_id: 'project' }, checkpoint, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('canonicalizes model-style board operations before they reach the renderer', async () => {
    let received: Record<string, unknown> = {}
    const registry = new ToolRegistry({} as RuntimeRepository, {} as McpManager, async (_name, args) => { received = args; return { ok: true } })
    const batch: ToolDefinition = { name: 'board_batch', description: 'batch', source: 'builtin', handlerKey: 'board-bridge', timeoutMs: 1000, inputSchema: { type: 'object', required: ['project_id', 'operations'], properties: { project_id: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } } } } }
    await registry.execute(batch, { project_id: 'project', operations: [
      { op: 'add_element', id: 'start', element: { shape: 'rounded-rect', label: '开始', style: { fill: '#0f0', textColor: '#fff' } } },
      { op: 'add_element', id: 'done', element: { shape: 'rectangle', text: '第一行\\n第二行', fontWeight: 700, fontStyle: 'italic', textDecoration: 'underline' } },
      { op: 'add_edge', id: 'edge', element: { source: 'start', target: 'done', style: { endArrow: true, routing: 'straight' } } },
    ] }, checkpoint, new AbortController().signal)
    expect(received.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'add_element', element: expect.objectContaining({ id: 'start', kind: 'rounded_rectangle', text: '开始', fill: '#0f0', textColor: '#fff' }) }),
      expect.objectContaining({ op: 'add_element', element: expect.objectContaining({ id: 'done', text: '第一行\n第二行', fontWeight: 'bold', fontStyle: 'italic', textDecoration: 'underline' }) }),
      expect.objectContaining({ op: 'add_edge', edge: expect.objectContaining({ id: 'edge', from: 'start', to: 'done', endArrow: 'arrow', routing: 'straight' }) }),
    ]))
  })

  it('unwraps GLM/Qwen board_batch argument wrappers before schema validation', async () => {
    let received: Record<string, unknown> = {}
    const registry = new ToolRegistry({} as RuntimeRepository, {} as McpManager, async (_name, args) => { received = args; return { ok: true } })
    const batch: ToolDefinition = { name: 'board_batch', description: 'batch', source: 'builtin', handlerKey: 'board-bridge', timeoutMs: 1000, inputSchema: { type: 'object', required: ['project_id', 'operations'], properties: { project_id: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } } }, additionalProperties: false } }
    await registry.execute(batch, { data: { projectId: 'project', ops: JSON.stringify([{ type: 'create', node: { id: 'n1', label: '开始' } }]) } }, checkpoint, new AbortController().signal)
    expect(received).toMatchObject({ project_id: 'project', operations: [expect.objectContaining({ op: 'add_element', element: expect.objectContaining({ id: 'n1', text: '开始' }) })] })
  })

  it('classifies any schema mismatch as a bounded repairable validation error', async () => {
    const registry = new ToolRegistry({} as RuntimeRepository, {} as McpManager, async () => ({ ok: true }))
    const strictTool: ToolDefinition = { name: 'load_skill', description: 'load', source: 'builtin', handlerKey: 'load-skill', inputSchema: { type: 'object', required: ['skill_id'], properties: { skill_id: { type: 'string' } }, additionalProperties: false } }
    await expect(registry.execute(strictTool, { skill_id: 7 } as never, checkpoint, new AbortController().signal)).rejects.toBeInstanceOf(ToolExecutionError)
    await expect(registry.execute(strictTool, { skill_id: 7 } as never, checkpoint, new AbortController().signal)).rejects.toMatchObject({ category: 'validation', repairable: true })
  })
})
