import type { BoardDocument, BoardEdge, BoardElement, BoardOperation } from '../types'
import { resolvedEdgeAnchor } from './edgeGeometry'
import { orthogonalControlPoints, sampledEdgePoints, type CanvasRect } from './canvasGeometry'

type IssueType = 'edge_crossing' | 'edge_over_node' | 'node_overlap' | 'crowded' | 'long_diagonal' | 'orphan' | 'background_occlusion' | 'misaligned' | 'broken_edge' | 'edge_label_collision' | 'text_overflow' | 'small_text' | 'low_contrast' | 'inconsistent_size' | 'uneven_spacing' | 'container_padding'
type AuditArea = 'structure' | 'layout' | 'connectors' | 'hierarchy' | 'readability' | 'consistency'
type Issue = { type: IssueType; area: AuditArea; severity: 'high' | 'medium'; message: string; ids: string[]; fixable: boolean; suggestedPatch?: { width?: number; height?: number; fontSize?: number } }
export type DiagramReflection = { checked: boolean; score: number; dimensions: Record<AuditArea, number>; summary: string; issues: Issue[]; suggestions: string[]; recommendation?: string }
type Rect = Pick<BoardElement, 'x' | 'y' | 'width' | 'height'>
type Point = { x: number; y: number }

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const contains = (outer: Rect, inner: Rect, padding = 0) => outer.x - padding <= inner.x && outer.y - padding <= inner.y && outer.x + outer.width + padding >= inner.x + inner.width && outer.y + outer.height + padding >= inner.y + inner.height
const center = (item: Rect): Point => ({ x: item.x + item.width / 2, y: item.y + item.height / 2 })
const segmentCross = (a: Point, b: Point, c: Point, d: Point) => {
  const orient = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0
}
const pointInRect = (point: Point, rect: Rect) => point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height
const segmentHitsRect = (a: Point, b: Point, rect: Rect) => {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true
  const tl = { x: rect.x, y: rect.y }, tr = { x: rect.x + rect.width, y: rect.y }, br = { x: rect.x + rect.width, y: rect.y + rect.height }, bl = { x: rect.x, y: rect.y + rect.height }
  return segmentCross(a, b, tl, tr) || segmentCross(a, b, tr, br) || segmentCross(a, b, br, bl) || segmentCross(a, b, bl, tl)
}
const edgePoints = (edge: BoardEdge, from?: BoardElement, to?: BoardElement, obstacles: CanvasRect[] = [], occupiedRoutes: Point[][] = []): Point[] => {
  const fromTarget = to ? center(to) : edge.freeEnd || { x: 0, y: 0 }; const toTarget = from ? center(from) : edge.freeStart || { x: 0, y: 0 }
  const start = from ? resolvedEdgeAnchor(from, fromTarget, edge.fromAnchor) : edge.freeStart
  const end = to ? resolvedEdgeAnchor(to, toTarget, edge.toAnchor) : edge.freeEnd
  if (!start || !end) return []
  const controls = (edge.controlPoints || []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  const routing = edge.routing || 'curve'
  const resolved = routing === 'elbow' && controls.length === 0 ? orthogonalControlPoints(start, end, obstacles, 18, occupiedRoutes) : controls
  return sampledEdgePoints(routing, start, end, resolved)
}
const polylineCrosses = (a: Point[], b: Point[]) => a.slice(1).some((point, index) => b.slice(1).some((other, otherIndex) => segmentCross(a[index], point, b[otherIndex], other)))
const polylineHitsRect = (points: Point[], rect: Rect) => points.slice(1).some((point, index) => segmentHitsRect(points[index], point, rect))
const hexToRgb = (value?: string) => {
  const hex = String(value || '').trim().replace('#', '')
  if (!/^[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(hex)) return null
  const full = hex.length === 3 ? hex.split('').map(char => char + char).join('') : hex
  return [0, 2, 4].map(index => Number.parseInt(full.slice(index, index + 2), 16)) as [number, number, number]
}
const contrast = (foreground?: string, background?: string) => {
  const fg = hexToRgb(foreground), bg = hexToRgb(background); if (!fg || !bg) return null
  const luminance = (rgb: [number, number, number]) => rgb.map(value => { const channel = value / 255; return channel <= .03928 ? channel / 12.92 : Math.pow((channel + .055) / 1.055, 2.4) }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const [a, b] = [luminance(fg), luminance(bg)].sort((left, right) => right - left)
  return (a + .05) / (b + .05)
}
const issue = (type: IssueType, area: AuditArea, severity: Issue['severity'], message: string, ids: string[], fixable = false, suggestedPatch?: Issue['suggestedPatch']): Issue => ({ type, area, severity, message, ids, fixable, ...(suggestedPatch ? { suggestedPatch } : {}) })

/** A frame, or a large card holding other cards, must always render behind content. */
export const isBackgroundElement = (element: BoardElement, all: BoardElement[]) => element.kind === 'frame'
  || Boolean(element.metadata?.container)
  || (element.kind !== 'text' && all.filter(other => other.id !== element.id && contains(element, other)).length >= 2)

const graph = (document: BoardDocument) => {
  const backgrounds = new Set(document.elements.filter(item => isBackgroundElement(item, document.elements)).map(item => item.id))
  const candidates = document.elements.filter(item => !backgrounds.has(item.id) && item.kind !== 'text')
  const candidateIds = new Set(candidates.map(item => item.id))
  const edges = document.edges.filter(edge => candidateIds.has(edge.from) && candidateIds.has(edge.to))
  const connected = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  return { backgrounds, nodes: candidates.filter(node => connected.has(node.id)), edges, connected }
}

// A directed graph gives us a useful visual invariant: nodes with the same
// dependency depth form a column in the normal left-to-right diagram.  This
// is deliberately based on relationships, not on proximity, so hand-drawn
// decorations are never snapped just because they happen to be nearby.
const flowRanks = (nodes: BoardElement[], edges: BoardDocument['edges']) => {
  const incoming = new Map(nodes.map(item => [item.id, 0])); const outgoing = new Map(nodes.map(item => [item.id, [] as string[]]))
  for (const edge of edges) { outgoing.get(edge.from)?.push(edge.to); incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1) }
  const ranks = new Map(nodes.map(item => [item.id, 0])); const queue = nodes.filter(item => !incoming.get(item.id)).map(item => item.id); const seen = new Set<string>()
  while (queue.length) { const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id); for (const next of outgoing.get(id) || []) { ranks.set(next, Math.max(ranks.get(next) || 0, (ranks.get(id) || 0) + 1)); incoming.set(next, (incoming.get(next) || 0) - 1); if (incoming.get(next) === 0) queue.push(next) } }
  let fallback = Math.max(0, ...ranks.values()); nodes.filter(item => !seen.has(item.id)).forEach(item => ranks.set(item.id, ++fallback))
  return ranks
}

export function reflectDiagram(document: BoardDocument): DiagramReflection {
  if (document.elements.length < 2 || document.edges.length === 0) return { checked: false, score: 100, dimensions: { structure: 100, layout: 100, connectors: 100, hierarchy: 100, readability: 100, consistency: 100 }, summary: '当前画板没有足够的关系线，暂不进行完整质量审计。', issues: [], suggestions: [] }
  const issues: Issue[] = []
  const backgrounds = document.elements.filter(item => isBackgroundElement(item, document.elements))
  const foreground = document.elements.filter(item => !backgrounds.some(background => background.id === item.id))
  for (let i = 0; i < foreground.length; i += 1) for (let j = i + 1; j < foreground.length; j += 1) {
    const a = foreground[i], b = foreground[j]
    if (overlap(a, b)) issues.push(issue('node_overlap', 'layout', 'high', `图形「${a.text || a.id}」与「${b.text || b.id}」重叠`, [a.id, b.id], true))
    else if (Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)) < 24 && Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)) < 24) issues.push(issue('crowded', 'layout', 'medium', `图形「${a.text || a.id}」与「${b.text || b.id}」间距过小`, [a.id, b.id], true))
  }
  const { nodes, edges, connected } = graph(document); const byId = new Map(document.elements.map(item => [item.id, item]))
  const auditedRoutes: Point[][] = []
  const linked = edges.map(edge => {
    const points = edgePoints(edge, byId.get(edge.from), byId.get(edge.to), foreground.filter(node => node.kind !== 'text' && node.id !== edge.from && node.id !== edge.to), auditedRoutes)
    auditedRoutes.push(points)
    return { edge, a: byId.get(edge.from)!, b: byId.get(edge.to)!, points }
  })
  for (let i = 0; i < linked.length; i += 1) for (let j = i + 1; j < linked.length; j += 1) {
    const one = linked[i], two = linked[j]
    if ([one.edge.from, one.edge.to].some(id => id === two.edge.from || id === two.edge.to)) continue
    if (polylineCrosses(one.points, two.points)) issues.push(issue('edge_crossing', 'connectors', 'high', '两条连线交叉，建议重新排列同层节点并使用正交路由', [one.edge.id, two.edge.id], true))
  }
  for (const { edge, a, b, points } of linked) {
    const from = points[0] || center(a), to = points.at(-1) || center(b); const blocker = foreground.find(node => node.id !== a.id && node.id !== b.id && polylineHitsRect(points, node))
    if (blocker) issues.push(issue('edge_over_node', 'connectors', 'high', `连线穿过「${blocker.text || blocker.id}」，会遮挡文字或误导关系`, [edge.id, blocker.id], true))
    if ((edge.routing || 'curve') === 'curve' && Math.abs(from.x - to.x) > 260 && Math.abs(from.y - to.y) > 120) issues.push(issue('long_diagonal', 'connectors', 'medium', '存在较长的斜向曲线，可能削弱层级阅读路径', [edge.id], true))
  }
  for (const background of backgrounds) {
    const hidden = foreground.filter(item => contains(background, item) && (background.zIndex ?? 0) >= (item.zIndex ?? 0))
    if (hidden.length) issues.push(issue('background_occlusion', 'hierarchy', 'high', `容器「${background.text || background.id}」层级会遮挡其中的内容`, [background.id, ...hidden.map(item => item.id)], true))
  }
  const ranks = flowRanks(nodes, edges)
  const columns = new Map<number, BoardElement[]>()
  nodes.forEach(node => { const rank = ranks.get(node.id) || 0; columns.set(rank, [...(columns.get(rank) || []), node]) })
  for (const [rank, items] of columns) {
    if (items.length < 2) continue
    const guide = median(items.map(item => item.x))
    const drifting = items.filter(item => Math.abs(item.x - guide) > 12)
    if (drifting.length) issues.push(issue('misaligned', 'layout', 'medium', `第 ${rank + 1} 层的卡片没有对齐到同一条垂直基准线`, items.map(item => item.id), true))
    if (items.length >= 3) {
      const widths = items.map(item => item.width), heights = items.map(item => item.height)
      if (Math.max(...widths) - Math.min(...widths) > 48 || Math.max(...heights) - Math.min(...heights) > 32) issues.push(issue('inconsistent_size', 'consistency', 'medium', `第 ${rank + 1} 层同类业务卡片尺寸差异过大，阅读节奏不一致`, items.map(item => item.id), true))
      const gaps = [...items].sort((a, b) => a.y - b.y).slice(1).map((item, index) => item.y - (items.slice().sort((a, b) => a.y - b.y)[index].y + items.slice().sort((a, b) => a.y - b.y)[index].height))
      if (gaps.length >= 2 && Math.max(...gaps) - Math.min(...gaps) > 36) issues.push(issue('uneven_spacing', 'layout', 'medium', `第 ${rank + 1} 层卡片的垂直间距不均匀`, items.map(item => item.id), true))
    }
  }
  for (const edge of document.edges) if (!byId.has(edge.from) || !byId.has(edge.to)) issues.push(issue('broken_edge', 'structure', 'high', `连线「${edge.label || edge.id}」指向不存在的图形`, [edge.id], true))
  for (const edge of linked) if (edge.edge.label) {
    const midpoint = Math.floor((edge.points.length - 1) / 2); const left = edge.points[midpoint] || center(edge.a), right = edge.points[midpoint + 1] || center(edge.b)
    const labelPoint = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
    const blocker = foreground.find(node => node.id !== edge.a.id && node.id !== edge.b.id && pointInRect(labelPoint, node))
    if (blocker) issues.push(issue('edge_label_collision', 'connectors', 'medium', `连线标签「${edge.edge.label}」落在「${blocker.text || blocker.id}」上`, [edge.edge.id, blocker.id], true))
  }
  for (const element of foreground) {
    const text = String(element.text || '').trim(); if (!text) continue
    const fontSize = Math.max(1, element.fontSize || 16); const lines = text.split('\n').flatMap(line => Array.from(line).length ? [line] : [' '])
    const usableWidth = Math.max(1, element.width - 18)
    const charsPerLine = Math.max(1, Math.floor(usableWidth / (fontSize * .62)))
    const requiredLines = lines.reduce((count, line) => count + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)), 0)
    const requiredHeight = Math.ceil(requiredLines * fontSize * 1.35 + 14)
    const longestLine = Math.max(...lines.map(line => Array.from(line).length))
    const singleLineWidth = Math.ceil(longestLine * fontSize * .62 + 18)
    if (requiredHeight > element.height) {
      const severity: Issue['severity'] = requiredHeight > element.height * 1.3 ? 'high' : 'medium'
      const safeFont = Math.max(12, Math.floor((element.height - 14) / Math.max(1, requiredLines * 1.35)))
      const patch = { height: requiredHeight, ...(requiredLines === 1 && singleLineWidth > element.width ? { width: singleLineWidth } : {}), ...(safeFont < fontSize ? { fontSize: safeFont } : {}) }
      issues.push(issue('text_overflow', 'readability', severity, `图形「${text.slice(0, 20)}」当前 ${Math.round(element.width)}×${Math.round(element.height)} 放不下 ${requiredLines} 行文字；保持 ${fontSize}px 字号至少需要高度 ${requiredHeight}px${requiredLines === 1 ? `、宽度 ${singleLineWidth}px` : ''}。优先扩大框，空间受限时字号最低可降至 ${safeFont}px。`, [element.id], true, patch))
    }
    if (fontSize < 11 && text.length > 1) issues.push(issue('small_text', 'readability', 'medium', `图形「${text.slice(0, 20)}」字号过小`, [element.id], true))
    const ratio = contrast(element.textColor || '#263145', element.fill)
    if (ratio !== null && ratio < 3) issues.push(issue('low_contrast', 'readability', 'medium', `图形「${text.slice(0, 20)}」文字与底色对比度不足`, [element.id]))
  }
  for (const frame of backgrounds) {
    const children = foreground.filter(item => contains(frame, item)); if (!children.length) continue
    const padding = Math.min(...children.flatMap(item => [item.x - frame.x, item.y - frame.y, frame.x + frame.width - item.x - item.width, frame.y + frame.height - item.y - item.height]))
    if (padding < 18) issues.push(issue('container_padding', 'hierarchy', 'medium', `容器「${frame.text || frame.id}」与内容留白不足`, [frame.id, ...children.map(item => item.id)], true))
  }
  for (const item of document.elements.filter(item => !connected.has(item.id) && item.kind !== 'frame' && item.kind !== 'text')) issues.push(issue('orphan', 'structure', 'medium', `图形「${item.text || item.id}」没有关系线；请确认它是否应保留、分组或连接`, [item.id]))
  const unique = issues.filter((issue, index, all) => all.findIndex(other => other.type === issue.type && other.ids.join('|') === issue.ids.join('|')) === index)
  const score = Math.max(0, 100 - unique.reduce((sum, issue) => sum + (issue.severity === 'high' ? 18 : 7), 0))
  const dimensions = (['structure', 'layout', 'connectors', 'hierarchy', 'readability', 'consistency'] as AuditArea[]).reduce((result, area) => ({ ...result, [area]: Math.max(0, 100 - unique.filter(item => item.area === area).reduce((sum, item) => sum + (item.severity === 'high' ? 24 : 10), 0)) }), {} as Record<AuditArea, number>)
  const suggestions = [...new Set(unique.filter(item => item.fixable).map(item => item.type === 'orphan' ? '确认孤立元素的业务含义后，再决定连接、分组或删除。' : item.area === 'readability' ? '调整卡片尺寸、字号或颜色，保证文字完整且清晰。' : item.area === 'hierarchy' ? '把容器置于底层并预留足够内边距。' : '调用 board_optimize_layout 自动修复可确定的布局、对齐和连线问题。'))]
  return { checked: true, score, dimensions, issues: unique.slice(0, 16), suggestions, summary: unique.length ? `画布质量审计发现 ${unique.length} 项问题，综合评分 ${score}/100。` : '画布质量审计通过：结构、布局、连线、层级、文字和视觉一致性均无明显问题。', recommendation: unique.length ? '优先处理高严重度问题；可自动修复的项目可调用 board_optimize_layout，其余由 Agent 根据业务语义决定。' : undefined }
}

