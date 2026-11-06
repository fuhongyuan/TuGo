import { describe, expect, it } from 'vitest'
import { normalizePresentationAreas } from './presentationAreas'
import { commit, normalizeDocument, redo, undo } from './boardState'
import { emptyDocument } from '../types'

const slide = { id: 's1', name: 'Slide 1', bounds: { x: -50, y: 30, width: 600, height: 400 } }
describe('manual presentation areas', () => {
  it('preserves user-defined order and rejects invalid geometry and duplicate IDs', () => {
    const second = { ...slide, id: 's2', bounds: { ...slide.bounds, x: -1000 } }
    expect(normalizePresentationAreas([slide, null, { ...slide, id: 'bad', bounds: { ...slide.bounds, width: NaN } }, slide, second])).toEqual([slide, second])
    expect(normalizePresentationAreas(undefined)).toEqual([])
  })
  it('does not infer slides from legacy board content', () => {
    expect(normalizeDocument(emptyDocument()).presentationAreas).toBeUndefined()
  })
  it('persists through serialization, edits, deletes, undo and redo without modifying board content', () => {
    const original = emptyDocument()
    let history = commit({ current: original, past: [], future: [] }, [{ op: 'replace_document', document: { ...original, presentationAreas: [slide] } }])
    expect(normalizeDocument(JSON.parse(JSON.stringify(history.current))).presentationAreas).toEqual([slide])
    history = commit(history, [{ op: 'replace_document', document: { ...history.current, presentationAreas: [{ ...slide, name: 'Renamed', bounds: { ...slide.bounds, x: 200 } }] } }])
    expect(undo(history).current.presentationAreas).toEqual([slide])
    history = commit(history, [{ op: 'replace_document', document: { ...history.current, presentationAreas: [] } }])
    expect(undo(history).current.presentationAreas?.[0].name).toBe('Renamed')
    expect(redo(undo(history)).current.presentationAreas).toEqual([])
    expect(history.current.elements).toEqual(original.elements)
  })
})
