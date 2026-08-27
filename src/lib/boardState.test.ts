import { describe, expect, it } from 'vitest'
import { applyBoardOperations, commit, redo, undo } from './boardState'
import { emptyDocument } from '../types'

const node = { id: 'a', kind: 'rectangle' as const, x: 0, y: 0, width: 100, height: 60, text: 'A', fill: '#fff', stroke: '#000', strokeWidth: 1, fontSize: 16 }

describe('board state operations', () => {
  it('applies element and edge operations atomically', () => {
    const result = applyBoardOperations(emptyDocument(), [
      { op: 'add_element', element: node },
      { op: 'add_element', element: { ...node, id: 'b', text: 'B' } },
      { op: 'add_edge', edge: { id: 'e', from: 'a', to: 'b', stroke: '#000', strokeWidth: 1, arrowEnd: true } },
      { op: 'patch_element', id: 'a', patch: { x: 42, text: 'Renamed' } },
    ])
    expect(result.elements[0]).toMatchObject({ x: 42, text: 'Renamed' })
    expect(result.edges).toHaveLength(1)
  })

  it('removes connected edges when deleting a node', () => {
    const seeded = applyBoardOperations(emptyDocument(), [
      { op: 'add_element', element: node },
      { op: 'add_element', element: { ...node, id: 'b' } },
      { op: 'add_edge', edge: { id: 'e', from: 'a', to: 'b', stroke: '#000', strokeWidth: 1 } },
    ])
    const result = applyBoardOperations(seeded, [{ op: 'delete_element', id: 'a' }])
    expect(result.edges).toHaveLength(0)
  })

  it('supports undo and redo', () => {
    const initial = { current: emptyDocument(), past: [], future: [] }
    const changed = commit(initial, [{ op: 'add_element', element: node }])
    expect(undo(changed).current.elements).toHaveLength(0)
    expect(redo(undo(changed)).current.elements).toHaveLength(1)
  })

  it('normalizes Agent-created visual style fields and preserves layer changes', () => {
    const result = applyBoardOperations(emptyDocument(), [
      { op: 'add_element', element: { ...node, kind: 'cloud', width: 0, height: 0, strokeStyle: 'dashed', fillOpacity: .4, zIndex: -2 } },
      { op: 'patch_element', id: 'a', patch: { zIndex: 12, opacity: .7 } },
    ])
    expect(result.version).toBe(3)
    expect(result.elements[0]).toMatchObject({ kind: 'cloud', width: 20, height: 20, strokeStyle: 'dashed', fillOpacity: .4, zIndex: 12, opacity: .7 })
  })

  it('renders double-escaped tool text as real lines and normalizes text styles', () => {
    const result = applyBoardOperations(emptyDocument(), [
      { op: 'add_element', element: { ...node, text: '第一行\\n第二行', fontWeight: 'bold', fontStyle: 'italic', textDecoration: 'underline', textAlign: 'left', verticalAlign: 'top' } },
      { op: 'patch_element', id: 'a', patch: { text: '更新<br>第三行' } },
    ])
    expect(result.elements[0]).toMatchObject({ text: '更新\n第三行', fontWeight: 'bold', fontStyle: 'italic', textDecoration: 'underline', textAlign: 'left', verticalAlign: 'top' })
  })

  it('supports semantic group, align, distribute and ungroup operations for Agent tools', () => {
    const seeded = applyBoardOperations(emptyDocument(), [
      { op: 'add_element', element: node },
      { op: 'add_element', element: { ...node, id: 'b', x: 200 } },
      { op: 'add_element', element: { ...node, id: 'c', x: 500 } },
    ])
    const grouped = applyBoardOperations(seeded, [{ op: 'group_elements', ids: ['a', 'b'], groupId: 'group_test' }, { op: 'align_elements', ids: ['a', 'b'], alignment: 'top' }, { op: 'distribute_elements', ids: ['a', 'b', 'c'], axis: 'horizontal' }])
    expect(grouped.elements.slice(0, 2).map(item => item.groupId)).toEqual(['group_test', 'group_test'])
    expect(applyBoardOperations(grouped, [{ op: 'ungroup_elements', ids: ['a', 'b'] }]).elements[0].groupId).toBeUndefined()
  })

  it('persists the selected palette on the project document', () => {
    const changed = applyBoardOperations(emptyDocument(), [{ op: 'set_palette', paletteId: 'vivid' }])
    expect(changed.paletteId).toBe('vivid')
  })

  it('sanitizes malformed edge control points on add and patch', () => {
    const seeded = applyBoardOperations(emptyDocument(), [
      { op: 'add_element', element: node },
      { op: 'add_element', element: { ...node, id: 'b' } },
      { op: 'add_edge', edge: { id: 'e', from: 'a', to: 'b', stroke: '#000', strokeWidth: 1, controlPoints: [{ x: 12, y: 24 }, { x: Number.NaN, y: 1 }] } },
      { op: 'patch_edge', id: 'e', patch: { controlPoints: [undefined, { x: Number.POSITIVE_INFINITY, y: 2 }] as never } },
    ])
    expect(seeded.edges[0].controlPoints).toBeUndefined()
  })

  it('persists valid user-selected edge attachments and clamps malformed ones', () => {
    const seeded = applyBoardOperations(emptyDocument(), [
      { op: 'add_element', element: node }, { op: 'add_element', element: { ...node, id: 'b', x: 300 } },
      { op: 'add_edge', edge: { id: 'e', from: 'a', to: 'b', stroke: '#000', strokeWidth: 1, fromAnchor: { x: 1, y: .25 }, toAnchor: { x: 3, y: -2 } } },
    ])
    expect(seeded.edges[0]).toMatchObject({ fromAnchor: { x: 1, y: .25 }, toAnchor: { x: 1, y: 0 } })
  })

  it('persists a loose multi-segment line without requiring shape endpoints', () => {
    const result = applyBoardOperations(emptyDocument(), [{ op: 'add_edge', edge: { id: 'loose', from: '', to: '', freeStart: { x: 20, y: 30 }, freeEnd: { x: 260, y: 170 }, controlPoints: [{ x: 110, y: 30 }, { x: 110, y: 120 }], routing: 'polyline', stroke: '#000', strokeWidth: 2 } }])
    expect(result.edges[0]).toMatchObject({ routing: 'polyline', freeStart: { x: 20, y: 30 }, freeEnd: { x: 260, y: 170 }, controlPoints: [{ x: 110, y: 30 }, { x: 110, y: 120 }] })
  })

  it('unlocks legacy Mermaid subgraph frames when loading saved boards', () => {
    const result = applyBoardOperations({
      ...emptyDocument(),
      elements: [{ ...node, id: 'subgraph', kind: 'frame', locked: true, metadata: { mermaidSubgraph: 'effects' } }],
    }, [])
    expect(result.elements[0].locked).toBe(false)
  })

  it('recovers malformed Agent documents without leaving dangling edges', () => {
    const result = applyBoardOperations({
      ...emptyDocument(),
      elements: [{ shape: 'rounded_rectangle', x: 10, y: 20, width: 100, height: 50, text: '完成', style: { fill: '#0f0' } } as never],
      edges: [{ source: 'missing-a', target: 'missing-b', style: { endArrow: 'arrow' } } as never],
    }, [])
    expect(result.elements[0]).toMatchObject({ id: 'recovered_element_0', kind: 'rounded_rectangle', fill: '#0f0' })
    expect(result.edges).toEqual([])
  })
})
