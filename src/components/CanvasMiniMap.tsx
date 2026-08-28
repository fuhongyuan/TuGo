import { useEffect, useMemo, useRef, useState } from 'react'
import { LocateFixed } from 'lucide-react'
import type { BoardDocument } from '../types'
import { contentBounds, miniMapTransform, visibleWorldBounds, type ScreenSize, type ViewportState } from '../lib/miniMapGeometry'

const MAP_SIZE = { width: 184, height: 112 }
const PANEL_SIZE = { width: 196, height: 142 }
const POSITION_KEY = 'tugo.canvas-minimap-position'
const savedPosition = () => {
  try { const value = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null'); return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? value as { x: number; y: number } : null } catch { return null }
}

export function CanvasMiniMap({ document, viewport, screen, onNavigate, onFit }: { document: BoardDocument; viewport: ViewportState; screen: ScreenSize; onNavigate(point: { x: number; y: number }): void; onFit(): void }) {
  const svgRef = useRef<SVGSVGElement>(null), dragging = useRef(false)
  const panelDrag = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(savedPosition)
  const clampPosition = (value: { x: number; y: number }) => ({ x: Math.max(8, Math.min(Math.max(8, screen.width - PANEL_SIZE.width - 8), value.x)), y: Math.max(8, Math.min(Math.max(8, screen.height - PANEL_SIZE.height - 8), value.y)) })
  const panelPosition = clampPosition(position || { x: screen.width - PANEL_SIZE.width - 18, y: screen.height - PANEL_SIZE.height - 18 })
  useEffect(() => { if (position) setPosition(current => current ? clampPosition(current) : current) }, [screen.width, screen.height]) // eslint-disable-line react-hooks/exhaustive-deps
  const content = useMemo(() => contentBounds(document.elements), [document.elements])
  const elementsById = useMemo(() => new Map(document.elements.map(item => [item.id, item])), [document.elements])
  const visible = visibleWorldBounds(viewport, screen)
  const model = useMemo(() => content ? miniMapTransform(content, visible, MAP_SIZE) : null, [content, visible.x, visible.y, visible.width, visible.height])
  if (!content || !model || screen.width <= 0 || screen.height <= 0) return null
  const navigate = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return
    onNavigate(model.invert({ x: (event.clientX - rect.left) * MAP_SIZE.width / rect.width, y: (event.clientY - rect.top) * MAP_SIZE.height / rect.height }))
  }
  const viewportRect = model.rect(visible)
  return <aside className="canvas-minimap" aria-label="画板导航地图" style={{ left: panelPosition.x, top: panelPosition.y }} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <header title="拖动可移动导航地图" onPointerDown={event => { if ((event.target as HTMLElement).closest('button')) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); panelDrag.current = { ...panelPosition, clientX: event.clientX, clientY: event.clientY } }} onPointerMove={event => { const start = panelDrag.current; if (!start) return; setPosition(clampPosition({ x: start.x + event.clientX - start.clientX, y: start.y + event.clientY - start.clientY })) }} onPointerUp={event => { if (!panelDrag.current) return; panelDrag.current = null; try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* capture may already be gone */ } setPosition(current => { if (current) try { localStorage.setItem(POSITION_KEY, JSON.stringify(current)) } catch { /* private storage may be unavailable */ } return current }) }} onPointerCancel={() => { panelDrag.current = null }}><span>画板导航</span><button type="button" title="显示全部内容" aria-label="显示全部画板内容" onPointerDown={event => event.stopPropagation()} onClick={onFit}><LocateFixed size={14}/></button></header>
    <svg ref={svgRef} viewBox={`0 0 ${MAP_SIZE.width} ${MAP_SIZE.height}`} onPointerDown={event => { event.stopPropagation(); dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); navigate(event) }} onPointerMove={event => { if (dragging.current) navigate(event) }} onPointerUp={event => { dragging.current = false; try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* capture may already be gone */ } }} onPointerCancel={() => { dragging.current = false }}>
      <rect className="minimap-surface" width={MAP_SIZE.width} height={MAP_SIZE.height}/>
      <g className="minimap-edges">{document.edges.map(edge => { const from = elementsById.get(edge.from), to = elementsById.get(edge.to); const a = from ? { x: from.x + from.width / 2, y: from.y + from.height / 2 } : edge.freeStart; const b = to ? { x: to.x + to.width / 2, y: to.y + to.height / 2 } : edge.freeEnd; if (!a || !b) return null; const start = model.point(a), end = model.point(b); return <line key={edge.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y}/> })}</g>
      <g className="minimap-elements">{document.elements.map(item => { const rect = model.rect(item); return <rect key={item.id} x={rect.x} y={rect.y} width={Math.max(2.5, rect.width)} height={Math.max(2.5, rect.height)} rx={Math.min(2, rect.width / 5)} className={item.kind === 'frame' || item.metadata?.container ? 'is-frame' : ''}/> })}</g>
      <rect className="minimap-viewport" x={viewportRect.x} y={viewportRect.y} width={Math.max(5, viewportRect.width)} height={Math.max(5, viewportRect.height)} rx="2"/>
    </svg>
  </aside>
}
