import type { BoardDocument, BoardEdge, BoardElement, BoardOperation } from '../types'
import { alignOperations, distributeOperations } from './boardCommands'

export type BoardHistory = { current: BoardDocument; past: BoardDocument[]; future: BoardDocument[] }

const clone = <T,>(value: T): T => structuredClone(value)
// Tool-call JSON is sometimes double-escaped by compatible model providers:
// the renderer then receives the two literal characters "\\" and "n" rather
// than a line break. Normalize at the board boundary so every writer (Agent,
// DSL import, IPC and future integrations) gets the same visual result.
export const normalizeCanvasText = (value: unknown) => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/\\r\\n|\\n|\\r/g, '\n')
  .replace(/<br\s*\/?\s*>/gi, '\n')
const textAlign = (value: unknown): BoardElement['textAlign'] => ['left', 'center', 'right'].includes(String(value)) ? String(value) as BoardElement['textAlign'] : 'center'
const verticalAlign = (value: unknown): BoardElement['verticalAlign'] => ['top', 'middle', 'bottom'].includes(String(value)) ? String(value) as BoardElement['verticalAlign'] : 'middle'
const fontWeight = (value: unknown): BoardElement['fontWeight'] => String(value).toLowerCase() === 'bold' || Number(value) >= 600 ? 'bold' : 'normal'
const fontStyle = (value: unknown): BoardElement['fontStyle'] => String(value).toLowerCase() === 'italic' ? 'italic' : 'normal'
const textDecoration = (value: unknown): BoardElement['textDecoration'] => /underline/i.test(String(value)) ? 'underline' : 'none'
const normalizeElement = (value: BoardElement, index = 0): BoardElement => {
  const raw = value as BoardElement & { shape?: BoardElement['kind']; style?: Partial<BoardElement> }
  const style = raw.style || {}
  return {
  ...value, id: String(value.id || `recovered_element_${index}`), kind: value.kind || raw.shape || 'rectangle',
  x: Number.isFinite(Number(value.x)) ? Number(value.x) : 0, y: Number.isFinite(Number(value.y)) ? Number(value.y) : 0,
  text: normalizeCanvasText(value.text), width: Math.max(20, Number(value.width ?? 180)), height: Math.max(20, Number(value.height ?? 90)),
  fill: value.fill ?? style.fill ?? '#DBEAFE', stroke: value.stroke ?? style.stroke ?? '#475569', strokeWidth: Number(value.strokeWidth ?? style.strokeWidth ?? 2),
  strokeStyle: value.strokeStyle || 'solid', fillOpacity: value.fillOpacity ?? 1, opacity: value.opacity ?? 1,
  textColor: value.textColor || '#263145', fontSize: Number(value.fontSize || 16), zIndex: value.zIndex ?? index,
  fontFamily: value.fontFamily || 'Inter', fontWeight: fontWeight(value.fontWeight), fontStyle: fontStyle(value.fontStyle),
  textDecoration: textDecoration(value.textDecoration), textAlign: textAlign(value.textAlign), verticalAlign: verticalAlign(value.verticalAlign),
  // Earlier Mermaid imports marked subgraph frames as locked. Normalize those
  // saved documents on load so existing boards regain normal canvas editing.
  locked: value.metadata?.mermaidSubgraph ? false : (value.locked ?? false),
}}
const finiteControlPoints = (value: unknown): Array<{ x: number; y: number }> | undefined => {
  if (!Array.isArray(value)) return undefined
  const points = value
    .filter((point): point is { x: unknown; y: unknown } => Boolean(point) && typeof point === 'object')
    .map(point => ({ x: Number(point.x), y: Number(point.y) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  return points.length ? points : undefined
}
const finiteAnchor = (value: unknown): { x: number; y: number } | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const point = value as { x?: unknown; y?: unknown }
  const x = Number(point.x), y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}
const finitePoint = (value: unknown): { x: number; y: number } | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const point = value as { x?: unknown; y?: unknown }; const x = Number(point.x), y = Number(point.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

const normalizeEdge = (value: BoardEdge, index = 0): BoardEdge => {
  const raw = value as BoardEdge & { source?: string; target?: string; style?: Partial<BoardEdge> }
  const style = raw.style || {}
  return {
  ...value, id: String(value.id || `recovered_edge_${index}`), from: String(value.from || raw.source || ''), to: String(value.to || raw.target || ''),
  controlPoints: finiteControlPoints(value.controlPoints), freeStart: finitePoint(value.freeStart), freeEnd: finitePoint(value.freeEnd), fromAnchor: finiteAnchor(value.fromAnchor), toAnchor: finiteAnchor(value.toAnchor), stroke: value.stroke || style.stroke || '#64748B', strokeWidth: Number(value.strokeWidth || style.strokeWidth || 2),
  strokeStyle: value.strokeStyle || (value.dashed ? 'dashed' : 'solid'), startArrow: value.startArrow || (value.arrowStart ? 'arrow' : 'none'),
  endArrow: value.endArrow || style.endArrow || (value.arrowEnd ? 'arrow' : 'none'), routing: value.routing || style.routing || 'curve', opacity: value.opacity ?? style.opacity ?? 1, zIndex: value.zIndex ?? index,
}}
export const normalizeDocument = (value: BoardDocument): BoardDocument => {
  const elements = (Array.isArray(value.elements) ? value.elements : []).map(normalizeElement)
  const ids = new Set(elements.map(item => item.id))
  const edges = (Array.isArray(value.edges) ? value.edges : []).map(normalizeEdge).filter(edge => (ids.has(edge.from) || edge.freeStart) && (ids.has(edge.to) || edge.freeEnd))
  return { ...value, version: 3, paletteId: value.paletteId || 'macaron', elements, edges }
}

export function applyBoardOperations(document: BoardDocument, operations: BoardOperation[]): BoardDocument {
  let next = normalizeDocument(clone(document))
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_element':
        next.elements = [...next.elements.filter(item => item.id !== operation.element.id), normalizeElement(operation.element, next.elements.length)]
        break
      case 'patch_element':
        next.elements = next.elements.map((item, index) => item.id === operation.id ? normalizeElement({ ...item, ...operation.patch, id: item.id }, index) : item)
        break
      case 'delete_element':
        next.elements = next.elements.filter(item => item.id !== operation.id)
        next.edges = next.edges.filter(edge => edge.from !== operation.id && edge.to !== operation.id)
        break
      case 'add_edge':
        if ((next.elements.some(item => item.id === operation.edge.from) || operation.edge.freeStart) && (next.elements.some(item => item.id === operation.edge.to) || operation.edge.freeEnd)) {
          next.edges = [...next.edges.filter(item => item.id !== operation.edge.id), normalizeEdge(operation.edge, next.edges.length)]
        }
        break
      case 'patch_edge':
        // A control-point edit is user input as well as an Agent tool target. Always
        // normalize it here so one malformed/sparse point can never poison SVG render.
        next.edges = next.edges.map((item, index) => item.id === operation.id ? normalizeEdge({ ...item, ...operation.patch, id: item.id }, index) : item)
        break
      case 'delete_edge':
        next.edges = next.edges.filter(item => item.id !== operation.id)
        break
      case 'group_elements': {
        const groupId = operation.groupId || `group_${crypto.randomUUID()}`
        next.elements = next.elements.map(item => operation.ids.includes(item.id) ? { ...item, groupId } : item)
        break
      }
      case 'ungroup_elements':
        next.elements = next.elements.map(item => operation.ids.includes(item.id) ? { ...item, groupId: undefined } : item)
        break
      case 'align_elements':
        next = applyBoardOperations(next, alignOperations(next, operation.ids, operation.alignment))
        break
      case 'distribute_elements':
        next = applyBoardOperations(next, distributeOperations(next, operation.ids, operation.axis))
        break
      case 'set_palette':
        next.paletteId = operation.paletteId
        break
      case 'replace_document':
        next = normalizeDocument(clone(operation.document))
        break
      case 'patch_dsl':
        next.dsl = { kind: operation.kind, source: operation.source, updatedAt: new Date().toISOString() }
        break
    }
  }
  return next
}

export function commit(history: BoardHistory, operations: BoardOperation[]): BoardHistory {
  const next = applyBoardOperations(history.current, operations)
  return { current: next, past: [...history.past.slice(-99), clone(history.current)], future: [] }
}

export function undo(history: BoardHistory): BoardHistory {
  const previous = history.past.at(-1)
  if (!previous) return history
  return {
    current: clone(previous),
    past: history.past.slice(0, -1),
    future: [clone(history.current), ...history.future].slice(0, 100),
  }
}

export function redo(history: BoardHistory): BoardHistory {
  const following = history.future[0]
  if (!following) return history
  return {
    current: clone(following),
    past: [...history.past, clone(history.current)].slice(-100),
    future: history.future.slice(1),
  }
}
