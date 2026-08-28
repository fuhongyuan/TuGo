import type { BoardDocument, BoardEdge, BoardElement, DslKind } from '../types'
import { emptyDocument, newId } from '../types'

const palette = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#cffafe']
// Mermaid labels commonly contain quoted text, HTML line breaks and entities.
// Keep the text content for our native canvas rather than displaying Mermaid's
// markup literally (for example, `<br/>` must become a real line break).
const clean = (value: string) => value.trim()
  .replace(/^['"]|['"]$/g, '')
  .replace(/<br\s*\/?\s*>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .trim()
const makeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_') || `node_${Math.random().toString(36).slice(2)}`
const styleDirective = /^%%\s*tugo:(node|edge)\s+(\S+)\s+(.+)$/
const safeJson = (value: string) => { try { return JSON.parse(value) as Record<string, unknown> } catch { return null } }
const mxStyle = (value: string | null) => Object.fromEntries(String(value || '').split(';').filter(Boolean).map(part => { const [key, raw = '1'] = part.split('='); return [key, raw] }))
const nodeStyle = (element: BoardElement) => ({
  kind: element.kind, x: element.x, y: element.y, width: element.width, height: element.height,
  fill: element.fill, stroke: element.stroke, strokeWidth: element.strokeWidth, strokeStyle: element.strokeStyle || 'solid',
  fillOpacity: element.fillOpacity ?? 1, opacity: element.opacity ?? 1, textColor: element.textColor || '#263145',
  fontSize: element.fontSize, fontFamily: element.fontFamily || 'Inter', fontWeight: element.fontWeight || 'normal', fontStyle: element.fontStyle || 'normal',
  textDecoration: element.textDecoration || 'none', textAlign: element.textAlign || 'center', verticalAlign: element.verticalAlign || 'middle',
  rotation: element.rotation || 0, borderRadius: element.borderRadius, zIndex: element.zIndex ?? 0, groupId: element.groupId, locked: element.locked ?? false,
})
const edgeStyle = (edge: BoardEdge) => ({
  id: edge.id, stroke: edge.stroke, strokeWidth: edge.strokeWidth, strokeStyle: edge.strokeStyle || (edge.dashed ? 'dashed' : 'solid'),
  startArrow: edge.startArrow || (edge.arrowStart ? 'arrow' : 'none'), endArrow: edge.endArrow || (edge.arrowEnd ? 'arrow' : 'none'),
  routing: edge.routing || 'curve', opacity: edge.opacity ?? 1, zIndex: edge.zIndex ?? 0,
  controlPoints: edge.controlPoints, fromAnchor: edge.fromAnchor, toAnchor: edge.toAnchor,
})

function layoutNodes(nodes: Map<string, { label: string; kind: BoardElement['kind'] }>) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.size)))
  return [...nodes.entries()].map(([id, node], index): BoardElement => ({
    id: makeId(id),
    kind: node.kind,
    x: 120 + (index % columns) * 260,
    y: 100 + Math.floor(index / columns) * 170,
    width: node.kind === 'text' ? 180 : 190,
    height: node.kind === 'text' ? 48 : 92,
    text: node.label || id,
    fill: palette[index % palette.length],
    stroke: '#334155',
    strokeWidth: 2,
    fontSize: 16,
    metadata: { dslId: id },
  }))
}

type MermaidNode = { label: string; kind: BoardElement['kind']; groupId?: string }
type MermaidGroup = { id: string; label: string; members: string[] }

const mermaidNodeSize = (node: MermaidNode) => {
  const width = node.kind === 'text' ? 210 : 230
  // Imported Mermaid labels can contain both explicit <br/> breaks and long
  // CJK prose. Estimate the native canvas wrapping so text never vanishes
  // below a fixed 92px card.
  const visualLines = node.label.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / 17)), 0)
  return { width, height: Math.max(node.kind === 'text' ? 48 : 92, 32 + visualLines * 23) }
}

function layoutDirectionalMermaid(nodes: Map<string, MermaidNode>, edges: Array<{ from: string; to: string }>, direction: string): BoardElement[] {
  const ids = [...nodes.keys()]
  const incoming = new Map(ids.map(id => [id, 0]))
  const outgoing = new Map(ids.map(id => [id, [] as string[]]))
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
    outgoing.get(edge.from)!.push(edge.to)
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
  }
  const ranks = new Map(ids.map(id => [id, 0]))
  const queue = ids.filter(id => !incoming.get(id))
  const visited = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const next of outgoing.get(id) || []) {
      ranks.set(next, Math.max(ranks.get(next) || 0, (ranks.get(id) || 0) + 1))
      const nextIncoming = (incoming.get(next) || 0) - 1
      incoming.set(next, nextIncoming)
      if (nextIncoming === 0) queue.push(next)
    }
  }
  // Cycles do not have a topological root. Retain source order for the
  // remaining vertices rather than failing the whole import.
  for (const id of ids) if (!visited.has(id)) ranks.set(id, ranks.get(id) || 0)
  const lanes = new Map<number, string[]>()
  for (const id of ids) {
    const rank = ranks.get(id) || 0
    if (!lanes.has(rank)) lanes.set(rank, [])
    lanes.get(rank)!.push(id)
  }
  const horizontal = /^(LR|RL)$/i.test(direction)
  const rankOrder = [...lanes.keys()].sort((a, b) => a - b)
  const primaryOffset = new Map<number, number>()
  let cursor = 110
  for (const rank of rankOrder) {
    const members = lanes.get(rank) || []
    const extent = Math.max(...members.map(id => {
      const size = mermaidNodeSize(nodes.get(id)!)
      return horizontal ? size.width : size.height
    }))
    primaryOffset.set(rank, cursor)
    cursor += extent + 88
  }
  return ids.map((id, index) => {
    const node = nodes.get(id)!
    const size = mermaidNodeSize(node)
    const rank = ranks.get(id) || 0
    const members = lanes.get(rank) || []
    const laneIndex = members.indexOf(id)
    let crossOffset = 100
    for (const prior of members.slice(0, laneIndex)) {
      const priorSize = mermaidNodeSize(nodes.get(prior)!)
      crossOffset += (horizontal ? priorSize.height : priorSize.width) + 64
    }
    return {
      id: makeId(id), kind: node.kind,
      x: horizontal ? primaryOffset.get(rank)! : crossOffset,
      y: horizontal ? crossOffset : primaryOffset.get(rank)!,
      width: size.width, height: size.height, text: node.label || id,
      fill: palette[index % palette.length], stroke: '#334155', strokeWidth: 2, fontSize: 16,
      metadata: { dslId: id },
    } as BoardElement
  })
}

/**
 * Mermaid flowcharts are directional graphs, not a set of unrelated cards.
 * Keep subgraph membership and arrange each subgraph as a directional lane;
 * this also gives imported diagrams the familiar Mermaid "container" look.
 */
function layoutMermaid(nodes: Map<string, MermaidNode>, edges: Array<{ from: string; to: string }>, groups: MermaidGroup[], direction: string): BoardElement[] {
  if (!groups.length) return layoutDirectionalMermaid(nodes, edges, direction)
  // A LR chart whose subgraphs are explicitly named as lanes is a swimlane
  // diagram, not a set of unrelated nested flowcharts. Keep lanes side by
  // side and stack their activities vertically. This makes cross-lane arrows
  // read in the same direction as the business flow.
  if (/^(LR|RL)$/i.test(direction) && groups.length > 1 && groups.every(group => /泳道|lane/i.test(group.label))) {
    return layoutSwimlaneMermaid(nodes, groups, direction)
  }
  const horizontal = /^(LR|RL)$/i.test(direction)
  const nodePositions = new Map<string, { x: number; y: number }>()
  const elements: BoardElement[] = []
  const ungrouped = [...nodes.keys()].filter(id => !nodes.get(id)?.groupId)
  const lanes = [...groups, ...(ungrouped.length ? [{ id: '__ungrouped__', label: '', members: ungrouped }] : [])]
  let groupTop = 96

  // Lay a single subgraph out as a tiny DAG.  The old implementation used
  // one coordinate as both the group offset and child X position for TB
  // diagrams, so later groups escaped their own frames.
  const layoutGroup = (members: string[]) => {
    const memberSet = new Set(members)
    const incoming = new Map(members.map(id => [id, 0]))
    const outgoing = new Map(members.map(id => [id, [] as string[]]))
    for (const edge of edges) {
      if (!memberSet.has(edge.from) || !memberSet.has(edge.to)) continue
      outgoing.get(edge.from)!.push(edge.to)
      incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
    }
    const ranks = new Map(members.map(id => [id, 0]))
    const queue = members.filter(id => !incoming.get(id))
    const ordered: string[] = []
    while (queue.length) {
      const id = queue.shift()!
      ordered.push(id)
      for (const next of outgoing.get(id) || []) {
        ranks.set(next, Math.max(ranks.get(next) || 0, (ranks.get(id) || 0) + 1))
        const count = (incoming.get(next) || 0) - 1
        incoming.set(next, count)
        if (count === 0) queue.push(next)
      }
    }
    for (const id of members) if (!ordered.includes(id)) ordered.push(id)
    const rankMembers = new Map<number, string[]>()
    for (const id of ordered) {
      const rank = ranks.get(id) || 0
      if (!rankMembers.has(rank)) rankMembers.set(rank, [])
      rankMembers.get(rank)!.push(id)
    }
    const ranksInOrder = [...rankMembers.keys()].sort((a, b) => a - b)
    const primaryOffsets = new Map<number, number>()
    let primaryCursor = 0
    for (const rank of ranksInOrder) {
      const extent = Math.max(...(rankMembers.get(rank) || []).map(id => {
        const size = mermaidNodeSize(nodes.get(id)!)
        return horizontal ? size.width : size.height
      }))
      primaryOffsets.set(rank, primaryCursor)
      primaryCursor += extent + 84
    }
    const positions = new Map<string, { x: number; y: number }>()
    let maxCross = 0
    for (const rank of ranksInOrder) {
      let crossCursor = 0
      for (const id of rankMembers.get(rank) || []) {
        const size = mermaidNodeSize(nodes.get(id)!)
        positions.set(id, horizontal
          ? { x: primaryOffsets.get(rank)!, y: crossCursor }
          : { x: crossCursor, y: primaryOffsets.get(rank)! })
        crossCursor += (horizontal ? size.height : size.width) + 58
      }
      maxCross = Math.max(maxCross, Math.max(0, crossCursor - 58))
    }
    return {
      positions,
      width: horizontal ? Math.max(0, primaryCursor - 84) : maxCross,
      height: horizontal ? maxCross : Math.max(0, primaryCursor - 84),
    }
  }

  for (const lane of lanes) {
    const hasFrame = lane.id !== '__ungrouped__'
    const layout = layoutGroup(lane.members)
    const paddingX = hasFrame ? 48 : 0
    const paddingTop = hasFrame ? 54 : 0
    const paddingBottom = hasFrame ? 38 : 0
    const groupLeft = 110
    for (const [id, position] of layout.positions) nodePositions.set(id, { x: groupLeft + paddingX + position.x, y: groupTop + paddingTop + position.y })
    const groupWidth = Math.max(230, layout.width + paddingX * 2)
    const groupHeight = Math.max(120, layout.height + paddingTop + paddingBottom)
    if (hasFrame && lane.members.length) {
      // A Mermaid subgraph is an ordinary canvas frame, not a protected
      // background. Users need to be able to select, move, resize, and delete
      // it just like any hand-created frame.
      elements.push({ id: makeId(`group_${lane.id}`), kind: 'frame', x: groupLeft, y: groupTop, width: groupWidth, height: groupHeight, text: lane.label, fill: '#f8fafc', fillOpacity: .58, stroke: '#94a3b8', strokeWidth: 2, strokeStyle: 'dashed', textColor: '#475569', fontSize: 15, fontWeight: 'bold', verticalAlign: 'top', textAlign: 'left', locked: false, zIndex: 0, metadata: { mermaidSubgraph: lane.id } })
    }
    groupTop += groupHeight + 92
  }

  for (const [index, [id, node]] of [...nodes.entries()].entries()) {
    const size = mermaidNodeSize(node)
    const position = nodePositions.get(id) || { x: 120 + index * (size.width + 66), y: 110 }
    elements.push({ id: makeId(id), kind: node.kind, x: position.x, y: position.y, width: size.width, height: size.height, text: node.label || id, fill: palette[index % palette.length], stroke: '#334155', strokeWidth: 2, fontSize: 16, groupId: node.groupId ? makeId(`group_${node.groupId}`) : undefined, zIndex: 1 + index, metadata: { dslId: id } })
  }
  return elements
}

