import type { BoardDocument, BoardElement, BoardOperation } from '../types'
import { resolvedEdgeEndpoints } from './edgeGeometry'
import { remapControlPoints } from './canvasGeometry'

export type GroupResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type GroupBounds = { x: number; y: number; width: number; height: number }

export function boundsForElements(elements: BoardElement[]): GroupBounds | null {
  if (!elements.length) return null
  const left = Math.min(...elements.map(item => item.x)), top = Math.min(...elements.map(item => item.y))
  const right = Math.max(...elements.map(item => item.x + item.width)), bottom = Math.max(...elements.map(item => item.y + item.height))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** Corner handles scale uniformly around the opposite corner; side handles scale one axis. */
export function resizedGroupBounds(bounds: GroupBounds, handle: GroupResizeHandle, dx: number, dy: number, minimumScale = .08): GroupBounds {
  const corner = handle.length === 2
  if (corner) {
    const signX = handle.includes('w') ? -1 : 1, signY = handle.includes('n') ? -1 : 1
    const scale = Math.max(minimumScale, 1 + (dx * signX * bounds.width + dy * signY * bounds.height) / (bounds.width * bounds.width + bounds.height * bounds.height))
    const width = bounds.width * scale, height = bounds.height * scale
    return { x: handle.includes('w') ? bounds.x + bounds.width - width : bounds.x, y: handle.includes('n') ? bounds.y + bounds.height - height : bounds.y, width, height }
  }
  let { x, y, width, height } = bounds
  if (handle === 'e') width = Math.max(bounds.width * minimumScale, bounds.width + dx)
  if (handle === 's') height = Math.max(bounds.height * minimumScale, bounds.height + dy)
  if (handle === 'w') { width = Math.max(bounds.width * minimumScale, bounds.width - dx); x = bounds.x + bounds.width - width }
  if (handle === 'n') { height = Math.max(bounds.height * minimumScale, bounds.height - dy); y = bounds.y + bounds.height - height }
  return { x, y, width, height }
}

const finitePoints = (points: unknown) => Array.isArray(points) ? points.filter((point): point is { x: number; y: number } => Boolean(point) && Number.isFinite(point.x) && Number.isFinite(point.y)) : []
const scalePoint = (point: { x: number; y: number }, from: GroupBounds, to: GroupBounds) => ({ x: to.x + (point.x - from.x) * to.width / from.width, y: to.y + (point.y - from.y) * to.height / from.height })

/** Produce one atomic operation set for elements and every affected manual connector. */
export function groupResizeOperations(document: BoardDocument, ids: string[], from: GroupBounds, to: GroupBounds): BoardOperation[] {
  const selected = new Set(ids)
  const scaleX = to.width / from.width, scaleY = to.height / from.height
  const uniform = Math.abs(scaleX - scaleY) < .0001
  const elementOperations: BoardOperation[] = document.elements.filter(item => selected.has(item.id) && !item.locked).map(item => ({
    op: 'patch_element', id: item.id, patch: {
      x: to.x + (item.x - from.x) * scaleX,
      y: to.y + (item.y - from.y) * scaleY,
      width: Math.max(4, item.width * scaleX),
      height: Math.max(4, item.height * scaleY),
      ...(uniform ? { fontSize: Math.max(8, Math.min(160, item.fontSize * scaleX)) } : {}),
    },
  }))
  const patchedElements = document.elements.map(item => {
    const operation = elementOperations.find(value => value.op === 'patch_element' && value.id === item.id)
    return operation?.op === 'patch_element' ? { ...item, ...operation.patch } : item
  })
  const edgeOperations: BoardOperation[] = []
  for (const edge of document.edges) {
    const fromSelected = selected.has(edge.from), toSelected = selected.has(edge.to)
    const controls = finitePoints(edge.controlPoints)
    if ((!fromSelected && !toSelected) || !controls.length) continue
    let points: Array<{ x: number; y: number }>
    if (fromSelected && toSelected) points = controls.map(point => scalePoint(point, from, to))
    else {
      const before = resolvedEdgeEndpoints(document.elements, edge), after = resolvedEdgeEndpoints(patchedElements, edge)
      if (!before || !after) continue
      points = (edge.routing || 'curve') === 'elbow' ? [] : remapControlPoints(before.start, before.end, after.start, after.end, controls)
    }
    edgeOperations.push({ op: 'patch_edge', id: edge.id, patch: { controlPoints: points } })
  }
  return [...elementOperations, ...edgeOperations]
}
