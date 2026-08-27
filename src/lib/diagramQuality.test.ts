import { describe, expect, it } from 'vitest'
import { applyBoardOperations } from './boardState'
import { optimizeDiagramLayout, reflectDiagram } from './diagramQuality'
import type { BoardDocument, BoardElement } from '../types'

const node = (id: string, x: number, y: number): BoardElement => ({ id, kind: 'rectangle', x, y, width: 120, height: 60, text: id, fill: '#fff', stroke: '#000', strokeWidth: 2, fontSize: 16 })
const base: BoardDocument = { version: 3, viewport: { x: 0, y: 0, zoom: 1 }, elements: [node('a', 0, 0), node('b', 220, 150), node('c', 0, 150), node('d', 220, 0)], edges: [{ id: 'one', from: 'a', to: 'b', stroke: '#000', strokeWidth: 2, routing: 'straight' }, { id: 'two', from: 'c', to: 'd', stroke: '#000', strokeWidth: 2, routing: 'straight' }] }

describe('diagram reflection and layout optimization', () => {
  it('skips reflection for unconnected sketch nodes', () => expect(reflectDiagram({ ...base, edges: [] })).toMatchObject({ checked: false, score: 100 }))
  it('reports crossing edges with an actionable layout recommendation', () => {
    const reflection = reflectDiagram(base)
    expect(reflection.issues.some(issue => issue.type === 'edge_crossing')).toBe(true)
    expect(reflection.recommendation).toContain('board_optimize_layout')
  })
  it('repositions a graph by hierarchy and switches its connections to elbow routing', () => {
    const optimized = applyBoardOperations(base, optimizeDiagramLayout(base))
    expect(optimized.edges.every(edge => edge.routing === 'elbow')).toBe(true)
    expect(optimized.elements.map(item => item.x)).not.toEqual(base.elements.map(item => item.x))
  })
  it('uses local repair by default at the tool boundary without globally moving cards', () => {
    const document: BoardDocument = { ...base, elements: [{ ...node('a', 0, 0), text: '一段很长很长很长很长很长的文字', height: 24 }, node('b', 220, 150)] }
    const optimized = applyBoardOperations(document, optimizeDiagramLayout(document, 'local'))
    expect(optimized.elements.find(item => item.id === 'a')?.height).toBeGreaterThan(24)
    expect(optimized.elements.find(item => item.id === 'b')?.x).toBe(220)
  })
  it('detects a connector crossing another card and lowers an enclosing container', () => {
    const document: BoardDocument = {
      ...base,
      elements: [
        { ...node('container', -20, -20), width: 520, height: 360, zIndex: 20 },
        node('a', 0, 0), node('b', 320, 0), node('blocker', 150, -20),
      ],
      edges: [{ id: 'edge', from: 'a', to: 'b', stroke: '#000', strokeWidth: 2, routing: 'straight' }],
    }
    const reflection = reflectDiagram(document)
    expect(reflection.issues.some(issue => issue.type === 'edge_over_node')).toBe(true)
    expect(reflection.issues.some(issue => issue.type === 'background_occlusion')).toBe(true)
    const optimized = applyBoardOperations(document, optimizeDiagramLayout(document))
    expect(optimized.elements.find(item => item.id === 'container')?.zIndex).toBeLessThan(0)
  })
  it('flags off-grid cards in one semantic layer and snaps them to one guide', () => {
    const document: BoardDocument = {
      ...base,
      elements: [node('start', 0, 0), node('left', 300, 20), node('right', 346, 180)],
      edges: [
        { id: 'left-edge', from: 'start', to: 'left', stroke: '#000', strokeWidth: 2 },
        { id: 'right-edge', from: 'start', to: 'right', stroke: '#000', strokeWidth: 2 },
      ],
    }
    expect(reflectDiagram(document).issues.some(issue => issue.type === 'misaligned')).toBe(true)
    const optimized = applyBoardOperations(document, optimizeDiagramLayout(document))
    const left = optimized.elements.find(item => item.id === 'left')!, right = optimized.elements.find(item => item.id === 'right')!
    expect(left.x).toBe(right.x)
    expect(left.y % 8).toBe(0)
    expect(right.y % 8).toBe(0)
  })
  it('returns a six-area audit with readable, actionable issues', () => {
    const document: BoardDocument = {
      ...base,
      elements: [
        { ...node('a', 0, 0), height: 30, text: '这是一个明显超过卡片宽度且会被裁切的长标题', fontSize: 10, fill: '#263145', textColor: '#334155' },
        node('b', 260, 0), node('c', 260, 160),
      ],
      edges: [{ id: 'edge', from: 'a', to: 'b', label: '关系', stroke: '#000', strokeWidth: 2 }],
    }
    const audit = reflectDiagram(document)
    expect(Object.keys(audit.dimensions)).toEqual(expect.arrayContaining(['structure', 'layout', 'connectors', 'hierarchy', 'readability', 'consistency']))
    const overflow = audit.issues.find(item => item.type === 'text_overflow')
    expect(overflow).toBeTruthy()
    expect(overflow?.suggestedPatch?.height).toBeGreaterThan(30)
    expect(audit.issues.some(item => item.type === 'small_text')).toBe(true)
    expect(audit.issues.some(item => item.type === 'low_contrast')).toBe(true)
    expect(audit.suggestions.length).toBeGreaterThan(0)
  })

  it('uses selected anchors and polyline control points instead of a center-line approximation', () => {
    const document: BoardDocument = {
      ...base,
      elements: [node('left', 0, 0), node('right', 400, 0), node('middle', 190, -10)],
      edges: [{ id: 'around', from: 'left', to: 'right', fromAnchor: { x: 0.5, y: 1 }, toAnchor: { x: 0.5, y: 1 }, routing: 'polyline', controlPoints: [{ x: 60, y: 160 }, { x: 460, y: 160 }], stroke: '#000', strokeWidth: 2 }],
    }
    const audit = reflectDiagram(document)
    expect(audit.issues.some(item => item.type === 'edge_over_node' && item.ids.includes('middle'))).toBe(false)
  })

  it('detects intersections along elbow segments', () => {
    const document: BoardDocument = {
      ...base,
      elements: [node('a', 0, 0), node('b', 300, 200), node('c', 0, 200), node('d', 300, 0)],
      edges: [
        { id: 'one', from: 'a', to: 'b', routing: 'elbow', controlPoints: [{ x: 180, y: 30 }, { x: 180, y: 230 }], stroke: '#000', strokeWidth: 2 },
        { id: 'two', from: 'c', to: 'd', routing: 'elbow', controlPoints: [{ x: 120, y: 230 }, { x: 120, y: 30 }], stroke: '#000', strokeWidth: 2 },
      ],
    }
    expect(reflectDiagram(document).issues.some(item => item.type === 'edge_crossing')).toBe(true)
  })

  it('samples curved connectors when checking whether they pass over a node', () => {
    const document: BoardDocument = {
      ...base,
      elements: [node('left', 0, 0), node('right', 400, 0), node('blocker', 190, 90)],
      edges: [{ id: 'curve', from: 'left', to: 'right', routing: 'curve', controlPoints: [{ x: 250, y: 240 }], stroke: '#000', strokeWidth: 2 }],
    }
    expect(reflectDiagram(document).issues.some(item => item.type === 'edge_over_node' && item.ids.includes('blocker'))).toBe(true)
  })
})