function layoutSwimlaneMermaid(nodes: Map<string, MermaidNode>, groups: MermaidGroup[], direction: string): BoardElement[] {
  const reversed = /^RL$/i.test(direction)
  const laneWidth = 286
  const laneGap = 58
  const lanePadding = 28
  const titleHeight = 52
  const itemGap = 26
  const heights = groups.map(group => Math.max(310, titleHeight + lanePadding * 2 + group.members.reduce((sum, id) => sum + mermaidNodeSize(nodes.get(id)!).height, 0) + Math.max(0, group.members.length - 1) * itemGap))
  const laneHeight = Math.max(...heights)
  const ordered = reversed ? [...groups].reverse() : groups
  const elements: BoardElement[] = []
  ordered.forEach((group, laneIndex) => {
    const frameId = makeId(`group_${group.id}`)
    const x = 100 + laneIndex * (laneWidth + laneGap)
    elements.push({ id: frameId, kind: 'frame', x, y: 90, width: laneWidth, height: laneHeight, text: group.label, fill: '#f8fafc', fillOpacity: .72, stroke: '#94a3b8', strokeWidth: 2, strokeStyle: 'dashed', textColor: '#475569', fontSize: 15, fontWeight: 'bold', verticalAlign: 'top', textAlign: 'left', zIndex: 0, metadata: { mermaidSubgraph: group.id, mermaidSwimlane: true } })
    let y = 90 + titleHeight + lanePadding
    group.members.forEach((id, nodeIndex) => {
      const node = nodes.get(id)!
      const size = mermaidNodeSize(node)
      elements.push({ id: makeId(id), kind: node.kind, x: x + (laneWidth - size.width) / 2, y, width: size.width, height: size.height, text: node.label || id, fill: palette[(laneIndex + nodeIndex) % palette.length], stroke: '#334155', strokeWidth: 2, fontSize: 16, groupId: frameId, zIndex: 1 + elements.length, metadata: { dslId: id, mermaidSwimlane: group.id } })
      y += size.height + itemGap
    })
  })
  // A subgraph can be empty while its referenced nodes are declared later.
  // Do not silently discard such nodes during import.
  for (const [index, [id, node]] of [...nodes.entries()].filter(([id]) => !groups.some(group => group.members.includes(id))).entries()) {
    const size = mermaidNodeSize(node)
    elements.push({ id: makeId(id), kind: node.kind, x: 120 + index * (size.width + 52), y: laneHeight + 160, width: size.width, height: size.height, text: node.label || id, fill: palette[index % palette.length], stroke: '#334155', strokeWidth: 2, fontSize: 16, metadata: { dslId: id } })
  }
  return elements
}

function parseNodeToken(token: string) {
  // A Mermaid node token is `id` plus an optional shape envelope.  The old
  // regex looked for parentheses anywhere in the token, so labels containing
  // `()`/`<br/>` could be cut down to a single character. Parse the envelope
  // from the position immediately after the id instead.
  const raw = token.trim().replace(/:::[\w-]+\s*$/, '')
  const idMatch = raw.match(/^([\w.-]+)/)
  const id = idMatch?.[1] || raw
  const rest = raw.slice(id.length).trim()
  let label = id
  let kind: BoardElement['kind'] = 'rectangle'
  const envelopes: Array<[string, string, BoardElement['kind']]> = [
    ['[[', ']]', 'rounded_rectangle'],
    ['((', '))', 'ellipse'],
    ['([', '])', 'rounded_rectangle'],
    ['[', ']', 'rectangle'],
    ['(', ')', 'ellipse'],
    ['{', '}', 'diamond'],
  ]
  for (const [open, close, nextKind] of envelopes) {
    if (!rest.startsWith(open) || !rest.endsWith(close)) continue
    label = rest.slice(open.length, -close.length)
    kind = nextKind
    break
  }
  return { id, label: clean(label), kind }
}

type StateDiagramEdge = { from: string; to: string; label?: string }

/**
 * State diagrams deliberately have a different grammar from flowcharts:
 * `STATE: caption` is a state declaration, `[*]` is a pseudo-state, and an
 * edge caption follows `:` instead of Mermaid's `|caption|` form.  Parsing it
 * through the flowchart adapter turned these syntax words into boxes.
 */
function parseMermaidStateDiagram(source: string): BoardDocument {
  const states = new Map<string, string>()
  const edges: StateDiagramEdge[] = []
  let direction = 'TB'
  const stateOrder: string[] = []
  const remember = (id: string, label = id) => {
    if (!states.has(id)) stateOrder.push(id)
    const nextLabel = clean(label) || id
    // Edge references are bare state ids. Do not overwrite a richer
    // `STATE: caption` declaration that appeared earlier in the diagram.
    if (!states.has(id) || states.get(id) === id || nextLabel !== id) states.set(id, nextLabel)
  }
  const endpoint = (raw: string, role: 'from' | 'to') => {
    const value = raw.trim()
    if (value === '[*]') return role === 'from' ? '__state_start' : '__state_end'
    return value
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('%%') || /^stateDiagram(?:-v2)?$/i.test(line)) continue
    const directionMatch = line.match(/^direction\s+(LR|RL|TB|BT)$/i)
    if (directionMatch) { direction = directionMatch[1].toUpperCase(); continue }
    const alias = line.match(/^state\s+"(.+?)"\s+as\s+([\w.-]+)(?:\s*\{)?$/i)
    if (alias) { remember(alias[2], alias[1]); continue }
    const composite = line.match(/^state\s+([\w.-]+)(?:\s*\{)?$/i)
    if (composite) { remember(composite[1]); continue }
    const edge = line.match(/^(.+?)\s*-->\s*([^:]+?)(?:\s*:\s*(.+))?$/)
    if (edge) {
      const from = endpoint(edge[1], 'from'), to = endpoint(edge[2], 'to')
      if (!from.startsWith('__state_')) remember(from)
      if (!to.startsWith('__state_')) remember(to)
      edges.push({ from, to, label: edge[3] ? clean(edge[3]) : undefined })
      continue
    }
    const declaration = line.match(/^([\w.-]+)\s*:\s*(.+)$/)
    if (declaration) { remember(declaration[1], declaration[2]); continue }
    // A bare state name is valid Mermaid state syntax as well.
    if (/^[\w.-]+$/.test(line)) remember(line)
  }

  const horizontal = /^(LR|RL)$/.test(direction)
  const primary = horizontal ? 275 : 170
  const cross = horizontal ? 175 : 275
  const stateSize = (label: string) => {
    const lines = label.split('\n').reduce((sum, value) => sum + Math.max(1, Math.ceil(Array.from(value).length / 15)), 0)
    return { width: Math.max(180, Math.min(260, 76 + Math.max(...label.split('\n').map(value => Array.from(value).length)) * 9)), height: Math.max(84, 30 + lines * 24) }
  }
  const normalIds = stateOrder.filter(id => !id.startsWith('__state_'))
  const elements: BoardElement[] = []
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>()
  normalIds.forEach((id, index) => {
    const size = stateSize(states.get(id) || id)
    const pos = horizontal
      ? { x: 145 + index * primary, y: 165 + (index % 2) * 26, ...size }
      : { x: 175 + (index % 2) * 26, y: 115 + index * primary, ...size }
    positions.set(id, pos)
    elements.push({ id: makeId(id), kind: 'rounded_rectangle', ...pos, text: states.get(id) || id, fill: palette[index % palette.length], stroke: '#475569', strokeWidth: 2, fontSize: 16, metadata: { dslId: id, mermaidState: true } })
  })
  const first = positions.get(normalIds[0])
  const last = positions.get(normalIds.at(-1) || '')
  const specialPositions: Record<string, { x: number; y: number; width: number; height: number }> = {
    __state_start: horizontal ? { x: 72, y: (first?.y || 165) + 25, width: 34, height: 34 } : { x: (first?.x || 175) + 72, y: 48, width: 34, height: 34 },
    __state_end: horizontal ? { x: (last?.x || 145) + (last?.width || 180) + 70, y: (last?.y || 165) + 25, width: 38, height: 38 } : { x: (last?.x || 175) + 72, y: (last?.y || 115) + (last?.height || 84) + 70, width: 38, height: 38 },
  }
  for (const [id, pos] of Object.entries(specialPositions)) {
    positions.set(id, pos)
    elements.push({ id, kind: 'ellipse', ...pos, text: id === '__state_start' ? '●' : '◎', fill: id === '__state_start' ? '#475569' : '#ffffff', stroke: '#475569', strokeWidth: 2, textColor: id === '__state_start' ? '#475569' : '#475569', fontSize: id === '__state_start' ? 1 : 20, metadata: { mermaidStatePseudo: true } })
  }
  const idFor = (id: string) => id.startsWith('__state_') ? id : makeId(id)
  return {
    ...emptyDocument(), elements,
    edges: edges.map((edge, index) => ({ id: `state_edge_${index}_${idFor(edge.from)}_${idFor(edge.to)}`, from: idFor(edge.from), to: idFor(edge.to), label: edge.label, stroke: '#64748b', strokeWidth: 2, arrowEnd: true, routing: edge.from === edge.to ? 'curve' : 'elbow', metadata: { mermaidState: true } })),
    dsl: { kind: 'mermaid', source, updatedAt: new Date().toISOString() },
  }
}

/**
 * Sequence diagrams have a time axis, so treating messages as ordinary graph
 * edges (the generic flowchart fallback) loses their meaning.  Use native
 * cards for participants and loose canvas edges for the messages: the arrows
 * then start at the correct lifeline at the moment they occur, not at a card
 * anchor near the top of the page.
 */
function parseMermaidSequenceDiagram(source: string): BoardDocument {
  type Participant = { id: string; label: string; actor: boolean }
  type Message = { from: string; to: string; label: string; dashed: boolean }
  const participants: Participant[] = []
  const messages: Message[] = []
  const byId = new Map<string, Participant>()
  let autonumber = false
  const remember = (id: string, label = id, actor = false) => {
    const cleanId = makeId(id)
    const found = byId.get(cleanId)
    if (found) { if (label && found.label === found.id) found.label = clean(label); return found }
    const participant = { id: cleanId, label: clean(label) || id, actor }
    participants.push(participant); byId.set(cleanId, participant)
    return participant
  }
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('%%') || /^sequenceDiagram$/i.test(line)) continue
    if (/^autonumber\b/i.test(line)) { autonumber = true; continue }
    const declaration = line.match(/^(participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i)
    if (declaration) { remember(declaration[2], declaration[3] || declaration[2], /^actor$/i.test(declaration[1])); continue }
    // Supports Mermaid request/reply arrows, including a solid or dashed
    // shaft. `-->>` is a response; arrow decoration does not belong in the
    // text label on the canvas.
    const message = line.match(/^(\S+?)\s*(-->>|->>|-->|->|--x|--\)|-x)\s*(\S+?)\s*:\s*(.+)$/)
    if (!message) continue
    const from = remember(message[1]).id
    const to = remember(message[3].trim()).id
    messages.push({ from, to, label: clean(message[4]), dashed: message[2].startsWith('--') })
  }
  const cardWidth = 190
  const cardHeight = 62
  const left = 120
  const top = 78
  const lineTop = top + cardHeight + 38
  const rowHeight = 72
  const bottom = lineTop + Math.max(1, messages.length) * rowHeight + 46
  const centres = new Map<string, number>()
  const elements: BoardElement[] = participants.map((participant, index) => {
    const x = left + index * 255
    centres.set(participant.id, x + cardWidth / 2)
    return { id: participant.id, kind: participant.actor ? 'actor' : 'rounded_rectangle', x, y: top, width: cardWidth, height: cardHeight, text: participant.label, fill: participant.actor ? '#ede9fe' : '#eff6ff', stroke: '#475569', strokeWidth: 2, fontSize: 16, zIndex: 2, metadata: { mermaidSequenceParticipant: true, dslId: participant.id } }
  })
  const lifelines: BoardEdge[] = participants.map((participant, index) => ({ id: `sequence_lifeline_${participant.id}`, from: '', to: '', freeStart: { x: centres.get(participant.id)!, y: lineTop - 16 }, freeEnd: { x: centres.get(participant.id)!, y: bottom }, stroke: '#94a3b8', strokeWidth: 1.5, strokeStyle: 'dashed', routing: 'straight', zIndex: 0, metadata: { mermaidSequenceLifeline: true, participant: participant.id, order: index } }))
  const edges: BoardEdge[] = messages.map((message, index) => {
    const y = lineTop + index * rowHeight
    const fromX = centres.get(message.from) || left
    const toX = centres.get(message.to) || left
    const self = message.from === message.to
    return {
      id: `sequence_message_${index}`, from: '', to: '', label: `${autonumber ? `${index + 1}. ` : ''}${message.label}`,
      freeStart: self ? { x: fromX + 14, y } : { x: fromX, y },
      freeEnd: self ? { x: fromX + 64, y: y + 34 } : { x: toX, y },
      stroke: '#475569', strokeWidth: 2, strokeStyle: message.dashed ? 'dashed' : 'solid', arrowEnd: true,
      routing: self ? 'curve' : 'straight', zIndex: 1, metadata: { mermaidSequenceMessage: true, from: message.from, to: message.to },
    }
  })
  return { ...emptyDocument(), elements, edges: [...lifelines, ...edges], dsl: { kind: 'mermaid', source, updatedAt: new Date().toISOString() } }
}

