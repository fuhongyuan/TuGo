import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BoardDocument } from '../types'
import { documentEdgeRoutes } from './edgeRoute'
import { layoutNodeText } from './textLayout'

const doc = JSON.parse(readFileSync('artifacts/seam-regression/fixture.json', 'utf8')) as BoardDocument
describe('46 seam visual regression', () => {
  it('preserves all names and fits the 46 editable capability cards', () => {
    const nodes = doc.elements.filter(n => /^[RMTDIEG]\d\d$/.test(n.id))
    expect(nodes).toHaveLength(46)
    for (const node of nodes) {
      const layout = layoutNodeText(node)
      expect(layout.lines.join('').replace(/\s/g, ''), node.id).toBe(node.text.replace(/\s/g, ''))
      expect(layout.overflow, node.id).toBe(false)
      expect(layout.fontSize).toBeGreaterThanOrEqual(8)
    }
  })
  it('routes every dependency without crossing unrelated cards, including narrow gutters', () => {
    const routes = documentEdgeRoutes(doc.elements, doc.edges)
    expect(routes.size).toBe(doc.edges.length)
    const nodes = doc.elements.filter(n => /^[RMTDIEG]\d\d$/.test(n.id))
    const collisions: string[] = []
    for (const edge of doc.edges) {
      const points = routes.get(edge.id)!.pathPoints
      for (const n of nodes.filter(n => n.id !== edge.from && n.id !== edge.to)) {
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/2))
          for (let t = 0; t <= steps; t++) {
            const x = a.x+(b.x-a.x)*t/steps, y = a.y+(b.y-a.y)*t/steps
            if (x > n.x+1 && x < n.x+n.width-1 && y > n.y+1 && y < n.y+n.height-1) collisions.push(`${edge.id} crosses ${n.id}`)
          }
        }
      }
    }
    expect([...new Set(collisions)]).toEqual([])
  })
})
