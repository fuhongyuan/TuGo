import { useRef, useState } from 'react'
import { newId, type PresentationArea } from '../types'
import type { ViewportState } from '../lib/miniMapGeometry'

type Point = { x: number; y: number }
type Gesture = { pointerId: number; start: Point; area: PresentationArea; mode: 'draw' | 'move' | 'resize' }

export function PresentationAreaEditor({ areas, viewport, onChange, onClose }: {
  areas: PresentationArea[]; viewport: ViewportState
  onChange: (areas: PresentationArea[]) => void; onClose: () => void
}) {
  const surface = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [draft, setDraft] = useState<PresentationArea | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [drawing, setDrawing] = useState(!areas.length)
  const active = areas.find(area => area.id === selected)
  const point = (event: React.PointerEvent): Point => {
    const rect = surface.current!.getBoundingClientRect()
    return { x: (event.clientX - rect.left - viewport.x) / viewport.zoom, y: (event.clientY - rect.top - viewport.y) / viewport.zoom }
  }
  const begin = (event: React.PointerEvent, area?: PresentationArea, resize = false) => {
    if (event.button !== 0) return
    event.stopPropagation(); event.preventDefault()
    const start = point(event)
    if (drawing || !area) {
      if (!drawing) { setSelected(null); return }
      area = { id: newId('slide'), name: `Slide ${areas.length + 1}`, bounds: { ...start, width: 0, height: 0 } }
      gesture.current = { pointerId: event.pointerId, start, area, mode: 'draw' }
    } else gesture.current = { pointerId: event.pointerId, start, area, mode: resize ? 'resize' : 'move' }
    setSelected(area.id); setDraft(area)
    surface.current!.setPointerCapture(event.pointerId)
  }
  const update = (event: React.PointerEvent) => {
    const g = gesture.current
    if (!g || event.pointerId !== g.pointerId) return null
    const end = point(event), dx = end.x - g.start.x, dy = end.y - g.start.y, b = g.area.bounds
    const bounds = g.mode === 'draw'
      ? { x: Math.min(g.start.x, end.x), y: Math.min(g.start.y, end.y), width: Math.abs(dx), height: Math.abs(dy) }
      : g.mode === 'move' ? { ...b, x: b.x + dx, y: b.y + dy }
        : { ...b, width: Math.max(10 / viewport.zoom, b.width + dx), height: Math.max(10 / viewport.zoom, b.height + dy) }
    return { ...g.area, bounds }
  }
  const cancel = () => { gesture.current = null; setDraft(null) }
  const reorder = (direction: number) => {
    const index = areas.findIndex(area => area.id === selected), target = index + direction
    if (index < 0 || target < 0 || target >= areas.length) return
    const next = [...areas]; [next[index], next[target]] = [next[target], next[index]]; onChange(next)
  }
  const shown = areas.map(area => draft?.id === area.id ? draft : area)
  if (draft && !areas.some(area => area.id === draft.id)) shown.push(draft)
  return <div ref={surface} className={`slide-editor ${drawing ? 'is-drawing' : ''}`} aria-label="Presentation area editor"
    onPointerDown={event => begin(event)} onPointerMove={event => { event.stopPropagation(); const next = update(event); if (next) setDraft(next) }}
    onPointerUp={event => {
      event.stopPropagation()
      const next = update(event), g = gesture.current
      if (next && g && next.bounds.width * viewport.zoom >= 10 && next.bounds.height * viewport.zoom >= 10) {
        if (g.mode === 'draw') onChange([...areas, next])
        else if (JSON.stringify(next.bounds) !== JSON.stringify(g.area.bounds)) onChange(areas.map(area => area.id === next.id ? next : area))
        setDrawing(false)
      }
      cancel()
      if (surface.current?.hasPointerCapture(event.pointerId)) surface.current.releasePointerCapture(event.pointerId)
    }} onPointerCancel={cancel} onLostPointerCapture={cancel}
    onDoubleClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
    onDrop={event => { event.preventDefault(); event.stopPropagation() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); onClose() } }}>
    {shown.map((area, index) => <div key={area.id} data-slide-id={area.id} className={`slide-editor-area ${selected === area.id ? 'selected' : ''}`}
      style={{ left: viewport.x + area.bounds.x * viewport.zoom, top: viewport.y + area.bounds.y * viewport.zoom, width: area.bounds.width * viewport.zoom, height: area.bounds.height * viewport.zoom }}
      onPointerDown={event => begin(event, area)}>
      <span>{index + 1}. {area.name}</span>
      {selected === area.id && !drawing && <button className="slide-resize" aria-label="Resize presentation area" onPointerDown={event => begin(event, area, true)}/>}
    </div>)}
    <section className="slide-editor-panel glass" onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}>
      <strong>Presentation slides</strong>
      <p>{drawing ? 'Drag a rectangle anywhere to create a slide.' : 'Select an area to move it; drag its corner to resize.'}</p>
      <button type="button" aria-pressed={drawing} onClick={() => { cancel(); setDrawing(value => !value) }}>Draw area</button>
      <select aria-label="Edit slide" value={active?.id || ''} onChange={event => { setSelected(event.target.value || null); setDrawing(false) }}>
        <option value="">{areas.length ? 'Select a slide' : 'No slides yet'}</option>
        {areas.map((area, index) => <option key={area.id} value={area.id}>{index + 1}. {area.name}</option>)}
      </select>
      {active && <>
        <input key={`${active.id}:${active.name}`} aria-label="Slide name" defaultValue={active.name} onBlur={event => {
          const name = event.target.value.trim() || active.name
          if (name !== active.name) onChange(areas.map(area => area.id === active.id ? { ...area, name } : area))
        }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}/>
        <div><button type="button" disabled={areas[0]?.id === active.id} onClick={() => reorder(-1)}>Move earlier</button>
          <button type="button" disabled={areas.at(-1)?.id === active.id} onClick={() => reorder(1)}>Move later</button></div>
        <button type="button" onClick={() => { onChange(areas.filter(area => area.id !== active.id)); setSelected(null) }}>Delete area</button>
      </>}
      <button type="button" onClick={onClose}>Done</button>
    </section>
  </div>
}