/**
 * Mermaid has several non-flowchart grammars.  They are deliberately routed
 * here rather than falling through to the flowchart tokeniser (where words
 * such as `section`, `dateFormat`, and `classDiagram` became fake boxes).
 * Native primitives cannot reproduce every Mermaid theme detail, but every
 * supported construct remains legible and editable on the board.
 */
type MermaidSpecialItem = { id: string; label: string; kind?: BoardElement['kind']; section?: string; level?: number; value?: number }
type MermaidSpecialRelation = { from: string; to: string; label?: string; value?: number }

const mermaidTitles: Record<string, string> = { classDiagram: '类图', erDiagram: '实体关系图', journey: '用户旅程', gantt: '甘特图', pie: '饼图', gitGraph: 'Git 图', mindmap: '思维导图', timeline: '时间线', quadrantChart: '四象限图', requirementDiagram: '需求图', 'xychart-beta': 'XY 图表', 'sankey-beta': '桑基图', 'architecture-beta': '架构图', 'block-beta': '区块图', 'packet-beta': '数据包图', kanban: '看板', radar: '雷达图', treemap: '矩形树图', C4Context: 'C4 系统上下文图', C4Container: 'C4 容器图', C4Component: 'C4 组件图', C4Dynamic: 'C4 动态图', C4Deployment: 'C4 部署图', zenuml: 'ZenUML 时序图' }

function specialDocument(source: string, diagram: string, elements: BoardElement[], edges: BoardEdge[] = []): BoardDocument {
  const title = mermaidTitles[diagram] || diagram
  elements.unshift({ id: `mermaid_${makeId(diagram)}_title`, kind: 'text', x: 96, y: 38, width: 760, height: 36, text: title, fill: 'transparent', stroke: 'transparent', strokeWidth: 0, fontSize: 22, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'middle', metadata: { mermaidDiagram: diagram, mermaidTitle: true } })
  return { ...emptyDocument(), elements, edges, dsl: { kind: 'mermaid', source, updatedAt: new Date().toISOString() } }
}

function specialCard(diagram: string, item: MermaidSpecialItem, index: number, x: number, y: number, width = 220, height = 88, extra: Partial<BoardElement> = {}): BoardElement {
  return { id: item.id, kind: item.kind || 'rounded_rectangle', x, y, width, height, text: item.label, fill: palette[index % palette.length], stroke: '#475569', strokeWidth: 2, fontSize: 16, zIndex: 2 + index, metadata: { mermaidDiagram: diagram, mermaidId: item.id }, ...extra }
}
function specialEdge(diagram: string, relation: MermaidSpecialRelation, index: number, extra: Partial<BoardEdge> = {}): BoardEdge {
  return { id: `mermaid_${makeId(diagram)}_relation_${index}`, from: relation.from, to: relation.to, label: relation.label, stroke: '#64748b', strokeWidth: 2, arrowEnd: true, routing: 'elbow', metadata: { mermaidDiagram: diagram }, ...extra }
}
function specialLines(source: string, diagram: string) {
  const header = new RegExp(`^${diagram.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|-beta)?`, 'i')
  return source.split(/\r?\n/).filter(line => !header.test(line.trim()) && !line.trim().startsWith('%%') && !/^(title|dateFormat|axisFormat|tickInterval|accTitle|accDescr)\b/i.test(line.trim()))
}
function graphSpecial(source: string, diagram: string, declaration: RegExp, relation: RegExp, kind: BoardElement['kind'] = 'rounded_rectangle') {
  const items = new Map<string, MermaidSpecialItem>(), relations: MermaidSpecialRelation[] = []
  const remember = (raw: string, label = raw) => {
    const id = makeId(clean(raw)); if (!items.has(id)) items.set(id, { id, label: clean(label) || raw, kind }); return id
  }
  for (const raw of specialLines(source, diagram)) {
    const line = raw.trim(); if (!line || /^(\{|\}|end)$/i.test(line)) continue
    const declared = line.match(declaration)
    if (declared) { remember(declared[1], declared[2] || declared[1]); continue }
    const linked = line.match(relation) || line.match(/^([\w.-]+)\s*(?:-->|--|<--|\.\.>)\s*([\w.-]+)(?:\s*:\s*(.+))?$/)
    if (linked) { relations.push({ from: remember(linked[1]), to: remember(linked[2]), label: linked[3] ? clean(linked[3]) : undefined }); continue }
  }
  const values = [...items.values()]
  const elements = layoutDirectionalMermaid(new Map(values.map(item => [item.id, { label: item.label, kind: item.kind || kind }])), relations.map(edge => ({ from: edge.from, to: edge.to })), 'LR').map((element, index) => ({ ...element, metadata: { mermaidDiagram: diagram, mermaidId: values.find(item => item.id === element.id)?.id } }))
  return specialDocument(source, diagram, elements, relations.map((edge, index) => specialEdge(diagram, edge, index)))
}

function parseMermaidClassOrEntity(source: string, diagram: string): BoardDocument {
  const items = new Map<string, MermaidSpecialItem>(), relations: MermaidSpecialRelation[] = []
  let active: MermaidSpecialItem | undefined
  const remember = (name: string, label = name) => {
    const id = makeId(name)
    if (!items.has(id)) items.set(id, { id, label: clean(label), kind: diagram === 'erDiagram' ? 'database' : 'rounded_rectangle' })
    return items.get(id)!
  }
  for (const raw of specialLines(source, diagram)) {
    const line = raw.trim(); if (!line || line === '{' || line === '}') { if (line === '}') active = undefined; continue }
    const declared = line.match(/^(?:(?:functional|interface|performance|physical)?Requirement|class|entity)\s+([\w.-]+)(?:\s*\{)?/i)
    if (declared) { active = remember(declared[1]); continue }
    const linked = line.match(/^([\w.-]+)\s+(?:["|o{}()<>*.-]+)\s+([\w.-]+)(?:\s*:\s*(.+))?$/)
    if (linked) { relations.push({ from: remember(linked[1]).id, to: remember(linked[2]).id, label: linked[3] ? clean(linked[3]) : undefined }); continue }
    const requirementRelation = line.match(/^([\w.-]+)\s*-\s*(contains|copies|derives|satisfies|verifies|refines|traces)\s*->\s*([\w.-]+)$/i)
    if (requirementRelation) { relations.push({ from: remember(requirementRelation[1]).id, to: remember(requirementRelation[3]).id, label: requirementRelation[2] }); continue }
    if (active && !/^([\w.-]+)\s*:/i.test(line)) active.label += `\n${clean(line.replace(/[+~#-]\s*/g, ''))}`
    else if (diagram === 'requirementDiagram' && /^(id|text|risk|verifymethod):?/i.test(line)) { active ||= remember('requirement'); active.label += `\n${clean(line)}` }
  }
  const values = [...items.values()]
  const elements = layoutDirectionalMermaid(new Map(values.map(item => [item.id, { label: item.label, kind: item.kind! }])), relations, 'LR').map((element, index) => ({ ...element, height: Math.max(element.height, 94 + (element.text.split('\n').length - 1) * 18), metadata: { mermaidDiagram: diagram, mermaidEntity: true } }))
  return specialDocument(source, diagram, elements, relations.map((edge, index) => specialEdge(diagram, edge, index, diagram === 'erDiagram' ? { startArrow: 'circle', endArrow: 'arrow' } : {})))
}

function parseMermaidArchitecture(source: string, diagram: string): BoardDocument {
  type Service = MermaidSpecialItem & { group?: string; serviceKind: 'service' | 'junction' }
  const services = new Map<string, Service>(), groups = new Map<string, { id: string; label: string }>(), relations: MermaidSpecialRelation[] = []
  const remember = (id: string, label = id, serviceKind: Service['serviceKind'] = 'service', group?: string) => {
    const key = makeId(id); if (!services.has(key)) services.set(key, { id: key, label: clean(label) || id, group, serviceKind, kind: serviceKind === 'junction' ? 'ellipse' : 'rounded_rectangle' }); return services.get(key)!
  }
  for (const raw of specialLines(source, diagram)) {
    const line = raw.trim(); if (!line) continue
    const group = line.match(/^group\s+([\w.-]+)(?:\([^)]*\))?\s*\[([^\]]+)\]/i)
    if (group) { groups.set(makeId(group[1]), { id: makeId(group[1]), label: clean(group[2]) }); continue }
    const service = line.match(/^(service|junction)\s+([\w.-]+)(?:\([^)]*\))?\s*(?:\[([^\]]+)\])?(?:\s+in\s+([\w.-]+))?/i)
    if (service) { remember(service[2], service[3] || service[2], service[1].toLowerCase() as Service['serviceKind'], service[4] ? makeId(service[4]) : undefined); continue }
    const edge = line.match(/^([\w.-]+)(?::[LTRB])?\s*(?:<-->|-->|<--)\s*(?:[LTRB]:)?([\w.-]+)(?:\s*:\s*(.+))?$/i)
    if (edge) relations.push({ from: remember(edge[1]).id, to: remember(edge[2]).id, label: edge[3] ? clean(edge[3]) : undefined })
  }
  const items = [...services.values()], elements: BoardElement[] = []; const groupMembers = new Map<string, Service[]>()
  items.forEach(item => { if (item.group) groupMembers.set(item.group, [...(groupMembers.get(item.group) || []), item]) })
  let groupIndex = 0
  for (const group of groups.values()) {
    const members = groupMembers.get(group.id) || []; const x = 96 + groupIndex * 330, width = 288, height = Math.max(220, 90 + members.length * 108)
    elements.push({ id: `architecture_group_${group.id}`, kind: 'frame', x, y: 104, width, height, text: group.label, fill: '#f8fafc', fillOpacity: .68, stroke: '#94a3b8', strokeWidth: 2, strokeStyle: 'dashed', fontSize: 16, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'top', metadata: { mermaidDiagram: diagram, mermaidArchitectureGroup: true } })
    members.forEach((item, index) => elements.push(specialCard(diagram, item, elements.length, x + 30, 158 + index * 98, 228, 70, { groupId: `architecture_group_${group.id}`, kind: item.kind })))
    groupIndex++
  }
  const ungrouped = items.filter(item => !item.group); const offset = groups.size ? 96 + groups.size * 330 : 110
  ungrouped.forEach((item, index) => elements.push(specialCard(diagram, item, elements.length, offset + Math.floor(index / 4) * 270, 132 + (index % 4) * 112, 210, 70, { kind: item.kind })))
  return specialDocument(source, diagram, elements, relations.map((edge, index) => specialEdge(diagram, edge, index)))
}

