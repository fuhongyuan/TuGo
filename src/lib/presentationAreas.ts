import type { PresentationArea } from '../types'

/** Saved slides only. Diagram groups and frames never become slides implicitly. */
export function normalizePresentationAreas(value: unknown): PresentationArea[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.filter((area): area is PresentationArea => {
    if (!area || typeof area.id !== 'string' || !area.id || ids.has(area.id) || typeof area.name !== 'string') return false
    const b = area.bounds
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return false
    ids.add(area.id)
    return true
  })
}
