export const PROTOCOL_VERSION = '2026-07-13'
export const STRUCTURED_EVENT_TYPES = [
  'session.started',
  // Emitted only after a queued user instruction has been durably appended
  // to an active run's checkpoint and will therefore affect the next model turn.
  'run.steered',
  'llm.call.started',
  'agent.message.delta',
  'agent.message.completed',
  'agent.tool_preparing',
  'agent.tool_arguments.delta',
  'agent.tool_cancelled',
  'agent.tool_use',
  'agent.tool_result',
  'llm.call.failed',
  'context.summarization.started',
  'context.summarization.completed',
  'context.summarization.degraded',
  'plan.snapshot',
  'plan.updated',
  'plan.step.started',
  'plan.step.completed',
  'plan.step.blocked',
  'plan.completed',
  'plan.abandoned',
  'session.title',
  'session.completed',
  'session.failed',
  'session.interrupted',
  'stream.end',
] as const
export type StructuredEventType = typeof STRUCTURED_EVENT_TYPES[number]
export type JsonObject = Record<string, unknown>
export type Role = 'system' | 'user' | 'assistant' | 'tool'
export type ToolCall = { id: string; name: string; arguments: JsonObject; rawArguments?: string; providerMetadata?: JsonObject }
export type RuntimeMessage = { role: Role; content: string; reasoning?: string; name?: string; toolCallId?: string; toolCalls?: ToolCall[]; attachmentIds?: string[]; providerMetadata?: JsonObject }
export type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number }
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'cancelled' | 'error' | 'unknown'
export type ProviderCapability = { text: true; tools: boolean; reasoning: boolean; vision: boolean; streaming: true; usage: boolean }
export type ProviderErrorCategory = 'authentication' | 'permission' | 'rate_limit' | 'validation' | 'timeout' | 'network' | 'server' | 'malformed_response' | 'cancelled' | 'unknown'
export type ModelConfig = { model_id: string; provider_id: string; model: string; display_name: string; runtime_extra: JsonObject }
export type ModelAttachment = { attachmentId: string; name: string; mimeType: string; dataBase64: string; messageIndex?: number }
export type ModelRequest = { model: ModelConfig; messages: RuntimeMessage[]; tools: ToolDefinition[]; maxOutputTokens: number; signal: AbortSignal; attachments?: ModelAttachment[]; onDebug?: (entry: JsonObject) => void }
export type ModelStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call-started'; call: Pick<ToolCall, 'id' | 'name'> }
  | { type: 'tool-call-arguments-delta'; call: Pick<ToolCall, 'id' | 'name'>; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'provider-metadata'; metadata: JsonObject }
  | { type: 'finish'; reason: FinishReason; rawReason?: string }
export type ToolDefinition = { name: string; description: string; inputSchema: JsonObject; source: 'builtin' | 'mcp'; handlerKey?: string; timeoutMs: number; connectionId?: string }
export type StructuredEvent = { protocol_version: string; event_id: string; sequence: number; ts: string; thread_id: string; run_id: string; type: StructuredEventType; agent_id?: string | null; message_id?: string | null; tool_call_id?: string | null; payload: JsonObject }
export type RunCheckpoint = {
  version: 1
  threadId: string
  runId?: string
  agentId: string
  projectId?: string
  conversationId?: string
  status: string
  messages: RuntimeMessage[]
  summary?: string
  plan?: JsonObject
  completedToolCalls: Record<string, unknown>
  loopSignatures: string[]
  toolFrequencies?: Record<string, number>
  usage: Usage
  step: number
  middlewareState?: JsonObject
  boundary?: {
    phase: 'model' | 'tool'
    state: 'before' | 'after' | 'uncertain'
    callId?: string
    toolCallId?: string
    toolName?: string
    sideEffect?: boolean
    updatedAt: string
  }
}
export type RuntimeToHost =
  | { kind: 'ready'; protocol_version: string }
  | { kind: 'response'; id: string; result?: unknown; error?: string }
  | { kind: 'event'; subscription_id: string; event: StructuredEvent }
  | { kind: 'stream_end'; subscription_id: string; run_id: string }
  | { kind: 'tool_call'; id: string; name: string; args: JsonObject; context: JsonObject }
export type HostToRuntime =
  | { kind: 'request'; id: string; method: string; params?: JsonObject }
  | { kind: 'tool_result'; id: string; result?: unknown; error?: string }
  | { kind: 'shutdown' }