function parseMermaidC4(source: string, diagram: string): BoardDocument {
  type C4Node = MermaidSpecialItem & { group?: string }
  const nodes = new Map<string, C4Node>(), groups = new Map<string, { id: string; label: string }>(), relations: MermaidSpecialRelation[] = []; const stack: string[] = []
  const remember = (rawId: string, label = rawId, kind: BoardElement['kind'] = 'rounded_rectangle') => { const id = makeId(rawId); if (!nodes.has(id)) nodes.set(id, { id, label: clean(label) || rawId, kind, group: stack.at(-1) }); return nodes.get(id)! }
  for (const raw of specialLines(source, diagram)) {
    const line = raw.trim(); if (!line) continue
    if (line === '}') { stack.pop(); continue }
    const boundary = line.match(/^(?:System|Container|Enterprise)_Boundary\s*\(\s*([^,]+)\s*,\s*"?([^,")]+)"?.*\)\s*\{/i)
    if (boundary) { const id = makeId(boundary[1]); groups.set(id, { id, label: clean(boundary[2]) }); stack.push(id); continue }
    const declaration = line.match(/^(Person(?:_?Ext)?|System(?:_?Db|_?Ext)?|Container(?:_?Db|_?Ext)?|Component(?:_?Db|_?Ext)?|Deployment_Node)\s*\(\s*([^,]+)\s*,\s*"?([^,")]+)"?/i)
    if (declaration) { remember(declaration[2], declaration[3], /^Person/i.test(declaration[1]) ? 'actor' : /Db/i.test(declaration[1]) ? 'database' : 'rounded_rectangle'); continue }
    const relation = line.match(/^Rel(?:_\w+)?\s*\(\s*([^,]+)\s*,\s*([^,]+)(?:\s*,\s*"?([^,")]+)"?)?/i)
    if (relation) relations.push({ from: remember(relation[1]).id, to: remember(relation[2]).id, label: relation[3] ? clean(relation[3]) : undefined })
  }
  const values = [...nodes.values()], elements: BoardElement[] = []; const groupMembers = new Map<string, C4Node[]>(); values.forEach(node => { if (node.group) groupMembers.set(node.group, [...(groupMembers.get(node.group) || []), node]) })
  let groupIndex = 0
  for (const group of groups.values()) {
    const members = groupMembers.get(group.id) || [], x = 110 + groupIndex * 350, frameId = `c4_group_${group.id}`, height = Math.max(230, 82 + members.length * 104)
    elements.push({ id: frameId, kind: 'frame', x, y: 104, width: 310, height, text: group.label, fill: '#f8fafc', fillOpacity: .7, stroke: '#94a3b8', strokeWidth: 2, strokeStyle: 'dashed', fontSize: 16, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'top', metadata: { mermaidDiagram: diagram, mermaidC4Boundary: true } })
    members.forEach((node, index) => elements.push(specialCard(diagram, node, index, x + 38, 158 + index * 94, 234, 68, { kind: node.kind, groupId: frameId })))
    groupIndex++
  }
  const ungrouped = values.filter(node => !node.group); const origin = groups.size ? 110 + groups.size * 350 : 110
  ungrouped.forEach((node, index) => elements.push(specialCard(diagram, node, index, origin + Math.floor(index / 4) * 270, 132 + index % 4 * 106, 210, 70, { kind: node.kind })))
  return specialDocument(source, diagram, elements, relations.map((edge, index) => specialEdge(diagram, edge, index, { routing: 'curve' })))
}

function parseMermaidKanban(source: string, diagram: string): BoardDocument {
  const columns: Array<{ name: string; cards: MermaidSpecialItem[] }> = []; let current: typeof columns[number] | undefined
  for (const raw of specialLines(source, diagram)) {
    const indent = raw.match(/^\s*/)?.[0].length || 0; const line = raw.trim(); if (!line) continue
    if (indent === 0) { current = { name: clean(line.replace(/:$/, '')), cards: [] }; columns.push(current); continue }
    current ||= { name: '待处理', cards: [] }; if (!columns.includes(current)) columns.push(current)
    const label = clean(line.replace(/^[-*+]\s*/, '').replace(/^\[|\]$/g, '')); current.cards.push({ id: makeId(`kanban_${current.name}_${current.cards.length}`), label })
  }
  const elements: BoardElement[] = []
  columns.forEach((column, index) => {
    const frameId = makeId(`kanban_${column.name}`), height = Math.max(300, 96 + column.cards.length * 122), x = 96 + index * 282
    elements.push({ id: frameId, kind: 'frame', x, y: 98, width: 246, height, text: column.name, fill: '#f8fafc', fillOpacity: .72, stroke: '#94a3b8', strokeWidth: 2, strokeStyle: 'dashed', fontSize: 16, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'top', metadata: { mermaidDiagram: diagram, mermaidKanbanColumn: true } })
    column.cards.forEach((card, cardIndex) => elements.push(specialCard(diagram, card, cardIndex, x + 16, 154 + cardIndex * 112, 214, 84, { groupId: frameId })))
  })
  return specialDocument(source, diagram, elements)
}

function parseMermaidJourney(source: string, diagram: string): BoardDocument {
  const stages: Array<{ name: string; steps: MermaidSpecialItem[] }> = []; let current: { name: string; steps: MermaidSpecialItem[] } | undefined
  for (const raw of specialLines(source, diagram)) {
    const line = raw.trim(); if (!line) continue
    const section = line.match(/^section\s+(.+)/i)
    if (section) { current = { name: clean(section[1]), steps: [] }; stages.push(current); continue }
    const step = line.match(/^(.+?)\s*:\s*(\d+)(?:\s*:\s*(.+))?$/)
    if (!step) continue
    current ||= { name: '旅程', steps: [] }; if (!stages.includes(current)) stages.push(current)
    current.steps.push({ id: makeId(`journey_${stages.length}_${current.steps.length}`), label: `${clean(step[1])}\n${step[3] ? clean(step[3]) : ''}`.trim(), value: Number(step[2]) })
  }
  const elements: BoardElement[] = []
  stages.forEach((stage, stageIndex) => {
    const x = 96 + stageIndex * 286, frameId = makeId(`journey_${stage.name}`), height = Math.max(290, 110 + stage.steps.length * 104)
    elements.push({ id: frameId, kind: 'frame', x, y: 98, width: 250, height, text: stage.name, fill: '#f8fafc', fillOpacity: .7, stroke: '#94a3b8', strokeWidth: 2, strokeStyle: 'dashed', fontSize: 16, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'top', metadata: { mermaidDiagram: diagram, mermaidJourneyStage: true } })
    stage.steps.forEach((step, index) => elements.push(specialCard(diagram, step, index, x + 18, 154 + index * 94, 214, 72, { groupId: frameId, kind: 'note', textAlign: 'left', fill: step.value && step.value >= 4 ? '#dcfce7' : step.value && step.value <= 2 ? '#fee2e2' : '#fef3c7' })))
  })
  return specialDocument(source, diagram, elements)
}

function parseMermaidMindmap(source: string, diagram: string): BoardDocument {
  type RawMindmapNode = { line: string; indent: number }
  const rawNodes: RawMindmapNode[] = specialLines(source, diagram).map(raw => ({ line: raw.trim(), indent: raw.match(/^\s*/)?.[0].length || 0 })).filter(node => Boolean(node.line))
  const rootIndex = rawNodes.findIndex(node => /^root\b/i.test(node.line))
  const rootIndent = rootIndex >= 0 ? rawNodes[rootIndex].indent : 0
  // Many AI/chat editors strip indentation from numbered top-level branches
  // while leaving their children indented. Treat those numbered rows as root
  // children instead of letting them become a second root.
  const numberedRootChildren = rootIndex >= 0 && rawNodes.some((node, index) => index !== rootIndex && node.indent <= rootIndent && /^\d+[.)]\s+/.test(node.line))
  const nestedIndent = Math.min(...rawNodes.filter((node, index) => index !== rootIndex && !/^\d+[.)]\s+/.test(node.line) && node.indent > 0).map(node => node.indent), 2)
  const labelFor = (line: string) => clean(line.replace(/^root\s*/i, '').replace(/^\(\(|\)\)$/g, '').replace(/^\[|\]$/g, ''))
  const items: MermaidSpecialItem[] = [], relations: MermaidSpecialRelation[] = [], parents: Array<string | undefined> = []
  rawNodes.forEach((node, index) => {
    const label = labelFor(node.line); if (!label) return
    let level: number
    if (index === rootIndex) level = 0
    else if (numberedRootChildren) level = /^\d+[.)]\s+/.test(node.line) || node.indent === 0 ? 1 : 2 + Math.max(0, Math.floor((node.indent - nestedIndent) / 2))
    else level = rootIndex >= 0 ? Math.max(1, Math.round((node.indent - rootIndent) / 2)) : Math.max(0, Math.floor(node.indent / 2))
    const item = { id: makeId(`mind_${items.length}_${label}`), label, level, kind: level === 0 ? 'ellipse' as const : 'rounded_rectangle' as const }
    items.push(item)
    if (level > 0 && parents[level - 1]) relations.push({ from: parents[level - 1]!, to: item.id })
    parents[level] = item.id; parents.length = level + 1
  })
  const root = items.find(item => item.level === 0) || items[0]
  if (!root) return specialDocument(source, diagram, [])
  const children = new Map<string, string[]>(); relations.forEach(edge => children.set(edge.from, [...(children.get(edge.from) || []), edge.to]))
  const byId = new Map(items.map(item => [item.id, item]))
  const leafCount = (id: string): number => { const next = children.get(id) || []; return next.length ? next.reduce((count, child) => count + leafCount(child), 0) : 1 }
  const positions = new Map<string, { x: number; y: number }>(); const rootChildren = children.get(root.id) || []
  const left = rootChildren.filter((_, index) => index % 2 === 0), right = rootChildren.filter((_, index) => index % 2 === 1)
  const placeSide = (branches: string[], direction: -1 | 1) => {
    let cursor = 150
    const place = (id: string, depth: number): number => {
      const descendants = children.get(id) || []
      if (!descendants.length) { const y = cursor; cursor += 126; positions.set(id, { x: 590 + direction * depth * 290, y }); return y }
      const ys = descendants.map(child => place(child, depth + 1)); const y = (Math.min(...ys) + Math.max(...ys)) / 2
      positions.set(id, { x: 590 + direction * depth * 290, y }); return y
    }
    branches.forEach(branch => { place(branch, 1); cursor += 38 })
    return cursor
  }
  const leftBottom = placeSide(left, -1), rightBottom = placeSide(right, 1)
  positions.set(root.id, { x: 590, y: Math.max(250, (Math.max(leftBottom, rightBottom) + 100) / 2) })
  const elements = items.map((item, index) => {
    const position = positions.get(item.id) || positions.get(root.id)!; const size = mermaidNodeSize({ label: item.label, kind: item.kind || 'rounded_rectangle' })
    const width = item.id === root.id ? 250 : size.width
    return specialCard(diagram, item, index, position.x - width / 2, position.y - size.height / 2, width, size.height, { kind: item.id === root.id ? 'ellipse' : 'rounded_rectangle', fontSize: item.id === root.id ? 17 : 15 })
  })
  const elementById = new Map(elements.map(element => [element.id, element]))
  const edges = relations.map((edge, index) => {
    const from = elementById.get(edge.from)!, to = elementById.get(edge.to)!
    const toRight = to.x > from.x
    const start = { x: toRight ? 1 : 0, y: .5 }, end = { x: toRight ? 0 : 1, y: .5 }
    return specialEdge(diagram, edge, index, {
      routing: 'curve', endArrow: 'none', stroke: '#94a3b8', strokeWidth: 2.5,
      fromAnchor: start, toAnchor: end,
      controlPoints: [{ x: (from.x + from.width / 2 + to.x + to.width / 2) / 2, y: from.y + from.height / 2 }],
    })
  })
  return specialDocument(source, diagram, elements, edges)
}

