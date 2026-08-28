import type { JsonObject, RunCheckpoint, RuntimeMessage, ToolCall, ToolDefinition } from './contracts.js'

export type BoundSkill = { skill_id: string; slug: string; name: string; description: string; version: string }

export type BeforeModelContext = {
  checkpoint: RunCheckpoint
  messages: RuntimeMessage[]
  tools: ToolDefinition[]
  skills: BoundSkill[]
}

export type AfterModelContext = {
  checkpoint: RunCheckpoint
  text: string
  calls: ToolCall[]
}

export type BeforeToolContext = { checkpoint: RunCheckpoint; call: ToolCall }

export interface RuntimeMiddleware {
  readonly name: string
  beforeModel?(context: BeforeModelContext): void | Promise<void>
  afterModel?(context: AfterModelContext): void | Promise<void>
  beforeTool?(context: BeforeToolContext): void | Promise<void>
}

export type MiddlewareReport = { middleware: string; hook: string; status: 'started' | 'completed' | 'failed'; error?: string; details?: JsonObject }
export type MiddlewareReporter = (entry: MiddlewareReport) => void
export type PromptRenderer = (name: string, variables?: Record<string, unknown>) => string

const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}

export class MiddlewarePipeline {
  constructor(private readonly middlewares: RuntimeMiddleware[], private readonly report?: MiddlewareReporter) {}
  private async invoke(middleware: RuntimeMiddleware, hook: string, context: BeforeModelContext | AfterModelContext | BeforeToolContext, action: (() => void | Promise<void>) | undefined) {
    if (!action) return
    const details = () => describeContext(hook, context)
    this.report?.({ middleware: middleware.name, hook, status: 'started', details: details() })
    try { await action(); this.report?.({ middleware: middleware.name, hook, status: 'completed', details: details() }) }
    catch (error) { this.report?.({ middleware: middleware.name, hook, status: 'failed', error: error instanceof Error ? error.message : String(error), details: details() }); throw error }
  }
  async beforeModel(context: BeforeModelContext) { for (const middleware of this.middlewares) await this.invoke(middleware, 'before_model', context, middleware.beforeModel ? () => middleware.beforeModel!(context) : undefined) }
  async afterModel(context: AfterModelContext) { for (const middleware of this.middlewares) await this.invoke(middleware, 'after_model', context, middleware.afterModel ? () => middleware.afterModel!(context) : undefined) }
  async beforeTool(context: BeforeToolContext) { for (const middleware of this.middlewares) await this.invoke(middleware, 'before_tool', context, middleware.beforeTool ? () => middleware.beforeTool!(context) : undefined) }
}

const describeContext = (hook: string, context: BeforeModelContext | AfterModelContext | BeforeToolContext): JsonObject => {
  if (hook === 'before_model') {
    const value = context as BeforeModelContext
    return { message_count: value.messages.length, tool_count: value.tools.length, tool_names: value.tools.map(item => item.name), skill_count: value.skills.length, skill_ids: value.skills.map(item => item.skill_id), plan: value.checkpoint.plan || null }
  }
  if (hook === 'after_model') {
    const value = context as AfterModelContext
    return { text_length: value.text.length, text_preview: value.text.slice(0, 1000), tool_call_count: value.calls.length, tool_calls: value.calls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })), plan: value.checkpoint.plan || null, middleware_state: value.checkpoint.middlewareState || {} }
  }
  const value = context as BeforeToolContext
  return { tool_call_id: value.call.id, tool_name: value.call.name, arguments: value.call.arguments, loop_signatures: value.checkpoint.loopSignatures.slice(-5), tool_frequencies: value.checkpoint.toolFrequencies || {} }
}

export class SkillCatalogMiddleware implements RuntimeMiddleware {
  readonly name = 'skill-catalog'
  constructor(private readonly prompt: PromptRenderer) {}
  beforeModel(context: BeforeModelContext) {
    if (!context.skills.length) return
    const catalog = context.skills.map(skill => `- ${skill.skill_id} (${skill.slug}): ${skill.description || skill.name} [v${skill.version}]`).join('\n')
    context.messages.push({ role: 'system', content: this.prompt('middleware.skill_catalog', { catalog }) })
  }
}

