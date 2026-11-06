import { describe, expect, it } from 'vitest'
import { alignOperations, distributeOperations, duplicateOperations, selectionForElement, dragSelection, containsElement } from './boardCommands'
import { applyBoardOperations } from './boardState'
import { emptyDocument, type BoardElement } from '../types'

const item = (id: string, x: number, y: number, width = 100, height = 60, groupId?: string): BoardElement => ({ id, kind: 'rectangle', x, y, width, height, text: id, fill: '#fff', stroke: '#000', strokeWidth: 1, fontSize: 16, groupId })
const board = () => ({ ...emptyDocument(), elements: [item('a', 10, 20, 100, 60, 'g'), item('b', 180, 90, 80, 40, 'g'), item('c', 400, 180)] })

describe('board arrangement commands', () => {
  it('carries contained upper layers, including nested content, but not larger backgrounds or crossing objects', () => {
    const document = { ...emptyDocument(), elements: [
      { ...item('outer', 0, 0, 600, 600), kind: 'frame' as const, zIndex: 100 },
      item('box', 100, 100, 300, 300), item('inner', 150, 150, 100, 100),
      { ...item('text', 160, 160, 20, 20), kind: 'text' as const },
      item('crossing', 390, 390, 100, 100), { ...item('locked', 200, 200, 20, 20), locked: true },
    ] }
    expect(dragSelection(document, ['box'])).toEqual(['box', 'inner', 'text'])
    expect(dragSelection(document, ['text'])).toEqual(['text'])
  })
  it('uses displayed order for coextensive text and excludes lower coextensive shapes', () => {
    const document = { ...emptyDocument(), elements: [item('below', 0, 0), { ...item('box', 0, 0), zIndex: 2 }, { ...item('text', 0, 0), kind: 'text' as const }] }
    expect(dragSelection(document, ['box'])).toEqual(['box', 'text'])
  })
  it('carries enclosed free lines but not crossing or externally attached lines', () => {
    const document = { ...emptyDocument(), elements: [{ ...item('box', 0, 0, 300, 300), kind: 'frame' as const }], edges: [
      { id: 'inside', from: '', to: '', freeStart: { x: 20, y: 20 }, freeEnd: { x: 80, y: 80 }, stroke: '#000', strokeWidth: 2 },
      { id: 'outside', from: '', to: '', freeStart: { x: 20, y: 20 }, freeEnd: { x: 500, y: 80 }, stroke: '#000', strokeWidth: 2 },
    ] }
    expect(dragSelection(document, ['box'])).toEqual(['box', 'inside'])
  })
  it('checks rotated visual bounds and requires full marquee enclosure', () => {
    expect(containsElement(item('box', 0, 0, 100, 100), { ...item('child', 0, 0, 100, 100), rotation: 45 })).toBe(false)
    expect(containsElement(item('marquee', 10, 10, 100, 100), item('background', 0, 0, 600, 600))).toBe(false)
  })
  it('moves a frame with its explicit nested members without selecting outside siblings', () => {
    const document = { ...board(), elements: [
      { ...item('frame', 0, 0), kind: 'frame' as const },
      { ...item('nested', 10, 10, 80, 80, 'frame'), kind: 'frame' as const },
      item('child', 20, 20, 30, 30, 'nested'), item('outside', 400, 400),
    ] }
    expect(selectionForElement(document, 'frame', [])).toEqual(['frame', 'nested', 'child'])
    expect(selectionForElement(document, 'nested', [])).toEqual(['nested', 'child'])
  })
  it('selects a whole group and supports additive selection', () => {
    expect(selectionForElement(board(), 'a', [], false)).toEqual(['a', 'b'])
    expect(selectionForElement(board(), 'c', ['a', 'b'], true)).toEqual(['a', 'b', 'c'])
  })

  it('aligns and distributes selected elements', () => {
    const aligned = applyBoardOperations(board(), alignOperations(board(), ['a', 'b', 'c'], 'left'))
    expect(aligned.elements.map(element => element.x)).toEqual([10, 10, 10])
    const distributed = applyBoardOperations(board(), distributeOperations(board(), ['a', 'b', 'c'], 'horizontal'))
    expect(distributed.elements[0].x).toBe(10)
    expect(distributed.elements[2].x).toBe(400)
    expect(distributed.elements[1].x).toBeGreaterThan(180)
  })

  it('duplicates selected nodes, their internal edges and group identity', () => {
    const source = { ...board(), edges: [{ id: 'e', from: 'a', to: 'b', stroke: '#000', strokeWidth: 2 }] }
    const duplicated = duplicateOperations(source, ['a', 'b'])
    const result = applyBoardOperations(source, duplicated.operations)
    expect(result.elements).toHaveLength(5)
    expect(result.edges).toHaveLength(2)
    const copies = result.elements.filter(element => duplicated.ids.includes(element.id))
    expect(copies[0].groupId).toBeTruthy()
    expect(copies[0].groupId).toBe(copies[1].groupId)
    expect(copies[0].groupId).not.toBe('g')
  })
})
