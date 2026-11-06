import { describe, expect, it } from 'vitest'
import { CanvasClipboard } from './canvasClipboard'
import { emptyDocument, type BoardDocument } from '../types'
import { commit, undo } from './boardState'

const source = (): BoardDocument => ({ ...emptyDocument(), elements: [
  { id: 'frame', kind: 'frame', x: 0, y: 0, width: 500, height: 400, text: 'Group', fill: '#fff', stroke: '#000', strokeWidth: 1, fontSize: 16 },
  { id: 'a', groupId: 'frame', kind: 'rectangle', x: 30, y: 40, width: 100, height: 80, text: 'A', fill: '#abc', stroke: '#123', strokeWidth: 2, fontSize: 18 },
  { id: 'b', groupId: 'frame', kind: 'image', x: 240, y: 40, width: 100, height: 80, text: '', fill: '#fff', stroke: '#000', strokeWidth: 1, fontSize: 16, metadata: { attachmentId: 'image-asset' } },
], edges: [
  { id: 'link', from: 'a', to: 'b', label: 'Connect', stroke: '#abc', strokeWidth: 2, controlPoints: [{ x: 180, y: 150 }] },
  { id: 'free', from: '', to: '', freeStart: { x: 20, y: 200 }, freeEnd: { x: 300, y: 200 }, stroke: '#000', strokeWidth: 1 },
] })

describe('cross-board clipboard', () => {
  it('copies independently of source mutations, remaps nested groups/links and preserves image references', () => {
    const clipboard = new CanvasClipboard(), board = source()
    clipboard.copy(board, ['frame', 'a', 'b', 'free'])
    board.elements[1].text = 'Changed later'
    const pasted = clipboard.paste(emptyDocument())
    const history = commit({ current: emptyDocument(), past: [], future: [] }, pasted.operations)
    const [frame, a, b] = history.current.elements
    expect(a).toMatchObject({ text: 'A', x: 58, y: 68, fill: '#abc', groupId: frame.id })
    expect(b.groupId).toBe(frame.id)
    expect(b.metadata?.attachmentId).toBe('image-asset')
    expect(history.current.edges[0]).toMatchObject({ from: a.id, to: b.id, label: 'Connect', controlPoints: [{ x: 208, y: 178 }] })
    expect(history.current.edges[1].freeStart).toEqual({ x: 48, y: 228 })
    expect(undo(history).current.elements).toHaveLength(0)
    expect(clipboard.paste(emptyDocument()).ids.some(id => pasted.ids.includes(id))).toBe(false)
  })
  it('copies an edge alone as a free line rather than dangling source-board references', () => {
    const clipboard = new CanvasClipboard()
    clipboard.copy(source(), ['link'])
    expect(clipboard.hasContent).toBe(true)
    const [operation] = clipboard.paste(emptyDocument()).operations
    expect(operation.op).toBe('add_edge')
    if (operation.op !== 'add_edge') throw new Error('Expected edge')
    expect(operation.edge).toMatchObject({ from: '', to: '', label: 'Connect' })
    expect(operation.edge.freeStart).toBeDefined()
    expect(operation.edge.freeEnd).toBeDefined()
  })
  it('does not pull unrelated external edges into a node copy and keeps old clipboard on empty copy', () => {
    const clipboard = new CanvasClipboard()
    clipboard.copy(source(), ['a'])
    expect(clipboard.copy(source(), [])).toBe(false)
    expect(clipboard.paste(emptyDocument()).operations).toHaveLength(1)
  })
  it('places distant content in the destination viewport', () => {
    const clipboard = new CanvasClipboard()
    clipboard.copy(source(), ['a'])
    const [operation] = clipboard.paste(emptyDocument(), { x: 5000, y: 4000, width: 800, height: 600 }).operations
    if (operation.op !== 'add_element') throw new Error('Expected node')
    expect(operation.element.x + operation.element.width / 2).toBe(5400)
    expect(operation.element.y + operation.element.height / 2).toBe(4300)
  })
})
