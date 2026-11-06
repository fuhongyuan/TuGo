import type { BoardDocument, BoardElement, BoardOperation } from '../types'
import { newId } from '../types'

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeMode = 'horizontal' | 'vertical'

export const selectedElements = (document: BoardDocument, ids: string[]) => document.elements.filter(item => ids.includes(item.id))

/** Test visual corners in the container's local coordinate system. */
export function containsElement(container: BoardElement, child: BoardElement) {
  const angle = -(container.rotation || 0) * Math.PI / 180
  const childAngle = (child.rotation || 0) * Math.PI / 180
  return [-1, 1].every(sx => [-1, 1].every(sy => {
    const dx = sx * child.width / 2, dy = sy * child.height / 2
    const x = child.x + child.width / 2 + dx * Math.cos(childAngle) - dy * Math.sin(childAngle) - container.x - container.width / 2
    const y = child.y + child.height / 2 + dx * Math.sin(childAngle) + dy * Math.cos(childAngle) - container.y - container.height / 2
    return Math.abs(x * Math.cos(angle) - y * Math.sin(angle)) <= container.width / 2 + .001 && Math.abs(x * Math.sin(angle) + y * Math.cos(angle)) <= container.height / 2 + .001
  }))
}

// Shared with rendering: selection must follow visible stacking, not stale zIndex.
export function elementLayers(elements: BoardElement[]) {
  const background = elements.filter(item => item.kind === 'frame' || Boolean(item.metadata?.container) || (item.kind !== 'text' && elements.some(other => other.id !== item.id && item.width * item.height > other.width * other.height && containsElement(item, other))))
    .sort((a, b) => b.width * b.height - a.width * a.height || (a.zIndex ?? 0) - (b.zIndex ?? 0))
  const ids = new Set(background.map(item => item.id))
  const foreground = elements.filter(item => !ids.has(item.id)).sort((a, b) => Number(a.kind === 'text') - Number(b.kind === 'text') || (a.zIndex ?? 0) - (b.zIndex ?? 0))
  return { background, foreground }
}

export function dragSelection(document: BoardDocument, ids: string[]) {
  const { background, foreground } = elementLayers(document.elements)
  const ordered = [...background, ...foreground]
  const selected = new Set(ids)
  // Resolve once at pointer-down; never scoop up new objects while moving.
  for (let index = 0; index < ordered.length; index++) {
    const parent = ordered[index]
    if (!selected.has(parent.id) || parent.locked || parent.kind === 'text') continue
    for (const child of ordered.slice(index + 1)) if (!child.locked && containsElement(parent, child)) selected.add(child.id)
  }
  for (const edge of document.edges) {
    const moves = (id: string) => selected.has(id) && document.elements.some(element => element.id === id && !element.locked)
    const anchorsMove = (!edge.from || moves(edge.from)) && (!edge.to || moves(edge.to))
    const freePoints = [!edge.from ? edge.freeStart : undefined, !edge.to ? edge.freeEnd : undefined, ...(edge.controlPoints || [])].filter(point => point !== undefined)
    if (!anchorsMove || (!edge.from && !edge.freeStart) || (!edge.to && !edge.freeEnd)) continue
    if (background.some(parent => selected.has(parent.id) && !parent.locked && freePoints.every(point => containsElement(parent, { ...parent, x: point.x, y: point.y, width: 0, height: 0, rotation: 0 })))) selected.add(edge.id)
  }
  return [...selected]
}

export function selectionForElement(document: BoardDocument, id: string, current: string[], additive = false) {
  const element = document.elements.find(item => item.id === id)
  let related = element?.groupId ? document.elements.filter(item => item.groupId === element.groupId).map(item => item.id) : [id]
  if (element?.kind === 'frame') {
    const descendants = new Set([id])
    for (let pass = 0; pass < document.elements.length; pass++) {
      const before = descendants.size
      for (const item of document.elements) if (item.groupId && descendants.has(item.groupId)) descendants.add(item.id)
      if (descendants.size === before) break
    }
    related = [...descendants]
  }
  if (!additive) return related
  const hasAll = related.every(item => current.includes(item))
  return hasAll ? current.filter(item => !related.includes(item)) : [...new Set([...current, ...related])]
}

