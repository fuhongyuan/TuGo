export type CanvasPoint = { x: number; y: number }
export type CanvasRect = { x: number; y: number; width: number; height: number }
export type EdgeLabelPlacement = CanvasPoint & { width: number; height: number }

/** Stable default bend expressed perpendicular to the endpoint segment. */
export function defaultCurveControl(start: CanvasPoint, end: CanvasPoint): CanvasPoint {
  const dx = end.x - start.x, dy = end.y - start.y, distance = Math.max(1, Math.hypot(dx, dy))
  let nx = -dy / distance, ny = dx / distance
  if (ny > 0 || (Math.abs(ny) < .0001 && nx < 0)) { nx *= -1; ny *= -1 }
  const bend = Math.min(64, Math.max(24, distance * .16))
  return { x: (start.x + end.x) / 2 + nx * bend, y: (start.y + end.y) / 2 + ny * bend }
}

/** Preserve a user's handles in the coordinate system defined by two endpoints. */
export function remapControlPoints(oldStart: CanvasPoint, oldEnd: CanvasPoint, newStart: CanvasPoint, newEnd: CanvasPoint, controls: CanvasPoint[]): CanvasPoint[] {
  const oldDx = oldEnd.x - oldStart.x, oldDy = oldEnd.y - oldStart.y, oldLength = Math.hypot(oldDx, oldDy)
  const newDx = newEnd.x - newStart.x, newDy = newEnd.y - newStart.y, newLength = Math.hypot(newDx, newDy)
  if (oldLength < .001 || newLength < .001) {
    const dx = ((newStart.x - oldStart.x) + (newEnd.x - oldEnd.x)) / 2, dy = ((newStart.y - oldStart.y) + (newEnd.y - oldEnd.y)) / 2
    return controls.map(point => ({ x: point.x + dx, y: point.y + dy }))
  }
  const oldNormal = { x: -oldDy / oldLength, y: oldDx / oldLength }, newNormal = { x: -newDy / newLength, y: newDx / newLength }
  return controls.map(point => {
    const relative = { x: point.x - oldStart.x, y: point.y - oldStart.y }
    const along = (relative.x * oldDx + relative.y * oldDy) / (oldLength * oldLength)
    const offset = relative.x * oldNormal.x + relative.y * oldNormal.y
    return { x: newStart.x + along * newDx + offset * newNormal.x, y: newStart.y + along * newDy + offset * newNormal.y }
  })
}

const quadraticPoint = (start: CanvasPoint, control: CanvasPoint, end: CanvasPoint, t: number) => {
  const inverse = 1 - t
  return { x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x, y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y }
}

/** Convert route parameters instead of leaking incompatible handles across modes. */
export function convertRouteControlPoints(currentRouting: string, nextRouting: string, start: CanvasPoint, end: CanvasPoint, controls: CanvasPoint[]): CanvasPoint[] {
  if (nextRouting === 'straight' || nextRouting === 'elbow') return []
  if (nextRouting === currentRouting) return controls.map(point => ({ ...point }))
  if (nextRouting === 'polyline') {
    if (currentRouting !== 'curve') return controls.map(point => ({ ...point }))
    const control = controls[0] || defaultCurveControl(start, end)
    return [quadraticPoint(start, control, end, 1 / 3), quadraticPoint(start, control, end, 2 / 3)]
  }
  if (nextRouting === 'curve') {
    if (!controls.length || currentRouting === 'straight') return []
    const route = [start, ...controls, end]
    const lengths = route.slice(1).map((point, index) => Math.hypot(point.x - route[index].x, point.y - route[index].y))
    const half = lengths.reduce((sum, value) => sum + value, 0) / 2
    let walked = 0, midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    for (let index = 0; index < lengths.length; index += 1) {
      if (walked + lengths[index] >= half) { const ratio = lengths[index] ? (half - walked) / lengths[index] : 0; midpoint = { x: route[index].x + (route[index + 1].x - route[index].x) * ratio, y: route[index].y + (route[index + 1].y - route[index].y) * ratio }; break }
      walked += lengths[index]
    }
    return [{ x: midpoint.x * 2 - (start.x + end.x) / 2, y: midpoint.y * 2 - (start.y + end.y) / 2 }]
  }
  return []
}

const expanded = (rect: CanvasRect, margin: number): CanvasRect => ({ x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 })
const pointInRect = (point: CanvasPoint, rect: CanvasRect) => point.x > rect.x && point.x < rect.x + rect.width && point.y > rect.y && point.y < rect.y + rect.height
const orientation = (a: CanvasPoint, b: CanvasPoint, c: CanvasPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
const segmentsCross = (a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint) => orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0
const segmentHitsRect = (a: CanvasPoint, b: CanvasPoint, rect: CanvasRect) => {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true
  const tl = { x: rect.x, y: rect.y }, tr = { x: rect.x + rect.width, y: rect.y }, br = { x: rect.x + rect.width, y: rect.y + rect.height }, bl = { x: rect.x, y: rect.y + rect.height }
  return segmentsCross(a, b, tl, tr) || segmentsCross(a, b, tr, br) || segmentsCross(a, b, br, bl) || segmentsCross(a, b, bl, tl)
}
const rectsOverlap = (a: CanvasRect, b: CanvasRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const collinearOverlap = (a: CanvasPoint, b: CanvasPoint, c: CanvasPoint, d: CanvasPoint) => {
  if (a.x === b.x && c.x === d.x && a.x === c.x) return Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)))
  if (a.y === b.y && c.y === d.y && a.y === c.y) return Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)))
  return 0
}
const length = (points: CanvasPoint[]) => points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0)
const compact = (points: CanvasPoint[]) => points.filter((point, index, all) => {
  if (index === 0 || index === all.length - 1) return true
  const before = all[index - 1], after = all[index + 1]
  return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y))
})

