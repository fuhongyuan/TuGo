import { describe, expect, it } from 'vitest'
import { convertRouteControlPoints, defaultCurveControl, orthogonalControlPoints, placeEdgeLabel, remapControlPoints, sampledEdgePoints } from './canvasGeometry'

describe('canvas geometry', () => {
  it('routes an elbow around a blocking card', () => {
    const start = { x: 0, y: 50 }, end = { x: 300, y: 50 }, obstacle = { x: 120, y: 0, width: 60, height: 100 }
    const points = [start, ...orthogonalControlPoints(start, end, [obstacle]), end]
    expect(points.some(point => point.y < 0 || point.y > 100)).toBe(true)
  })

  it('samples a curve instead of treating it as a straight segment', () => {
    const points = sampledEdgePoints('curve', { x: 0, y: 0 }, { x: 100, y: 0 }, [{ x: 50, y: 100 }])
    expect(points).toHaveLength(17)
    expect(Math.max(...points.map(point => point.y))).toBeGreaterThan(40)
  })

  it('moves a label away from a card at the path midpoint', () => {
    const placement = placeEdgeLabel([{ x: 0, y: 0 }, { x: 200, y: 0 }], 'HTTPS', [{ x: 70, y: -12, width: 60, height: 24 }])
    expect(Math.abs(placement.y)).toBeGreaterThan(0)
  })

  it('uses a neighboring lane instead of overlapping an existing route', () => {
    const first = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 120 }]
    const controls = orthogonalControlPoints({ x: 0, y: 0 }, { x: 100, y: 120 }, [], 18, [first])
    expect([{ x: 0, y: 0 }, ...controls, { x: 100, y: 120 }]).not.toEqual(first)
  })

  it('translates manual handles exactly when both endpoints move together', () => {
    expect(remapControlPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 20, y: 30 }, { x: 120, y: 30 }, [{ x: 50, y: -40 }])).toEqual([{ x: 70, y: -10 }])
  })

  it('keeps a manual bend relative to a segment when only one endpoint moves', () => {
    const [point] = remapControlPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 }, [{ x: 50, y: -30 }])
    expect(point.x).toBeCloseTo(30)
    expect(point.y).toBeCloseTo(50)
  })

  it('converts a curve to a polyline without retaining a curve-only handle', () => {
    const start = { x: 0, y: 0 }, end = { x: 120, y: 0 }, control = defaultCurveControl(start, end)
    expect(convertRouteControlPoints('curve', 'polyline', start, end, [control])).toHaveLength(2)
    expect(convertRouteControlPoints('curve', 'straight', start, end, [control])).toEqual([])
  })
})
