import {runCooperatively} from './cooperativeTask'
import {sceneObstacles} from './sceneObstacles'
import type { BoardEdge, BoardElement } from '../types'
import { resolvedEdgeEndpoints } from './edgeGeometry'
import { edgeDefaults } from './canvasStyle'
import { orthogonalControlPoints, sampledEdgePoints, type CanvasPoint, type CanvasRect } from './canvasGeometry'

type Point = CanvasPoint
const normal = (node: BoardElement | undefined, point: Point, other: Point): Point => {
  if (!node) { const dx = other.x - point.x, dy = other.y - point.y; return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) } }
  const distances = [Math.abs(point.x - node.x), Math.abs(point.x - node.x - node.width), Math.abs(point.y - node.y), Math.abs(point.y - node.y - node.height)]
  return [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }][distances.indexOf(Math.min(...distances))]
}

/** Shared route used by the canvas, previews, exports and quality checks. */
export function resolveEdgeRoute(edge: BoardEdge, elements: BoardElement[], obstacles?: CanvasRect[], occupied: Point[][] = []) {
  const endpoints = resolvedEdgeEndpoints(elements, edge)
  if (!endpoints) return null
  const { start, end } = endpoints, routing = edgeDefaults(edge).routing
  const from = elements.find(item => item.id === edge.from), to = elements.find(item => item.id === edge.to)
  const controls = (edge.controlPoints || []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  const a = normal(from, start, end), b = normal(to, end, start)
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  const blockers = obstacles || sceneObstacles(elements).filter(item=>item.id!==edge.from&&item.id!==edge.to)
  let points = routing === 'straight' ? [] : controls
  if (!controls.length && routing === 'curve') {
    const reach = Math.min(100, distance / 3)
    points = [{ x: start.x + a.x * reach, y: start.y + a.y * reach }, { x: end.x + b.x * reach, y: end.y + b.y * reach }]
  }
  const curveBlocked = routing === 'curve' && !controls.length && sampledEdgePoints(routing, start, end, points).some(point => blockers.some(rect => point.x > rect.x - 8 && point.x < rect.x + rect.width + 8 && point.y > rect.y - 8 && point.y < rect.y + rect.height + 8))
  if (!controls.length && (routing === 'elbow' || curveBlocked)) {
    // A fixed 24px lead can land inside the next card in an 18px gutter.
    // Reserve half the actual free space before entering the routing graph.
    const lead = (p: Point, n: Point, owner?: BoardElement) => {
      let room = Math.min(24, distance / 3)
      for (const r of [...blockers, ...elements.filter(item => item.id === edge.from || item.id === edge.to)]) {
        if (r === owner) continue
        const spans = n.x ? p.y > r.y - 2 && p.y < r.y + r.height + 2 : p.x > r.x - 2 && p.x < r.x + r.width + 2
        const gap = n.x > 0 ? r.x - p.x : n.x < 0 ? p.x - r.x - r.width : n.y > 0 ? r.y - p.y : p.y - r.y - r.height
        if (spans && gap > 0) room = Math.min(room, gap / 2)
      }
      return { x: p.x + n.x * room, y: p.y + n.y * room }
    }
    const first = lead(start, a, from), last = lead(end, b, to)
    const margin = Math.min(6, Math.hypot(first.x - start.x, first.y - start.y) / 2, Math.hypot(last.x - end.x, last.y - end.y) / 2)
    points = [first, ...orthogonalControlPoints(first, last, [...blockers, ...[from, to].filter((item): item is BoardElement => Boolean(item))], margin, occupied), last]
    if (curveBlocked && points.length < 3) points.splice(1, 0, { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 })
  }
  return { start, end, points, pathPoints: sampledEdgePoints(routing, start, end, points), routing }
}

export function routePath(routing: string, start: Point, end: Point, controls: Point[]) {
  const move = `M ${start.x} ${start.y}`
  if ((routing === 'curve' && controls.length > 2) || (routing === 'elbow' && controls.length)) {
    const route = [start, ...controls, end]
    let path = move
    for (let i = 1; i < route.length - 1; i++) {
      const before = route[i - 1], corner = route[i], after = route[i + 1]
      const incoming = Math.hypot(corner.x - before.x, corner.y - before.y), outgoing = Math.hypot(after.x - corner.x, after.y - corner.y)
      const radius = Math.min(8, incoming / 2, outgoing / 2)
      if (!radius) continue
      const a = { x: corner.x + (before.x - corner.x) * radius / incoming, y: corner.y + (before.y - corner.y) * radius / incoming }
      const b = { x: corner.x + (after.x - corner.x) * radius / outgoing, y: corner.y + (after.y - corner.y) * radius / outgoing }
      path += ` L ${a.x} ${a.y} Q ${corner.x} ${corner.y} ${b.x} ${b.y}`
    }
    return `${path} L ${end.x} ${end.y}`
  }
  if (routing === 'curve' && controls.length >= 2) return `${move} C ${controls[0].x} ${controls[0].y} ${controls[1].x} ${controls[1].y} ${end.x} ${end.y}`
  if (routing === 'curve' && controls.length === 1) return `${move} Q ${controls[0].x} ${controls[0].y} ${end.x} ${end.y}`
  return `${move}${(routing === 'straight' ? [] : controls).map(point => ` L ${point.x} ${point.y}`).join('')} L ${end.x} ${end.y}`
}

export function* documentEdgeRouteSteps(elements: BoardElement[], edges: BoardEdge[]) {
  const occupied: Point[][] = [], routes = new Map<string, NonNullable<ReturnType<typeof resolveEdgeRoute>>>()
  const obstacles = sceneObstacles(elements)
  const prepared = edges.map(edge => ({ ...edge }))
  const ports = new Map<string, Array<{ edge: BoardEdge; end: 'fromAnchor' | 'toAnchor'; normal: Point; other: Point }>>()
  for (const edge of prepared) {
    yield
    if (edgeDefaults(edge).routing === 'straight' || edge.controlPoints?.length) continue
    const endpoints = resolvedEdgeEndpoints(elements, edge)
    if (!endpoints) continue
    for (const end of ['fromAnchor', 'toAnchor'] as const) {
      if (edge[end]) continue
      const from = end === 'fromAnchor', node = elements.find(item => item.id === (from ? edge.from : edge.to))
      if (!node) continue
      const point = from ? endpoints.start : endpoints.end, other = from ? endpoints.end : endpoints.start
      const n = normal(node, point, other), key = `${node.id}:${n.x}:${n.y}`
      ports.set(key, [...(ports.get(key) || []), { edge, end, normal: n, other }])
    }
  }
  for (const group of ports.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => (a.normal.x ? a.other.y - b.other.y : a.other.x - b.other.x) || a.edge.id.localeCompare(b.edge.id))
    group.forEach((port, index) => {
      const position = .2 + .6 * (index + 1) / (group.length + 1)
      port.edge[port.end] = port.normal.x ? { x: port.normal.x > 0 ? 1 : 0, y: position } : { x: position, y: port.normal.y > 0 ? 1 : 0 }
    })
  }
  for (const edge of prepared.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))) {
    yield
    const route = resolveEdgeRoute(edge, elements, obstacles.filter(item => item.id !== edge.from && item.id !== edge.to), occupied)
    if (route) { routes.set(edge.id, route); occupied.push(route.routing === 'elbow' || route.points.length > 2 ? [route.start, ...route.points, route.end] : route.pathPoints) }
  }
  return routes
}

export function documentEdgeRoutes(elements:BoardElement[],edges:BoardEdge[]) {
 const steps=documentEdgeRouteSteps(elements,edges);while(true){const next=steps.next();if(next.done)return next.value}
}
export const documentEdgeRoutesAsync=(elements:BoardElement[],edges:BoardEdge[],signal?:AbortSignal)=>runCooperatively(documentEdgeRouteSteps(elements,edges),signal)
