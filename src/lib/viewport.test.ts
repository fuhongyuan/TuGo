import { describe, expect, it } from 'vitest'
import { normalizeViewport, zoomViewport } from './viewport'
import { normalizeDocument } from './boardState'
import { emptyDocument } from '../types'

describe('viewport recovery', () => {
  it('repairs damaged saved views including NaN serialized to null', () => {
    for (const zoom of [NaN, Infinity, -Infinity, 0, -1, null, undefined, 'bad']) {
      const document = JSON.parse(JSON.stringify({ ...emptyDocument(), viewport: { x: null, y: null, zoom } }))
      expect(normalizeDocument(document).viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    }
    expect(normalizeViewport(undefined)).toEqual({ x: 0, y: 0, zoom: 1 })
  })
  it('keeps the last usable view when an update contains invalid numbers', () => {
    expect(normalizeViewport({ x: NaN, y: Infinity, zoom: NaN }, { x: 80, y: -30, zoom: .8 }))
      .toEqual({ x: 80, y: -30, zoom: .8 })
  })
  it('ignores malformed zoom input and preserves the anchor on valid zooms', () => {
    const view = { x: 20, y: 40, zoom: .5 }, anchor = { x: 220, y: 140 }
    for (const factor of [NaN, Infinity, 0, -1]) expect(zoomViewport(view, factor, anchor)).toEqual(view)
    expect(zoomViewport(view, 2, { x: NaN, y: 0 })).toEqual(view)
    const next = zoomViewport(view, 2, anchor)
    expect((anchor.x - next.x) / next.zoom).toBe((anchor.x - view.x) / view.zoom)
    expect((anchor.y - next.y) / next.zoom).toBe((anchor.y - view.y) / view.zoom)
    expect(zoomViewport({ x: NaN, y: NaN, zoom: NaN }, 1.16, anchor).zoom).toBe(1.16)
  })
})
