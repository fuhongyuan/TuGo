import type { JsonObject } from './contracts.js'

export type DiagramType = 'flowchart' | 'architecture' | 'sequence' | 'erd' | 'state' | 'mindmap' | 'timeline' | 'comparison' | 'presentation' | 'other'
export type DiagramBrief = {
  objective: string
  audience: string
  keyQuestion: string
  diagramType: DiagramType
  included: string[]
  excluded: string[]
  requiredEntities: string[]
  requiredRelationships: Array<{ from: string; to: string; label?: string }>
  sourcePolicy: 'user-only' | 'workspace' | 'web-verified'
  visualTone: 'technical' | 'executive' | 'educational'
  density: 'overview' | 'balanced' | 'detailed'
  deliveryFormat: 'board' | 'image' | 'pptx'
  acceptanceCriteria: string[]
  assumptions: string[]
}

export type DiagramModel = {
  entities: Array<{ id: string; label: string; type?: string }>
  relationships: Array<{ from: string; to: string; type?: string; label?: string }>
}

export type QualityFinding = {
  code: string
  severity: 'blocking' | 'warning' | 'suggestion'
  message: string
  refs?: string[]
}

export type ContentReview = {
  checked: true
  passed: boolean
  score: number
  entityCoverage: number
  relationshipCoverage: number
  findings: QualityFinding[]
  summary: string
}

export type AcceptanceReport = {
  checked: true
  passed: boolean
  stage: 'accepted' | 'blocked'
  blocking: QualityFinding[]
  warnings: QualityFinding[]
  suggestions: QualityFinding[]
  summary: string
}

const text = (value: unknown, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
const list = (value: unknown, maxItems = 50, maxLength = 200) => [...new Set((Array.isArray(value) ? value : []).map(item => text(item, maxLength)).filter(Boolean))].slice(0, maxItems)
const key = (value: unknown) => text(value, 300).toLocaleLowerCase().replace(/[\s\-_/:：→>]+/g, '')
const percent = (matched: number, total: number) => total ? Math.round(matched / total * 100) : 100
const relationKey = (from: unknown, to: unknown) => `${key(from)}>${key(to)}`

export function normalizeDiagramBrief(value: JsonObject): DiagramBrief {
  const allowedTypes: DiagramType[] = ['flowchart', 'architecture', 'sequence', 'erd', 'state', 'mindmap', 'timeline', 'comparison', 'presentation', 'other']
  const allowedSource = ['user-only', 'workspace', 'web-verified'] as const
  const allowedTone = ['technical', 'executive', 'educational'] as const
  const allowedDensity = ['overview', 'balanced', 'detailed'] as const
  const allowedDelivery = ['board', 'image', 'pptx'] as const
  const rawRelationships = Array.isArray(value.required_relationships) ? value.required_relationships : []
  const requiredRelationships = rawRelationships.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const relation = item as JsonObject; const from = text(relation.from, 200); const to = text(relation.to, 200)
    return from && to ? [{ from, to, ...(text(relation.label, 120) ? { label: text(relation.label, 120) } : {}) }] : []
  }).slice(0, 100)
  const diagramType = text(value.diagram_type) as DiagramType
  const sourcePolicy = text(value.source_policy) as DiagramBrief['sourcePolicy']
  const visualTone = text(value.visual_tone) as DiagramBrief['visualTone']
  const density = text(value.density) as DiagramBrief['density']
  const deliveryFormat = text(value.delivery_format) as DiagramBrief['deliveryFormat']
  return {
    objective: text(value.objective, 1000), audience: text(value.audience, 300), keyQuestion: text(value.key_question, 1000),
    diagramType: allowedTypes.includes(diagramType) ? diagramType : 'other',
    included: list(value.included), excluded: list(value.excluded), requiredEntities: list(value.required_entities), requiredRelationships,
    sourcePolicy: allowedSource.includes(sourcePolicy) ? sourcePolicy : 'user-only',
    visualTone: allowedTone.includes(visualTone) ? visualTone : 'technical', density: allowedDensity.includes(density) ? density : 'balanced',
    deliveryFormat: allowedDelivery.includes(deliveryFormat) ? deliveryFormat : 'board',
    acceptanceCriteria: list(value.acceptance_criteria), assumptions: list(value.assumptions),
  }
}

