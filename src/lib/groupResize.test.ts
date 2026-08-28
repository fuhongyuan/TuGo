import { describe, expect, it } from 'vitest'
import { applyBoardOperations } from './boardState'
import { boundsForElements, groupResizeOperations, resizedGroupBounds } from './groupResize'
import type { BoardDocument, BoardElement } from '../types'

const element = (id: string, x: number, y: number): BoardElement => ({ id, kind: 'rectangle', x, y, width: 100, height: 60, text: id, fill: '#fff', stroke: '#000', strokeWidth: 2, fontSize: 16 })

describe('group resize', () => {
  it('uniformly scales a multi-element selection from a corner', () => {
    const bounds = { x: 0, y: 0, width: 300, height: 160 }
    expect(resizedGroupBounds(bounds, 'se', 300, 160)).toEqual({ x: 0, y: 0, width: 600, height: 320 })
  })

  it('scales positions, sizes, text and internal manual control points atomically', () => {
    const a = element('a', 0, 0), b = element('b', 200, 100)
    const document: BoardDocument = { version: 3, viewport: { x: 0, y: 0, zoom: 1 }, elements: [a, b], edges: [{ id: 'e', from: 'a', to: 'b', stroke: '#000', strokeWidth: 2, routing: 'curve', controlPoints: [{ x: 150, y: 20 }] }] }
    const from = boundsForElements(document.elements)!
    const result = applyBoardOperations(document, groupResizeOperations(document, ['a', 'b'], from, { ...from, width: from.width * 2, height: from.height * 2 }))
    expect(result.elements[1]).toMatchObject({ x: 400, y: 200, width: 200, height: 120, fontSize: 32 })
    expect(result.edges[0].controlPoints).toEqual([{ x: 300, y: 40 }])
  })

  it('keeps the outside end fixed for a connector crossing the selection boundary', () => {
    const a = element('a', 0, 0), b = element('b', 300, 0)
    const document: BoardDocument = { version: 3, viewport: { x: 0, y: 0, zoom: 1 }, elements: [a, b], edges: [{ id: 'e', from: 'a', to: 'b', stroke: '#000', strokeWidth: 2, routing: 'curve', controlPoints: [{ x: 200, y: -40 }] }] }
    const operations = groupResizeOperations(document, ['a'], { x: 0, y: 0, width: 100, height: 60 }, { x: 0, y: 0, width: 200, height: 120 })
    const result = applyBoardOperations(document, operations)
    expect(result.elements[1]).toMatchObject({ id: 'b', x: 300, y: 0, width: 100, height: 60 })
    expect(result.edges[0].controlPoints?.[0].x).toBeGreaterThan(200)
  })
})