export function alignOperations(document: BoardDocument, ids: string[], mode: AlignMode): BoardOperation[] {
  const items = selectedElements(document, ids).filter(item => !item.locked)
  if (items.length < 2) return []
  const left = Math.min(...items.map(item => item.x)); const right = Math.max(...items.map(item => item.x + item.width))
  const top = Math.min(...items.map(item => item.y)); const bottom = Math.max(...items.map(item => item.y + item.height))
  const center = (left + right) / 2; const middle = (top + bottom) / 2
  return items.map(item => ({ op: 'patch_element', id: item.id, patch: mode === 'left' ? { x: left } : mode === 'center' ? { x: center - item.width / 2 } : mode === 'right' ? { x: right - item.width } : mode === 'top' ? { y: top } : mode === 'middle' ? { y: middle - item.height / 2 } : { y: bottom - item.height } }))
}

export function distributeOperations(document: BoardDocument, ids: string[], mode: DistributeMode): BoardOperation[] {
  const items = selectedElements(document, ids).filter(item => !item.locked)
  if (items.length < 3) return []
  const sorted = [...items].sort((a, b) => mode === 'horizontal' ? a.x - b.x : a.y - b.y)
  if (mode === 'horizontal') {
    const start = sorted[0].x; const end = sorted.at(-1)!.x + sorted.at(-1)!.width
    const gap = (end - start - sorted.reduce((sum, item) => sum + item.width, 0)) / (sorted.length - 1)
    let cursor = start
    return sorted.map(item => { const operation: BoardOperation = { op: 'patch_element', id: item.id, patch: { x: cursor } }; cursor += item.width + gap; return operation })
  }
  const start = sorted[0].y; const end = sorted.at(-1)!.y + sorted.at(-1)!.height
  const gap = (end - start - sorted.reduce((sum, item) => sum + item.height, 0)) / (sorted.length - 1)
  let cursor = start
  return sorted.map(item => { const operation: BoardOperation = { op: 'patch_element', id: item.id, patch: { y: cursor } }; cursor += item.height + gap; return operation })
}

export function groupOperations(document: BoardDocument, ids: string[]) {
  const items = selectedElements(document, ids)
  if (items.length < 2) return []
  const groupId = newId('group')
  return items.map((item): BoardOperation => ({ op: 'patch_element', id: item.id, patch: { groupId } }))
}

export function ungroupOperations(document: BoardDocument, ids: string[]) {
  return selectedElements(document, ids).filter(item => item.groupId).map((item): BoardOperation => ({ op: 'patch_element', id: item.id, patch: { groupId: undefined } }))
}

export function duplicateOperations(document: BoardDocument, ids: string[], offset = 24) {
  const items = selectedElements(document, ids)
  const idMap = new Map(items.map(item => [item.id, newId('node')]))
  const groupMap = new Map<string, string>()
  const operations: BoardOperation[] = items.map((item): BoardOperation => {
    if (item.groupId && !groupMap.has(item.groupId)) groupMap.set(item.groupId, newId('group'))
    return { op: 'add_element', element: { ...structuredClone(item), id: idMap.get(item.id)!, x: item.x + offset, y: item.y + offset, groupId: item.groupId ? groupMap.get(item.groupId) : undefined, locked: false } }
  })
  document.edges.filter(edge => idMap.has(edge.from) && idMap.has(edge.to)).forEach(edge => operations.push({ op: 'add_edge', edge: { ...structuredClone(edge), id: newId('edge'), from: idMap.get(edge.from)!, to: idMap.get(edge.to)! } }))
  return { operations, ids: [...idMap.values()] }
}

export function layerOperations(document: BoardDocument, ids: string[], action: 'front' | 'forward' | 'backward' | 'back') {
  const items = selectedElements(document, ids); if (!items.length) return []
  const levels = document.elements.map(item => item.zIndex ?? 0); const min = Math.min(0, ...levels); const max = Math.max(0, ...levels)
  return items.map((item, index): BoardOperation => ({ op: 'patch_element', id: item.id, patch: { zIndex: action === 'front' ? max + 1 + index : action === 'back' ? min - items.length + index : (item.zIndex ?? 0) + (action === 'forward' ? 1 : -1) } }))
}

export function patchSelected(document: BoardDocument, ids: string[], patch: Partial<BoardElement>) {
  return selectedElements(document, ids).map((item): BoardOperation => ({ op: 'patch_element', id: item.id, patch }))
}
