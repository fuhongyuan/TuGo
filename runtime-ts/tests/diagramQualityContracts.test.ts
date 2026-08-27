import { describe, expect, it } from 'vitest'
import { buildAcceptanceReport, normalizeDiagramBrief, normalizeDiagramModel, reviewDiagramContent } from '../src/diagramQualityContracts.js'
import { ToolRegistry } from '../src/tools.js'
import type { RunCheckpoint, ToolDefinition } from '../src/contracts.js'

const brief = normalizeDiagramBrief({
  objective: '解释登录流程', audience: '研发人员', key_question: '请求如何完成认证', diagram_type: 'flowchart',
  required_entities: ['客户端', '网关', '认证服务'], required_relationships: [{ from: '客户端', to: '网关' }, { from: '网关', to: '认证服务' }],
  acceptance_criteria: ['覆盖正常登录路径'],
})

describe('diagram quality contracts', () => {
  it('normalizes a brief with stable defaults', () => {
    expect(brief).toMatchObject({ diagramType: 'flowchart', sourcePolicy: 'user-only', density: 'balanced', deliveryFormat: 'board' })
  })

  it('reports missing required entities and relationships', () => {
    const model = normalizeDiagramModel({ entities: [{ id: 'client', label: '客户端' }, { id: 'gateway', label: '网关' }], relationships: [{ from: 'client', to: 'gateway' }] })
    const review = reviewDiagramContent(brief, model)
    expect(review.passed).toBe(false)
    expect(review.entityCoverage).toBe(67)
    expect(review.findings.map(item => item.code)).toEqual(expect.arrayContaining(['content.required_entity_missing', 'content.required_relationship_missing']))
  })

  it('passes a complete semantic model and acceptance audit', () => {
    const model = normalizeDiagramModel({ entities: [{ id: 'client', label: '客户端' }, { id: 'gateway', label: '网关' }, { id: 'auth', label: '认证服务' }], relationships: [{ from: 'client', to: 'gateway' }, { from: 'gateway', to: 'auth' }] })
    const contentReview = reviewDiagramContent(brief, model)
    expect(contentReview).toMatchObject({ passed: true, entityCoverage: 100, relationshipCoverage: 100 })
    expect(buildAcceptanceReport({ brief, contentReview, layoutReview: { checked: true, issues: [] } })).toMatchObject({ passed: true, stage: 'accepted' })
  })

  it('blocks acceptance when a high severity layout issue remains', () => {
    const contentReview = reviewDiagramContent(brief, normalizeDiagramModel({ entities: [{ id: 'client', label: '客户端' }, { id: 'gateway', label: '网关' }, { id: 'auth', label: '认证服务' }], relationships: [{ from: 'client', to: 'gateway' }, { from: 'gateway', to: 'auth' }] }))
    const report = buildAcceptanceReport({ brief, contentReview, layoutReview: { checked: true, issues: [{ type: 'node_overlap', severity: 'high', message: '节点重叠', ids: ['client', 'gateway'] }] } })
    expect(report.passed).toBe(false)
    expect(report.blocking[0]?.code).toBe('layout.node_overlap')
  })

  it('persists the brief, review, and acceptance through the real tool registry', async () => {
    const registry = new ToolRegistry({} as never, {} as never, async () => ({}))
    const checkpoint: RunCheckpoint = { version: 1, threadId: 'thread', agentId: 'agent', status: 'running', messages: [], completedToolCalls: {}, loopSignatures: [], usage: {}, step: 0, middlewareState: {} }
    const tool = (name: string): ToolDefinition => ({ name, description: name, source: 'builtin', handlerKey: 'diagram-quality', timeoutMs: 1000, inputSchema: { type: 'object', additionalProperties: true } })
    await registry.execute(tool('diagram_set_brief'), { objective: '解释登录流程', audience: '研发人员', key_question: '请求如何完成认证', diagram_type: 'flowchart', required_entities: ['客户端', '网关'], required_relationships: [{ from: '客户端', to: '网关' }], acceptance_criteria: ['主链路完整'] }, checkpoint, new AbortController().signal)
    const content = await registry.execute(tool('diagram_review_content'), { model: { entities: [{ id: 'client', label: '客户端' }, { id: 'gateway', label: '网关' }], relationships: [{ from: 'client', to: 'gateway' }] } }, checkpoint, new AbortController().signal) as { content_review: { passed: boolean } }
    expect(content.content_review.passed).toBe(true)
    const accepted = await registry.execute(tool('diagram_acceptance_check'), { layout_review: { checked: true, issues: [] } }, checkpoint, new AbortController().signal) as { acceptance: { passed: boolean } }
    expect(accepted.acceptance.passed).toBe(true)
    expect((checkpoint.middlewareState?.diagramQuality as { stage?: string }).stage).toBe('accepted')
  })
})
