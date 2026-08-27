import { GripVertical } from 'lucide-react'
import { useRef, useState } from 'react'
import { arrowStyles, colorPalettes, edgeDefaults, lineStyles, routingStyles } from '../lib/canvasStyle'
import { convertRouteControlPoints } from '../lib/canvasGeometry'
import { resolvedEdgeEndpoints } from '../lib/edgeGeometry'
import type { BoardDocument, BoardEdge, BoardElement, BoardOperation, StrokeStyle } from '../types'

export function CanvasInspector({ document, selectedId, onCommit }: { document: BoardDocument; selectedId: string; onCommit(operations: BoardOperation[]): void }) {
  const element = document.elements.find(item => item.id === selectedId)
  const edge = document.edges.find(item => item.id === selectedId)
  const rootRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  if (!element && !edge) return null
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation()
    const parent = rootRef.current?.parentElement
    const box = rootRef.current?.getBoundingClientRect()
    const parentBox = parent?.getBoundingClientRect()
    if (!parentBox || !box) return
    const currentLeft = position?.left ?? box.left - parentBox.left
    const currentTop = position?.top ?? box.top - parentBox.top
    const offset = { x: event.clientX - parentBox.left - currentLeft, y: event.clientY - parentBox.top - currentTop }
    setDragging(true)
    const move = (moveEvent: PointerEvent) => {
      const width = rootRef.current?.offsetWidth || box.width; const height = rootRef.current?.offsetHeight || box.height
      const left = Math.max(8, Math.min(parentBox.width - width - 8, moveEvent.clientX - parentBox.left - offset.x))
      const top = Math.max(8, Math.min(parentBox.height - height - 8, moveEvent.clientY - parentBox.top - offset.y))
      setPosition({ left, top })
    }
    const stop = () => { setDragging(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true })
  }
  return <div ref={rootRef} className={`canvas-inspector glass ${dragging ? 'is-dragging' : ''}`} style={position ? { left: position.left, top: position.top, bottom: 'auto', transform: 'none' } : undefined} onPointerDown={event => event.stopPropagation()}>
    <button className="inspector-drag-handle" title="拖动工具栏" aria-label="拖动工具栏" onPointerDown={startDrag}><GripVertical size={16}/></button>
    {element ? <ElementInspector element={element} document={document} onCommit={onCommit}/> : <EdgeInspector edge={edge!} document={document} onCommit={onCommit}/>} 
  </div>
}

function ElementInspector({ element, document, onCommit }: { element: BoardElement; document: BoardDocument; onCommit(operations: BoardOperation[]): void }) {
  const [paletteId, setPaletteId] = useState(document.paletteId || 'macaron')
  const activePaletteId = document.paletteId || paletteId || 'macaron'
  const palette = colorPalettes.find(item => item.id === activePaletteId) || colorPalettes[0]
  const patch = (value: Partial<BoardElement>) => onCommit([{ op: 'patch_element', id: element.id, patch: value }])
  return <>
    <div className="inspector-group palette-group">
      <select value={activePaletteId} onChange={event => { const nextPaletteId = event.target.value; setPaletteId(nextPaletteId); onCommit([{ op: 'set_palette', paletteId: nextPaletteId }]) }} title="当前工程配色主题">{colorPalettes.map(item => <option value={item.id} key={item.id}>{item.name} · {item.description}</option>)}</select>
      <div className="palette-swatches">{palette.colors.map((color, index) => <button key={index} title={`${palette.name} ${index + 1}`} style={{ background: color.fill, borderColor: color.stroke }} onClick={() => patch({ fill: color.fill, stroke: color.stroke, textColor: color.text })}/>)}</div>
    </div>
    <div className="inspector-group compact-controls">
      <label title="填充透明度"><span>填充</span><input type="range" min="0" max="1" step=".05" value={element.fillOpacity ?? 1} onChange={event => patch({ fillOpacity: Number(event.target.value) })}/><b>{Math.round((element.fillOpacity ?? 1) * 100)}%</b></label>
      <label><span>边框</span><input type="color" value={element.stroke === 'transparent' ? '#ffffff' : element.stroke} onChange={event => patch({ stroke: event.target.value })}/><select value={element.strokeWidth} onChange={event => patch({ strokeWidth: Number(event.target.value) })}>{[0,1,2,3,4,6,8].map(value => <option key={value} value={value}>{value}px</option>)}</select><select value={element.strokeStyle || 'solid'} onChange={event => patch({ strokeStyle: event.target.value as StrokeStyle })}>{lineStyles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    </div>
  </>
}

function EdgeInspector({ edge, document, onCommit }: { edge: BoardEdge; document: BoardDocument; onCommit(operations: BoardOperation[]): void }) {
  const style = edgeDefaults(edge)
  const patch = (value: Partial<BoardEdge>) => onCommit([{ op: 'patch_edge', id: edge.id, patch: value }])
  const changeRouting = (routing: BoardEdge['routing']) => {
    if (!routing || routing === style.routing) return
    const endpoints = resolvedEdgeEndpoints(document.elements, edge)
    const controls = endpoints ? convertRouteControlPoints(style.routing, routing, endpoints.start, endpoints.end, edge.controlPoints || []) : []
    patch({ routing, controlPoints: controls })
  }
  return <>
    <div className="inspector-group edge-controls">
      <label><span>线条</span><input type="color" value={edge.stroke} onChange={event => patch({ stroke: event.target.value })}/><select value={edge.strokeWidth} onChange={event => patch({ strokeWidth: Number(event.target.value) })}>{[1,2,3,4,6,8].map(value => <option key={value} value={value}>{value}px</option>)}</select><select value={style.strokeStyle} onChange={event => patch({ strokeStyle: event.target.value as BoardEdge['strokeStyle'], dashed: false })}>{lineStyles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label><span>起点</span><select value={style.startArrow} onChange={event => patch({ startArrow: event.target.value as BoardEdge['startArrow'], arrowStart: false })}>{arrowStyles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><span>终点</span><select value={style.endArrow} onChange={event => patch({ endArrow: event.target.value as BoardEdge['endArrow'], arrowEnd: false })}>{arrowStyles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><select value={style.routing} onChange={event => changeRouting(event.target.value as BoardEdge['routing'])}>{routingStyles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label><span>透明度</span><input type="range" min=".1" max="1" step=".05" value={style.opacity} onChange={event => patch({ opacity: Number(event.target.value) })}/><b>{Math.round(style.opacity * 100)}%</b></label>
    </div>
  </>
}
