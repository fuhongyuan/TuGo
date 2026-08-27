import { describe, expect, it } from 'vitest'
import type { BoardElement } from '../types'
import { edgeAttachmentForPoint, edgeAttachmentPoint, resolvedEdgeAnchor } from './edgeGeometry'

const box: BoardElement = {
  id: 'box', kind: 'rectangle', x: 100, y: 200, width: 160, height: 80, text: '',
  fill: '#fff', stroke: '#000', strokeWidth: 2, fontSize: 16,
}

describe('edge attachment geometry', () => {
  it('snaps a dropped endpoint to the nearest arbitrary position on a box boundary', () => {
    expect(edgeAttachmentForPoint(box, { x: 247, y: 247 })).toEqual({ x: 1, y: .5875 })
    expect(edgeAttachmentForPoint(box, { x: 162, y: 206 })).toEqual({ x: .3875, y: 0 })
  })

  it('persists explicit attachment positions instead of recalculating a centre-facing anchor', () => {
    const attachment = { x: 1, y: .25 }
    expect(edgeAttachmentPoint(box, attachment)).toEqual({ x: 260, y: 220 })
    expect(resolvedEdgeAnchor(box, { x: -1000, y: 1000 }, attachment)).toEqual({ x: 260, y: 220 })
  })
})
