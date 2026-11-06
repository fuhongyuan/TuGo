import { newId, type BoardDocument, type BoardElement, type BoardEdge, type BoardOperation } from '../types'
import { resolvedEdgeEndpoints, type EdgePoint } from './edgeGeometry'

type ClipboardContent = { elements: BoardElement[]; edges: BoardEdge[] }

/** App-session clipboard: survives canvas remounts when switching projects. */
export class CanvasClipboard {
  private content: ClipboardContent | null = null
  private pasteCount = 0

  get hasContent() { return Boolean(this.content?.elements.length || this.content?.edges.length) }

  copy(document: BoardDocument, selectedIds: string[]) {
    const selected = new Set(selectedIds)
    const elements = document.elements.filter(item => selected.has(item.id))
    const nodes = new Set(elements.map(item => item.id))
    const edges = document.edges.flatMap(edge => {
      if (!selected.has(edge.id) && !(nodes.has(edge.from) && nodes.has(edge.to))) return []
      const endpoints = resolvedEdgeEndpoints(document.elements, edge)
      if (!endpoints) return []
      // A copied line must not refer to an uncopied node on another board.
      return [{ ...edge,
        from: nodes.has(edge.from) ? edge.from : '',
        to: nodes.has(edge.to) ? edge.to : '',
        ...(!nodes.has(edge.from) ? { freeStart: endpoints.start, fromAnchor: undefined } : {}),
        ...(!nodes.has(edge.to) ? { freeEnd: endpoints.end, toAnchor: undefined } : {}),
      }]
    })
    if (!elements.length && !edges.length) return false
    this.content = structuredClone({ elements, edges })
    this.pasteCount = 0
    return true
  }

  paste(document: BoardDocument, visible?: { x: number; y: number; width: number; height: number }) {
    const result: { operations: BoardOperation[]; ids: string[] } = { operations: [], ids: [] }
    if (!this.content) return result
    const { elements, edges } = structuredClone(this.content)
    const offset = 28 * ++this.pasteCount
    let dx = offset, dy = offset
    const points = elements.flatMap(item => [{ x: item.x, y: item.y }, { x: item.x + item.width, y: item.y + item.height }])
    for (const edge of edges) points.push(...[edge.freeStart, edge.freeEnd, ...(edge.controlPoints || [])].filter((point): point is EdgePoint => Boolean(point)))
    if (visible && points.length) {
      const cx = (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2
      const cy = (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2
      if (cx + dx < visible.x || cx + dx > visible.x + visible.width || cy + dy < visible.y || cy + dy > visible.y + visible.height) {
        dx = visible.x + visible.width / 2 - cx
        dy = visible.y + visible.height / 2 - cy
      }
    }
    const move = (point: EdgePoint) => ({ x: point.x + dx, y: point.y + dy })
    const ids = new Map(elements.map(item => [item.id, newId('node')]))
    const groups = new Map<string, string>()
    const nodeTop = Math.max(0, ...document.elements.map(item => item.zIndex ?? 0)) + 1
    const edgeTop = Math.max(0, ...document.edges.map(item => item.zIndex ?? 0)) + 1
    const nodeBase = Math.min(0, ...elements.map(item => item.zIndex ?? 0))
    const edgeBase = Math.min(0, ...edges.map(item => item.zIndex ?? 0))
    for (const item of elements) {
      if (item.groupId && !groups.has(item.groupId)) groups.set(item.groupId, ids.get(item.groupId) || newId('group'))
      const id = ids.get(item.id)!
      result.ids.push(id)
      result.operations.push({ op: 'add_element', element: { ...item, id, ...move(item), locked: false,
        groupId: item.groupId ? groups.get(item.groupId) : undefined, zIndex: nodeTop + (item.zIndex ?? 0) - nodeBase } })
    }
    for (const edge of edges) {
      const id = newId('edge')
      result.ids.push(id)
      result.operations.push({ op: 'add_edge', edge: { ...edge, id, from: ids.get(edge.from) || '', to: ids.get(edge.to) || '',
        freeStart: edge.freeStart ? move(edge.freeStart) : undefined,
        freeEnd: edge.freeEnd ? move(edge.freeEnd) : undefined,
        controlPoints: edge.controlPoints?.map(move), zIndex: edgeTop + (edge.zIndex ?? 0) - edgeBase } })
    }
    return result
  }
}

export const canvasClipboard = new CanvasClipboard()
