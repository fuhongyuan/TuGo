import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { jsPDF } from 'jspdf'
import { TuGoRuntime } from '../src/runtime.js'
import type { RuntimeToHost } from '../src/contracts.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sse = (chunks: unknown[]) => new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
const promptTemplates = [
  { name: 'runtime.system', content: '{{agent_soul}}{{conversation_summary}}\nTools: {{tool_names}}', version: 'test' },
  { name: 'runtime.summarize', content: 'Summarize facts.', version: 'test' },
  { name: 'runtime.retry', content: 'Retry with valid JSON.', version: 'test' },
  { name: 'runtime.attachment_note', content: 'Attachments: {{attachment_ids}}', version: 'test' },
  { name: 'runtime.conversation_summary', content: '<conversation_summary>{{summary}}</conversation_summary>', version: 'test' },
  { name: 'runtime.interrupted_tool_result', content: 'ERROR: interrupted', version: 'test' },
  { name: 'runtime.tool_error', content: 'ERROR: {{message}}', version: 'test' },
  { name: 'runtime.view_image_materialized', content: 'Image {{attachment_id}} materialized.', version: 'test' },
  { name: 'runtime.board_capture_materialized', content: 'Board screenshot {{region}} materialized.', version: 'test' },
  { name: 'runtime.safety_termination', content: 'Safety stopped the response: {{reason}}.', version: 'test' },
  { name: 'middleware.skill_catalog', content: '<available_skills>{{catalog}}</available_skills>', version: 'test' },
  { name: 'middleware.plan_current', content: '<current_plan>{{plan}}</current_plan>', version: 'test' },
  { name: 'middleware.plan_required', content: 'Plan required.', version: 'test' },
  { name: 'middleware.plan_optional', content: 'Plan optional.', version: 'test' },
  { name: 'middleware.plan_reminder_create', content: 'Create plan.', version: 'test' },
  { name: 'middleware.plan_reminder_continue', content: 'Continue plan.', version: 'test' },
  { name: 'middleware.loop_warning', content: 'Do not repeat {{tool_name}}.', version: 'test' },
  { name: 'middleware.loop_frequency_warning', content: 'Too many {{tool_name}} calls: {{count}}.', version: 'test' },
]

const createRuntime = async (messages: RuntimeToHost[], options: { maxAttempts?: number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'tugo-loop-test-')); roots.push(root)
  const defaults = join(root, 'defaults.json')
  await writeFile(defaults, JSON.stringify({ templateVersion: '1', providers: [{ provider_id: 'openai', display_name: 'OpenAI' }], promptTemplates, tools: [
    { name: 'board_get_state', description: 'state', handlerKey: 'board-bridge', inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } }, additionalProperties: false } },
    { name: 'board_batch', description: 'batch', handlerKey: 'board-bridge', inputSchema: { type: 'object', required: ['project_id', 'operations'], properties: { project_id: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } } }, additionalProperties: false } },
    { name: 'board_capture_image', description: 'capture board image', handlerKey: 'board-bridge', inputSchema: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' } }, additionalProperties: false } },
    { name: 'view_image', description: 'view image', handlerKey: 'view-image', inputSchema: { type: 'object', required: ['attachment_id'], properties: { attachment_id: { type: 'string' } }, additionalProperties: false } },
    { name: 'plan', description: 'plan', handlerKey: 'plan', inputSchema: { type: 'object', required: ['steps'], properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } } } } },
    { name: 'load_skill', description: 'skill', handlerKey: 'load-skill', inputSchema: { type: 'object', required: ['skill_id'], properties: { skill_id: { type: 'string' } } } },
    { name: 'read_file', description: 'read attachment', handlerKey: 'read-file', inputSchema: { type: 'object', required: ['attachment_id'], properties: { attachment_id: { type: 'string' } }, additionalProperties: false } },
  ], skill: { slug: 'tugo-architect', version: '1', description: 'canvas skill', content: 'full skill instructions' }, agent: { name: 'tugo-architect', display_name: 'Agent', soul: 'system', tool_names: ['board_get_state', 'board_batch', 'board_capture_image', 'view_image', 'plan', 'load_skill', 'read_file'], skill_slugs: ['tugo-architect'], middleware: { plan: { enabled: true, mode: 'optional' }, title: { enabled: false }, maxSteps: 12, modelRetry: { maxAttempts: options.maxAttempts ?? 1 } } } }))
  let runtime!: TuGoRuntime
  runtime = new TuGoRuntime(root, defaults, message => {
    messages.push(message)
    if (message.kind === 'tool_call') runtime.resolveHostTool({ kind: 'tool_result', id: message.id, result: message.name === 'board_capture_image'
      ? { ok: true, mime_type: 'image/png', image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1OwAAAABJRU5ErkJggg==', region: { x: 0, y: 0, width: 1, height: 1 } }
      : { ok: true } })
  })
  await runtime.start()
  runtime.setSecrets({ 'test-secret': 'TUGO_TEST_SECRET_SHOULD_NOT_PERSIST_42' })
  const model = await runtime.http('POST', '/api/models', { name: 'test', provider_id: 'openai', model: 'test', display_name: 'Test', extra_config: { api_key_ref: 'test-secret', base_url: 'https://example.test/v1' } }) as Record<string, unknown>
  runtime.repository.recordModelProbe(String(model.model_id), true, 'test fixture')
  const resources = await runtime.http('POST', '/api/runtime/bootstrap', { model_id: model.model_id }) as { agent: Record<string, unknown> }
  return { runtime, agentId: String(resources.agent.agent_id), root }
}
const waitForEnd = (messages: RuntimeToHost[], subscription: string) => new Promise<void>((resolve, reject) => {
  const started = Date.now()
  const timer = setInterval(() => {
    if (messages.some(item => item.kind === 'stream_end' && item.subscription_id === subscription)) { clearInterval(timer); resolve() }
    else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error('runtime timeout')) }
  }, 5)
})

