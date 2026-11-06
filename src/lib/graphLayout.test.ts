import { describe, expect, it } from 'vitest'
import { parseMermaid, toMermaid } from './dsl'

describe('Mermaid graph layout', () => {
  it('attaches branches to the visible diamond rather than its bounding rectangle', () => {
    const board = parseMermaid('flowchart LR\nA{Decision} --> B\nA --> C')
    for (const edge of board.edges) {
      const anchor = edge.fromAnchor!
      expect(Math.abs(anchor.x - .5) * 2 + Math.abs(anchor.y - .5) * 2).toBeCloseTo(1)
    }
  })
  it.each(['TB', 'TD', 'BT', 'LR', 'RL'])('honors %s including reverse directions', direction => {
    const { elements } = parseMermaid(`flowchart ${direction}\nA --> B --> C`)
    const [a, b, c] = elements
    const axis = ['LR', 'RL'].includes(direction) ? 'x' : 'y'
    const sign = ['BT', 'RL'].includes(direction) ? -1 : 1
    expect((b[axis] - a[axis]) * sign).toBeGreaterThan(0)
    expect((c[axis] - b[axis]) * sign).toBeGreaterThan(0)
  })

  it('reorders parallel branches to remove declaration-order crossings', () => {
    const { elements } = parseMermaid('flowchart LR\nA\nB\nC\nD\nA --> D\nB --> C')
    const node = (id: string) => elements.find(element => element.id === id)!
    expect((node('A').y - node('B').y) * (node('D').y - node('C').y)).toBeGreaterThan(0)
  })

  it('keeps nested clusters contained and follows cross-cluster flow', () => {
    const { elements } = parseMermaid('flowchart LR\nsubgraph outer[Outer]\nsubgraph inner[Inner]\ndirection TB\nA --> B\nend\nend\nsubgraph output[Output]\nC\nend\nB --> C')
    expect(elements.some(element => element.text === 'direction')).toBe(false)
    for (const node of elements.filter(element => element.groupId)) {
      const parent = elements.find(element => element.id === node.groupId)!
      expect(node.x).toBeGreaterThanOrEqual(parent.x)
      expect(node.y).toBeGreaterThanOrEqual(parent.y)
      expect(node.x + node.width).toBeLessThanOrEqual(parent.x + parent.width)
      expect(node.y + node.height).toBeLessThanOrEqual(parent.y + parent.height)
    }
    expect(elements.find(element => element.id === 'C')!.x).toBeGreaterThan(elements.find(element => element.id === 'B')!.x)
  })

  it('routes cycles, self loops and long edges with finite editable bend points', () => {
    const board = parseMermaid('flowchart LR\nA --> B --> C\nC --> A\nB --> B\nA --> C\nX')
    expect(new Set(board.elements.map(element => `${element.x},${element.y}`)).size).toBe(4)
    expect(board.edges.find(edge => edge.from === 'B' && edge.to === 'B')!.controlPoints!.length).toBeGreaterThan(1)
    expect(board.edges.some(edge => edge.routing === 'polyline')).toBe(true)
    for (const edge of board.edges) for (const point of edge.controlPoints || []) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
    }
    const restored = parseMermaid(toMermaid(board))
    expect(restored.elements.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual(board.elements.map(({ x, y, width, height }) => ({ x, y, width, height })))
    expect(restored.edges.map(edge => edge.controlPoints)).toEqual(board.edges.map(edge => edge.controlPoints))
  })
})