export function briefFindings(brief: DiagramBrief): QualityFinding[] {
  const findings: QualityFinding[] = []
  if (!brief.objective) findings.push({ code: 'brief.objective_missing', severity: 'blocking', message: 'Diagram Brief 缺少明确目标。' })
  if (!brief.audience) findings.push({ code: 'brief.audience_missing', severity: 'blocking', message: 'Diagram Brief 缺少目标受众。' })
  if (!brief.keyQuestion) findings.push({ code: 'brief.question_missing', severity: 'blocking', message: 'Diagram Brief 缺少本图要回答的核心问题。' })
  if (!brief.requiredEntities.length) findings.push({ code: 'brief.entities_unspecified', severity: 'warning', message: '尚未列出必需实体，后续无法确定性判断内容完整性。' })
  if (!brief.acceptanceCriteria.length) findings.push({ code: 'brief.acceptance_unspecified', severity: 'warning', message: '尚未列出用户侧验收标准。' })
  return findings
}

export function normalizeDiagramModel(value: JsonObject): DiagramModel {
  const entities = (Array.isArray(value.entities) ? value.entities : []).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const entity = item as JsonObject; const id = text(entity.id, 200); const label = text(entity.label, 300)
    return id && label ? [{ id, label, ...(text(entity.type, 100) ? { type: text(entity.type, 100) } : {}) }] : []
  }).slice(0, 500)
  const relationships = (Array.isArray(value.relationships) ? value.relationships : []).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const relation = item as JsonObject; const from = text(relation.from, 200); const to = text(relation.to, 200)
    return from && to ? [{ from, to, ...(text(relation.type, 100) ? { type: text(relation.type, 100) } : {}), ...(text(relation.label, 200) ? { label: text(relation.label, 200) } : {}) }] : []
  }).slice(0, 1000)
  return { entities, relationships }
}

export function reviewDiagramContent(brief: DiagramBrief, model: DiagramModel): ContentReview {
  const findings: QualityFinding[] = [...briefFindings(brief)]
  const ids = new Set<string>(); const duplicateIds = new Set<string>()
  for (const entity of model.entities) { if (ids.has(entity.id)) duplicateIds.add(entity.id); ids.add(entity.id) }
  if (duplicateIds.size) findings.push({ code: 'model.duplicate_entity_id', severity: 'blocking', message: `语义模型存在重复实体 ID：${[...duplicateIds].join('、')}`, refs: [...duplicateIds] })
  const dangling = model.relationships.filter(relation => !ids.has(relation.from) || !ids.has(relation.to))
  if (dangling.length) findings.push({ code: 'model.dangling_relationship', severity: 'blocking', message: `存在 ${dangling.length} 条引用不存在实体的关系。`, refs: dangling.flatMap(item => [item.from, item.to]) })
  const entityKeys = new Set(model.entities.flatMap(entity => [key(entity.id), key(entity.label)]))
  const missingEntities = brief.requiredEntities.filter(required => !entityKeys.has(key(required)))
  if (missingEntities.length) findings.push({ code: 'content.required_entity_missing', severity: 'blocking', message: `缺少必需实体：${missingEntities.join('、')}`, refs: missingEntities })
  const labelById = new Map(model.entities.map(entity => [entity.id, entity.label]))
  const relationshipKeys = new Set(model.relationships.flatMap(relation => [relationKey(relation.from, relation.to), relationKey(labelById.get(relation.from), labelById.get(relation.to))]))
  const missingRelationships = brief.requiredRelationships.filter(relation => !relationshipKeys.has(relationKey(relation.from, relation.to)))
  if (missingRelationships.length) findings.push({ code: 'content.required_relationship_missing', severity: 'blocking', message: `缺少 ${missingRelationships.length} 条必需关系。`, refs: missingRelationships.map(item => `${item.from}->${item.to}`) })
  const connected = new Set(model.relationships.flatMap(item => [item.from, item.to]))
  const isolated = model.entities.filter(entity => model.entities.length > 1 && !connected.has(entity.id))
  if (isolated.length) findings.push({ code: 'content.isolated_entity', severity: 'warning', message: `存在 ${isolated.length} 个没有关系的实体，请确认是否应连接、分组或删除。`, refs: isolated.map(item => item.id) })
  const entityCoverage = percent(brief.requiredEntities.length - missingEntities.length, brief.requiredEntities.length)
  const relationshipCoverage = percent(brief.requiredRelationships.length - missingRelationships.length, brief.requiredRelationships.length)
  const blocking = findings.filter(item => item.severity === 'blocking').length
  const warnings = findings.filter(item => item.severity === 'warning').length
  const score = Math.max(0, Math.round(entityCoverage * .45 + relationshipCoverage * .45 + 10 - blocking * 20 - warnings * 3))
  return { checked: true, passed: blocking === 0, score, entityCoverage, relationshipCoverage, findings, summary: blocking ? `内容审查未通过：发现 ${blocking} 个阻断问题和 ${warnings} 个警告。` : `内容审查通过：必需实体覆盖率 ${entityCoverage}%，必需关系覆盖率 ${relationshipCoverage}%。` }
}