const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0

export function optimizeDiagramLayout(document: BoardDocument, scope: 'local' | 'full' = 'full'): BoardOperation[] {
  if (document.elements.length < 2) return []
  if (scope === 'local') {
    const audit = reflectDiagram(document)
    const operations: BoardOperation[] = []
    const patched = new Set<string>()
    for (const item of audit.issues) {
      if (item.suggestedPatch && item.ids[0] && !patched.has(item.ids[0])) { operations.push({ op: 'patch_element', id: item.ids[0], patch: item.suggestedPatch }); patched.add(item.ids[0]) }
      if (item.type === 'background_occlusion' && item.ids[0] && !patched.has(item.ids[0])) { operations.push({ op: 'patch_element', id: item.ids[0], patch: { zIndex: -1000 } }); patched.add(item.ids[0]) }
      if ((item.type === 'edge_crossing' || item.type === 'edge_over_node' || item.type === 'long_diagonal') && item.ids[0]) operations.push({ op: 'patch_edge', id: item.ids[0], patch: { routing: 'elbow', controlPoints: undefined } })
    }
    return operations
  }
  const { backgrounds, nodes, edges } = graph(document)
  if (!nodes.length) return document.elements.filter(item => backgrounds.has(item.id)).map((item, index) => ({ op: 'patch_element', id: item.id, patch: { zIndex: -1000 + index } }))
  const ids = new Set(nodes.map(item => item.id)); const parents = new Map(nodes.map(item => [item.id, [] as string[]]))
  for (const edge of edges) parents.get(edge.to)!.push(edge.from)
  const ranks = flowRanks(nodes, edges)
  const groups = new Map<number, BoardElement[]>(); nodes.forEach(item => { const rank = ranks.get(item.id) || 0; groups.set(rank, [...(groups.get(rank) || []), item]) })
  const rankOrder = [...groups.keys()].sort((a, b) => a - b)
  // Preserve semantic lanes: order each rank by the median position of its parents.
  for (let pass = 0; pass < 3; pass += 1) for (const rank of rankOrder) { const items = groups.get(rank)!; const previousIndex = new Map((groups.get(rank - 1) || []).map((item, index) => [item.id, index])); items.sort((a, b) => median((parents.get(a.id) || []).map(id => previousIndex.get(id)).filter((value): value is number => value !== undefined)) - median((parents.get(b.id) || []).map(id => previousIndex.get(id)).filter((value): value is number => value !== undefined)) || a.y - b.y) }
  const operations: BoardOperation[] = []; const positions = new Map<string, Rect>(); const layerGap = 312; const rowGap = 96; const snap = (value: number) => Math.round(value / 8) * 8
  for (const rank of rankOrder) { const items = groups.get(rank)!; const total = items.reduce((sum, item) => sum + item.height, 0) + Math.max(0, items.length - 1) * rowGap; let cursor = 300 - total / 2; items.forEach((item, index) => { const patch = { x: snap(224 + rank * layerGap), y: snap(cursor), zIndex: 10 + rank * 100 + index }; positions.set(item.id, { ...item, ...patch }); operations.push({ op: 'patch_element', id: item.id, patch }); cursor += item.height + rowGap }) }
  document.elements.filter(item => !ids.has(item.id) && !backgrounds.has(item.id)).forEach((item, index) => operations.push({ op: 'patch_element', id: item.id, patch: { zIndex: Math.max(5, item.zIndex ?? 5 + index) } }))
  document.elements.filter(item => backgrounds.has(item.id)).forEach((frame, index) => { const children = document.elements.filter(item => item.id !== frame.id && (item.groupId === frame.id || contains(frame, item))).map(item => positions.get(item.id) || item); const patch: Partial<BoardElement> = { zIndex: -1000 + index }; if (children.length) { const left = Math.min(...children.map(item => item.x)), top = Math.min(...children.map(item => item.y)), right = Math.max(...children.map(item => item.x + item.width)), bottom = Math.max(...children.map(item => item.y + item.height)); Object.assign(patch, { x: left - 34, y: top - 48, width: right - left + 68, height: bottom - top + 82 }) }; operations.push({ op: 'patch_element', id: frame.id, patch }) })
  edges.forEach((edge, index) => operations.push({ op: 'patch_edge', id: edge.id, patch: { routing: 'elbow', controlPoints: undefined, zIndex: index } }))
  return operations
}
