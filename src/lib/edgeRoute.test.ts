import { describe, it, expect } from 'vitest'
import type { BoardEdge, BoardElement } from '../types'
import { documentEdgeRoutes, resolveEdgeRoute, routePath } from './edgeRoute'
import { renderRegionSvg } from './exportDocument'

const node = (id: string, x: number, y: number): BoardElement => ({ id, x, y, width: 120, height: 60, kind: 'rectangle', text: id, fill: '#fff', stroke: '#000', strokeWidth: 1, fontSize: 14 })
const edge: BoardEdge = { id: 'ab', from: 'a', to: 'b', routing: 'elbow', stroke: '#000', strokeWidth: 2 }
describe('shared connector routing', () => {
  it('separates automatic ports without changing document data or explicit anchors', () => {
    const nodes = [node('a', 0, 100), node('b', 400, 0), node('c', 400, 200)]
    const edges = [edge, { ...edge, id: 'ac', to: 'c' }]
    const before = JSON.stringify(edges)
    const routes = documentEdgeRoutes(nodes, edges)
    expect(routes.get('ab')!.start.y).toBeLessThan(routes.get('ac')!.start.y)
    expect(JSON.stringify(edges)).toBe(before)
    const explicit = documentEdgeRoutes(nodes, [{ ...edge, fromAnchor: { x: 1, y: .2 } }, edges[1]])
    expect(explicit.get('ab')!.start).toEqual({ x: 120, y: 112 })
  })
  it('leaves and enters facing sides perpendicularly without crossing a blocker', () => {
    const nodes = [node('a', 0, 0), node('b', 420, 160), node('block', 210, 40)]
    const route = resolveEdgeRoute(edge, nodes)!
    expect(route.start).toEqual({ x: 120, y: 30 })
    expect(route.end).toEqual({ x: 420, y: 190 })
    expect(route.points[0].x).toBeGreaterThan(route.start.x)
    expect(route.points.at(-1)!.x).toBeLessThan(route.end.x)
    const vertices = [route.start, ...route.points, route.end]
    for (let i = 1; i < vertices.length; i++) expect(vertices[i].x === vertices[i - 1].x || vertices[i].y === vertices[i - 1].y).toBe(true)
    expect(routePath(route.routing, route.start, route.end, route.points)).toContain(' Q ')
    const points = route.pathPoints
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i]
      for (let t = 0; t <= 1; t += .02) {
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
        expect(x > 210 && x < 330 && y > 40 && y < 100).toBe(false)
      }
    }
  })
  it('keeps aligned automatic curves straight and gives diagonal curves normal tangents', () => {
    const curve = { ...edge, routing: 'curve' as const }
    const aligned = resolveEdgeRoute(curve, [node('a', 0, 0), node('b', 300, 0)])!
    expect(aligned.pathPoints.every(p => Math.abs(p.y - 30) < .00001)).toBe(true)
    const diagonal = resolveEdgeRoute(curve, [node('a', 0, 0), node('b', 300, 160)])!
    expect(diagonal.points[0].y).toBe(diagonal.start.y)
    expect(diagonal.points[1].y).toBe(diagonal.end.y)
  })
  it('routes automatic curves around an intervening card', () => {
    const nodes = [node('a', 0, 0), node('b', 500, 0), node('block', 250, 0)]
    const route = resolveEdgeRoute({ ...edge, routing: 'curve' }, nodes)!
    expect(route.points.length).toBeGreaterThan(2)
    expect(route.pathPoints.some(p => p.y < 0 || p.y > 60)).toBe(true)
    expect(route.pathPoints.some(p => p.x > 250 && p.x < 370 && p.y > 0 && p.y < 60)).toBe(false)
  })
  it('preserves every explicit waypoint and exports the same SVG route', () => {
    const elements = [node('a', 0, 0), node('b', 300, 160)]
    const manual = { ...edge, controlPoints: [{ x: 140, y: 30 }, { x: 140, y: 120 }, { x: 260, y: 120 }, { x: 260, y: 190 }] }
    const route = resolveEdgeRoute(manual, elements)!
    expect(route.points).toEqual(manual.controlPoints)
    const svg = renderRegionSvg({ version: 1, elements, edges: [manual], viewport: { x: 0, y: 0, zoom: 1 } }, { x: 0, y: 0, width: 600, height: 400 })
    expect(svg).toContain(`d="${routePath(route.routing, route.start, route.end, route.points)}"`)
  })
})