describe('TuGoRuntime loop', () => {
  it('seeds an independent thread with branch history before its first run', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body || '{}')))
      return sse([{ choices: [{ delta: { content: '分支会话已接续。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'branch-project', conversation_id: 'branch-conversation' } }) as { thread_id: string }
    await expect(runtime.http('PUT', `/api/threads/${thread.thread_id}/context`, { messages: [
      { role: 'user', content: '先画一个登录流程' },
      { role: 'assistant', content: '已创建登录流程图。' },
    ] })).resolves.toMatchObject({ seeded: true, message_count: 2 })
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '在这个基础上加上 MFA', subscription_id: 'branch-history' })
    await waitForEnd(messages, 'branch-history')
    const prompt = JSON.stringify(bodies[0]?.messages || [])
    expect(prompt).toContain('先画一个登录流程')
    expect(prompt).toContain('已创建登录流程图。')
    expect(prompt).toContain('在这个基础上加上 MFA')
    await runtime.close()
  })

  it('stops an active run before replacing its thread context for replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
    })))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'replay-project', conversation_id: 'replay-conversation' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '旧请求', subscription_id: 'replace-active-run' })
    await expect(runtime.http('PUT', `/api/threads/${thread.thread_id}/context`, {
      replace_active_run: true,
      messages: [{ role: 'user', content: '保留到这里' }],
    })).resolves.toMatchObject({ seeded: true, message_count: 1 })
    await expect(runtime.http('GET', `/api/threads/${thread.thread_id}`, {})).resolves.toMatchObject({
      thread_id: thread.thread_id,
      active_run_id: undefined,
    })
    expect(runtime.repository.latestCheckpoint(thread.thread_id)?.messages).toEqual([{ role: 'user', content: '保留到这里' }])
    await runtime.close()
  })

  it('reports an active run so a reloaded renderer can resume its event stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 35))
      return sse([{ choices: [{ delta: { content: '仍在运行。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    const run = runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '继续画图', subscription_id: 'resume-after-reload' })
    await expect(runtime.http('GET', `/api/threads/${thread.thread_id}`, {})).resolves.toMatchObject({ thread_id: thread.thread_id, active_run_id: run.run_id, subscription_id: 'resume-after-reload', status: 'running' })
    await waitForEnd(messages, 'resume-after-reload')
    await expect(runtime.http('GET', `/api/threads/${thread.thread_id}`, {})).resolves.toMatchObject({ thread_id: thread.thread_id, active_run_id: undefined })
    await runtime.close()
  })

  it('enforces one active writer for all conversations of the same project', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const firstThread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'shared', conversation_id: 'first' } }) as { thread_id: string }
    const secondThread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'shared', conversation_id: 'second' } }) as { thread_id: string }
    const first = runtime.startRun({ thread_id: firstThread.thread_id, agent_id: agentId, content: '编辑画板', subscription_id: 'project-lock-1' })
    expect(() => runtime.startRun({ thread_id: secondThread.thread_id, agent_id: agentId, content: '同时编辑', subscription_id: 'project-lock-2' })).toThrow('当前画板已有运行中的会话')
    runtime.cancelRun(first.run_id); await waitForEnd(messages, 'project-lock-1')
    expect(() => runtime.startRun({ thread_id: secondThread.thread_id, agent_id: agentId, content: '现在编辑', subscription_id: 'project-lock-3' })).not.toThrow()
    await runtime.close()
  })

  it('emits run.steered only when an accepted instruction enters the next agent loop', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      // Leave the first model turn open long enough for a UI steering request
      // to arrive. The next loop is where Runtime must consume and announce it.
      if (request === 1) {
        await new Promise(resolve => setTimeout(resolve, 30))
        return sse([{ choices: [{ delta: { content: '第一段答复。' }, finish_reason: 'stop' }] }])
      }
      return sse([{ choices: [{ delta: { content: '已收到补充要求。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    const run = runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '先回答', subscription_id: 'steering' })
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000
      const timer = setInterval(() => {
        if (messages.some(message => message.kind === 'event' && message.event.type === 'session.started')) { clearInterval(timer); resolve() }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('run did not start')) }
      }, 5)
    })
    expect(runtime.steerRun(run.run_id, '请使用更清晰的分层。', 'queue-42')).toMatchObject({ accepted: true })
    await waitForEnd(messages, 'steering')
    const steered = messages.find(message => message.kind === 'event' && message.subscription_id === 'steering' && message.event.type === 'run.steered')
    expect(steered).toMatchObject({ kind: 'event', event: { payload: { instructions: [{ client_request_id: 'queue-42', content: '请使用更清晰的分层。' }] } } })
    expect(request).toBe(2)
    await runtime.close()
  })

  it('saves a board screenshot as an attachment and materializes it only after view_image', async () => {
    let request = 0; const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body || '{}')))
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'capture-1', function: { name: 'board_capture_image', arguments: '{"project_id":"p1"}' } }] }, finish_reason: 'tool_calls' }] }])
      if (request === 2) {
        const attachmentId = JSON.stringify(bodies[1]?.messages || []).match(/attachment_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i)?.[0]
        expect(attachmentId).toBeTruthy()
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'view-1', function: { name: 'view_image', arguments: JSON.stringify({ attachment_id: attachmentId }) } }] }, finish_reason: 'tool_calls' }] }])
      }
      return sse([{ choices: [{ delta: { content: '我已根据截图检查并完成调整。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '请看一下画布视觉效果', subscription_id: 'capture' })
    await waitForEnd(messages, 'capture')
    const serializedTurns = bodies.map(body => JSON.stringify(body.messages || []))
    expect(serializedTurns[1]).not.toContain('image_url')
    expect(serializedTurns).toEqual(expect.arrayContaining([expect.stringContaining('image_url')]))
    const visualTurn = serializedTurns.find(turn => turn.includes('image_url')) || ''
    expect(visualTurn).toContain('data:image/png;base64,iVBORw0KGgo')
    const captureResult = messages.find(item => item.kind === 'event' && item.subscription_id === 'capture' && item.event.type === 'agent.tool_result' && item.event.payload.tool_name === 'board_capture_image')
    expect(captureResult?.kind === 'event' && captureResult.event.payload.attachment).toBeFalsy()
    const runId = messages.find(item => item.kind === 'event' && item.subscription_id === 'capture' && item.event.type === 'session.started')
    expect(runId?.kind === 'event' && JSON.stringify(runtime.repository.runConfigSnapshot(runId.event.run_id))).not.toContain('image_base64')
    await runtime.close()
  })

  it('serves the RunDebug trace route from the embedded runtime', async () => {
    const messages: RuntimeToHost[] = []; const { runtime } = await createRuntime(messages)
    await expect(runtime.http('POST', '/api/runtime/trace', { thread_id: 'missing', run_id: 'missing' })).resolves.toMatchObject({ run_id: 'missing', loops: [] })
    await runtime.close()
  })

  it('runs different boards concurrently, keeps events isolated and rejects a second run on one board', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { messages?: Array<{ content?: string }> }
      const isFirst = JSON.stringify(body.messages || []).includes('p1 hello')
      await new Promise(resolve => setTimeout(resolve, isFirst ? 35 : 5))
      return sse([{ choices: [{ delta: { content: isFirst ? 'project-one' : 'project-two' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const first = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    const second = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p2', conversation_id: 'c2' } }) as { thread_id: string }
    runtime.startRun({ thread_id: first.thread_id, agent_id: agentId, content: 'p1 hello', subscription_id: 'parallel-1' })
    expect(() => runtime.startRun({ thread_id: first.thread_id, agent_id: agentId, content: 'duplicate', subscription_id: 'duplicate' })).toThrow('运行中的任务')
    runtime.startRun({ thread_id: second.thread_id, agent_id: agentId, content: 'p2 hello', subscription_id: 'parallel-2' })
    await Promise.all([waitForEnd(messages, 'parallel-1'), waitForEnd(messages, 'parallel-2')])
    const firstEvents = messages.filter(item => item.kind === 'event' && item.subscription_id === 'parallel-1')
    const secondEvents = messages.filter(item => item.kind === 'event' && item.subscription_id === 'parallel-2')
    expect(firstEvents.every(item => item.kind === 'event' && item.event.thread_id === first.thread_id)).toBe(true)
    expect(secondEvents.every(item => item.kind === 'event' && item.event.thread_id === second.thread_id)).toBe(true)
    expect(JSON.stringify(firstEvents)).toContain('project-one'); expect(JSON.stringify(firstEvents)).not.toContain('project-two')
    expect(JSON.stringify(secondEvents)).toContain('project-two'); expect(JSON.stringify(secondEvents)).not.toContain('project-one')
    await runtime.close()
  })

  it('offers the complete agent tool set for a greeting without forcing a tool call', async () => {
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || '{}'))
      return sse([{ choices: [{ delta: { reasoning_content: '先判断是否需要工具。' }, finish_reason: null }] }, { choices: [{ delta: { content: '你好！' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '用户请求：你好', subscription_id: 's1' })
    await waitForEnd(messages, 's1')
    expect(messages.some(item => item.kind === 'tool_call')).toBe(false)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.message.delta' && item.event.payload.reasoning_delta === '先判断是否需要工具。')).toBe(true)
    const prompt = JSON.stringify(requestBody?.messages || [])
    expect(JSON.stringify(requestBody?.tools || [])).toContain('board_get_state')
    expect(JSON.stringify(requestBody?.tools || [])).toContain('board_batch')
    expect(JSON.stringify(requestBody?.tools || [])).toContain('board_capture_image')
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('tugo-architect')
    const runId = messages.find(item => item.kind === 'event' && item.event.type === 'session.started' && item.subscription_id === 's1')
    const snapshot = runId?.kind === 'event' ? runtime.repository.runConfigSnapshot(runId.event.run_id) : undefined
    expect(snapshot).toMatchObject({ version: 1, agent: { name: 'tugo-architect' }, model: { model: 'test' } })
    expect(JSON.stringify(snapshot)).not.toContain('TUGO_TEST_SECRET_SHOULD_NOT_PERSIST_42')
    await runtime.close()
  })

  it('offers board tools for context-dependent follow-up text', async () => {
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || '{}'))
      return sse([{ choices: [{ delta: { content: '继续处理。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '继续', subscription_id: 'follow-up-tools' })
    await waitForEnd(messages, 'follow-up-tools')
    const tools = JSON.stringify(requestBody?.tools || [])
    expect(tools).toContain('board_get_state')
    expect(tools).toContain('board_batch')
    await runtime.close()
  })

  it('suppresses tool calls returned with a provider safety finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'unsafe-call', function: { name: 'board_batch', arguments: '{"description":"调整登录流程","project_id":"p1","operations":[]}' } }] }, finish_reason: 'content_filter' }] },
    ])))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '用户请求：测试安全终止', subscription_id: 's-safety' })
    await waitForEnd(messages, 's-safety')
    expect(messages.some(item => item.kind === 'tool_call')).toBe(false)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.tool_use')).toBe(false)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.tool_arguments.delta' && item.event.payload.preview === '调整登录流程')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.tool_cancelled')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.message.completed' && /safety policy|content_filter/i.test(String(item.event.payload.content)))).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed')).toBe(true)
    await runtime.close()
  })

  it('binds a board tool call to its project, conversation, thread and run', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'board_get_state', arguments: '{"project_id":"p1"}' } }] }, finish_reason: 'tool_calls' }] },
      ])
      return sse([{ choices: [{ delta: { content: '已读取画板。' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    const run = runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '画布项目 ID：p1。用户请求：读取画板', subscription_id: 's2' })
    await waitForEnd(messages, 's2')
    const call = messages.find(item => item.kind === 'tool_call')
    expect(call).toMatchObject({ kind: 'tool_call', context: { project_id: 'p1', conversation_id: 'c1', thread_id: thread.thread_id, run_id: run.run_id } })
    const preparingIndex = messages.findIndex(item => item.kind === 'event' && item.event.type === 'agent.tool_preparing')
    const useIndex = messages.findIndex(item => item.kind === 'event' && item.event.type === 'agent.tool_use')
    expect(preparingIndex).toBeGreaterThanOrEqual(0)
    expect(useIndex).toBeGreaterThan(preparingIndex)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.tool_use')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.tool_use' && item.event.payload.tool_description === 'state' && item.event.payload.tool_source === 'builtin')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.tool_result')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'stream.end')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && String(item.event.type).startsWith('tool.call.'))).toBe(false)
    const journal = await runtime.http('POST', '/api/runtime/journal', { run_id: run.run_id }) as { items: Array<Record<string, unknown>> }
    expect(journal.items.map(item => item.event_type)).toEqual(expect.arrayContaining(['run.started', 'model.request', 'model.response', 'tool.request', 'tool.response', 'run.finished']))
    expect(journal.items.some(item => item.phase === 'middleware')).toBe(true)
    const trace = await runtime.http('POST', '/api/runtime/trace', { run_id: run.run_id }) as { loops: Array<{ model: unknown[]; middleware: unknown[]; tools: unknown[] }> }
    expect(trace.loops.some(loop => loop.model.length > 0 && loop.middleware.length > 0 && loop.tools.length > 0)).toBe(true)
    await runtime.close()
  })

  it('reuses a historical image by reference without persisting Base64 or API keys', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(String(init?.body || '{}'))); return sse([{ choices: [{ delta: { content: '看到了。' }, finish_reason: 'stop' }] }]) }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId, root } = await createRuntime(messages)
    const image = join(root, 'history.png'); await writeFile(image, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0]))
    const attachment = await runtime.http('POST', '/api/attachments/import', { path: image }) as { attachment_id: string }
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '用户请求：看图', attachment_ids: [attachment.attachment_id], subscription_id: 'image-1' }); await waitForEnd(messages, 'image-1')
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '用户请求：刚才图片是什么', subscription_id: 'image-2' }); await waitForEnd(messages, 'image-2')
    const secondMessages = bodies.at(-1)?.messages as Array<{ role: string; content: unknown }>
    expect(secondMessages.some(item => item.role === 'user' && Array.isArray(item.content) && JSON.stringify(item.content).includes('data:image/png;base64,'))).toBe(true)
    expect(Array.isArray(secondMessages.filter(item => item.role === 'user').at(-1)?.content)).toBe(false)
    await runtime.close()
    const database = (await readFile(join(root, 'runtime.sqlite'))).toString('latin1')
    expect(database).not.toContain('TUGO_TEST_SECRET_SHOULD_NOT_PERSIST_42')
    expect(database).not.toContain('iVBORw0KGgo')
  })

  it('disables an incorrectly declared vision capability when the model rejects images', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Model only supports text input; received unsupported content type image_url"}}', { status: 400 })))
    const messages: RuntimeToHost[] = []; const { runtime, agentId, root } = await createRuntime(messages)
    const image = join(root, 'unsupported.png'); await writeFile(image, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0]))
    const attachment = await runtime.http('POST', '/api/attachments/import', { path: image }) as { attachment_id: string }
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '用户请求：看图', attachment_ids: [attachment.attachment_id], subscription_id: 'vision-rejected' }); await waitForEnd(messages, 'vision-rejected')
    const failed = messages.find(item => item.kind === 'event' && item.event.type === 'session.failed')
    expect(failed?.kind === 'event' ? failed.event.payload : {}).toMatchObject({
      error_code: 'MODEL_VISION_UNSUPPORTED',
      user_message: expect.stringContaining('不支持图片输入'),
      technical_detail: expect.stringContaining('only supports text input'),
      provider_error: { status: 400, body: expect.stringContaining('only supports text input') },
    })
    const models = await runtime.http('GET', '/api/models', {}) as { items: Array<{ extra_config: { vision_capable: boolean } }> }
    expect(models.items[0].extra_config.vision_capable).toBe(false)
    await runtime.close()
  })

  it('does not disable model vision when only the gateway image format is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Unsupported content type image_url; data URL is invalid for this endpoint"}}', { status: 400 })))
    const messages: RuntimeToHost[] = []; const { runtime, agentId, root } = await createRuntime(messages)
    const image = join(root, 'format-unsupported.png'); await writeFile(image, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0]))
    const attachment = await runtime.http('POST', '/api/attachments/import', { path: image }) as { attachment_id: string }
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '用户请求：看图', attachment_ids: [attachment.attachment_id], subscription_id: 'vision-format-rejected' }); await waitForEnd(messages, 'vision-format-rejected')
    const failed = messages.find(item => item.kind === 'event' && item.event.type === 'session.failed')
    expect(failed?.kind === 'event' ? failed.event.payload : {}).toMatchObject({
      error_code: 'IMAGE_INPUT_FORMAT_UNSUPPORTED',
      user_message: expect.stringContaining('图片输入格式'),
    })
    const models = await runtime.http('GET', '/api/models', {}) as { items: Array<{ extra_config: { vision_capable: boolean } }> }
    expect(models.items[0].extra_config.vision_capable).toBe(true)
    await runtime.close()
  })

  it('extracts a PDF and returns its text through the read_file tool loop', async () => {
    let request = 0; let attachmentId = ''
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-pdf', function: { name: 'read_file', arguments: JSON.stringify({ attachment_id: attachmentId }) } }] }, finish_reason: 'tool_calls' }] }])
      return sse([{ choices: [{ delta: { content: 'PDF 口令已读取。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId, root } = await createRuntime(messages)
    const pdf = new jsPDF(); pdf.text('TuGo PDF runtime phrase', 20, 20); const pdfPath = join(root, 'runtime.pdf'); await writeFile(pdfPath, Buffer.from(pdf.output('arraybuffer')))
    const attachment = await runtime.http('POST', '/api/attachments/import', { path: pdfPath }) as { attachment_id: string }; attachmentId = attachment.attachment_id
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '用户请求：读取 PDF', attachment_ids: [attachmentId], subscription_id: 'pdf-loop' }); await waitForEnd(messages, 'pdf-loop')
    const journal = runtime.repository.listJournal(thread.thread_id)
    expect(JSON.stringify(journal)).toContain('TuGo PDF runtime phrase')
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed')).toBe(true)
    await runtime.close()
  })

  it('parses GLM text tool calls and repairs legacy board operations', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { content: '我来创建。 board_batch({"project_id":"p1","operations":[{"type":"create","shape":"rectangle","text":"开始","x":10,"y":20},{"type":"create","shape":"rectangle","text":"完成","x":250,"y":20},{"type":"create_edge","source_node_id":"node_0","target_node_id":"node_1","arrow":true}]})' }, finish_reason: 'stop' }] }])
      return sse([{ choices: [{ delta: { content: '画板已更新。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '画布项目 ID：p1。用户请求：创建流程', subscription_id: 's3' })
    await waitForEnd(messages, 's3')
    const call = messages.find(item => item.kind === 'tool_call')
    expect(call).toMatchObject({ kind: 'tool_call', name: 'board_batch', args: { operations: [
      { op: 'add_element', element: { id: 'node_0', text: '开始' } },
      { op: 'add_element', element: { id: 'node_1', text: '完成' } },
      { op: 'add_edge', edge: { from: 'node_0', to: 'node_1', endArrow: 'arrow' } },
    ] } })
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed')).toBe(true)
    await runtime.close()
  })

  it('executes the assignment-style GLM tool format and nested node/edge operations', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { content: '<tool_call>board_batch project_id="p1" operations=[{"type":"create","node":{"id":"start","label":"开始","shape":"rounded"}},{"type":"create","edge":{"id":"edge","from":"start","to":"start"}}]' }, finish_reason: 'stop' }] }])
      return sse([{ choices: [{ delta: { content: '创建完成' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '画布项目 ID：p1。用户请求：创建流程', subscription_id: 's-assignment' }); await waitForEnd(messages, 's-assignment')
    expect(messages.find(item => item.kind === 'tool_call')).toMatchObject({ kind: 'tool_call', name: 'board_batch', args: { operations: [
      { op: 'add_element', element: { id: 'start', kind: 'rounded_rectangle', text: '开始' } },
      { op: 'add_edge', edge: { id: 'edge', from: 'start', to: 'start' } },
    ] } })
    await runtime.close()
  })

  it('executes the JSON-envelope GLM tool format', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { content: '<tool_call> {"name":"board_batch","arguments":{"project_id":"p1","operations":[{"type":"addNode","id":"start","data":{"label":"开始","shape":"ellipse"}},{"type":"addNode","id":"done","data":{"label":"完成","shape":"ellipse"}},{"type":"addEdge","id":"edge","data":{"source":"start","target":"done"}}]}}' }, finish_reason: 'stop' }] }])
      return sse([{ choices: [{ delta: { content: '创建完成' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '画布项目 ID：p1。用户请求：创建流程', subscription_id: 's-json-envelope' }); await waitForEnd(messages, 's-json-envelope')
    expect(messages.find(item => item.kind === 'tool_call')).toMatchObject({ kind: 'tool_call', name: 'board_batch' })
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.tool_result')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed')).toBe(true)
    await runtime.close()
  })

  it('returns a recoverable board_batch contract error and lets the model correct it', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'missing-operations', function: { name: 'board_batch', arguments: '{"project_id":"p1"}' } }] }, finish_reason: 'tool_calls' }] }])
      if (request === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'corrected-operations', function: { name: 'board_batch', arguments: '{"project_id":"p1","operations":[{"op":"add_element","element":{"id":"start","kind":"rectangle","text":"开始","x":0,"y":0,"width":120,"height":60}}]}' } }] }, finish_reason: 'tool_calls' }] }])
      return sse([{ choices: [{ delta: { content: '已更正参数并创建节点。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '创建一个开始节点', subscription_id: 'repair-batch' })
    await waitForEnd(messages, 'repair-batch')
    expect(messages.some(message => message.kind === 'event' && message.event.type === 'agent.tool_result' && message.event.payload.recoverable === true)).toBe(true)
    expect(messages.some(message => message.kind === 'tool_call' && message.name === 'board_batch' && Array.isArray(message.args.operations))).toBe(true)
    expect(messages.some(message => message.kind === 'event' && message.event.type === 'session.completed')).toBe(true)
    await runtime.close()
  })

  it('does not retry a non-recoverable authentication failure', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid token"}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages, { maxAttempts: 3 })
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '你好', subscription_id: 's4' })
    await waitForEnd(messages, 's4')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.failed')).toBe(true)
    await runtime.close()
  })

  it('does not retry a request validation failure', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid request"}', { status: 422 }))
    vi.stubGlobal('fetch', fetchMock)
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages, { maxAttempts: 3 })
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '你好', subscription_id: 's422' })
    await waitForEnd(messages, 's422')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.failed')).toBe(true)
    await runtime.close()
  })

  it('retries a network stream failure without leaking text from the failed attempt', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) {
        const stale = '这段失败输出绝不能出现在界面。'.repeat(8)
        let sent = false
        const stream = new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: stale } }] })}\n\n`)) } else controller.error(new TypeError('network failed')) } })
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return sse([{ choices: [{ delta: { content: '重试成功' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages, { maxAttempts: 2 })
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '你好', subscription_id: 's-retry' })
    await waitForEnd(messages, 's-retry')
    let projection = ''; let callBase = ''; let callId = ''
    for (const item of messages) {
      if (item.kind !== 'event') continue
      if (item.event.type === 'agent.message.delta') {
        const nextCallId = String(item.event.payload.call_id || item.event.tool_call_id || '')
        if (nextCallId && nextCallId !== callId) { callId = nextCallId; callBase = projection }
        projection += String(item.event.payload.delta || '')
      } else if (item.event.type === 'llm.call.failed' && item.event.payload.discard_output === true) {
        projection = callBase; callId = ''
      } else if (item.event.type === 'agent.message.completed') projection = String(item.event.payload.content || '')
    }
    expect(projection).toBe('重试成功')
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'agent.message.delta' && String(item.event.payload.delta || '').includes('绝不能出现在界面'))).toBe(true)
    expect(request).toBe(2)
    await runtime.close()
  })

  it('honors Retry-After for 429 and retries a 5xx response', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return new Response('busy', { status: 429, headers: { 'Retry-After': '0' } })
      if (request === 2) return new Response('temporary', { status: 503 })
      return sse([{ choices: [{ delta: { content: '恢复成功' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages, { maxAttempts: 3 })
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '你好', subscription_id: 's-http-retry' })
    await waitForEnd(messages, 's-http-retry')
    expect(request).toBe(3)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed')).toBe(true)
    await runtime.close()
  })

  it('clears an interrupted run so the same thread can continue', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      request += 1
      if (request === 1) return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
      })
      return sse([{ choices: [{ delta: { content: '继续成功' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    const first = runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '等待', subscription_id: 's5' })
    await vi.waitFor(() => expect(request).toBe(1))
    expect(runtime.cancelRun(first.run_id)).toEqual({ cancelled: true })
    await waitForEnd(messages, 's5')
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '继续', subscription_id: 's6' })
    await waitForEnd(messages, 's6')
    // A late UI cancel must not mutate the completed replacement run.
    expect(runtime.cancelRun(first.run_id)).toEqual({ cancelled: false })
    expect((await runtime.http('GET', `/api/threads/${thread.thread_id}`, {})).active_run_id).toBeUndefined()
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.interrupted')).toBe(true)
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed' && item.subscription_id === 's6')).toBe(true)
    await runtime.close()
  })

  it('keeps one project usable across 100 mixed completion, steering, and cancellation runs', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      request += 1
      // Every third request remains in-flight until the test cancels it; all
      // other runs finish normally. This exercises the real abort/cleanup
      // path rather than changing state directly in the repository.
      if (request % 3 === 0) return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))
      return sse([{ choices: [{ delta: { content: `完成第 ${request} 次` }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'sequence-project', conversation_id: 'sequence-conversation' } }) as { thread_id: string }
    const subscriptions: string[] = []
    for (let index = 1; index <= 100; index += 1) {
      const subscription = `sequence-${index}`; subscriptions.push(subscription)
      const run = runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: `第 ${index} 次操作`, subscription_id: subscription })
      if (index % 3 === 0) {
        await vi.waitFor(() => expect(request).toBe(index))
        expect(runtime.steerRun(run.run_id, '取消前的补充要求', `steer-${index}`)).toMatchObject({ accepted: true })
        expect(runtime.cancelRun(run.run_id)).toEqual({ cancelled: true })
      }
      await waitForEnd(messages, subscription)
      expect((await runtime.http('GET', `/api/threads/${thread.thread_id}`, {})).active_run_id).toBeUndefined()
    }
    expect(new Set(messages.filter(item => item.kind === 'stream_end').map(item => item.subscription_id)).size).toBe(100)
    expect(messages.filter(item => item.kind === 'stream_end')).toHaveLength(100)
    expect(runtime.repository.activeRunForProject('sequence-project')).toBeUndefined()
    await runtime.close()
  })

  it('loads an actually bound skill by the catalog id', async () => {
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const skillId = runtime.repository.boundSkills(agentId)[0].skill_id
    runtime.repository.saveSkillResources(skillId, [
      { path: 'references/diagram-rules.md', content: '资源规则：主流程从左到右，所有网关必须标明分支。' },
      { path: 'examples/api-flow.mmd', content: 'flowchart LR\nA-->B' },
    ])
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'skill-call', function: { name: 'load_skill', arguments: JSON.stringify({ skill_id: skillId }) } }] }, finish_reason: 'tool_calls' }] }])
      return sse([{ choices: [{ delta: { content: '已使用技能。' }, finish_reason: 'stop' }] }])
    }))
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    const run = runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '使用画板技能回答', subscription_id: 's7' })
    await waitForEnd(messages, 's7')
    const journal = await runtime.http('POST', '/api/runtime/journal', { run_id: run.run_id }) as { items: Array<Record<string, unknown>> }
    expect(JSON.stringify(journal.items)).toContain('full skill instructions')
    expect(JSON.stringify(journal.items)).toContain('references/diagram-rules.md')
    expect(JSON.stringify(journal.items)).toContain('所有网关必须标明分支')
    expect(JSON.stringify(journal.items)).toContain('examples/api-flow.mmd')
    expect(messages.some(item => item.kind === 'event' && item.event.type === 'session.completed')).toBe(true)
    await runtime.close()
  })

  it('projects plan state transitions onto the canonical event contract', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-1', function: { name: 'plan', arguments: '{"title":"绘图","steps":[{"id":"draw","description":"创建节点","status":"in_progress"}]}' } }] }, finish_reason: 'tool_calls' }] }])
      if (request === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-2', function: { name: 'plan', arguments: '{"title":"绘图","steps":[{"id":"draw","description":"创建节点","status":"completed","result_summary":"完成"}]}' } }] }, finish_reason: 'tool_calls' }] }])
      return sse([{ choices: [{ delta: { content: '计划完成。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '制定并完成计划', subscription_id: 's8' })
    await waitForEnd(messages, 's8')
    const types = messages.filter(item => item.kind === 'event').map(item => item.event.type)
    expect(types).toEqual(expect.arrayContaining(['plan.snapshot', 'plan.step.started', 'plan.updated', 'plan.step.completed', 'plan.completed']))
    const completion = messages.find(item => item.kind === 'event' && item.event.type === 'plan.step.completed')
    expect(completion && completion.kind === 'event' ? completion.event.payload : undefined).toMatchObject({
      step: { id: 'draw', status: 'completed', result_summary: '完成' },
    })
    await runtime.close()
  })

  it('suppresses a duplicate provider tool-call id instead of repeating a board mutation', async () => {
    let request = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'write-once', function: { name: 'board_batch', arguments: '{"operations":[{"op":"add_element","element":{"id":"only-once","kind":"rectangle","text":"一次"}}]}' } },
        { index: 1, id: 'write-once', function: { name: 'board_batch', arguments: '{"operations":[{"op":"add_element","element":{"id":"must-not-run","kind":"rectangle","text":"重复"}}]}' } },
      ] }, finish_reason: 'tool_calls' }] }])
      return sse([{ choices: [{ delta: { content: '已完成。' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '创建一个方框', subscription_id: 'duplicate-tool-id' })
    await waitForEnd(messages, 'duplicate-tool-id')
    expect(messages.filter(item => item.kind === 'tool_call' && item.name === 'board_batch')).toHaveLength(1)
    expect(runtime.repository.listDebug(thread.thread_id).some(item => item.category === 'tool.duplicate_suppressed')).toBe(true)
    await runtime.close()
  })

  it('does not inject a completed plan on the next request', async () => {
    const bodies: Array<Record<string, unknown>> = []; let request = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body || '{}'))); request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-done', function: { name: 'plan', arguments: '{"title":"一次任务","steps":[{"id":"one","description":"完成","status":"completed"}]}' } }] }, finish_reason: 'tool_calls' }] }])
      return sse([{ choices: [{ delta: { content: request === 2 ? '第一轮完成' : '第二轮回答' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '第一项工作', subscription_id: 's-plan-1' }); await waitForEnd(messages, 's-plan-1')
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '完全不同的新问题', subscription_id: 's-plan-2' }); await waitForEnd(messages, 's-plan-2')
    expect(JSON.stringify(bodies.at(-1)?.messages || [])).not.toContain('<current_plan>')
    // Title generation has its own provider call and is covered by the
    // production template; this deterministic loop fixture disables it.
    expect(messages.filter(item => item.kind === 'event' && item.event.type === 'session.title')).toHaveLength(0)
    await runtime.close()
  })

  it('retains an active interrupted plan only when the user explicitly continues', async () => {
    let request = 0; let continuationBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      request += 1
      if (request === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-active', function: { name: 'plan', arguments: '{"title":"待续任务","steps":[{"id":"one","description":"执行","status":"in_progress"}]}' } }] }, finish_reason: 'tool_calls' }] }])
      if (request === 2) return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))
      continuationBody = JSON.parse(String(init?.body || '{}'))
      if (request === 3) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-complete', function: { name: 'plan', arguments: '{"title":"待续任务","steps":[{"id":"one","description":"执行","status":"completed"}]}' } }] }, finish_reason: 'tool_calls' }] }])
      return sse([{ choices: [{ delta: { content: '已继续完成' }, finish_reason: 'stop' }] }])
    }))
    const messages: RuntimeToHost[] = []; const { runtime, agentId } = await createRuntime(messages)
    const thread = await runtime.http('POST', '/api/threads', { assistant_id: agentId, metadata: { project_id: 'p1', conversation_id: 'c1' } }) as { thread_id: string }
    const first = runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '执行复杂任务', subscription_id: 's-active-1' })
    await vi.waitFor(() => expect(request).toBe(2)); runtime.cancelRun(first.run_id); await waitForEnd(messages, 's-active-1')
    runtime.startRun({ thread_id: thread.thread_id, agent_id: agentId, content: '继续', subscription_id: 's-active-2' }); await waitForEnd(messages, 's-active-2')
    expect(JSON.stringify(continuationBody?.messages || [])).toContain('<current_plan>')
    await runtime.close()
  })

  it('allows a saved model to bootstrap before an optional connection probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tugo-probe-test-')); roots.push(root)
    const defaults = join(root, 'defaults.json')
    await writeFile(defaults, JSON.stringify({ templateVersion: '1', providers: [{ provider_id: 'openai', display_name: 'OpenAI' }], tools: [], skill: { slug: 'tugo-architect', version: '1', content: 'skill' }, agent: { name: 'tugo-architect', soul: 'system', tool_names: [], skill_slugs: ['tugo-architect'] } }))
    const runtime = new TuGoRuntime(root, defaults, () => undefined); await runtime.start()
    runtime.setSecrets({ 'probe-secret': 'x' })
    const model = await runtime.http('POST', '/api/models', { name: 'probe', provider_id: 'openai', model: 'test', extra_config: { api_key_ref: 'probe-secret', base_url: 'https://example.test/v1' } }) as Record<string, unknown>
    await expect(runtime.http('POST', '/api/runtime/bootstrap', { model_id: model.model_id })).resolves.toHaveProperty('agent')
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'probe', function: { name: 'tugo_probe', arguments: '{"value":"ok"}' } }] }, finish_reason: 'tool_calls' }] }])))
    await expect(runtime.http('POST', '/api/models/test', { model_id: model.model_id })).resolves.toMatchObject({ ok: true })
    await expect(runtime.http('POST', '/api/runtime/bootstrap', { model_id: model.model_id })).resolves.toHaveProperty('agent')
    await runtime.close()
  })
})
