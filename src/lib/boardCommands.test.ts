import { describe, expect, it } from 'vitest'
import { alignOperations, distributeOperations, duplicateOperations, selectionForElement } from './boardCommands'
import { applyBoardOperations } from './boardState'
import { emptyDocument, type BoardElement } from '../types'

const item = (id: string, x: number, y: number, width = 100, height = 60, groupId?: string): BoardElement => ({ id, kind: 'rectangle', x, y, width, height, text: id, fill: '#fff', stroke: '#000', strokeWidth: 1, fontSize: 16, groupId })
const board = () => ({ ...emptyDocument(), elements: [item('a', 10, 20, 100, 60, 'g'), item('b', 180, 90, 80, 40, 'g'), item('c', 400, 180)] })

describe('board arrangement commands', () => {
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