export function buildAcceptanceReport(input: { brief?: DiagramBrief; contentReview?: ContentReview; layoutReview?: JsonObject; visualReview?: JsonObject; requireVisualReview?: boolean }): AcceptanceReport {
  const findings: QualityFinding[] = []
  if (!input.brief) findings.push({ code: 'acceptance.brief_missing', severity: 'blocking', message: '尚未建立 Diagram Brief。' })
  else findings.push(...briefFindings(input.brief))
  if (!input.contentReview) findings.push({ code: 'acceptance.content_review_missing', severity: 'blocking', message: '尚未完成内容审查。' })
  else findings.push(...input.contentReview.findings)
  const layout = input.layoutReview
  if (!layout || layout.checked !== true) findings.push({ code: 'acceptance.layout_review_missing', severity: 'blocking', message: '尚未完成有效的画板质量审计。' })
  else for (const raw of Array.isArray(layout.issues) ? layout.issues : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as JsonObject; const severity = String(item.severity) === 'high' ? 'blocking' : 'warning'
    findings.push({ code: `layout.${text(item.type, 100) || 'issue'}`, severity, message: text(item.message, 500) || '画板质量审计发现问题。', refs: list(item.ids, 50, 200) })
  }
  const visualStatus = String(input.visualReview?.status || '')
  if (input.requireVisualReview && visualStatus !== 'passed') findings.push({ code: 'acceptance.visual_review_missing', severity: 'blocking', message: '该交付要求视觉评审，但尚未获得通过结果。' })
  else if (visualStatus === 'warning') findings.push({ code: 'acceptance.visual_review_warning', severity: 'warning', message: text(input.visualReview?.summary, 500) || '视觉评审存在待确认问题。' })
  const unique = findings.filter((item, index, all) => all.findIndex(other => other.code === item.code && other.message === item.message) === index)
  const blocking = unique.filter(item => item.severity === 'blocking'), warnings = unique.filter(item => item.severity === 'warning'), suggestions = unique.filter(item => item.severity === 'suggestion')
  return { checked: true, passed: blocking.length === 0, stage: blocking.length ? 'blocked' : 'accepted', blocking, warnings, suggestions, summary: blocking.length ? `验收未通过：仍有 ${blocking.length} 个阻断问题和 ${warnings.length} 个警告。` : `验收通过${warnings.length ? `，保留 ${warnings.length} 个非阻断警告` : ''}。` }
}