/** Pick a short orthogonal route while treating foreground cards as obstacles. */
export function orthogonalControlPoints(start: CanvasPoint, end: CanvasPoint, obstacles: CanvasRect[], margin = 18, occupiedRoutes: CanvasPoint[][] = []): CanvasPoint[] {
  const blocked = obstacles.map(rect => expanded(rect, margin))
  const candidates: CanvasPoint[][] = []
  if (start.x === end.x || start.y === end.y) candidates.push([start, end])
  const midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2
  const xs = new Set([start.x, end.x, midX - 32, midX - 16, midX, midX + 16, midX + 32])
  const ys = new Set([start.y, end.y, midY - 32, midY - 16, midY, midY + 16, midY + 32])
  blocked.forEach(rect => { xs.add(rect.x - margin); xs.add(rect.x + rect.width + margin); ys.add(rect.y - margin); ys.add(rect.y + rect.height + margin) })
  occupiedRoutes.flat().forEach(point => { xs.add(point.x - 12); xs.add(point.x + 12); ys.add(point.y - 12); ys.add(point.y + 12) })
  xs.forEach(x => candidates.push([start, { x, y: start.y }, { x, y: end.y }, end]))
  ys.forEach(y => candidates.push([start, { x: start.x, y }, { x: end.x, y }, end]))
  const scored = candidates.map(raw => {
    const points = compact(raw)
    const collisions = points.slice(1).reduce((sum, point, index) => sum + blocked.filter(rect => segmentHitsRect(points[index], point, rect)).length, 0)
    let crossings = 0, sharedLength = 0
    for (let index = 1; index < points.length; index += 1) for (const route of occupiedRoutes) for (let other = 1; other < route.length; other += 1) {
      if (segmentsCross(points[index - 1], points[index], route[other - 1], route[other])) crossings += 1
      sharedLength += collinearOverlap(points[index - 1], points[index], route[other - 1], route[other])
    }
    return { points, score: collisions * 1_000_000 + crossings * 2_500 + sharedLength * 12 + length(points) + Math.max(0, points.length - 2) * 28 }
  }).sort((a, b) => a.score - b.score)
  return (scored[0]?.points || [start, end]).slice(1, -1)
}

/** Expand a rendered edge into line segments used by labels and collision checks. */
export function sampledEdgePoints(routing: string, start: CanvasPoint, end: CanvasPoint, controls: CanvasPoint[]): CanvasPoint[] {
  if (routing === 'curve') {
    const control = controls[0] || defaultCurveControl(start, end)
    return Array.from({ length: 17 }, (_, index) => {
      const t = index / 16, inverse = 1 - t
      return { x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x, y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y }
    })
  }
  return [start, ...controls, end]
}

/** Place an edge label on a long path segment and avoid cards and prior labels. */
export function placeEdgeLabel(points: CanvasPoint[], label: string, obstacles: CanvasRect[], occupied: CanvasRect[] = []): EdgeLabelPlacement {
  const width = Math.max(34, Array.from(label).length * 7.4 + 16), height = 22
  const segments = points.slice(1).map((point, index) => ({ a: points[index], b: point, length: Math.hypot(point.x - points[index].x, point.y - points[index].y) })).sort((a, b) => b.length - a.length)
  const offsets = [0, -16, 16, -28, 28, -40, 40]
  let fallback = { x: (points[0]?.x || 0) + ((points.at(-1)?.x || 0) - (points[0]?.x || 0)) / 2, y: (points[0]?.y || 0) + ((points.at(-1)?.y || 0) - (points[0]?.y || 0)) / 2, width, height }
  for (const segment of segments) {
    const dx = segment.b.x - segment.a.x, dy = segment.b.y - segment.a.y, magnitude = Math.max(1, Math.hypot(dx, dy))
    for (const offset of offsets) {
      const center = { x: (segment.a.x + segment.b.x) / 2 + (-dy / magnitude) * offset, y: (segment.a.y + segment.b.y) / 2 + (dx / magnitude) * offset }
      const candidate = { x: center.x - width / 2, y: center.y - height / 2, width, height }
      fallback = { x: center.x, y: center.y, width, height }
      if (![...obstacles, ...occupied].some(rect => rectsOverlap(candidate, expanded(rect, 3)))) return fallback
    }
  }
  return fallback
}
