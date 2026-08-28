import { afterEach, describe, expect, it, vi } from 'vitest'
import { TuGoApi } from './api'
import type { TuGoConfig } from './types'

const config: TuGoConfig = { theme: 'system' }
type RuntimeEvent = { subscriptionId: string; event: Record<string, any> }

const installRuntime = (request: (method: string, params: Record<string, any>) => unknown | Promise<unknown>) => {
  const eventListeners = new Set<(value: RuntimeEvent) => void>()
  const endListeners = new Set<(value: { subscriptionId: string; runId: string }) => void>()
  window.tugo = { runtime: {
    request: vi.fn(request) as never,
    onEvent: (listener: (value: RuntimeEvent) => void) => { eventListeners.add(listener); return () => eventListeners.delete(listener) },
    onStreamEnd: (listener: (value: { subscriptionId: string; runId: string }) => void) => { endListeners.add(listener); return () => endListeners.delete(listener) },
  } } as unknown as typeof window.tugo
  return {
    emit(subscriptionId: string, type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) { for (const listener of eventListeners) listener({ subscriptionId, event: { type, payload, ...extra } }) },
    end(subscriptionId: string, runId = 'run-1') { for (const listener of endListeners) listener({ subscriptionId, runId }) },
  }
}

describe('TuGo embedded Runtime client', () => {
  afterEach(() => { vi.unstubAllGlobals(); delete window.tugo })

  it('renders only lead message events and treats completed content as authoritative', async () => {
    let bridge: ReturnType<typeof installRuntime>
    bridge = installRuntime(async (method, params) => {
      if (method === 'run.start') queueMicrotask(() => {
        bridge.emit(params.subscription_id, 'agent.message.delta', { delta: '正在', call_id: 'call-1' })
        bridge.emit(params.subscription_id, 'subagent.message.delta', { delta: '内部过程' })
        bridge.emit(params.subscription_id, 'agent.message.delta', { delta: '绘制', call_id: 'call-1' })
        bridge.emit(params.subscription_id, 'agent.message.completed', { content: '绘制完成。' })
        bridge.end(params.subscription_id)
      })
      return { run_id: 'run-1' }
    })
    const updates: string[] = []
    await expect(new TuGoApi(config).streamChat('thread', 'agent', 'draw', value => updates.push(value), new AbortController().signal)).resolves.toBe('绘制完成。')
    expect(updates).toEqual(['正在', '正在绘制', '绘制完成。'])
  })

  it('rolls back failed attempt text and accepts a recovered final response', async () => {
    let bridge: ReturnType<typeof installRuntime>
    bridge = installRuntime(async (_method, params) => {
      queueMicrotask(() => {
        bridge.emit(params.subscription_id, 'agent.message.delta', { delta: 'bad draft', call_id: 'call-bad' })
        bridge.emit(params.subscription_id, 'llm.call.failed', { discard_output: true, error_detail: 'invalid tool call' })
        bridge.emit(params.subscription_id, 'agent.message.completed', { content: '画板已更新。' })
        bridge.end(params.subscription_id)
      })
      return { run_id: 'run-1' }
    })
    const updates: string[] = []
    await expect(new TuGoApi(config).streamChat('thread', 'agent', 'draw', value => updates.push(value), new AbortController().signal)).resolves.toBe('画板已更新。')
    expect(updates).toEqual(['bad draft', '', '画板已更新。'])
  })

  it('surfaces an explicit terminal Runtime failure', async () => {
    let bridge: ReturnType<typeof installRuntime>
    bridge = installRuntime(async (_method, params) => { queueMicrotask(() => { bridge.emit(params.subscription_id, 'session.failed', { error_detail: 'Invalid token' }); bridge.end(params.subscription_id) }); return { run_id: 'run-1' } })
    await expect(new TuGoApi(config).streamChat('thread', 'agent', 'draw', () => undefined, new AbortController().signal)).rejects.toThrow('Invalid token')
  })

  it('keeps a masked secret when updating an existing model with an empty key', async () => {
    const calls: Array<Record<string, any>> = []
    installRuntime(async (_method, params) => {
      calls.push(params)
      if (params.path === '/api/models?page_size=100') return { items: [{ model_id: 'current', name: 'tugo-openai-gpt-5', provider_id: 'openai', model: 'gpt-5', display_name: 'GPT-5', enabled: true }] }
      return { model_id: 'current', ...params.body }
    })
    await new TuGoApi(config).saveSingleModel({ modelId: 'current', providerId: 'openai', model: 'gpt-5', displayName: 'GPT-5', apiKey: '' })
    expect(calls[1].path).toBe('/api/models/current')
    expect(calls[1].body.extra_config).toMatchObject({ context_window: 128000, max_output_tokens: 32768, vision_capable: true })
    expect(calls[1].body.extra_config).not.toHaveProperty('api_key')
  })

  it('does not report an Agent with missing canvas tools as ready', async () => {
    installRuntime(async (_method, params) => {
      if (String(params.path).startsWith('/api/models')) return { items: [{ model_id: 'model', model: 'glm', enabled: true, extra_config: { probe_status: 'success' } }] }
      if (String(params.path).startsWith('/api/agents')) return { items: [{ agent_id: 'agent', name: 'tugo-architect', tool_names: [] }] }
      return { items: [{ slug: 'tugo-architect' }] }
    })
    await expect(new TuGoApi(config).inspectBootstrap()).resolves.toMatchObject({ l4: 'ready', agent: 'missing' })
  })

  it('cancels the active embedded run when the user aborts', async () => {
    let cancelRequested = false
    installRuntime(async method => { if (method === 'run.cancel') cancelRequested = true; return method === 'run.start' ? { run_id: 'run-1' } : undefined })
    const controller = new AbortController(); const pending = new TuGoApi(config).streamChat('thread', 'agent', 'draw', () => undefined, controller.signal)
    await Promise.resolve(); controller.abort('user')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelRequested).toBe(true)
  })
})