function parseMermaidTimeline(source: string, diagram: string): BoardDocument {
  const items: MermaidSpecialItem[] = []; let section = ''
  for (const raw of specialLines(source, diagram)) { const line = raw.trim(); if (!line) continue; if (/^(section|period)\s+/i.test(line)) { section = clean(line.replace(/^(section|period)\s+/i, '')); continue }; const match = line.match(/^(.+?)\s*:\s*(.+)$/); if (match) items.push({ id: makeId(`timeline_${items.length}`), label: `${clean(match[1])}\n${clean(match[2])}`, section }) }
  const elements: BoardElement[] = []; const axis: BoardEdge = { id: 'timeline_axis', from: '', to: '', freeStart: { x: 120, y: 255 }, freeEnd: { x: Math.max(520, 150 + items.length * 250), y: 255 }, stroke: '#475569', strokeWidth: 3, endArrow: 'arrow', routing: 'straight', metadata: { mermaidDiagram: diagram, mermaidTimelineAxis: true } }
  items.forEach((item, index) => { const x = 125 + index * 250; elements.push(specialCard(diagram, item, index, x, index % 2 ? 294 : 122, 210, 88, { kind: 'note' })); elements.push({ id: `${item.id}_marker`, kind: 'ellipse', x: x + 89, y: 239, width: 22, height: 22, text: '', fill: palette[index % palette.length], stroke: '#475569', strokeWidth: 2, fontSize: 1, metadata: { mermaidDiagram: diagram, mermaidTimelineMarker: true } }) })
  return specialDocument(source, diagram, elements, [axis])
}

function parseMermaidGantt(source: string, diagram: string): BoardDocument {
  const tasks: Array<MermaidSpecialItem & { startDate?: number; sequence: number; duration: number }> = []; let section = '任务'
  for (const raw of specialLines(source, diagram)) {
    const line = raw.trim(); if (!line) continue
    if (/^section\s+/i.test(line)) { section = clean(line.replace(/^section\s+/i, '')); continue }
    const match = line.match(/^(.+?)\s*:\s*(.*)$/); if (!match) continue
    const config = match[2], chunks = config.split(',').map(value => value.trim())
    const date = config.match(/\d{4}-\d{2}-\d{2}/)?.[0]; const durationToken = chunks.at(-1) || '1d'
    const durationMatch = durationToken.match(/([\d.]+)\s*([dwmy]?)/i); const multiplier = durationMatch?.[2].toLowerCase() === 'w' ? 7 : durationMatch?.[2].toLowerCase() === 'm' ? 30 : durationMatch?.[2].toLowerCase() === 'y' ? 365 : 1
    tasks.push({ id: makeId(`gantt_${tasks.length}`), label: clean(match[1]), section, sequence: tasks.length, startDate: date ? Date.parse(`${date}T00:00:00Z`) : undefined, duration: Math.max(1, Number(durationMatch?.[1] || 1) * multiplier) })
  }
  const dated = tasks.map(task => task.startDate).filter((date): date is number => Number.isFinite(date)); const epoch = dated.length ? Math.min(...dated) : 0
  const startOf = (task: typeof tasks[number]) => task.startDate !== undefined ? Math.round((task.startDate - epoch) / 86_400_000) : task.sequence * 2
  const maxDay = Math.max(1, ...tasks.map(task => startOf(task) + task.duration)); const unit = Math.max(26, Math.min(54, 650 / maxDay)); const chartX = 342
  const elements: BoardElement[] = [{ id: 'gantt_axis', kind: 'text', x: chartX, y: 96, width: maxDay * unit, height: 28, text: Array.from({ length: Math.ceil(maxDay) }, (_, index) => dated.length ? new Date(epoch + index * 86_400_000).toISOString().slice(5, 10) : `${index + 1}`).filter((_, index) => index % Math.max(1, Math.ceil(maxDay / 9)) === 0).join('     '), fill: 'transparent', stroke: 'transparent', strokeWidth: 0, fontSize: 13, textAlign: 'left', verticalAlign: 'middle', metadata: { mermaidDiagram: diagram, mermaidGanttAxis: true } }]
  const bySection = new Map<string, typeof tasks>(); tasks.forEach(task => bySection.set(task.section || '任务', [...(bySection.get(task.section || '任务') || []), task])); let row = 0
  for (const [name, rows] of bySection) {
    const frameY = 132 + row * 70, frameHeight = rows.length * 70 + 20, frameId = makeId(`gantt_section_${name}`)
    elements.push({ id: frameId, kind: 'frame', x: 86, y: frameY, width: Math.max(800, chartX + maxDay * unit - 86), height: frameHeight, text: name, fill: '#f8fafc', fillOpacity: .45, stroke: '#cbd5e1', strokeWidth: 1.5, strokeStyle: 'dashed', fontSize: 14, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'top', metadata: { mermaidDiagram: diagram, mermaidGanttSection: true } })
    rows.forEach((task, index) => { const y = frameY + 28 + index * 70; elements.push(specialCard(diagram, task, row + index, 108, y, 210, 44, { kind: 'text', fill: 'transparent', stroke: 'transparent', strokeWidth: 0, textAlign: 'left', fontSize: 14, groupId: frameId })); elements.push(specialCard(diagram, task, row + index, chartX + startOf(task) * unit, y, Math.max(48, task.duration * unit), 44, { kind: 'rounded_rectangle', fontSize: 13, groupId: frameId })) })
    row += rows.length + 1
  }
  return specialDocument(source, diagram, elements)
}

function parseMermaidQuadrant(source: string, diagram: string): BoardDocument {
  const elements: BoardElement[] = []; const edges: BoardEdge[] = []; const labels = new Map<string, string>()
  for (const raw of specialLines(source, diagram)) { const line = raw.trim(); const axis = line.match(/^(x-axis|y-axis)\s+(.+?)\s*--?>\s*(.+)$/i); if (axis) { labels.set(axis[1].toLowerCase(), `${clean(axis[2])} → ${clean(axis[3])}`); continue }; const point = line.match(/^(.+?)\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/); if (point) { const x = 160 + Number(point[2]) * 520, y = 630 - Number(point[3]) * 440; elements.push(specialCard(diagram, { id: makeId(`quadrant_${point[1]}`), label: clean(point[1]) }, elements.length, x, y, 160, 62, { kind: 'ellipse', fontSize: 14 })) } }
  edges.push({ id: 'quadrant_x', from: '', to: '', freeStart: { x: 120, y: 410 }, freeEnd: { x: 760, y: 410 }, stroke: '#64748b', strokeWidth: 2, endArrow: 'arrow', routing: 'straight', metadata: { mermaidDiagram: diagram } }, { id: 'quadrant_y', from: '', to: '', freeStart: { x: 440, y: 640 }, freeEnd: { x: 440, y: 120 }, stroke: '#64748b', strokeWidth: 2, endArrow: 'arrow', routing: 'straight', metadata: { mermaidDiagram: diagram } })
  elements.push({ id: 'quadrant_x_label', kind: 'text', x: 510, y: 420, width: 250, height: 30, text: labels.get('x-axis') || 'X 轴', fill: 'transparent', stroke: 'transparent', strokeWidth: 0, fontSize: 14, textAlign: 'left', verticalAlign: 'middle', metadata: { mermaidDiagram: diagram } }, { id: 'quadrant_y_label', kind: 'text', x: 120, y: 125, width: 250, height: 30, text: labels.get('y-axis') || 'Y 轴', fill: 'transparent', stroke: 'transparent', strokeWidth: 0, fontSize: 14, textAlign: 'left', verticalAlign: 'middle', metadata: { mermaidDiagram: diagram } })
  return specialDocument(source, diagram, elements, edges)
}

function parseMermaidPieOrChart(source: string, diagram: string): BoardDocument {
  if (/^pie$/i.test(diagram)) {
    const values: MermaidSpecialItem[] = []
    for (const raw of specialLines(source, diagram)) { const slice = raw.trim().match(/^"?(.+?)"?\s*:\s*([\d.]+)\s*$/); if (slice) values.push({ id: makeId(`pie_${values.length}_${slice[1]}`), label: clean(slice[1]), value: Number(slice[2]) }) }
    const total = Math.max(1, values.reduce((sum, item) => sum + (item.value || 0), 0)); let angle = 0; const elements: BoardElement[] = []
    values.forEach((item, index) => {
      const next = angle + (item.value || 0) / total * 360
      elements.push(specialCard(diagram, { ...item, label: '' }, index, 120, 120, 278, 278, { kind: 'ellipse', fill: palette[index % palette.length], stroke: '#ffffff', strokeWidth: 2, metadata: { mermaidDiagram: diagram, mermaidPieSlice: { start: angle, end: next }, mermaidId: item.id } }))
      elements.push(specialCard(diagram, { ...item, label: `${item.label}  ${item.value} (${Math.round((item.value || 0) / total * 100)}%)` }, index, 440, 132 + index * 58, 310, 42, { kind: 'rounded_rectangle', fontSize: 14, textAlign: 'left', fill: '#ffffff', stroke: palette[index % palette.length], strokeWidth: 2 }))
      angle = next
    })
    return specialDocument(source, diagram, elements)
  }
  const categories = specialLines(source, diagram).map(line => line.trim().match(/^x-axis\s*\[([^\]]+)\]/i)?.[1]).find(Boolean)?.split(',').map(value => clean(value)) || []
  const series: Array<{ kind: 'bar' | 'line'; values: number[] }> = []
  for (const raw of specialLines(source, diagram)) { const match = raw.trim().match(/^(bar|line)\s*\[([^\]]+)\]/i); if (match) series.push({ kind: match[1].toLowerCase() as 'bar' | 'line', values: match[2].split(',').map(value => Number(value.trim()) || 0) }) }
  const count = Math.max(categories.length, ...series.map(item => item.values.length), 1), max = Math.max(1, ...series.flatMap(item => item.values)); const elements: BoardElement[] = [], edges: BoardEdge[] = []
  const left = 125, bottom = 455, chartWidth = 610, chartHeight = 280, slot = chartWidth / count
  edges.push({ id: 'xy_x_axis', from: '', to: '', freeStart: { x: left, y: bottom }, freeEnd: { x: left + chartWidth, y: bottom }, stroke: '#64748b', strokeWidth: 2, endArrow: 'arrow', routing: 'straight', metadata: { mermaidDiagram: diagram } }, { id: 'xy_y_axis', from: '', to: '', freeStart: { x: left, y: bottom }, freeEnd: { x: left, y: bottom - chartHeight }, stroke: '#64748b', strokeWidth: 2, endArrow: 'arrow', routing: 'straight', metadata: { mermaidDiagram: diagram } })
  Array.from({ length: count }, (_, index) => elements.push({ id: `xy_label_${index}`, kind: 'text', x: left + index * slot, y: bottom + 12, width: slot, height: 26, text: categories[index] || `${index + 1}`, fill: 'transparent', stroke: 'transparent', strokeWidth: 0, fontSize: 13, textAlign: 'center', verticalAlign: 'middle', metadata: { mermaidDiagram: diagram, mermaidXyLabel: true } }))
  series.forEach((entry, seriesIndex) => {
    const points: Array<{ x: number; y: number }> = []
    entry.values.forEach((value, index) => {
      const x = left + index * slot + slot / 2, y = bottom - value / max * chartHeight
      if (entry.kind === 'bar') elements.push(specialCard(diagram, { id: `xy_bar_${seriesIndex}_${index}`, label: `${value}` }, index, x - Math.min(42, slot * .28), y, Math.min(84, slot * .56), Math.max(18, bottom - y), { kind: 'rectangle', fontSize: 13, verticalAlign: 'top' }))
      else { points.push({ x, y }); elements.push({ id: `xy_point_${seriesIndex}_${index}`, kind: 'ellipse', x: x - 8, y: y - 8, width: 16, height: 16, text: '', fill: seriesIndex % 2 ? '#f59e0b' : '#6366f1', stroke: '#fff', strokeWidth: 2, fontSize: 1, metadata: { mermaidDiagram: diagram, mermaidXyPoint: true } }) }
    })
    points.slice(1).forEach((point, index) => edges.push({ id: `xy_line_${seriesIndex}_${index}`, from: '', to: '', freeStart: points[index], freeEnd: point, stroke: seriesIndex % 2 ? '#f59e0b' : '#6366f1', strokeWidth: 3, routing: 'straight', metadata: { mermaidDiagram: diagram, mermaidXyLine: true } }))
  })
  return specialDocument(source, diagram, elements, edges)
}

