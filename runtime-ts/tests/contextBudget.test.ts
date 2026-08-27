import { describe, expect, it } from 'vitest'
import { boundedSummary, contextFits, deterministicSummaryFallback, estimateContextTokens } from '../src/contextBudget.js'

describe('context budget', () => {
  it('accounts for system prompts, tool schemas, attachments and output reserve', () => {
    const base = estimateContextTokens({ messages: [{ role: 'user', content: 'hello' }] })
    const complete = estimateContextTokens({
      messages: [{ role: 'system', content: 'x'.repeat(1_000) }, { role: 'user', content: 'hello' }],
      tools: [{ name: 'board_batch', description: 'edit', inputSchema: { type: 'object', properties: { operations: { type: 'array' } } }, source: 'builtin', timeoutMs: 1_000 }],
      attachments: [{ attachmentId: 'image', name: 'image.png', mimeType: 'image/png', dataBase64: 'a'.repeat(100) }],
      outputTokens: 4_096,
    })
    expect(complete).toBeGreaterThan(base + 6_000)
    expect(contextFits({ messages: [{ role: 'user', content: 'x'.repeat(20_000) }], outputTokens: 2_000 }, 4_096)).toBe(false)
  })

  it('replaces a rolling summary with a bounded result instead of growing forever', () => {
    const first = deterministicSummaryFallback('old'.repeat(10_000), Array.from({ length: 30 }, (_, index) => ({ role: 'user' as const, content: `turn-${index}-${'x'.repeat(2_000)}` })))
    const second = deterministicSummaryFallback(first, Array.from({ length: 30 }, (_, index) => ({ role: 'assistant' as const, content: `next-${index}-${'y'.repeat(2_000)}` })))
    expect(first.length).toBeLessThanOrEqual(12_000)
    expect(second.length).toBeLessThanOrEqual(12_000)
    expect(boundedSummary('z'.repeat(20_000))).toContain('摘要已滚动压缩')
  })
})
