export type SafeViewport = { x: number; y: number; zoom: number }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const validZoom = (value: unknown): value is number => finite(value) && value > 0

/** Reject missing/null/string/non-finite values before they reach SVG or world coordinates. */
export function normalizeViewport(value: unknown, previous?: SafeViewport): SafeViewport {
  const input = value && typeof value === 'object' ? value as Partial<SafeViewport> : {}
  const zoom = validZoom(input.zoom) ? input.zoom : validZoom(previous?.zoom) ? previous.zoom : 1
  return {
    x: finite(input.x) ? input.x : finite(previous?.x) ? previous.x : 0,
    y: finite(input.y) ? input.y : finite(previous?.y) ? previous.y : 0,
    zoom: Math.min(3, Math.max(.18, zoom)),
  }
}

export function zoomViewport(value: SafeViewport, factor: number, anchor: { x: number; y: number }): SafeViewport {
  const current = normalizeViewport(value)
  if (!validZoom(factor) || !finite(anchor.x) || !finite(anchor.y)) return current
  const product = current.zoom * factor
  const zoom = Math.min(3, Math.max(.18, product))
  return normalizeViewport({
    zoom,
    x: anchor.x - (anchor.x - current.x) / current.zoom * zoom,
    y: anchor.y - (anchor.y - current.y) / current.zoom * zoom,
  }, current)
}