function parseMermaidGit(source: string, diagram: string): BoardDocument {
  const branches = new Map<string, number>([['main', 0]]), heads = new Map<string, string>(); let branch = 'main'; const commits: MermaidSpecialItem[] = []; const edges: MermaidSpecialRelation[] = []
  const addCommit = (label: string, extraParents: string[] = []) => { const item = { id: makeId(`git_${commits.length}_${label}`), label, section: branch }; commits.push(item); const previous = heads.get(branch); if (previous) edges.push({ from: previous, to: item.id }); extraParents.filter(Boolean).forEach(parent => edges.push({ from: parent, to: item.id, label: 'merge' })); heads.set(branch, item.id) }
  for (const raw of specialLines(source, diagram)) {
    const line = raw.trim(); const branchMatch = line.match(/^(branch|checkout)\s+"?([^"\s]+)"?/i)
    if (branchMatch) { const next = branchMatch[2]; if (!branches.has(next)) { branches.set(next, branches.size); heads.set(next, heads.get(branch) || '') }; branch = next; continue }
    const merge = line.match(/^merge\s+"?([^"\s]+)"?(?:\s+id:\s*"?([^"\s]+)"?)?/i)
    if (merge) { addCommit(merge[2] || `merge ${merge[1]}`, [heads.get(merge[1]) || '']); continue }
    const commit = line.match(/^(commit|cherry-pick)\b(?:\s+id:\s*"?([^"\s]+)"?)?/i); if (commit) addCommit(commit[2] || commit[1])
  }
  const elements: BoardElement[] = []; const laneY = (name: string) => 154 + (branches.get(name) || 0) * 122
  branches.forEach((lane, name) => { const y = laneY(name); elements.push({ id: `git_lane_${makeId(name)}`, kind: 'text', x: 96, y: y - 14, width: 108, height: 28, text: name, fill: 'transparent', stroke: 'transparent', strokeWidth: 0, fontSize: 15, fontWeight: 'bold', textAlign: 'left', verticalAlign: 'middle', metadata: { mermaidDiagram: diagram, mermaidGitBranch: true } }); elements.push({ id: `git_rail_${makeId(name)}`, kind: 'text', x: 200, y, width: Math.max(260, commits.length * 142), height: 2, text: '', fill: 'transparent', stroke: '#cbd5e1', strokeWidth: 2, fontSize: 1, metadata: { mermaidDiagram: diagram, mermaidGitRail: true } }) })
  commits.forEach((item, index) => elements.push(specialCard(diagram, item, index, 230 + index * 142, laneY(item.section || 'main') - 29, 94, 58, { kind: 'ellipse', fontSize: 13 })))
  return specialDocument(source, diagram, elements, edges.map((edge, index) => specialEdge(diagram, edge, index, { routing: 'curve', endArrow: 'none', strokeWidth: 2.5 })))
}

function parseMermaidSankey(source: string, diagram: string): BoardDocument {
  const relations: MermaidSpecialRelation[] = []; const left = new Map<string, MermaidSpecialItem>(), right = new Map<string, MermaidSpecialItem>()
  for (const raw of specialLines(source, diagram)) { const [from, to, value] = raw.trim().split(',').map(clean); if (!from || !to) continue; const fromId = makeId(`sankey_${from}`), toId = makeId(`sankey_${to}`); left.set(fromId, { id: fromId, label: from }); right.set(toId, { id: toId, label: to }); relations.push({ from: fromId, to: toId, value: Number(value) || 1, label: value }) }
  const elements: BoardElement[] = []; [...left.values()].forEach((item, index) => elements.push(specialCard(diagram, item, index, 110, 125 + index * 110, 170, 68))); [...right.values()].forEach((item, index) => elements.push(specialCard(diagram, item, index + left.size, 610, 125 + index * 110, 170, 68)))
  return specialDocument(source, diagram, elements, relations.map((edge, index) => specialEdge(diagram, edge, index, { strokeWidth: Math.max(2, Math.min(18, Math.sqrt(edge.value || 1) * 2)), opacity: .68, routing: 'curve' })))
}

function parseMermaidPacket(source: string, diagram: string): BoardDocument {
  const fields = specialLines(source, diagram).map(line => line.trim().match(/^(\d+\s*-\s*\d+)\s*:\s*"?(.+?)"?$/)).filter((match): match is RegExpMatchArray => Boolean(match)); const elements = fields.map((field, index) => specialCard(diagram, { id: makeId(`packet_${index}`), label: `${field[1]}\n${clean(field[2])}` }, index, 110 + index * 148, 170, 142, 104, { kind: 'rectangle', fontSize: 14 }))
  return specialDocument(source, diagram, elements)
}

function parseMermaidBlockOrTree(source: string, diagram: string): BoardDocument {
  const lines = specialLines(source, diagram).filter(line => line.trim() && !/^columns\s+\d+/i.test(line.trim())); const columns = Number(specialLines(source, diagram).find(line => /^\s*columns\s+\d+/i.test(line))?.match(/\d+/)?.[0] || 2); const elements: BoardElement[] = []
  lines.forEach((raw, index) => { const indentation = raw.match(/^\s*/)?.[0].length || 0; const labels = diagram === 'block-beta' ? raw.trim().split(/\s+/) : [raw.trim().replace(/^[-+*]\s*/, '')]; labels.forEach((label, nested) => { const row = Math.floor(index / Math.max(1, columns)); elements.push(specialCard(diagram, { id: makeId(`${diagram}_${index}_${nested}_${label}`), label: clean(label), level: indentation }, elements.length, 110 + ((index + nested) % columns) * 260 + indentation * 20, 130 + row * 130, 220, 86, { kind: diagram === 'treemap' ? 'rectangle' : 'rounded_rectangle' })) }) })
  return specialDocument(source, diagram, elements)
}

function parseMermaidTreemap(source: string, diagram: string): BoardDocument {
  type TreeNode = { id: string; label: string; value?: number; depth: number; children: TreeNode[] }
  const roots: TreeNode[] = [], stack: TreeNode[] = []
  for (const raw of specialLines(source, diagram)) {
    const text = raw.trim(); if (!text || /^(title|classDef|class)\b/i.test(text)) continue
    const depth = Math.floor((raw.match(/^\s*/)?.[0].length || 0) / 2)
    const match = text.match(/^"?(.+?)"?\s*(?::\s*([\d.]+))?$/); if (!match) continue
    const node: TreeNode = { id: makeId(`treemap_${roots.length}_${depth}_${match[1]}`), label: clean(match[1]), value: match[2] ? Number(match[2]) : undefined, depth, children: [] }
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop()
    if (stack.at(-1)) stack.at(-1)!.children.push(node); else roots.push(node)
    stack.push(node)
  }
  const weight = (node: TreeNode): number => node.value || (node.children.length ? node.children.reduce((sum, child) => sum + weight(child), 0) : 1)
  const elements: BoardElement[] = []
  const draw = (node: TreeNode, x: number, y: number, width: number, height: number, index: number, vertical: boolean): number => {
    const isContainer = node.children.length > 0
    const id = node.id
    elements.push(specialCard(diagram, { id, label: node.value === undefined ? node.label : `${node.label}\n${node.value}` }, index, x, y, width, height, { kind: isContainer ? 'frame' : 'rectangle', fill: isContainer ? '#f8fafc' : palette[index % palette.length], fillOpacity: isContainer ? .6 : 1, strokeStyle: isContainer ? 'dashed' : 'solid', textAlign: isContainer ? 'left' : 'center', verticalAlign: isContainer ? 'top' : 'middle', fontSize: isContainer ? 15 : 14, metadata: { mermaidDiagram: diagram, mermaidTreemapContainer: isContainer } }))
    if (!isContainer) return index + 1
    const padding = 22, header = 30, total = node.children.reduce((sum, child) => sum + weight(child), 0); let cursor = vertical ? y + header : x + padding
    let nextIndex = index + 1
    node.children.forEach(child => {
      const ratio = weight(child) / Math.max(1, total)
      const childWidth = vertical ? Math.max(72, width - padding * 2) : Math.max(82, (width - padding * 2) * ratio)
      const childHeight = vertical ? Math.max(58, (height - header - padding) * ratio) : Math.max(64, height - header - padding)
      nextIndex = draw(child, vertical ? x + padding : cursor, vertical ? cursor : y + header, childWidth, childHeight, nextIndex, !vertical)
      cursor += (vertical ? childHeight : childWidth) + 4
    })
    return nextIndex
  }
  if (roots.length === 1) draw(roots[0], 96, 100, 760, 480, 0, false)
  else roots.forEach((root, index) => draw(root, 96 + index * (760 / Math.max(1, roots.length)), 100, 740 / Math.max(1, roots.length), 480, index, true))
  return specialDocument(source, diagram, elements)
}