export class PlanMiddleware implements RuntimeMiddleware {
  readonly name = 'plan'
  constructor(private readonly mode: 'disabled' | 'optional' | 'required', private readonly prompt: PromptRenderer) {}
  beforeModel(context: BeforeModelContext) {
    if (this.mode === 'disabled') return
    const current = context.checkpoint.plan
    if (current) context.messages.push({ role: 'system', content: this.prompt('middleware.plan_current', { plan: JSON.stringify(current) }) })
    else if (this.mode === 'required') context.messages.push({ role: 'system', content: this.prompt('middleware.plan_required') })
    else context.messages.push({ role: 'system', content: this.prompt('middleware.plan_optional') })
  }
  afterModel(context: AfterModelContext) {
    if (this.mode === 'disabled') return
    const state = object(context.checkpoint.middlewareState)
    const attempts = Number(state.planReminders || 0)
    const hasPlanCall = context.calls.some(call => call.name === 'plan')
    const needsCreation = this.mode === 'required' && !context.checkpoint.plan && !hasPlanCall
    const hasOpenPlan = Boolean(context.checkpoint.plan && context.checkpoint.plan.status === 'active')
    if (!context.calls.length && attempts < 2 && (needsCreation || hasOpenPlan)) {
      context.calls.length = 0
      context.text = ''
      context.checkpoint.messages.push({ role: 'system', content: this.prompt(needsCreation ? 'middleware.plan_reminder_create' : 'middleware.plan_reminder_continue') })
      context.checkpoint.middlewareState = { ...state, planReminders: attempts + 1, repeatModel: true }
    } else {
      if (!context.calls.length && attempts >= 2 && hasOpenPlan && context.checkpoint.plan) {
        const steps = Array.isArray(context.checkpoint.plan.steps) ? context.checkpoint.plan.steps as JsonObject[] : []
        context.checkpoint.plan = { ...context.checkpoint.plan, status: 'abandoned', current_step_id: null, steps: steps.map(step => ({ ...step, status: step.status === 'completed' ? 'completed' : step.status === 'pending' ? 'skipped' : 'abandoned' })) }
      }
      context.checkpoint.middlewareState = { ...state, planReminders: 0, repeatModel: false }
    }
  }
}

export class LoopDetectionMiddleware implements RuntimeMiddleware {
  readonly name = 'loop-detection'
  constructor(private readonly warnAfter: number, private readonly stopAfter: number, private readonly frequencyWarnAfter: number, private readonly frequencyStopAfter: number, private readonly prompt: PromptRenderer) {}
  beforeTool({ checkpoint, call }: BeforeToolContext) {
    const deferWarning = (content: string) => {
      const state = object(checkpoint.middlewareState)
      const pending = Array.isArray(state.deferredToolWarnings) ? state.deferredToolWarnings.map(String) : []
      checkpoint.middlewareState = { ...state, deferredToolWarnings: [...pending, content] }
    }
    const signature = `${call.name}:${JSON.stringify(call.arguments)}`
    const repeats = checkpoint.loopSignatures.filter(item => item === signature).length + 1
    checkpoint.loopSignatures.push(signature)
    checkpoint.loopSignatures = checkpoint.loopSignatures.slice(-20)
    if (repeats >= this.stopAfter) throw new Error(`检测到无进展的重复工具调用：${call.name}`)
    // Do not insert a system message here. OpenAI-compatible providers require
    // every tool result to be immediately adjacent to the assistant tool-call
    // message; a warning inserted between them corrupts the conversation.
    if (repeats >= this.warnAfter) deferWarning(this.prompt('middleware.loop_warning', { tool_name: call.name }))
    checkpoint.toolFrequencies ||= {}
    const frequency = Number(checkpoint.toolFrequencies[call.name] || 0) + 1
    checkpoint.toolFrequencies[call.name] = frequency
    if (frequency >= this.frequencyStopAfter) throw new Error(`工具 ${call.name} 在本次运行中调用过于频繁（${frequency} 次）`)
    if (frequency === this.frequencyWarnAfter) deferWarning(this.prompt('middleware.loop_frequency_warning', { tool_name: call.name, count: frequency }))
  }
}

export const buildMiddlewarePipeline = (configValue: unknown, report: MiddlewareReporter | undefined, prompt: PromptRenderer) => {
  const config = object(configValue)
  const plan = object(config.plan)
  const planMode = plan.enabled === false ? 'disabled' : ['optional', 'required'].includes(String(plan.mode)) ? String(plan.mode) as 'optional' | 'required' : 'optional'
  const loop = object(config.loopDetection)
  const middlewares: RuntimeMiddleware[] = [new SkillCatalogMiddleware(prompt), new PlanMiddleware(planMode, prompt)]
  if (loop.enabled !== false) middlewares.push(new LoopDetectionMiddleware(Number(loop.warnAfter || 2), Number(loop.stopAfter || 4), Number(loop.frequencyWarnAfter || 20), Number(loop.frequencyStopAfter || 30), prompt))
  return { pipeline: new MiddlewarePipeline(middlewares, report), planMode }
}
