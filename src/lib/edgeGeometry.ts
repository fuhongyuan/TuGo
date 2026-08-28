import type { BoardEdge, BoardElement, EdgeAnchor } from '../types'

export type EdgePoint = { x: number; y: number }

const clamp = (value: number) => Math.max(0, Math.min(1, value))

/** Convert a local 0–1 attachment into an absolute canvas point. */
export function edgeAttachmentPoint(element: BoardElement, attachment: EdgeAnchor): EdgePoint {
  return { x: element.x + clamp(attachment.x) * element.width, y: element.y + clamp(attachment.y) * element.height }
}

/** Snap an arbitrary pointer position to the closest edge of an element. */
export function edgeAttachmentForPoint(element: BoardElement, point: EdgePoint): EdgeAnchor {
  const x = clamp((point.x - element.x) / Math.max(1, element.width))
  const y = clamp((point.y - element.y) / Math.max(1, element.height))
  const distance = [x, 1 - x, y, 1 - y]
  const side = distance.indexOf(Math.min(...distance))
  if (side === 0) return { x: 0, y }
  if (side === 1) return { x: 1, y }
  if (side === 2) return { x, y: 0 }
  return { x, y: 1 }
}

/** Existing edges without explicit attachments retain the former auto-anchor behavior. */
export function resolvedEdgeAnchor(element: BoardElement, target: EdgePoint, attachment?: EdgeAnchor): EdgePoint {
  return attachment ? edgeAttachmentPoint(element, attachment) : edgeAnchor(element, target)
}

/** Resolve both bound/free endpoints from one document projection. */
export function resolvedEdgeEndpoints(elements: BoardElement[], edge: BoardEdge): { start: EdgePoint; end: EdgePoint } | null {
  const from = elements.find(item => item.id === edge.from), to = elements.find(item => item.id === edge.to)
  if ((!from && !edge.freeStart) || (!to && !edge.freeEnd)) return null
  const start = from ? resolvedEdgeAnchor(from, to ? { x: to.x + to.width / 2, y: to.y + to.height / 2 } : edge.freeEnd!, edge.fromAnchor) : edge.freeStart!
  const end = to ? resolvedEdgeAnchor(to, from ? { x: from.x + from.width / 2, y: from.y + from.height / 2 } : edge.freeStart!, edge.toAnchor) : edge.freeEnd!
  return { start, end }
}

// Return the point where a ray from the element center toward `target` meets
// the visible shape. Edge data stays unchanged; this is purely render geometry.
export function edgeAnchor(element: BoardElement, target: EdgePoint): EdgePoint {
  const cx = element.x + element.width / 2
  const cy = element.y + element.height / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) return { x: cx, y: cy }
  if (element.kind === 'ellipse') {
    const factor = 1 / Math.sqrt((dx * dx) / (element.width * element.width / 4) + (dy * dy) / (element.height * element.height / 4))
    return { x: cx + dx * factor, y: cy + dy * factor }
  }
  const polygon = element.kind === 'diamond'
    ? [{ x: cx, y: element.y }, { x: element.x + element.width, y: cy }, { x: cx, y: element.y + element.height }, { x: element.x, y: cy }]
    : element.kind === 'triangle'
      ? [{ x: cx, y: element.y }, { x: element.x + element.width, y: element.y + element.height }, { x: element.x, y: element.y + element.height }]
      : element.kind === 'hexagon'
        ? [{ x: element.x + element.width * .24, y: element.y }, { x: element.x + element.width * .76, y: element.y }, { x: element.x + element.width, y: cy }, { x: element.x + element.width * .76, y: element.y + element.height }, { x: element.x + element.width * .24, y: element.y + element.height }, { x: element.x, y: cy }]
        : null
  if (polygon) {
    let best: EdgePoint | null = null
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index]; const b = polygon[(index + 1) % polygon.length]
      const denominator = dx * (a.y - b.y) - dy * (a.x - b.x)
      if (Math.abs(denominator) < 0.0001) continue
      const ray = ((a.x - cx) * (a.y - b.y) - (a.y - cy) * (a.x - b.x)) / denominator
      const segment = ((a.x - cx) * dy - (a.y - cy) * dx) / denominator
      if (ray >= 0 && segment >= 0 && segment <= 1) {
        const point = { x: cx + ray * dx, y: cy + ray * dy }
        if (!best || ray < Math.hypot(best.x - cx, best.y - cy) / Math.hypot(dx, dy)) best = point
      }
    }
    if (best) return best
  }
  const factor = Math.min((element.width / 2) / Math.abs(dx || Number.EPSILON), (element.height / 2) / Math.abs(dy || Number.EPSILON))
  return { x: cx + dx * factor, y: cy + dy * factor }
}