function parseMermaidRadar(source: string, diagram: string): BoardDocument {
  const axes = specialLines(source, diagram).map(line => line.trim().match(/^axis\s+([^,]+)/i)?.[1]).filter((axis): axis is string => Boolean(axis)); const curves = specialLines(source, diagram).map(line => line.trim().match(/^curve\s+(.+?)\s*\{\s*([^}]+)\s*\}/i)).filter((curve): curve is RegExpMatchArray => Boolean(curve)); const elements: BoardElement[] = [{ id: 'radar_center', kind: 'ellipse', x: 390, y: 320, width: 72, height: 72, text: '指标', fill: '#eff6ff', stroke: '#475569', strokeWidth: 2, fontSize: 14, metadata: { mermaidDiagram: diagram } }]; const edges: BoardEdge[] = []; const centre = { x: 426, y: 356 }
  const axisPoint = (index: number, ratio = 1) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, axes.length); return { x: centre.x + Math.cos(angle) * 240 * ratio, y: centre.y + Math.sin(angle) * 220 * ratio } }
  axes.forEach((axis, index) => { const point = axisPoint(index), id = makeId(`radar_${axis}`); elements.push(specialCard(diagram, { id, label: clean(axis) }, index, point.x - 76, point.y - 26, 152, 52, { kind: 'ellipse', fontSize: 14 })); edges.push(specialEdge(diagram, { from: 'radar_center', to: id }, index, { routing: 'straight', endArrow: 'none' })) })
  curves.forEach((curve, curveIndex) => {
    const values = curve[2].split(',').map(value => Number(value.trim()) || 0)
    const points = axes.map((_, index) => axisPoint(index, Math.max(.08, Math.min(1, (values[index] || 0) / 100))))
    points.forEach((point, index) => elements.push({ id: `radar_curve_${curveIndex}_${index}`, kind: 'ellipse', x: point.x - 7, y: point.y - 7, width: 14, height: 14, text: '', fill: curveIndex % 2 ? '#f59e0b' : '#6366f1', stroke: '#fff', strokeWidth: 1, fontSize: 1, metadata: { mermaidDiagram: diagram, mermaidRadarCurve: curve[1] } }))
    points.forEach((point, index) => { const next = points[(index + 1) % points.length]; edges.push({ id: `radar_curve_edge_${curveIndex}_${index}`, from: '', to: '', freeStart: point, freeEnd: next, stroke: curveIndex % 2 ? '#f59e0b' : '#6366f1', strokeWidth: 2.5, opacity: .78, routing: 'straight', metadata: { mermaidDiagram: diagram, mermaidRadarCurve: curve[1] } }) })
  })
  return specialDocument(source, diagram, elements, edges)
}

/**
 * Mermaid grammars are intentionally dispatched to visual models instead of a
 * shared row/grid fallback. Every grammar supported by Mermaid 11.16 is
 * represented by a recognisable editable board structure.
 */
function parseMermaidSpecialDiagram(source: string, diagram: string): BoardDocument {
  if (/^(classDiagram|erDiagram|requirementDiagram)$/i.test(diagram)) return parseMermaidClassOrEntity(source, diagram)
  if (/^kanban$/i.test(diagram)) return parseMermaidKanban(source, diagram)
  if (/^mindmap$/i.test(diagram)) return parseMermaidMindmap(source, diagram)
  if (/^timeline$/i.test(diagram)) return parseMermaidTimeline(source, diagram)
  if (/^gantt$/i.test(diagram)) return parseMermaidGantt(source, diagram)
  if (/^quadrantChart$/i.test(diagram)) return parseMermaidQuadrant(source, diagram)
  if (/^(pie|xychart-beta)$/i.test(diagram)) return parseMermaidPieOrChart(source, diagram)
  if (/^gitGraph$/i.test(diagram)) return parseMermaidGit(source, diagram)
  if (/^sankey-beta$/i.test(diagram)) return parseMermaidSankey(source, diagram)
  if (/^packet-beta$/i.test(diagram)) return parseMermaidPacket(source, diagram)
  if (/^block-beta$/i.test(diagram)) return parseMermaidBlockOrTree(source, diagram)
  if (/^treemap$/i.test(diagram)) return parseMermaidTreemap(source, diagram)
  if (/^radar$/i.test(diagram)) return parseMermaidRadar(source, diagram)
  if (/^architecture-beta$/i.test(diagram)) return parseMermaidArchitecture(source, diagram)
  if (/^C4(?:Context|Container|Component|Dynamic|Deployment)$/i.test(diagram)) return parseMermaidC4(source, diagram)
  if (/^journey$/i.test(diagram)) return parseMermaidJourney(source, diagram)
  if (/^zenuml$/i.test(diagram)) {
    const parsed = parseMermaidSequenceDiagram(source.replace(/^zenuml/im, 'sequenceDiagram'))
    return { ...parsed, elements: parsed.elements.map(element => ({ ...element, metadata: { ...element.metadata, mermaidDiagram: diagram } })), edges: parsed.edges.map(edge => ({ ...edge, metadata: { ...edge.metadata, mermaidDiagram: diagram } })) }
  }
  // Architecture and C4 have the same visual core: named components and
  // explicit relations. They are a directional system graph, not a card list.
  return graphSpecial(source, diagram, /^(?:Person|System|System_Boundary|Container|Component|Deployment_Node|service|group|junction)\s*\(?(?:\s*)?([\w.-]+)(?:\s*,\s*"?([^,")]+)"?)?/i, /^(?:Rel(?:_\w+)?\s*\()?\s*([\w.-]+)\s*,\s*([\w.-]+)(?:\s*,\s*"?([^,")]+)"?)?\)?/i)
}

/**
 * AI responses sometimes wrap Mermaid in a JSON object (for example
 * `{ "source": "mindmap", "root": ..., "children": [...] }`).  Passing
 * that JSON to the line-oriented Mermaid parser turns object keys such as
 * `source` and numbered branches into fake cards.  Unwrap real DSL strings
 * first and translate the common mindmap AST form into Mermaid indentation.
 */
function unwrapMermaidSource(source: string): string {
  const text = source.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return source
  let value: unknown
  try { value = JSON.parse(text) } catch { return source }
  const known = /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|kanban|xychart-beta|sankey-beta|architecture-beta|block-beta|packet-beta|radar|treemap|C4(?:Context|Container|Component|Dynamic|Deployment)|zenuml)\b/i
  const findDsl = (candidate: unknown): string | undefined => {
    if (typeof candidate === 'string') return known.test(candidate.trim()) ? candidate : undefined
    if (!candidate || typeof candidate !== 'object') return undefined
    for (const child of Object.values(candidate as Record<string, unknown>)) { const found = findDsl(child); if (found) return found }
    return undefined
  }
  const embedded = findDsl(value)
  if (embedded && embedded.trim().split(/\r?\n/).length > 1) return embedded
  if (!value || typeof value !== 'object' || Array.isArray(value)) return source
  const object = value as Record<string, unknown>
  if (String(object.source || object.type || '').toLowerCase() !== 'mindmap') return source
  const labelKeys = ['root', 'title', 'name', 'label', 'text']
  const childKeys = ['children', 'nodes', 'items', 'topics', 'branches']
  const labelOf = (node: Record<string, unknown>) => labelKeys.map(key => node[key]).find(item => typeof item === 'string') as string | undefined
  const childrenOf = (node: Record<string, unknown>) => childKeys.map(key => node[key]).find(item => Array.isArray(item) || (item && typeof item === 'object'))
  const lines = ['mindmap']
  const visit = (node: unknown, depth: number, fallback?: string) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') { lines.push(`${'  '.repeat(depth)}${String(node)}`); return }
    if (Array.isArray(node)) { node.forEach(item => visit(item, depth, undefined)); return }
    if (typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const label = labelOf(record) || fallback
    if (label) lines.push(`${'  '.repeat(depth)}${depth === 0 ? `root((${label}))` : label}`)
    const children = childrenOf(record)
    if (children) { visit(children, depth + 1); return }
    for (const [key, child] of Object.entries(record)) {
      if (['source', 'type', ...labelKeys, ...childKeys, 'metadata'].includes(key)) continue
      if (child && typeof child === 'object') { lines.push(`${'  '.repeat((label ? depth : depth) + 1)}${key}`); visit(child, (label ? depth : depth) + 2) }
      else if (child !== undefined && child !== null) lines.push(`${'  '.repeat((label ? depth : depth) + 1)}${key}: ${String(child)}`)
    }
  }
  const root = labelOf(object)
  if (root) {
    lines.push(`root((${root}))`)
    const children = childrenOf(object)
    if (children) visit(children, 1)
    else for (const [key, child] of Object.entries(object)) if (!['source', 'type', ...labelKeys, ...childKeys, 'metadata'].includes(key)) { lines.push(`  ${key}`); visit(child, 2) }
  } else visit(object, 0)
  return lines.length > 1 ? lines.join('\n') : source
}

export function parseMermaid(source: string): BoardDocument {
  // Text pasted from JSON, chat transcripts, or a code property may contain
  // literal `\\n` characters instead of line feeds. Mermaid's grammar is
  // line-oriented, so normalize before deciding which diagram parser owns it.
  source = unwrapMermaidSource(source.replace(/\r\n?/g, '\n').replace(/\\r\\n|\\n|\\r/g, '\n'))
  if (/^\s*sequenceDiagram\b/im.test(source)) return parseMermaidSequenceDiagram(source)
  if (/^\s*stateDiagram(?:-v2)?\b/im.test(source)) return parseMermaidStateDiagram(source)
  const special = source.match(/^\s*(classDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|kanban|xychart-beta|sankey-beta|architecture-beta|block-beta|packet-beta|radar|treemap|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|zenuml)\b/im)?.[1]
  if (special) return parseMermaidSpecialDiagram(source, special)
  const nodes = new Map<string, MermaidNode>()
  const rawEdges: Array<{ from: string; to: string; label?: string }> = []
  const groups: MermaidGroup[] = []
  const groupStack: string[] = []
  const nodeStyles = new Map<string, Record<string, unknown>>()
  const edgeStyles = new Map<number, Record<string, unknown>>()
  let paletteId = 'macaron'
  let direction = 'LR'
  // Nodes are often declared with a label once and then referenced later as
  // bare ids (`A[Long label] --> B` then `A --> C`). Never let a later bare
  // reference erase the earlier human-readable label.
  const rememberNode = (node: ReturnType<typeof parseNodeToken>) => {
    const existing = nodes.get(node.id)
    if (!existing || existing.label === node.id || node.label !== node.id) {
      nodes.set(node.id, { label: node.label, kind: node.kind, groupId: existing?.groupId || groupStack.at(-1) })
    }
    const groupId = nodes.get(node.id)?.groupId
    const group = groupId ? groups.find(item => item.id === groupId) : undefined
    if (group && !group.members.includes(node.id)) group.members.push(node.id)
  }
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    const paletteDirective = line.match(/^%%\s*tugo:palette\s+(\S+)/)
    if (paletteDirective) { paletteId = paletteDirective[1]; continue }
    const directive = line.match(styleDirective)
    if (directive) { const value = safeJson(directive[3]); if (value) directive[1] === 'node' ? nodeStyles.set(makeId(directive[2]), value) : edgeStyles.set(Number(directive[2]), value); continue }
    const chart = line.match(/^(?:graph|flowchart)\s+(\w+)/i)
    if (chart) { direction = chart[1]; continue }
    if (!line || line.startsWith('%%') || /^(style|linkStyle|classDef|class)\b/i.test(line)) continue
    if (/^end$/i.test(line)) { groupStack.pop(); continue }
    const subgraph = line.match(/^subgraph\s+(.+)$/i)
    if (subgraph) {
      const token = parseNodeToken(subgraph[1])
      const id = token.id === subgraph[1].trim() ? makeId(`group_${groups.length + 1}`) : token.id
      groups.push({ id, label: token.label === token.id ? clean(subgraph[1]) : token.label, members: [] })
      groupStack.push(id)
      continue
    }
    // Split an arbitrary Mermaid chain, including `A --> B --> C` and
    // fan-in forms such as `A & B --> C`. Connector labels stay on the
    // connector that introduced the target segment.
    const connector = /(?:-->|---|-.->|==>|--x|--o)(?:\s*\|([^|]*)\|)?/g
    const segments: string[] = []
    const labels: Array<string | undefined> = []
    let cursor = 0, match: RegExpExecArray | null
    while ((match = connector.exec(line))) {
      segments.push(line.slice(cursor, match.index).trim())
      labels.push(match[1]?.trim())
      cursor = match.index + match[0].length
    }
    if (segments.length) {
      segments.push(line.slice(cursor).trim())
      let previous = segments[0].split(/\s*&\s*/).filter(Boolean).map(parseNodeToken)
      previous.forEach(rememberNode)
      for (let index = 1; index < segments.length; index++) {
        const next = segments[index].split(/\s*&\s*/).filter(Boolean).map(parseNodeToken)
        next.forEach(rememberNode)
        for (const from of previous) for (const to of next) rawEdges.push({ from: from.id, to: to.id, label: labels[index - 1] })
        previous = next
      }
      continue
    }
    const node = parseNodeToken(line)
    rememberNode(node)
  }
  const elements = layoutMermaid(nodes, rawEdges, groups, direction).map(element => ({ ...element, ...(nodeStyles.get(element.id) || {}) } as BoardElement))
  const idMap = new Map([...nodes.keys()].map(id => [id, makeId(id)]))
  const edges: BoardEdge[] = rawEdges.map((edge, index) => ({
    id: `edge_${index}_${idMap.get(edge.from)}_${idMap.get(edge.to)}`,
    from: idMap.get(edge.from)!,
    to: idMap.get(edge.to)!,
    label: edge.label,
    stroke: '#64748b',
    strokeWidth: 2,
    arrowEnd: true, ...(edgeStyles.get(index) || {}),
  }))
  return { ...emptyDocument(), paletteId, elements, edges, dsl: { kind: 'mermaid', source, updatedAt: new Date().toISOString() } }
}

