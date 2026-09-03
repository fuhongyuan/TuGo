import { describe, expect, it } from 'vitest'
import { buildMiddlewarePipeline } from '../src/middleware.js'
import type { RunCheckpoint, RuntimeMessage, ToolDefinition } from '../src/contracts.js'

const checkpoint = (): RunCheckpoint => ({ version: 1, threadId: 'thread', runId: 'run', agentId: 'agent', status: 'running', messages: [], completedToolCalls: {}, loopSignatures: [], usage: {}, step: 0 })
const planTool: ToolDefinition = { name: 'plan', description: 'plan', inputSchema: { type: 'object' }, source: 'builtin', timeoutMs: 1000 }
const prompt = (name: string, variables: Record<string, unknown> = {}) => `${name}:${Object.values(variables).join('|')}`

describe('runtime middleware pipeline', () => {
  it('honors disabled plan and loop detection switches', async () => {
    const built = buildMiddlewarePipeline({ plan: { enabled: false }, loopDetection: { enabled: false } }, undefined, prompt)
    expect(built.planMode).toBe('disabled')
    const state = checkpoint(); const messages: RuntimeMessage[] = []
    await built.pipeline.beforeModel({ checkpoint: state, messages, tools: [planTool], skills: [] })
    await built.pipeline.beforeTool({ checkpoint: state, call: { id: '1', name: 'x', arguments: {} } })
    await built.pipeline.beforeTool({ checkpoint: state, call: { id: '2', name: 'x', arguments: {} } })
    expect(messages).toEqual([])
    expect(state.loopSignatures).toEqual([])
  })

  it('injects a concrete skill catalog instead of a count', async () => {
    const built = buildMiddlewarePipeline({ plan: { enabled: false }, loopDetection: { enabled: false } }, undefined, prompt)
    const messages: RuntimeMessage[] = []
    await built.pipeline.beforeModel({ checkpoint: checkpoint(), messages, tools: [], skills: [{ skill_id: 'skill-1', slug: 'diagram', name: 'Diagram', description: 'Draw diagrams', version: '2' }] })
    expect(messages[0]?.content).toContain('skill-1 (diagram)')
    expect(messages[0]?.content).toContain('Draw diagrams')
  })

  it('keeps reusable skill and plan instructions ahead of conversation history', async () => {
    const built = buildMiddlewarePipeline({ plan: { mode: 'optional' }, loopDetection: { enabled: false } }, undefined, prompt)
    const messages: RuntimeMessage[] = [
      { role: 'system', content: 'stable runtime prompt' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'volatile runtime context' },
    ]
    await built.pipeline.beforeModel({ checkpoint: checkpoint(), messages, tools: [planTool], skills: [{ skill_id: 'skill-1', slug: 'diagram', name: 'Diagram', description: 'Draw diagrams', version: '2' }] })
    expect(messages.map(message => message.content)).toEqual([
      'stable runtime prompt',
      expect.stringContaining('middleware.skill_catalog'),
      'middleware.plan_optional:',
      'hello',
      'volatile runtime context',
    ])
  })

  it('keeps changing plan state after conversation history', async () => {
    const built = buildMiddlewarePipeline({ plan: { mode: 'optional' }, loopDetection: { enabled: false } }, undefined, prompt)
    const state = checkpoint(); state.plan = { id: 'plan-1', status: 'active', steps: [] }
    const messages: RuntimeMessage[] = [{ role: 'system', content: 'stable runtime prompt' }, { role: 'user', content: 'hello' }]
    await built.pipeline.beforeModel({ checkpoint: state, messages, tools: [planTool], skills: [] })
    expect(messages.at(-1)?.content).toContain('middleware.plan_current')
  })

  it('reports only middleware hooks that actually execute', async () => {
    const entries: Array<{ middleware: string; hook: string; status: string }> = []
    const built = buildMiddlewarePipeline({ plan: { mode: 'optional' }, loopDetection: {} }, entry => entries.push(entry), prompt)
    const state = checkpoint(); const messages: RuntimeMessage[] = []
    await built.pipeline.beforeModel({ checkpoint: state, messages, tools: [planTool], skills: [] })
    await built.pipeline.afterModel({ checkpoint: state, text: 'done', calls: [] })
    await built.pipeline.beforeTool({ checkpoint: state, call: { id: '1', name: 'search', arguments: { query: 'x' } } })
    expect(entries.filter(entry => entry.status === 'started').map(entry => `${entry.middleware}:${entry.hook}`)).toEqual([
      'skill-catalog:before_model', 'plan:before_model', 'plan:after_model', 'loop-detection:before_tool',
    ])
  })

  it('stops high-frequency calls even when their arguments keep changing', async () => {
    const built = buildMiddlewarePipeline({ plan: { enabled: false }, loopDetection: { warnAfter: 99, stopAfter: 100, frequencyWarnAfter: 2, frequencyStopAfter: 3 } }, undefined, prompt)
    const state = checkpoint()
    await built.pipeline.beforeTool({ checkpoint: state, call: { id: '1', name: 'search', arguments: { query: 'a' } } })
    await built.pipeline.beforeTool({ checkpoint: state, call: { id: '2', name: 'search', arguments: { query: 'b' } } })
    // Tool-call/result messages must remain adjacent for OpenAI-compatible
    // providers, so loop warnings are deferred until the Runtime finishes the
    // current tool-call batch.
    expect((state.middlewareState?.deferredToolWarnings as string[] | undefined)?.at(-1)).toContain('middleware.loop_frequency_warning')
    await expect(built.pipeline.beforeTool({ checkpoint: state, call: { id: '3', name: 'search', arguments: { query: 'c' } } })).rejects.toThrow('调用过于频繁')
  })
})
