import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { InfiniteCanvas } from '../../src/components/InfiniteCanvas'
import { commit, undo, redo } from '../../src/lib/boardState'
import { emptyDocument, type BoardDocument } from '../../src/types'

const initial: BoardDocument = { ...emptyDocument(), viewport: { x: 0, y: 0, zoom: 1 }, elements: [
  { id: 'a', kind: 'rectangle', x: 100, y: 180, width: 180, height: 100, text: 'Editable card', fill: '#fff', stroke: '#334155', strokeWidth: 2, fontSize: 16 },
  { id: 'b', kind: 'rectangle', x: 700, y: 180, width: 180, height: 100, text: 'Target', fill: '#fff', stroke: '#334155', strokeWidth: 2, fontSize: 16 },
], edges: [
  { id: 'edge', from: 'a', to: 'b', routing: 'straight', label: 'Edit this label', stroke: '#334155', strokeWidth: 2, endArrow: 'arrow' },
  { id: 'crossing', from: '', to: '', freeStart: { x: 50, y: 210 }, freeEnd: { x: 340, y: 210 }, routing: 'straight', stroke: '#64748b', strokeWidth: 2 },
] }
function Fixture() {
  const [history, setHistory] = useState({ current: initial, past: [] as BoardDocument[], future: [] as BoardDocument[] })
  const [selected, select] = useState<string[]>([])
  const [playback, setPlayback] = useState(false)
  const [generation, setGeneration] = useState(0)
  const noop = () => {}
  Object.assign(window, { corruptViewport: () => {
    setGeneration(n => n + 1); select([])
    setHistory({ current: { ...structuredClone(initial), viewport: { x: NaN, y: Infinity, zoom: NaN } }, past: [], future: [] })
  } })
  Object.assign(window, { switchClipboardBoard: (empty: boolean) => {
    setGeneration(n => n + 1); setPlayback(false); select([])
    setHistory({ current: empty ? { ...emptyDocument(), viewport: { x: 0, y: 0, zoom: 1 } } : structuredClone(initial), past: [], future: [] })
  } })
  Object.assign(window, { canvasTest: { get document() { return history.current }, selected, reset: () => { setHistory({ current: structuredClone(initial), past: [], future: [] }); select([]) }, layers: () => { setGeneration(n => n + 1); setPlayback(false); select([]); setHistory({ current: { ...structuredClone(initial), elements: [{ ...initial.elements[0], id: 'cover', x: 400, y: 410, width: 300, height: 130, text: '', zIndex: 500 }, { ...initial.elements[0], id: 'loose-text', kind: 'text', x: 400, y: 410, width: 300, height: 130, text: 'Independent text', fill: 'transparent', stroke: 'transparent', strokeWidth: 0, zIndex: 0 }, ...initial.elements.map(e => ({ ...e, groupId: 'nested' })), { ...initial.elements[0], id: 'inner', kind: 'frame', x: 70, y: 130, width: 850, height: 200, text: '', zIndex: 50 }, { ...initial.elements[0], id: 'outer', kind: 'frame', x: 40, y: 110, width: 900, height: 250, text: '', zIndex: 100 }] }, past: [], future: [] }) }, curve: () => setHistory(current => ({ ...current, current: { ...current.current, edges: current.current.edges.map(e => e.id === 'edge' ? { ...e, routing: 'curve', controlPoints: [{ x: 490, y: 230 }] } : e) } })), startAi: () => setPlayback(true) } })
  return <InfiniteCanvas key={generation} document={history.current} selectedIds={selected} onSelect={select}
    onCommit={ops => setHistory(current => commit(current, ops))}
    onViewportChange={viewport => setHistory(current => ({ ...current, current: { ...current.current, viewport } }))}
    onUndo={() => setHistory(undo)} onRedo={() => setHistory(redo)} canUndo={!!history.past.length} canRedo={!!history.future.length}
    onAddImage={noop} onDropImages={noop} onExportRegion={noop} onBatchExportRegions={noop} onAddToChat={noop}
    aiPlayback={playback ? { id: 'fixture-playback', projectId: 'fixture', base: initial, operations: Array.from({ length: 30 }, (_, i) => ({ op: 'add_element' as const, element: { ...initial.elements[0], id: `ai-${i}`, x: 2500 + i * 300 } })) } : null}/>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
