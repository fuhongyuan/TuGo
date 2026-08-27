import type { BoardElement } from '../types'

export type ViewportState = { x: number; y: number; zoom: number }
export type MiniRect = { x: number; y: number; width: number; height: number }
export type ScreenSize = { width: number; height: number }

export function contentBounds(elements: BoardElement[], padding = 40): MiniRect | null {
  if (!elements.length) return null
  const left = Math.min(...elements.map(item => item.x)), top = Math.min(...elements.map(item => item.y))
  const right = Math.max(...elements.map(item => item.x + item.width)), bottom = Math.max(...elements.map(item => item.y + item.height))
  return { x: left - padding, y: top - padding, width: Math.max(1, right - left + padding * 2), height: Math.max(1, bottom - top + padding * 2) }
}

export const visibleWorldBounds = (viewport: ViewportState, screen: ScreenSize): MiniRect => ({ x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, width: screen.width / viewport.zoom, height: screen.height / viewport.zoom })

/** Keep navigation out of the way until the viewport reaches blank space beyond the board. */
export function shouldShowMiniMap(content: MiniRect, visible: MiniRect, edgeRatio = .08): boolean {
  const insetX = Math.min(content.width * edgeRatio, visible.width * edgeRatio)
  const insetY = Math.min(content.height * edgeRatio, visible.height * edgeRatio)
  return visible.x < content.x - insetX
    || visible.y < content.y - insetY
    || visible.x + visible.width > content.x + content.width + insetX
    || visible.y + visible.height > content.y + content.height + insetY
}

const union = (a: MiniRect, b: MiniRect): MiniRect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

export function miniMapTransform(content: MiniRect, visible: MiniRect, size: ScreenSize, padding = 8) {
  const world = union(content, visible)
  const scale = Math.min((size.width - padding * 2) / Math.max(1, world.width), (size.height - padding * 2) / Math.max(1, world.height))
  const offsetX = padding + (size.width - padding * 2 - world.width * scale) / 2
  const offsetY = padding + (size.height - padding * 2 - world.height * scale) / 2
  const point = (value: { x: number; y: number }) => ({ x: offsetX + (value.x - world.x) * scale, y: offsetY + (value.y - world.y) * scale })
  const rect = (value: MiniRect): MiniRect => { const origin = point(value); return { ...origin, width: value.width * scale, height: value.height * scale } }
  const invert = (value: { x: number; y: number }) => ({ x: world.x + (value.x - offsetX) / scale, y: world.y + (value.y - offsetY) / scale })
  return { world, scale, point, rect, invert }
}

export function fitViewportToContent(content: MiniRect, screen: ScreenSize, padding = 72): ViewportState {
  const zoom = Math.min(1.5, Math.max(.18, Math.min((screen.width - padding * 2) / content.width, (screen.height - padding * 2) / content.height)))
  return { zoom, x: screen.width / 2 - (content.x + content.width / 2) * zoom, y: screen.height / 2 - (content.y + content.height / 2) * zoom }
}
