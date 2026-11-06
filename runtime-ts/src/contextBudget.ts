import type { ModelAttachment, RuntimeMessage, ToolDefinition } from './contracts.js'
import {referenceTextTokens} from './referenceTokenizer.js'

// Upper byte-based text estimate, not a provider tokenizer. Media has an
// explicit configured reserve and remains an estimate (see projection report).
const encoder = new TextEncoder()
const textTokens = (value: unknown) => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value ?? '')).length

export type ContextBudgetInput = {
  messages: RuntimeMessage[]
  tools?: ToolDefinition[]
  attachments?: ModelAttachment[]
  outputTokens?: number
  imageTokenReserve?: number
  /** Internal, exact-message usage credits; never accepted from tool arguments. */
  measuredMessageTokens?: readonly (number|undefined)[]
  textEstimator?:'byte_upper'|'reference_bpe'
}

export const contextTokenBreakdown = ({ messages, tools = [], attachments = [], outputTokens = 0, imageTokenReserve = 16_384, measuredMessageTokens = [],textEstimator='byte_upper' }: ContextBudgetInput) => {
  const countText=textEstimator==='reference_bpe'?referenceTextTokens:textTokens
  let systemTokens = 0, historyTokens = 0, measuredMessages = 0, measurementSavings = 0
  for (const [index,message] of messages.entries()) {
    const upper = 16 + countText(message), measured = measuredMessageTokens[index]
    const tokens = message.role==='assistant'&&Number.isSafeInteger(measured)&&Number(measured)>0 ? Math.min(upper,Number(measured)) : upper
    if(tokens<upper){measuredMessages++;measurementSavings+=upper-tokens}
    if (message.role === 'system') systemTokens += tokens
    else historyTokens += tokens
  }
  const toolTokens = tools.reduce((sum, tool) => sum + 32 + countText(tool), 0)
  // Mirror provider binding semantics, including repeated references to one image.
  const hasBindings = messages.some(message => message.attachmentIds?.length)
  const lastUser = messages.map(message => message.role).lastIndexOf('user')
  let attachmentTokens = 0, attachmentOccurrences = 0
  for (let index = 0; index < messages.length; index += 1) {
    const selected = hasBindings
      ? attachments.filter(item => messages[index].attachmentIds?.includes(item.attachmentId))
      : index === lastUser ? attachments : []
    for (const attachment of selected) {
      attachmentOccurrences += 1
      attachmentTokens += /^image\//i.test(attachment.mimeType) ? imageTokenReserve : Math.ceil(attachment.dataBase64.length / 3)
    }
  }
  return { framingTokens:64, systemTokens, historyTokens, toolTokens, attachmentTokens, attachmentOccurrences, outputTokens:Math.max(0,outputTokens), measuredMessages, measurementSavings }
}

/** Provider-neutral estimate, shared by trigger heuristics and admission. */
export const estimateContextTokens = (input:ContextBudgetInput) => {
  const b = contextTokenBreakdown(input)
  return b.framingTokens + b.systemTokens + b.historyTokens + b.toolTokens + b.attachmentTokens + b.outputTokens
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
