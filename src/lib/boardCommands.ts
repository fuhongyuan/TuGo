import type { BoardDocument, BoardElement, BoardOperation } from '../types'
import { newId } from '../types'

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeMode = 'horizontal' | 'vertical'

export const selectedElements = (document: BoardDocument, ids: string[]) => document.elements.filter(item => ids.includes(item.id))

export function selectionForElement(document: BoardDocument, id: string, current: string[], additive = false) {
  const element = document.elements.find(item => item.id === id)
  const related = element?.groupId ? document.elements.filter(item => item.groupId === element.groupId).map(item => item.id) : [id]
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
