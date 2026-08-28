import { describe, expect, it } from 'vitest'
import { contentBounds, fitViewportToContent, miniMapTransform, shouldShowMiniMap, visibleWorldBounds } from './miniMapGeometry'
import type { BoardElement } from '../types'

const node: BoardElement = { id: 'n', kind: 'rectangle', x: 100, y: 200, width: 300, height: 100, text: '', fill: '#fff', stroke: '#000', strokeWidth: 2, fontSize: 16 }

describe('mini map geometry', () => {
  it('keeps both distant content and the current blank viewport in the map', () => {
    const content = contentBounds([node], 0)!, visible = visibleWorldBounds({ x: -2000, y: 0, zoom: 1 }, { width: 800, height: 600 })
    const model = miniMapTransform(content, visible, { width: 180, height: 110 })
    expect(model.world.x).toBe(100)
    expect(model.world.x + model.world.width).toBe(2800)
  })

  it('round-trips map and world coordinates', () => {
    const model = miniMapTransform({ x: 0, y: 0, width: 1000, height: 500 }, { x: 200, y: 100, width: 400, height: 300 }, { width: 180, height: 110 })
    const restored = model.invert(model.point({ x: 420, y: 260 }))
    expect(restored.x).toBeCloseTo(420)
    expect(restored.y).toBeCloseTo(260)
  })

  it('fits content into the available screen with padding', () => {
    const viewport = fitViewportToContent({ x: 100, y: 200, width: 400, height: 200 }, { width: 1000, height: 700 })
    expect(viewport.zoom).toBeLessThanOrEqual(1.5)
    expect(viewport.x + 300 * viewport.zoom).toBeCloseTo(500)
    expect(viewport.y + 300 * viewport.zoom).toBeCloseTo(350)
  })

  it('only shows navigation after the viewport moves beyond the content edge', () => {
    const content = { x: 0, y: 0, width: 1000, height: 800 }
    expect(shouldShowMiniMap(content, { x: 100, y: 100, width: 600, height: 500 })).toBe(false)
    expect(shouldShowMiniMap(content, { x: 700, y: 100, width: 600, height: 500 })).toBe(true)
    expect(shouldShowMiniMap(content, { x: -300, y: 100, width: 600, height: 500 })).toBe(true)
  })
})
