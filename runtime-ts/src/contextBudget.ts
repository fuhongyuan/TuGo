import type { ModelAttachment, RuntimeMessage, ToolDefinition } from './contracts.js'

const textTokens = (value: unknown) => Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / 2.5)

export type ContextBudgetInput = {
  messages: RuntimeMessage[]
  tools?: ToolDefinition[]
  attachments?: ModelAttachment[]
  outputTokens?: number
}

/** Conservative provider-neutral estimate used for admission control. */
export const estimateContextTokens = ({ messages, tools = [], attachments = [], outputTokens = 0 }: ContextBudgetInput) => {
  const messageTokens = messages.reduce((sum, message) => sum + 6 + textTokens(message.content) + textTokens(message.reasoning || '') + textTokens(message.toolCalls || []) + textTokens(message.providerMetadata || {}), 0)
  const toolTokens = tools.reduce((sum, tool) => sum + 16 + textTokens(tool.name) + textTokens(tool.description) + textTokens(tool.inputSchema), 0)
  // Exact image tokenization differs by provider. Base64 size is an overly
  // expensive proxy, so reserve a bounded visual budget per image instead.
  const attachmentTokens = attachments.reduce((sum, attachment) => sum + (/^image\//i.test(attachment.mimeType) ? 2_048 : Math.min(16_384, Math.ceil(attachment.dataBase64.length / 3))), 0)
  return messageTokens + toolTokens + attachmentTokens + Math.max(0, outputTokens)
}

export const contextFits = (input: ContextBudgetInput, contextWindow: number, reserveRatio = .97) => estimateContextTokens(input) <= Math.floor(contextWindow * reserveRatio)

export const boundedSummary = (value: string, maxCharacters = 16_000) => {
  const normalized = value.trim()
  if (normalized.length <= maxCharacters) return normalized
  const head = Math.floor(maxCharacters * .35)
  const tail = maxCharacters - head - 28
  return `${normalized.slice(0, head)}\n…[摘要已滚动压缩]…\n${normalized.slice(-tail)}`
}

export const deterministicSummaryFallback = (previousSummary: string, messages: RuntimeMessage[], maxCharacters = 12_000) => boundedSummary(JSON.stringify({
  previous_summary: previousSummary,
  recent_history: messages.slice(-8).map(message => ({ role: message.role, name: message.name, content: String(message.content || '').slice(0, 800) })),
}), maxCharacters)