export function parsePlantUml(source: string): BoardDocument {
  const nodes = new Map<string, { label: string; kind: BoardElement['kind'] }>()
  const rawEdges: Array<{ from: string; to: string; label?: string }> = []
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("'") || line.startsWith('@')) continue
    const declaration = line.match(/^(actor|component|class|interface|database|node|rectangle|usecase)\s+(?:"([^"]+)"\s+as\s+)?([\w.-]+)/i)
    if (declaration) {
      const kind = /actor/i.test(declaration[1]) ? 'actor' : /usecase/i.test(declaration[1]) ? 'ellipse' : /database/i.test(declaration[1]) ? 'database' : 'rectangle'
      nodes.set(declaration[3], { label: declaration[2] || declaration[3], kind })
      continue
    }
    const edge = line.match(/^([\w.-]+)\s*(?:-->|->|\.\.>|--|<-+)\s*([\w.-]+)(?:\s*:\s*(.+))?$/)
    if (edge) {
      if (!nodes.has(edge[1])) nodes.set(edge[1], { label: edge[1], kind: 'rectangle' })
      if (!nodes.has(edge[2])) nodes.set(edge[2], { label: edge[2], kind: 'rectangle' })
      rawEdges.push({ from: edge[1], to: edge[2], label: edge[3] })
    }
  }
  const elements = layoutNodes(nodes)
  const edges = rawEdges.map((edge, index): BoardEdge => ({
    id: `edge_${index}_${makeId(edge.from)}_${makeId(edge.to)}`,
    from: makeId(edge.from), to: makeId(edge.to), label: edge.label,
    stroke: '#64748b', strokeWidth: 2, arrowEnd: true,
  }))
  return { ...emptyDocument(), elements, edges, dsl: { kind: 'plantuml', source, updatedAt: new Date().toISOString() } }
}

export function parseDrawIo(source: string): BoardDocument {
  const xml = new DOMParser().parseFromString(source, 'application/xml')
  if (xml.querySelector('parsererror')) throw new Error('draw.io XML 格式不正确')
  const cells = [...xml.querySelectorAll('mxCell')]
  const elements: BoardElement[] = cells.filter(cell => cell.getAttribute('vertex') === '1').map((cell, index) => {
    const geometry = cell.querySelector('mxGeometry')
    const style = mxStyle(cell.getAttribute('style'))
    const shape = style.shape || ''
    const kind: BoardElement['kind'] = shape.includes('cylinder') ? 'database' : shape.includes('cloud') ? 'cloud' : shape.includes('actor') ? 'actor' : style.rhombus === '1' ? 'diamond' : style.ellipse === '1' ? 'ellipse' : style.rounded === '1' ? 'rounded_rectangle' : 'rectangle'
    return {
      id: cell.getAttribute('id') || `drawio_${index}`,
      kind,
      x: Number(geometry?.getAttribute('x') || index * 220),
      y: Number(geometry?.getAttribute('y') || 100),
      width: Number(geometry?.getAttribute('width') || 180),
      height: Number(geometry?.getAttribute('height') || 80),
      text: cell.getAttribute('value')?.replace(/<[^>]+>/g, '') || '节点',
      fill: style.fillColor ? `#${style.fillColor.replace(/^#/, '')}` : palette[index % palette.length],
      stroke: style.strokeColor ? `#${style.strokeColor.replace(/^#/, '')}` : '#334155',
      strokeWidth: Number(style.strokeWidth || 2), strokeStyle: style.dashed === '1' ? 'dashed' : 'solid',
      fillOpacity: Number(style.fillOpacity || 100) / 100, opacity: Number(style.opacity || 100) / 100,
      textColor: style.fontColor ? `#${style.fontColor.replace(/^#/, '')}` : '#263145', fontSize: Number(style.fontSize || 16), zIndex: index,
      metadata: { drawIoStyle: cell.getAttribute('style') || '' },
    }
  })
  const edges: BoardEdge[] = cells.filter(cell => cell.getAttribute('edge') === '1' && cell.getAttribute('source') && cell.getAttribute('target')).map((cell, index) => {
    const style = mxStyle(cell.getAttribute('style'))
    const arrow = (value?: string) => !value || value === 'none' ? 'none' as const : value.includes('diamond') ? 'diamond' as const : value.includes('oval') ? 'circle' as const : value.includes('block') ? 'triangle' as const : 'arrow' as const
    return { id: cell.getAttribute('id') || `drawio_edge_${index}`, from: cell.getAttribute('source')!, to: cell.getAttribute('target')!, label: cell.getAttribute('value') || '',
      stroke: style.strokeColor ? `#${style.strokeColor.replace(/^#/, '')}` : '#64748b', strokeWidth: Number(style.strokeWidth || 2), strokeStyle: style.dashed === '1' ? 'dashed' : 'solid',
      startArrow: arrow(style.startArrow), endArrow: style.endArrow === undefined ? 'arrow' : arrow(style.endArrow), routing: style.edgeStyle?.includes('orthogonal') ? 'elbow' : style.curved === '0' ? 'straight' : 'curve', opacity: Number(style.opacity || 100) / 100, zIndex: index }
  })
  return { ...emptyDocument(), elements, edges, dsl: { kind: 'drawio', source, updatedAt: new Date().toISOString() } }
}

export function parseDsl(kind: DslKind, source: string) {
  if (kind === 'mermaid') return parseMermaid(source)
  if (kind === 'plantuml') return parsePlantUml(source)
  return parseDrawIo(source)
}

/** Add a parsed DSL diagram without replacing the current board. */
export function insertDslDocument(current: BoardDocument, imported: BoardDocument): BoardDocument {
  if (!imported.elements.length) throw new Error('DSL 中没有可渲染的图形。')

  const existing = current.elements
  const importedLeft = Math.min(...imported.elements.map(item => item.x))
  const importedTop = Math.min(...imported.elements.map(item => item.y))
  const existingRight = existing.length ? Math.max(...existing.map(item => item.x + item.width)) : 0
  const existingTop = existing.length ? Math.min(...existing.map(item => item.y)) : 0
  // Keep the DSL's native layout on an empty board. Otherwise put it alongside
  // existing content, rather than covering or replacing that content.
  const offsetX = existing.length ? existingRight + 140 - importedLeft : 0
  const offsetY = existing.length ? existingTop - importedTop : 0
  const maxZIndex = Math.max(-1, ...existing.map(item => item.zIndex ?? 0), ...current.edges.map(item => item.zIndex ?? 0))

  // Parsers deliberately use stable ids while resolving DSL edges. Remap all
  // of them at insertion time so repeated imports remain independent.
  const elementIds = new Map(imported.elements.map(item => [item.id, newId('dsl_node')]))
  const groupIds = new Map<string, string>()
  const remapGroup = (groupId?: string) => {
    if (!groupId) return undefined
    if (!groupIds.has(groupId)) groupIds.set(groupId, newId('dsl_group'))
    return groupIds.get(groupId)
  }
  const elements = imported.elements.map((item, index) => ({
    ...item,
    id: elementIds.get(item.id)!,
    x: item.x + offsetX,
    y: item.y + offsetY,
    groupId: remapGroup(item.groupId),
    zIndex: maxZIndex + 1 + index,
    metadata: { ...item.metadata, importedFromDsl: imported.dsl?.kind || 'dsl' },
  }))
  const edges: BoardEdge[] = imported.edges
    // Sequence lifelines and timed messages are deliberately loose edges:
    // their endpoints sit on a specific time position, rather than on a
    // participant card's generic anchor. Retain them during DSL insertion.
    .filter(edge => (elementIds.has(edge.from) || edge.freeStart) && (elementIds.has(edge.to) || edge.freeEnd))
    .map((edge, index) => ({
      ...edge,
      id: newId('dsl_edge'),
      from: elementIds.get(edge.from) || '',
      to: elementIds.get(edge.to) || '',
      freeStart: edge.freeStart ? { x: edge.freeStart.x + offsetX, y: edge.freeStart.y + offsetY } : undefined,
      freeEnd: edge.freeEnd ? { x: edge.freeEnd.x + offsetX, y: edge.freeEnd.y + offsetY } : undefined,
      controlPoints: edge.controlPoints?.map(point => ({ x: point.x + offsetX, y: point.y + offsetY })),
      zIndex: maxZIndex + 1 + elements.length + index,
      metadata: { ...edge.metadata, importedFromDsl: imported.dsl?.kind || 'dsl' },
    }))

  return {
    ...current,
    elements: [...current.elements, ...elements],
    edges: [...current.edges, ...edges],
    // A board can contain several DSL imports. Preserve a prior source; on an
    // empty board, retain the imported source for the familiar edit workflow.
    dsl: current.dsl || imported.dsl,
  }
}

export function toMermaid(document: BoardDocument) {
  const lines = ['flowchart LR']
  for (const element of document.elements) {
    const label = element.text.replace(/[\[\]]/g, '')
    if (element.kind === 'diamond') lines.push(`  ${element.id}{${label}}`)
    else if (element.kind === 'ellipse') lines.push(`  ${element.id}((${label}))`)
    else if (element.kind === 'rounded_rectangle') lines.push(`  ${element.id}(${label})`)
    else lines.push(`  ${element.id}[${label}]`)
  }
  for (const edge of document.edges) lines.push(`  ${edge.from} -->${edge.label ? `|${edge.label}|` : ''} ${edge.to}`)
  lines.push('', `  %% tugo:palette ${document.paletteId || 'macaron'}`, '  %% TuGo 可编辑样式：图形、尺寸、主题色、透明度、边框和图层')
  for (const element of document.elements) {
    const dash = element.strokeStyle === 'dashed' ? '10 7' : element.strokeStyle === 'dotted' ? '2 6' : '0'
    lines.push(`  style ${element.id} fill:${element.fill},stroke:${element.stroke},stroke-width:${element.strokeWidth}px,stroke-dasharray:${dash},fill-opacity:${element.fillOpacity ?? 1}`)
    lines.push(`  %% tugo:node ${element.id} ${JSON.stringify(nodeStyle(element))}`)
  }
  document.edges.forEach((edge, index) => {
    const dash = edge.strokeStyle === 'dashed' || edge.dashed ? '10 7' : edge.strokeStyle === 'dotted' ? '2 6' : '0'
    lines.push(`  linkStyle ${index} stroke:${edge.stroke},stroke-width:${edge.strokeWidth}px,stroke-dasharray:${dash},opacity:${edge.opacity ?? 1}`)
    lines.push(`  %% tugo:edge ${index} ${JSON.stringify(edgeStyle(edge))}`)
  })
  return lines.join('\n')
}
