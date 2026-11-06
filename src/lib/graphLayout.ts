import { Graph } from 'dagre-d3-es/src/graphlib/graph.js'
import { layout } from 'dagre-d3-es/src/dagre/layout.js'
import type { BoardEdge, BoardElement } from '../types'
import { edgeAnchor } from './edgeGeometry'

/** Layout editable objects together, including cross-cluster edges. No SVG/image fallback. */
export function layoutGraph(elements: BoardElement[], edges: BoardEdge[], direction = 'LR') {
  if (!elements.length) return { elements, edges }
  const graph = new Graph({ compound: true, multigraph: true })
  graph.setGraph({ rankdir: direction === 'TD' ? 'TB' : direction, ranksep: 96, nodesep: 56, edgesep: 28, marginx: 96, marginy: 96 })
  graph.setDefaultEdgeLabel(() => ({}))
  const ids = new Set(elements.map(element => element.id))
  for (const element of elements) graph.setNode(element.id, { width: element.width, height: element.height })
  for (const element of elements) if (element.groupId && ids.has(element.groupId)) graph.setParent(element.id, element.groupId)
  edges.forEach((edge, index) => {
    // Compound endpoints are not leaf nodes in Dagre. Keep unsupported edges editable.
    if (!ids.has(edge.from) || !ids.has(edge.to) || graph.children(edge.from)?.length || graph.children(edge.to)?.length) return
    const lines = (edge.label || '').split('\n')
    graph.setEdge(edge.from, edge.to, {
      width: edge.label ? Math.min(300, Math.max(...lines.map(line => Array.from(line).length)) * 14 + 20) : 0,
      height: edge.label ? lines.length * 22 + 12 : 0,
      labelpos: 'c',
    }, String(index))
  })
  layout(graph, {})
  const placed = elements.map(element => {
    const box = graph.node(element.id)
    return { ...element, x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height }
  })
  const byId = new Map(placed.map(element => [element.id, element]))
  const routed = edges.map((edge, index): BoardEdge => {
    const result = graph.edge(edge.from, edge.to, String(index))
    if (!result?.points?.length) return edge
    const points = result.points as Array<{ x: number; y: number }>
    const anchor = (id: string, point: { x: number; y: number }) => {
      const node = byId.get(id)!
      const boundary = edgeAnchor(node, point)
      return { x: Math.max(0, Math.min(1, (boundary.x - node.x) / node.width)), y: Math.max(0, Math.min(1, (boundary.y - node.y) / node.height)) }
    }
    const controls = points.slice(1, -1).filter((point, i) => {
      const before = points[i], after = points[i + 2]
      return Math.abs((point.x - before.x) * (after.y - point.y) - (point.y - before.y) * (after.x - point.x)) > .01
    })
    return { ...edge, routing: controls.length ? 'polyline' : 'straight', controlPoints: controls,
      fromAnchor: anchor(edge.from, points[0]), toAnchor: anchor(edge.to, points.at(-1)!) }
  })
  return { elements: placed, edges: routed }
}
