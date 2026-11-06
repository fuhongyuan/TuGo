import { layoutNodeText } from '../lib/textLayout'
import {sceneObstacles} from '../lib/sceneObstacles'
import { registerRenderProbe, trackBoardVersion } from '../lib/boardObservation'
import { documentEdgeRoutes, resolveEdgeRoute, routePath } from '../lib/edgeRoute'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Circle, Cloud, CopyPlus, Cylinder, Diamond, Frame, Hand, Hexagon, ImagePlus, Minus, MousePointer2, PanelTop, Play, Redo2, Scan, Square, StickyNote, Triangle, Type, Undo2, UserRound, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { BoardDocument, BoardEdge, BoardElement, BoardOperation, CanvasReference, ElementKind } from '../types'
import { newId } from '../types'
import type { ExportRegion } from '../lib/exportDocument'
import { edgeDefaults, elementStyle, strokeDasharray } from '../lib/canvasStyle'
import { containsElement, dragSelection, elementLayers, duplicateOperations, groupOperations, layerOperations, patchSelected, selectionForElement, ungroupOperations } from '../lib/boardCommands'
import { CanvasContextMenu } from './CanvasContextMenu'
import { canvasClipboard } from '../lib/canvasClipboard'
import { normalizeViewport, zoomViewport } from '../lib/viewport'
import { normalizePresentationAreas } from '../lib/presentationAreas'
import { PresentationAreaEditor } from './PresentationAreaEditor'
import { edgeAttachmentForPoint, edgeAttachmentPoint, edgeAttachmentTargetAt, resolvedEdgeAnchor, resolvedEdgeEndpoints } from '../lib/edgeGeometry'
import { applyBoardOperations } from '../lib/boardState'
import { defaultCurveControl, edgeLabelLines, edgeLabelSize, orthogonalControlPoints, placeEdgeLabel, remapControlPoints, sampledEdgePoints, type CanvasRect } from '../lib/canvasGeometry'
import { boundsForElements, groupResizeOperations, resizedGroupBounds, type GroupBounds, type GroupResizeHandle } from '../lib/groupResize'
import { contentBounds, fitViewportToContent, shouldShowMiniMap, visibleWorldBounds, type ViewportState } from '../lib/miniMapGeometry'
import { CanvasMiniMap } from './CanvasMiniMap'
import { AiCursorGlyph } from './AiCursorGlyph'
import type { DrawingCursorStyle } from '../types'

type Tool = 'select' | 'hand' | ElementKind | 'edge' | 'export' | 'batch_export'
type Point = { x: number; y: number }
type ConnectionPort = { id: string; x: number; y: number }
type ResizeHandle = GroupResizeHandle
type Rect = { x: number; y: number; width: number; height: number }
type AlignmentGuide = { axis: 'x' | 'y'; position: number; start: number; end: number }
type DistanceGuide = { axis: 'x' | 'y'; from: number; to: number; at: number; label: string }
type DragAssist = { delta: Point; bounds: Rect; guides: AlignmentGuide[]; distances: DistanceGuide[] }
/** A playback projection is transient, but it must never cross a board boundary. */
export type AiCanvasPlayback = { id: string; projectId: string; base: BoardDocument; operations: BoardOperation[]; label?: string }
export type AiCanvasWork = { id: string; label: string; anchor?: Point }

type Props = {
  projectId?: string
  document: BoardDocument
  onCommit: (operations: BoardOperation[]) => void
  onViewportChange?: (viewport: ViewportState) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onExportRegion: (region: ExportRegion) => void
  onBatchExportRegions: (regions: ExportRegion[]) => void
  onAddImage: (point: Point) => void | Promise<void>
  onDropImages: (paths: string[], point: Point) => void | Promise<void>
  imageSources?: Record<string, string>
  exportModeRequest?: number
  aiPlayback?: AiCanvasPlayback | null
  aiWork?: AiCanvasWork | null
  onAiPlaybackComplete?: (id: string) => void
  onAddToChat: (references: CanvasReference[]) => void
  cursorStyle?: DrawingCursorStyle
  cursorColor?: string
  onPresentationChange?: (active: boolean) => void
}

const defaults: Record<ElementKind, Pick<BoardElement, 'width' | 'height' | 'fill' | 'stroke'>> = {
  rectangle: { width: 190, height: 96, fill: '#DBEAFE', stroke: '#3B82F6' },
  rounded_rectangle: { width: 190, height: 96, fill: '#DFE7FD', stroke: '#657CB8' },
  ellipse: { width: 180, height: 105, fill: '#E2ECE9', stroke: '#5E8F82' },
  diamond: { width: 170, height: 120, fill: '#FFF1C7', stroke: '#B38B32' },
  triangle: { width: 170, height: 130, fill: '#FDE2E4', stroke: '#C96D75' },
  hexagon: { width: 190, height: 110, fill: '#E4E0EC', stroke: '#6C6084' },
  database: { width: 170, height: 125, fill: '#D9E8E5', stroke: '#477A70' },
  cloud: { width: 190, height: 115, fill: '#DBEAFE', stroke: '#3B82F6' },
  actor: { width: 110, height: 150, fill: 'transparent', stroke: '#475569' },
  frame: { width: 340, height: 240, fill: 'transparent', stroke: '#64748B' },
  text: { width: 180, height: 48, fill: 'transparent', stroke: 'transparent' },
  note: { width: 190, height: 130, fill: '#FFF1C7', stroke: '#B38B32' },
  image: { width: 240, height: 160, fill: '#F1F5F9', stroke: '#64748B' },
}

const toolbar = [
  { id: 'select', label: '选择 V', icon: MousePointer2 }, { id: 'hand', label: '抓手 H', icon: Hand },
  { id: 'rectangle', label: '矩形 R', icon: Square }, { id: 'rounded_rectangle', label: '圆角矩形', icon: PanelTop },
  { id: 'ellipse', label: '椭圆 O', icon: Circle }, { id: 'diamond', label: '菱形 D', icon: Diamond },
  { id: 'triangle', label: '三角形', icon: Triangle }, { id: 'hexagon', label: '六边形', icon: Hexagon },
  { id: 'database', label: '数据库', icon: Cylinder }, { id: 'cloud', label: '云', icon: Cloud },
  { id: 'actor', label: '角色', icon: UserRound }, { id: 'frame', label: '容器/分组', icon: Frame },
  { id: 'note', label: '便签 N', icon: StickyNote }, { id: 'text', label: '文本 T', icon: Type },
  { id: 'edge', label: '连线 C', icon: Minus },
  { id: 'export', label: '框选导出', icon: Scan },
  { id: 'batch_export', label: '批量框选', icon: CopyPlus },
  { id: 'image_import', label: '添加图片', icon: ImagePlus },
] as const

const handles: Array<{ id: ResizeHandle; x: number; y: number }> = [
  { id: 'nw', x: 0, y: 0 }, { id: 'n', x: .5, y: 0 }, { id: 'ne', x: 1, y: 0 }, { id: 'e', x: 1, y: .5 },
  { id: 'se', x: 1, y: 1 }, { id: 's', x: .5, y: 1 }, { id: 'sw', x: 0, y: 1 }, { id: 'w', x: 0, y: .5 },
]
const minSize = (kind: ElementKind) => ({ width: kind === 'text' ? 70 : 44, height: kind === 'text' ? 26 : 36 })
const minimumGroupScale = (elements: BoardElement[], handle: ResizeHandle) => Math.min(1, Math.max(.08, ...elements.flatMap(element => {
  const minimum = minSize(element.kind), ratios: number[] = []
  if (handle.includes('e') || handle.includes('w')) ratios.push(minimum.width / Math.max(1, element.width))
  if (handle.includes('n') || handle.includes('s')) ratios.push(minimum.height / Math.max(1, element.height))
  if (handle.length === 2) ratios.push(8 / Math.max(1, element.fontSize))
  return ratios
})))
const boundsOf = (elements: BoardElement[]): Rect => {
  const left = Math.min(...elements.map(item => item.x)), top = Math.min(...elements.map(item => item.y))
  const right = Math.max(...elements.map(item => item.x + item.width)), bottom = Math.max(...elements.map(item => item.y + item.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
const overlaps = (startA: number, endA: number, startB: number, endB: number) => Math.min(endA, endB) - Math.max(startA, startB) > 0
const dragAssistFor = (elements: BoardElement[], movingIds: string[], raw: Point, zoom: number): DragAssist | null => {
  const moving = elements.filter(item => movingIds.includes(item.id)); if (!moving.length) return null
  const bounds = boundsOf(moving); const peers = elements.filter(item => !movingIds.includes(item.id)); const threshold = 7 / Math.max(.18, zoom)
  let dx = raw.x, dy = raw.y
  const moved = () => ({ x: bounds.x + dx, y: bounds.y + dy, width: bounds.width, height: bounds.height })
  const choose = (axis: 'x' | 'y') => {
    const rect = moved(); const own = axis === 'x' ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width] : [rect.y, rect.y + rect.height / 2, rect.y + rect.height]
    let best: { correction: number; position: number; peer: BoardElement } | undefined
    for (const peer of peers) for (const target of axis === 'x' ? [peer.x, peer.x + peer.width / 2, peer.x + peer.width] : [peer.y, peer.y + peer.height / 2, peer.y + peer.height]) for (const source of own) {
      const correction = target - source
      if (Math.abs(correction) > threshold || (best && Math.abs(correction) >= Math.abs(best.correction))) continue
      best = { correction, position: target, peer }
    }
    return best
  }
  const xMatch = choose('x'); if (xMatch) dx += xMatch.correction
  const yMatch = choose('y'); if (yMatch) dy += yMatch.correction
  const finalBounds = moved(); const guides: AlignmentGuide[] = []
  if (xMatch) guides.push({ axis: 'x', position: xMatch.position, start: Math.min(finalBounds.y, xMatch.peer.y) - 18, end: Math.max(finalBounds.y + finalBounds.height, xMatch.peer.y + xMatch.peer.height) + 18 })
  if (yMatch) guides.push({ axis: 'y', position: yMatch.position, start: Math.min(finalBounds.x, yMatch.peer.x) - 18, end: Math.max(finalBounds.x + finalBounds.width, yMatch.peer.x + yMatch.peer.width) + 18 })
  const distances: DistanceGuide[] = []
  const horizontal = peers.filter(peer => overlaps(finalBounds.y, finalBounds.y + finalBounds.height, peer.y, peer.y + peer.height)).map(peer => peer.x + peer.width <= finalBounds.x
    ? { peer, from: peer.x + peer.width, to: finalBounds.x }
    : finalBounds.x + finalBounds.width <= peer.x ? { peer, from: finalBounds.x + finalBounds.width, to: peer.x } : undefined).filter(Boolean) as Array<{ peer: BoardElement; from: number; to: number }>
  const vertical = peers.filter(peer => overlaps(finalBounds.x, finalBounds.x + finalBounds.width, peer.x, peer.x + peer.width)).map(peer => peer.y + peer.height <= finalBounds.y
    ? { peer, from: peer.y + peer.height, to: finalBounds.y }
    : finalBounds.y + finalBounds.height <= peer.y ? { peer, from: finalBounds.y + finalBounds.height, to: peer.y } : undefined).filter(Boolean) as Array<{ peer: BoardElement; from: number; to: number }>
  const nearestX = horizontal.sort((a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from))[0]
  const nearestY = vertical.sort((a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from))[0]
  if (nearestX && Math.abs(nearestX.to - nearestX.from) <= 400) distances.push({ axis: 'x', from: nearestX.from, to: nearestX.to, at: finalBounds.y + finalBounds.height / 2, label: `${Math.round(Math.abs(nearestX.to - nearestX.from))}` })
  if (nearestY && Math.abs(nearestY.to - nearestY.from) <= 400) distances.push({ axis: 'y', from: nearestY.from, to: nearestY.to, at: finalBounds.x + finalBounds.width / 2, label: `${Math.round(Math.abs(nearestY.to - nearestY.from))}` })
  return { delta: { x: dx, y: dy }, bounds: finalBounds, guides, distances }
}
const connectionPorts = (element: BoardElement): ConnectionPort[] => [
  { id: 'n', x: .5, y: 0 }, { id: 'ne', x: 1, y: 0 }, { id: 'e', x: 1, y: .5 }, { id: 'se', x: 1, y: 1 },
  { id: 's', x: .5, y: 1 }, { id: 'sw', x: 0, y: 1 }, { id: 'w', x: 0, y: .5 }, { id: 'nw', x: 0, y: 0 },
]
const quickAddPorts: ConnectionPort[] = [
  { id: 'n', x: .5, y: 0 }, { id: 'e', x: 1, y: .5 }, { id: 's', x: .5, y: 1 }, { id: 'w', x: 0, y: .5 },
]

function resized(element: BoardElement, handle: ResizeHandle, dx: number, dy: number) {
  let { x, y, width, height } = element
  const min = minSize(element.kind)
  if (handle.includes('e')) width = Math.max(min.width, element.width + dx)
  if (handle.includes('s')) height = Math.max(min.height, element.height + dy)
  if (handle.includes('w')) { width = Math.max(min.width, element.width - dx); x = element.x + element.width - width }
  if (handle.includes('n')) { height = Math.max(min.height, element.height - dy); y = element.y + element.height - height }
  return { x, y, width, height }
}

function edgePath(routing: string, x1: number, y1: number, x2: number, y2: number, points: Array<{x:number;y:number}> = []) {
  return routePath(routing, { x: x1, y: y1 }, { x: x2, y: y2 }, points)
}

const isFinitePoint = (value: unknown): value is Point => Boolean(value) && typeof value === 'object'
  && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y)

// The SVG preview and the committed document must resolve missing control points
// in exactly the same way. Otherwise releasing a newly-created handle could write
// a sparse array (for example [undefined, point]) and crash the next render.
function resolvedControlPoints(edge: BoardEdge, routing: string, x1: number, y1: number, x2: number, y2: number, obstacles: CanvasRect[] = [], occupiedRoutes: Point[][] = []): Point[] {
  if (routing === 'polyline') return Array.isArray(edge.controlPoints) ? edge.controlPoints.filter(isFinitePoint).map(point => ({ ...point })) : []
  if (routing === 'elbow' && (!Array.isArray(edge.controlPoints) || !edge.controlPoints.filter(isFinitePoint).length)) return orthogonalControlPoints({ x: x1, y: y1 }, { x: x2, y: y2 }, obstacles, 18, occupiedRoutes)
  const count = routing === 'elbow' ? 2 : routing === 'straight' ? 0 : edge.controlPoints?.length === 2 ? 2 : 1
  const points = Array.isArray(edge.controlPoints) ? edge.controlPoints.filter(isFinitePoint).map(point => ({ ...point })) : []
  if (routing === 'elbow' && points.length) return points
  while (points.length < count) {
    points.push(routing === 'elbow'
      ? (points.length === 0 ? { x: (x1 + x2) / 2, y: y1 } : { x: (x1 + x2) / 2, y: y2 })
      : defaultCurveControl({ x: x1, y: y1 }, { x: x2, y: y2 }))
  }
  return points.slice(0, count)
}

// A quadratic Bézier's actual control point is intentionally off the visible
// stroke. Keep that mathematical detail internal: the editor exposes a handle
// on the curve midpoint, then converts its position back to the Bézier point.
const quadraticMidpoint = (start: Point, control: Point, end: Point): Point => ({
  x: (start.x + 2 * control.x + end.x) / 4,
  y: (start.y + 2 * control.y + end.y) / 4,
})
const quadraticControlForMidpoint = (start: Point, midpoint: Point, end: Point): Point => ({
  x: 2 * midpoint.x - (start.x + end.x) / 2,
  y: 2 * midpoint.y - (start.y + end.y) / 2,
})

// A drag is a temporary board state, not a CSS-like visual offset. Reproject
// manual handles from the old endpoint basis into the new one; averaging the
// endpoint deltas made one-sided moves visibly lag and distorted every bend.
function dragOperationsFor(document: BoardDocument, movingIds: string[], delta: Point): BoardOperation[] {
  if ((!delta.x && !delta.y) || !movingIds.length) return []
  const moving = new Set(movingIds)
  const nextElements = document.elements.map(element => moving.has(element.id) && !element.locked ? { ...element, x: element.x + delta.x, y: element.y + delta.y } : element)
  const operations: BoardOperation[] = document.elements
    .filter(element => moving.has(element.id) && !element.locked)
    .map(element => ({ op: 'patch_element', id: element.id, patch: { x: element.x + delta.x, y: element.y + delta.y } }))
  for (const edge of document.edges) {
    if (moving.has(edge.id) && (!edge.from || moving.has(edge.from)) && (!edge.to || moving.has(edge.to))) {
      operations.push({ op: 'patch_edge', id: edge.id, patch: {
        ...(edge.freeStart && !edge.from ? { freeStart: { x: edge.freeStart.x + delta.x, y: edge.freeStart.y + delta.y } } : {}),
        ...(edge.freeEnd && !edge.to ? { freeEnd: { x: edge.freeEnd.x + delta.x, y: edge.freeEnd.y + delta.y } } : {}),
        controlPoints: (edge.controlPoints || []).map(point => ({ x: point.x + delta.x, y: point.y + delta.y })),
      } })
      continue
    }
    if (!moving.has(edge.from) && !moving.has(edge.to)) continue
    const controls = Array.isArray(edge.controlPoints) ? edge.controlPoints.filter(isFinitePoint) : []
    if (!controls.length) continue // Auto routes are regenerated from their live endpoints.
    const before = resolvedEdgeEndpoints(document.elements, edge), after = resolvedEdgeEndpoints(nextElements, edge)
    if (!before || !after) continue
    const points = (edge.routing || 'curve') === 'elbow' ? [] : remapControlPoints(before.start, before.end, after.start, after.end, controls)
    operations.push({ op: 'patch_edge', id: edge.id, patch: { controlPoints: points } })
  }
  return operations
}

function liveControlPoints(edge: BoardEdge, routing: string, controls: Point[], start: Point, end: Point, liveStart: Point, liveEnd: Point, obstacles: CanvasRect[]): Point[] {
  if (start.x === liveStart.x && start.y === liveStart.y && end.x === liveEnd.x && end.y === liveEnd.y) return controls
  const explicit = (edge.controlPoints || []).filter(isFinitePoint)
  if (!explicit.length || routing === 'elbow') return resolvedControlPoints(edge, routing, liveStart.x, liveStart.y, liveEnd.x, liveEnd.y, obstacles)
  return remapControlPoints(start, end, liveStart, liveEnd, controls)
}

function endpointPatchWithRemappedControls(document: BoardDocument, edge: BoardEdge, patch: Partial<BoardEdge>): Partial<BoardEdge> {
  const controls = (edge.controlPoints || []).filter(isFinitePoint)
  if (!controls.length) return patch
  const before = resolvedEdgeEndpoints(document.elements, edge), after = resolvedEdgeEndpoints(document.elements, { ...edge, ...patch })
  if (!before || !after) return patch
  return { ...patch, controlPoints: (edge.routing || 'curve') === 'elbow' ? [] : remapControlPoints(before.start, before.end, after.start, after.end, controls) }
}

function edgeIntersectsSelection(edge: BoardEdge, elements: BoardElement[], left: number, right: number, top: number, bottom: number) {
  const route = resolveEdgeRoute(edge, elements)
  if (!route) return false
  const points = route.pathPoints
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x))
  const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y))
  return minX <= right && maxX >= left && minY <= bottom && maxY >= top
}

function Shape({ element }: { element: BoardElement }) {
  const { width: w, height: h } = element
  const style = elementStyle(element)
  const pie = element.metadata?.mermaidPieSlice as { start?: number; end?: number } | undefined
  if (pie && Number.isFinite(pie.start) && Number.isFinite(pie.end)) {
    const start = (pie.start! - 90) * Math.PI / 180, end = (pie.end! - 90) * Math.PI / 180
    const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2
    const sx = cx + Math.cos(start) * rx, sy = cy + Math.sin(start) * ry
    const ex = cx + Math.cos(end) * rx, ey = cy + Math.sin(end) * ry
    return <path d={`M ${cx} ${cy} L ${sx} ${sy} A ${rx} ${ry} 0 ${pie.end! - pie.start! > 180 ? 1 : 0} 1 ${ex} ${ey} Z`} {...style}/>
  }
  if (element.kind === 'ellipse') return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...style}/>
  if (element.kind === 'diamond') return <path d={`M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`} {...style}/>
  if (element.kind === 'triangle') return <path d={`M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`} {...style}/>
  if (element.kind === 'hexagon') return <path d={`M ${w * .25} 0 H ${w * .75} L ${w} ${h / 2} L ${w * .75} ${h} H ${w * .25} L 0 ${h / 2} Z`} {...style}/>
  if (element.kind === 'note') return <path d={`M 0 0 H ${w - 28} L ${w} 28 V ${h} H 0 Z M ${w - 28} 0 V 28 H ${w}`} {...style}/>
  if (element.kind === 'database') return <path d={`M 0 16 C 0 -5 ${w} -5 ${w} 16 V ${h - 16} C ${w} ${h + 5} 0 ${h + 5} 0 ${h - 16} Z M 0 16 C 0 37 ${w} 37 ${w} 16 M 0 ${h - 16} C 0 ${h - 37} ${w} ${h - 37} ${w} ${h - 16}`} {...style}/>
  if (element.kind === 'cloud') return <path d={`M ${w*.2} ${h*.78} C ${w*.02} ${h*.78} ${w*.01} ${h*.47} ${w*.21} ${h*.43} C ${w*.2} ${h*.2} ${w*.48} ${h*.1} ${w*.61} ${h*.3} C ${w*.79} ${h*.21} ${w*.96} ${h*.39} ${w*.9} ${h*.55} C ${w*1.05} ${h*.71} ${w*.86} ${h*.85} ${w*.72} ${h*.78} Z`} {...style}/>
  if (element.kind === 'actor') return <g {...style} fill="none"><circle cx={w/2} cy={h*.17} r={Math.min(w,h)*.13}/><path d={`M ${w/2} ${h*.3} V ${h*.65} M ${w*.2} ${h*.43} H ${w*.8} M ${w/2} ${h*.65} L ${w*.22} ${h*.96} M ${w/2} ${h*.65} L ${w*.78} ${h*.96}`}/></g>
  return <rect width={w} height={h} rx={element.kind === 'rounded_rectangle' ? (element.borderRadius ?? 28) : element.kind === 'frame' ? 6 : element.kind === 'text' ? 0 : (element.borderRadius ?? 8)} {...style}/>
}

function InfiniteCanvasComponent({ projectId, document, onCommit, onViewportChange, onUndo, onRedo, canUndo, canRedo, selectedIds, onSelect, onExportRegion, onBatchExportRegions, onAddImage, onDropImages, imageSources = {}, exportModeRequest = 0, aiPlayback = null, aiWork = null, onAiPlaybackComplete, onAddToChat, cursorStyle = 'classic', cursorColor = '#4F46E5', onPresentationChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const [tool, setTool] = useState<Tool>('select')
  const [presenting, setPresenting] = useState(false)
  const areas = useMemo(() => normalizePresentationAreas(document.presentationAreas), [document.presentationAreas])
  const [editingSlides, setEditingSlides] = useState(false)
  const [presentationAreaId, setPresentationAreaId] = useState<string | null>(null)
  const areaIndex = areas.findIndex(area => area.id === presentationAreaId)
  const currentArea = areas[areaIndex]
  const changeArea = (direction: number) => {
    const index = areaIndex < 0 ? (direction > 0 ? 0 : areas.length - 1) : areaIndex + direction
    if (index >= 0 && index < areas.length) { cancelGesture(); setLaserPoint(null); setPresentationAreaId(areas[index].id) }
  }
  const [laser, setLaser] = useState(true)
  const [laserPoint, setLaserPoint] = useState<Point | null>(null)
  const previousTool = useRef<Tool>('select')
  useEffect(() => {
    onPresentationChange?.(presenting)
    return () => onPresentationChange?.(false)
  }, [presenting, onPresentationChange])
  const togglePresentation = () => {
    setEditingSlides(false)
    cancelGesture(); setContextMenu(null); setEdgeSource(null); setFreeEdgeDraft(null); setBatchRegions([])
    setLaserPoint(null); setFollowAi(false)
    if (presenting) { setPresenting(false); setTool(previousTool.current) }
    else { previousTool.current = tool; setTool('hand'); onSelect([]); setLaser(true); setPresentationAreaId(areas[0]?.id || null); setPresenting(true) }
  }
  const [viewport, setViewportRaw] = useState(() => normalizeViewport(document.viewport))
  useEffect(() => {
    if (viewport.x !== document.viewport?.x || viewport.y !== document.viewport?.y || viewport.zoom !== document.viewport?.zoom) onViewportChange?.(viewport)
  }, [viewport, onViewportChange])
  const [isWheeling, setWheeling] = useState(false)
  const wheelTimerRef = useRef<number | null>(null)
  const [miniMapHint, setMiniMapHint] = useState(false)
  const miniMapTimerRef = useRef<number | null>(null)
  // Any viewport change reveals the minimap and arms a timer that hides it
  // once the user stops navigating. Wrapping setViewport here lets every pan,
  // wheel, zoom, fit, and minimap-navigation call site opt in for free.
  const revealMiniMap = () => {
    if (!miniMapHint) setMiniMapHint(true)
    if (miniMapTimerRef.current) window.clearTimeout(miniMapTimerRef.current)
    miniMapTimerRef.current = window.setTimeout(() => setMiniMapHint(false), 2500)
  }
  const setViewport = (next: React.SetStateAction<ViewportState>) => {
    setViewportRaw(current => normalizeViewport(typeof next === 'function' ? next(current) : next, current))
    revealMiniMap()
  }
  useEffect(() => {
    if (!presenting || !currentArea || !canvasSize.width || !canvasSize.height) return
    setViewport(fitViewportToContent(currentArea.bounds, { width: canvasSize.width, height: Math.max(1, canvasSize.height - 64) }))
  }, [presenting, currentArea, canvasSize.width, canvasSize.height])
  const [isSpaceDown, setSpaceDown] = useState(false)
  const [panStart, setPanStart] = useState<{ client: Point; origin: Point } | null>(null)
  const [drawStart, setDrawStart] = useState<Point | null>(null)
  const [drawCurrent, setDrawCurrent] = useState<Point | null>(null)
  const [marquee, setMarquee] = useState<{ start: Point; current: Point; base: string[] } | null>(null)
  const [exportMarquee, setExportMarquee] = useState<{ start: Point; current: Point } | null>(null)
  const [batchRegions, setBatchRegions] = useState<ExportRegion[]>([])
  const [dragStart, setDragStart] = useState<Point | null>(null)
  const [dragIds, setDragIds] = useState<string[]>([])
  const [isolatedElement, setIsolatedElement] = useState<string | null>(null)
  const [dragDelta, setDragDelta] = useState<Point>({ x: 0, y: 0 })
  const [dragAssist, setDragAssist] = useState<DragAssist | null>(null)
  const [resize, setResize] = useState<{ handle: ResizeHandle; start: Point; element: BoardElement; current: Pick<BoardElement, 'x'|'y'|'width'|'height'> } | null>(null)
  const [groupResize, setGroupResize] = useState<{ handle: ResizeHandle; start: Point; bounds: GroupBounds; current: GroupBounds; ids: string[]; minimumScale: number } | null>(null)
  const [edgeSource, setEdgeSource] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [edgeControlDrag, setEdgeControlDrag] = useState<{ edgeId: string; index: number; point: Point } | null>(null)
  const [edgeEndpointDrag, setEdgeEndpointDrag] = useState<{ edgeId: string; endpoint: 'from' | 'to'; point: Point } | null>(null)
  const [connectionDrag, setConnectionDrag] = useState<{ from: string; anchor: Point; point: Point } | null>(null)
  const [freeEdgeDraft, setFreeEdgeDraft] = useState<{ start: Point; points: Point[]; cursor: Point } | null>(null)
  const edgeGestureRef = useRef<{ start: Point; hadDraft: boolean; moved: boolean } | null>(null)
  const [playbackStep, setPlaybackStep] = useState(0)
  const [followAi, setFollowAi] = useState(true)
  const [aiRestPoint, setAiRestPoint] = useState<Point | null>(null)
  const aiWorkIdRef = useRef<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string; kind: 'element' | 'edge'; at?: Point } | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const root = rootRef.current; if (!root) return
    const measure = () => { const rect = root.getBoundingClientRect(); setCanvasSize({ width: rect.width, height: rect.height }) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure); observer.observe(root)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { if (exportModeRequest > 0) { setTool('export'); setEdgeSource(null); setContextMenu(null) } }, [exportModeRequest])
  useEffect(() => () => { if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current); if (miniMapTimerRef.current) window.clearTimeout(miniMapTimerRef.current) }, [])
  useLayoutEffect(() => {
    if (!editing) return
    editorRef.current?.focus()
    editorRef.current?.select()
  }, [editing?.id, editing?.kind])
  useEffect(() => {
    if (!aiPlayback) { setPlaybackStep(0); return }
    setPlaybackStep(0)
    let step = 0; let timer = 0; let cancelled = false
    const advance = () => {
      if (cancelled) return
      step += 1; setPlaybackStep(step)
      if (step >= aiPlayback.operations.length) return
      const operation = aiPlayback.operations[step]
      const delay = operation?.op === 'add_element' ? 260 : operation?.op === 'add_edge' ? 210 : operation?.op === 'replace_document' ? 120 : 150
      timer = window.setTimeout(advance, delay)
    }
    timer = window.setTimeout(advance, 120)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [aiPlayback?.id])
  useEffect(() => {
    if (!aiPlayback || playbackStep < aiPlayback.operations.length) return
    const timer = window.setTimeout(() => onAiPlaybackComplete?.(aiPlayback.id), 360)
    return () => window.clearTimeout(timer)
  }, [aiPlayback, onAiPlaybackComplete, playbackStep])

  const newEdge = (from: string, to: string, fromAnchor?: Point, toAnchor?: Point): BoardEdge => {
    const selected = document.edges.find(edge => selectedIds.includes(edge.id))
    const style = selected || [...document.edges].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))[0]
    return {
      id: newId('edge'), from, to,
      stroke: style?.stroke || '#64748B', strokeWidth: style?.strokeWidth || 2,
      strokeStyle: style?.strokeStyle || 'solid', startArrow: style?.startArrow || (style?.arrowStart ? 'arrow' : 'none'),
      endArrow: style?.endArrow || (style?.arrowEnd ? 'arrow' : 'arrow'), routing: style?.routing || 'curve', opacity: style?.opacity ?? 1,
      zIndex: document.edges.length, ...(fromAnchor ? { fromAnchor } : {}), ...(toAnchor ? { toAnchor } : {}),
    }
  }
  const targetAt = (point: Point, excludedId?: string) => [...document.elements].reverse().find(element => element.id !== excludedId
    && point.x >= element.x - 18 && point.x <= element.x + element.width + 18
    && point.y >= element.y - 18 && point.y <= element.y + element.height + 18)
  const startConnection = (event: React.PointerEvent, element: BoardElement, anchor: Point) => {
    event.stopPropagation(); if (element.locked) return
    rootRef.current?.setPointerCapture(event.pointerId)
    const absolute = edgeAttachmentPoint(element, anchor)
    setConnectionDrag({ from: element.id, anchor, point: absolute }); setEdgeSource(null); onSelect([element.id])
  }
  const addLinkedNode = (event: React.MouseEvent, element: BoardElement, anchor: Point) => {
    event.stopPropagation(); if (element.locked) return
    const dx = anchor.x === 0 ? -1 : anchor.x === 1 ? 1 : 0
    const dy = anchor.y === 0 ? -1 : anchor.y === 1 ? 1 : 0
    const gap = 88
    const copy: BoardElement = { ...structuredClone(element), id: newId('node'), text: '',
      x: element.x + dx * (element.width + gap), y: element.y + dy * (element.height + gap), zIndex: document.elements.length,
    }
    const targetAnchor = { x: anchor.x === 0 ? 1 : anchor.x === 1 ? 0 : anchor.x, y: anchor.y === 0 ? 1 : anchor.y === 1 ? 0 : anchor.y }
    const edge = newEdge(element.id, copy.id, anchor, targetAnchor)
    onCommit([{ op: 'add_element', element: copy }, { op: 'add_edge', edge }]); onSelect([copy.id])
  }
  const finishFreeEdge = (point: Point) => {
    if (!freeEdgeDraft) return
    const samePoint = (value: Point) => Math.abs(value.x - point.x) < .1 && Math.abs(value.y - point.y) < .1
    const controlPoints = freeEdgeDraft.points.filter(value => !samePoint(value))
    const template = document.edges.find(edge => selectedIds.includes(edge.id)) || [...document.edges].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))[0]
    const edge: BoardEdge = {
      id: newId('edge'), from: '', to: '', freeStart: freeEdgeDraft.start, freeEnd: point, controlPoints,
      stroke: template?.stroke || '#64748B', strokeWidth: template?.strokeWidth || 2, strokeStyle: template?.strokeStyle || 'solid',
      startArrow: template?.startArrow || 'none', endArrow: template?.endArrow || 'arrow', routing: 'polyline', opacity: template?.opacity ?? 1, zIndex: document.edges.length,
    }
    onCommit([{ op: 'add_edge', edge }]); onSelect([edge.id]); setFreeEdgeDraft(null); setTool('select')
  }

  const copySelection = () => {
    canvasClipboard.copy(document, selectedIds)
  }
  const pasteSelection = () => {
    const duplicated = canvasClipboard.paste(document, visibleWorldBounds(viewport, canvasSize))
    if (!duplicated.operations.length) return
    onCommit(duplicated.operations); onSelect(duplicated.ids)
  }
  const duplicateSelection = () => { const duplicated = duplicateOperations(document, selectedIds); if (duplicated.operations.length) { onCommit(duplicated.operations); onSelect(duplicated.ids) } }
  const deleteSelection = () => {
    const operations = selectedIds.map(id => ({ op: document.edges.some(item => item.id === id) ? 'delete_edge' : 'delete_element', id } as BoardOperation))
    if (operations.length) onCommit(operations); onSelect([])
  }

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (editingSlides) {
        if (event.key === 'Escape') { event.preventDefault(); setEditingSlides(false) }
        if (!(event.target instanceof HTMLInputElement) && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? onRedo() : onUndo() }
        return
      }
      if (presenting) {
        if (event.target instanceof HTMLSelectElement && event.key !== 'Escape') return
        if (event.key === 'Escape') { event.preventDefault(); togglePresentation() }
        else if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(event.key)) { event.preventDefault(); changeArea(1) }
        else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); changeArea(-1) }
        else if (event.key.toLowerCase() === 'l' && !event.metaKey && !event.ctrlKey) { setLaser(value => !value); setLaserPoint(null) }
        else if (event.key !== 'Tab' && !((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLButtonElement)) event.preventDefault()
        return
      }
      const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable)
      // Let text fields (especially the chat composer) own all keyboard input.
      // Otherwise the canvas shortcuts would consume spaces and letters such as V/R/H.
      if (editable) return
      if (event.code === 'Space') { event.preventDefault(); setSpaceDown(true) }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? onRedo() : onUndo() }
      if (!editable && event.key === 'Escape') { cancelGesture(); setBatchRegions([]); setTool(current => current === 'batch_export' ? 'select' : current); setEdgeSource(null); setContextMenu(null); onSelect([]) }
      if (tool === 'batch_export' && event.key === 'Backspace') { event.preventDefault(); setBatchRegions(current => current.slice(0, -1)) }
      if (tool === 'batch_export' && event.key === 'Enter' && batchRegions.length) { event.preventDefault(); onBatchExportRegions(batchRegions); setBatchRegions([]); setTool('select') }
      const mapping: Record<string, Tool> = { v: 'select', h: 'hand', r: 'rectangle', o: 'ellipse', d: 'diamond', n: 'note', t: 'text', c: 'edge' }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && mapping[event.key.toLowerCase()]) setTool(mapping[event.key.toLowerCase()])
      if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); onSelect([...document.elements.map(item => item.id), ...document.edges.map(edge => edge.id)]) }
      if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelection() }
      if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x') { event.preventDefault(); copySelection(); deleteSelection() }
      if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteSelection() }
      if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection() }
      if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') { event.preventDefault(); onCommit(event.shiftKey ? ungroupOperations(document, selectedIds) : groupOperations(document, selectedIds)) }
      if (!editable && (event.metaKey || event.ctrlKey) && (event.key === ']' || event.key === '[')) { event.preventDefault(); onCommit(layerOperations(document, selectedIds, event.key === ']' ? (event.shiftKey ? 'front' : 'forward') : (event.shiftKey ? 'back' : 'backward'))) }
      if (!editable && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) && selectedIds.length) { event.preventDefault(); const amount=event.shiftKey?10:1; const dx=event.key==='ArrowLeft'?-amount:event.key==='ArrowRight'?amount:0;const dy=event.key==='ArrowUp'?-amount:event.key==='ArrowDown'?amount:0;const operations=patchSelected(document,selectedIds,{}).flatMap(operation=>{if(operation.op!=='patch_element')return[];const item=document.elements.find(element=>element.id===operation.id);return item&&!item.locked?[{...operation,patch:{x:item.x+dx,y:item.y+dy}} as BoardOperation]:[]});if(operations.length)onCommit(operations) }
      if (!editable && (event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length) { event.preventDefault(); deleteSelection() }
    }
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [batchRegions, document, onBatchExportRegions, onCommit, onRedo, onSelect, onUndo, selectedIds, tool, presenting, areaIndex, areas, editingSlides]) // eslint-disable-line react-hooks/exhaustive-deps

  const toWorld = (clientX: number, clientY: number): Point => { const rect = rootRef.current?.getBoundingClientRect() || { left: 0, top: 0 }; return { x: (clientX - rect.left - viewport.x) / viewport.zoom, y: (clientY - rect.top - viewport.y) / viewport.zoom } }
  const beginExport = (event: React.PointerEvent) => { const point=toWorld(event.clientX,event.clientY);rootRef.current?.setPointerCapture(event.pointerId);setExportMarquee({start:point,current:point});onSelect([]) }
  const zoomBy = (factor: number, anchor?: Point) => { setFollowAi(false); const rect = rootRef.current?.getBoundingClientRect(); const point = anchor || { x: (rect?.width || 800) / 2, y: (rect?.height || 600) / 2 }; setViewport(current => zoomViewport(current, factor, point)) }
  const handleWheel = (event: React.WheelEvent) => {
    event.preventDefault()
    setFollowAi(false)
    // Continuous wheel/trackpad input must reach the viewport without the
    // 180ms transform transition, otherwise the canvas perpetually lags the
    // pointer. Lift the transition only while scrolling is active.
    setWheeling(true)
    if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current)
    wheelTimerRef.current = window.setTimeout(() => setWheeling(false), 140)
    if (event.ctrlKey || event.metaKey) zoomBy(Math.exp(-event.deltaY*.003), { x: event.clientX - (rootRef.current?.getBoundingClientRect().left || 0), y: event.clientY - (rootRef.current?.getBoundingClientRect().top || 0) })
    else setViewport(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
  }
  const pointerDownBackground = (event: React.PointerEvent) => {
    setIsolatedElement(null)
    setContextMenu(null)
    if (event.button === 1 || tool === 'hand' || isSpaceDown) setFollowAi(false)
    if (event.button === 2) return
    if (event.button === 1 || tool === 'hand' || isSpaceDown) { rootRef.current?.setPointerCapture(event.pointerId); setPanStart({ client: { x:event.clientX,y:event.clientY }, origin:{ x:viewport.x,y:viewport.y } }); return }
    if (tool === 'export' || tool === 'batch_export') { beginExport(event); return }
    if (tool === 'select') { const point=toWorld(event.clientX,event.clientY);rootRef.current?.setPointerCapture(event.pointerId);setMarquee({start:point,current:point,base:event.shiftKey?selectedIds:[]});if(!event.shiftKey)onSelect([]);return }
    if (tool === 'edge') { const point = toWorld(event.clientX, event.clientY); rootRef.current?.setPointerCapture(event.pointerId); edgeGestureRef.current = { start: point, hadDraft: Boolean(freeEdgeDraft), moved: false }; setFreeEdgeDraft(current => current ? { ...current, points: [...current.points, point], cursor: point } : { start: point, points: [], cursor: point }); onSelect([]); return }
    const point=toWorld(event.clientX,event.clientY); rootRef.current?.setPointerCapture(event.pointerId); setDrawStart(point); setDrawCurrent(point)
  }
  const pointerMove = (event: React.PointerEvent) => {
    if (panStart) setViewport(current => ({ ...current, x:panStart.origin.x+event.clientX-panStart.client.x, y:panStart.origin.y+event.clientY-panStart.client.y }))
    else if (exportMarquee) { const point=toWorld(event.clientX,event.clientY);setExportMarquee(state=>state?{...state,current:point}:null) }
    else if (freeEdgeDraft) { const point = toWorld(event.clientX, event.clientY); const gesture = edgeGestureRef.current; if (gesture && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > 4 / viewport.zoom) gesture.moved = true; setFreeEdgeDraft(current => current ? { ...current, cursor: point } : null) }
    else if (drawStart) setDrawCurrent(toWorld(event.clientX,event.clientY))
    else if (marquee) { const point=toWorld(event.clientX,event.clientY);setMarquee(state=>state?{...state,current:point}:null) }
    else if (resize) { const p=toWorld(event.clientX,event.clientY); setResize(current => current ? { ...current, current: resized(current.element,current.handle,p.x-current.start.x,p.y-current.start.y) } : null) }
    else if (groupResize) { const p=toWorld(event.clientX,event.clientY); setGroupResize(current => current ? { ...current, current: resizedGroupBounds(current.bounds,current.handle,p.x-current.start.x,p.y-current.start.y,current.minimumScale) } : null) }
    else if (edgeEndpointDrag) setEdgeEndpointDrag(current => current ? { ...current, point: toWorld(event.clientX,event.clientY) } : null)
    else if (connectionDrag) setConnectionDrag(current => current ? { ...current, point: toWorld(event.clientX,event.clientY) } : null)
    else if (edgeControlDrag) setEdgeControlDrag(current => current ? { ...current, point: toWorld(event.clientX,event.clientY) } : null)
    else if (dragStart) { const p=toWorld(event.clientX,event.clientY); const assist=dragAssistFor(document.elements,dragIds,{ x:p.x-dragStart.x,y:p.y-dragStart.y },viewport.zoom); setDragDelta(assist?.delta || { x:p.x-dragStart.x,y:p.y-dragStart.y }); setDragAssist(assist) }
  }
  const pointerUp = (event: React.PointerEvent) => {
    if (panStart) setPanStart(null)
    if (exportMarquee) { const x=Math.min(exportMarquee.start.x,exportMarquee.current.x),y=Math.min(exportMarquee.start.y,exportMarquee.current.y),width=Math.abs(exportMarquee.current.x-exportMarquee.start.x),height=Math.abs(exportMarquee.current.y-exportMarquee.start.y); const region={x,y,width,height}; if(width>=8&&height>=8) { if (tool === 'batch_export') setBatchRegions(current => [...current, region]); else { onExportRegion(region); setTool('select') } } setExportMarquee(null) }
    if (marquee) { const left=Math.min(marquee.start.x,marquee.current.x),right=Math.max(marquee.start.x,marquee.current.x),top=Math.min(marquee.start.y,marquee.current.y),bottom=Math.max(marquee.start.y,marquee.current.y);if(right-left>3||bottom-top>3){const elementHits=document.elements.filter(item=>containsElement({...item,x:left,y:top,width:right-left,height:bottom-top,rotation:0},item)).map(item=>item.id);const edgeHits=document.edges.filter(edge=>edgeIntersectsSelection(edge,document.elements,left,right,top,bottom)).map(edge=>edge.id);onSelect([...new Set([...marquee.base,...elementHits,...edgeHits])])}setMarquee(null)}
    const edgeGesture = edgeGestureRef.current
    if (tool === 'edge' && edgeGesture?.moved && !edgeGesture.hadDraft) {
      const end = toWorld(event.clientX, event.clientY)
      const template = document.edges.find(edge => selectedIds.includes(edge.id)) || [...document.edges].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))[0]
      const edge: BoardEdge = { id: newId('edge'), from: '', to: '', freeStart: edgeGesture.start, freeEnd: end, controlPoints: [], stroke: template?.stroke || '#64748B', strokeWidth: template?.strokeWidth || 2, strokeStyle: template?.strokeStyle || 'solid', startArrow: template?.startArrow || 'none', endArrow: template?.endArrow || 'arrow', routing: 'straight', opacity: template?.opacity ?? 1, zIndex: document.edges.length }
      onCommit([{ op: 'add_edge', edge }]); onSelect([edge.id]); setFreeEdgeDraft(null); setTool('select')
    }
    edgeGestureRef.current = null
    if (drawStart && drawCurrent && !['select','hand','edge','export','batch_export'].includes(tool)) {
      const spec=defaults[tool as ElementKind]; const dx=drawCurrent.x-drawStart.x; const dy=drawCurrent.y-drawStart.y
      const width=Math.max(tool==='text'?100:70,Math.abs(dx)||spec.width); const height=Math.max(tool==='text'?36:50,Math.abs(dy)||spec.height)
      const element: BoardElement={ id:newId('node'),kind:tool as ElementKind,x:dx<0?drawStart.x-width:drawStart.x,y:dy<0?drawStart.y-height:drawStart.y,width,height,text:tool==='text'?'双击编辑文本':tool==='note'?'新便签':tool==='frame'?'分组标题':tool==='actor'?'角色':'新节点',fill:spec.fill,stroke:spec.stroke,strokeWidth:2,strokeStyle:'solid',fillOpacity:1,opacity:1,textColor:'#263145',fontSize:tool==='text'?20:16,zIndex:document.elements.length }
      onCommit([{op:'add_element',element}]); onSelect([element.id]); setTool('select')
    }
    const release = toWorld(event.clientX, event.clientY)
    if (resize) onCommit([{ op:'patch_element',id:resize.element.id,patch:resized(resize.element,resize.handle,release.x-resize.start.x,release.y-resize.start.y) }])
    else if (groupResize) { const bounds = resizedGroupBounds(groupResize.bounds,groupResize.handle,release.x-groupResize.start.x,release.y-groupResize.start.y,groupResize.minimumScale); const operations = groupResizeOperations(document, groupResize.ids, groupResize.bounds, bounds); if (operations.length) onCommit(operations) }
    else if (dragStart && dragIds.length) { const delta = { x:release.x-dragStart.x,y:release.y-dragStart.y }; if (Math.hypot(delta.x,delta.y) > 2 / viewport.zoom) { const assist = dragAssistFor(document.elements,dragIds,delta,viewport.zoom); const operations = dragOperationsFor(document, dragIds, assist?.delta || delta); if (operations.length) onCommit(operations) } }
    if (edgeControlDrag) {
      const edge = document.edges.find(item => item.id === edgeControlDrag.edgeId)
      const from = edge && document.elements.find(item => item.id === edge.from)
      const to = edge && document.elements.find(item => item.id === edge.to)
      // Use the pointer-up coordinate, not the last scheduled React state update.
      // A quick drag-and-release otherwise commits the previous frame's position.
      const releasePoint = toWorld(event.clientX, event.clientY)
      if (edge && isFinitePoint(releasePoint)) {
        if ((!from && !edge.freeStart) || (!to && !edge.freeEnd)) { setEdgeControlDrag(null); return }
        const route = documentEdgeRoutes(document.elements, document.edges).get(edge.id)
        if (!route) return
        const { start, end, points } = route
        if (edgeControlDrag.index >= 0 && edgeControlDrag.index < points.length) {
          points[edgeControlDrag.index] = edgeDefaults(edge).routing === 'curve' && points.length === 1 && edgeControlDrag.index === 0
            ? quadraticControlForMidpoint(start, releasePoint, end)
            : releasePoint
          onCommit([{ op: 'patch_edge', id: edge.id, patch: { controlPoints: points, ...(from ? { fromAnchor: edgeAttachmentForPoint(from, start) } : {}), ...(to ? { toAnchor: edgeAttachmentForPoint(to, end) } : {}) } }])
        }
      }
    }
    if (edgeEndpointDrag) {
      const edge = document.edges.find(item => item.id === edgeEndpointDrag.edgeId)
      const releasePoint = toWorld(event.clientX, event.clientY)
      const originalEndpoint = edge && (edgeEndpointDrag.endpoint === 'from' ? edge.from : edge.to)
      const otherEndpoint = edge && (edgeEndpointDrag.endpoint === 'from' ? edge.to : edge.from)
      // Dragging an endpoint out of its current card means "make it free"
      // unless it lands on a different foreground card. In particular, do not
      // let a canvas-sized frame or the original card reattach it and undo the
      // user's length adjustment on pointer-up.
      const excludedEndpoints = [originalEndpoint, otherEndpoint].filter((id): id is string => Boolean(id))
      const target = edge ? edgeAttachmentTargetAt(document.elements, releasePoint, excludedEndpoints) : undefined
      if (edge && target) {
        const otherEnd = edgeEndpointDrag.endpoint === 'from' ? edge.to : edge.from
        if (target.id !== otherEnd) {
          const anchor = edgeAttachmentForPoint(target, releasePoint)
          const patch: Partial<BoardEdge> = edgeEndpointDrag.endpoint === 'from'
            ? { from: target.id, fromAnchor: anchor, freeStart: undefined }
            : { to: target.id, toAnchor: anchor, freeEnd: undefined }
          onCommit([{ op: 'patch_edge', id: edge.id, patch: endpointPatchWithRemappedControls(document, edge, patch) }])
        }
      } else if (edge) {
        const patch: Partial<BoardEdge> = edgeEndpointDrag.endpoint === 'from' ? { from: '', fromAnchor: undefined, freeStart: releasePoint } : { to: '', toAnchor: undefined, freeEnd: releasePoint }
        onCommit([{ op: 'patch_edge', id: edge.id, patch: endpointPatchWithRemappedControls(document, edge, patch) }])
      }
    }
    if (connectionDrag) {
      const releasePoint = toWorld(event.clientX, event.clientY)
      const target = targetAt(releasePoint, connectionDrag.from)
      if (target) onCommit([{ op: 'add_edge', edge: newEdge(connectionDrag.from, target.id, connectionDrag.anchor, edgeAttachmentForPoint(target, releasePoint)) }])
    }
    setEdgeControlDrag(null);setEdgeEndpointDrag(null);setConnectionDrag(null);setDrawStart(null);setDrawCurrent(null);setDragStart(null);setDragIds([]);setDragDelta({x:0,y:0});setDragAssist(null);setResize(null);setGroupResize(null)
    try{rootRef.current?.releasePointerCapture(event.pointerId)}catch{/* no capture */}
  }
  const cancelGesture = () => {
    setPanStart(null); setMarquee(null); setExportMarquee(null); setDrawStart(null); setDrawCurrent(null);
    setDragStart(null); setDragIds([]); setDragDelta({ x: 0, y: 0 }); setDragAssist(null);
    setResize(null); setGroupResize(null); setEdgeControlDrag(null); setEdgeEndpointDrag(null); setConnectionDrag(null);
    setFreeEdgeDraft(null); edgeGestureRef.current = null;
  }
  const startElementDrag=(event:React.PointerEvent,id:string)=>{if(event.button === 1 || tool === 'hand' || isSpaceDown){event.stopPropagation();pointerDownBackground(event);return}if(event.button !== 0)return;setFollowAi(false);event.stopPropagation();setContextMenu(null);if(tool==='export'){beginExport(event);return}if(tool==='edge'){const element=document.elements.find(item=>item.id===id);const point=toWorld(event.clientX,event.clientY);if(freeEdgeDraft&&element){const anchor=edgeAttachmentForPoint(element,point);const template=document.edges.find(edge=>selectedIds.includes(edge.id));const edge:BoardEdge={id:newId('edge'),from:'',to:id,freeStart:freeEdgeDraft.start,controlPoints:freeEdgeDraft.points,stroke:template?.stroke||'#64748B',strokeWidth:template?.strokeWidth||2,strokeStyle:template?.strokeStyle||'solid',startArrow:template?.startArrow||'none',endArrow:template?.endArrow||'arrow',routing:'polyline',opacity:template?.opacity??1,zIndex:document.edges.length,toAnchor:anchor};onCommit([{op:'add_edge',edge}]);onSelect([edge.id]);setFreeEdgeDraft(null);setTool('select');return}onSelect([id]);if(!edgeSource)setEdgeSource(id);else if(edgeSource!==id){onCommit([{op:'add_edge',edge:{id:newId('edge'),from:edgeSource,to:id,stroke:'#64748B',strokeWidth:2,strokeStyle:'solid',startArrow:'none',endArrow:'arrow',routing:'elbow',opacity:1,zIndex:document.edges.length}}]);setEdgeSource(null);setTool('select')}return}if(tool!=='select')return;const additive=event.shiftKey||event.metaKey||event.ctrlKey;const alreadySelected=selectedIds.includes(id);const isolated=isolatedElement===id&&alreadySelected&&!additive; if(!isolated)setIsolatedElement(null); const base=isolated?[id]:!additive&&alreadySelected?selectedIds:selectionForElement(document,id,selectedIds,additive);const next=isolated||additive&&!base.includes(id)?base:dragSelection(document,base);onSelect(next);const element=document.elements.find(item=>item.id===id);if(!next.includes(id)||element?.locked)return;event.currentTarget.setPointerCapture(event.pointerId);setDragIds(next.filter(itemId=>document.elements.some(item=>item.id===itemId&&!item.locked)||document.edges.some(edge=>edge.id===itemId)));setDragDelta({x:0,y:0});setDragAssist(null);setDragStart(toWorld(event.clientX,event.clientY))}
  const startResize=(event:React.PointerEvent,element:BoardElement,handle:ResizeHandle)=>{setFollowAi(false);event.stopPropagation();if(element.locked)return;rootRef.current?.setPointerCapture(event.pointerId);const start=toWorld(event.clientX,event.clientY);setResize({handle,start,element,current:{x:element.x,y:element.y,width:element.width,height:element.height}})}
  const startGroupResize=(event:React.PointerEvent,handle:ResizeHandle)=>{setFollowAi(false);event.stopPropagation();const elements=document.elements.filter(item=>selectedIds.includes(item.id));const bounds=boundsForElements(elements);if(!bounds||elements.length<2||elements.some(item=>item.locked))return;rootRef.current?.setPointerCapture(event.pointerId);setGroupResize({handle,start:toWorld(event.clientX,event.clientY),bounds,current:bounds,ids:elements.map(item=>item.id),minimumScale:minimumGroupScale(elements,handle)})}
  const showContextMenu=(event:React.MouseEvent,id?:string)=>{event.preventDefault();event.stopPropagation();let next=selectedIds;if(id&&!next.includes(id)){next=document.elements.some(item=>item.id===id)?selectionForElement(document,id,selectedIds,false):[id];onSelect(next)}const rect=rootRef.current?.getBoundingClientRect();const rawX=event.clientX-(rect?.left||0),rawY=event.clientY-(rect?.top||0);const menuWidth=Math.min(360,Math.max(0,(rect?.width||900)-16));setContextMenu({x:Math.max(8,Math.min(rawX,(rect?.width||900)-menuWidth-8)),y:Math.max(8,Math.min(rawY,(rect?.height||700)-220))})}
  const startEditing=(event:React.MouseEvent,element:BoardElement)=>{event.stopPropagation();if(element.locked || tool !== 'select')return;setIsolatedElement(element.id);onSelect([element.id]);setDragStart(null);setDragIds([]);setEditing({id:element.id,value:element.text,kind:'element'})}
  // The label editor stays anchored where the label lives when editing starts,
  // so later keystrokes cannot shift the box around under the caret.
  const edgeLabelAnchor=(edge:BoardEdge):Point|undefined=>{const geometry=edgeGeometry.find(item=>item.edge.id===edge.id);if(!geometry)return undefined;const existing=edgeLabels.get(edge.id);if(existing)return{x:existing.x,y:existing.y};const placement=placeEdgeLabel(geometry.pathPoints,edge.label||'新标签',foregroundRects);return{x:placement.x,y:placement.y}}
  const startEdgeLabelEditing=(event:React.MouseEvent,edge:BoardEdge)=>{event.stopPropagation();onSelect([edge.id]);setDragStart(null);setDragIds([]);setEditing({id:edge.id,value:edge.label||'',kind:'edge',at:edgeLabelAnchor(edge)})}
  const finishEditing=(save=true)=>{if(!editing)return;if(editing.kind==='edge'){const edge=document.edges.find(item=>item.id===editing.id);if(save&&edge&&editing.value!==(edge.label||''))onCommit([{op:'patch_edge',id:editing.id,patch:{label:editing.value}}])}else{const element=document.elements.find(item=>item.id===editing.id);if(save&&element&&editing.value!==element.text)onCommit([{op:'patch_element',id:editing.id,patch:{text:editing.value}}])}setEditing(null)}
  const preview=useMemo(()=>{if(!drawStart||!drawCurrent||['select','hand','edge','export'].includes(tool))return null;return{x:Math.min(drawStart.x,drawCurrent.x),y:Math.min(drawStart.y,drawCurrent.y),width:Math.max(1,Math.abs(drawCurrent.x-drawStart.x)),height:Math.max(1,Math.abs(drawCurrent.y-drawStart.y))}},[drawCurrent,drawStart,tool])
  const marqueeRect=marquee?{x:Math.min(marquee.start.x,marquee.current.x),y:Math.min(marquee.start.y,marquee.current.y),width:Math.abs(marquee.current.x-marquee.start.x),height:Math.abs(marquee.current.y-marquee.start.y)}:null
  const exportRect=exportMarquee?{x:Math.min(exportMarquee.start.x,exportMarquee.current.x),y:Math.min(exportMarquee.start.y,exportMarquee.current.y),width:Math.abs(exportMarquee.current.x-exportMarquee.start.x),height:Math.abs(exportMarquee.current.y-exportMarquee.start.y)}:null
  // The persisted board is already final and safe for undo/recovery. Only the
  // rendered projection is replayed operation-by-operation to give AI edits a
  // tangible drawing rhythm instead of a sudden full-screen replacement.
  const dragOperations = useMemo(() => dragStart ? dragOperationsFor(document, dragIds, dragDelta) : [], [document, dragDelta, dragIds, dragStart])
  const groupResizePreviewOperations = useMemo(() => groupResize ? groupResizeOperations(document, groupResize.ids, groupResize.bounds, groupResize.current) : [], [document, groupResize])
  const visualDocument = useMemo(() => {
    const base = aiPlayback
      ? applyBoardOperations(aiPlayback.base, aiPlayback.operations.slice(0, Math.min(playbackStep, aiPlayback.operations.length)))
      : document
    if (groupResizePreviewOperations.length) return applyBoardOperations(base, groupResizePreviewOperations)
    return dragOperations.length ? applyBoardOperations(base, dragOperations) : base
  }, [aiPlayback, document, dragOperations, groupResizePreviewOperations, playbackStep])
  const navigateFromMiniMap = (point: Point) => { setFollowAi(false); setViewport(current => ({ ...current, x: canvasSize.width / 2 - point.x * current.zoom, y: canvasSize.height / 2 - point.y * current.zoom })) }
  const fitCanvasContent = () => { setFollowAi(false); const bounds = contentBounds(visualDocument.elements); if (bounds) setViewport(fitViewportToContent(bounds, canvasSize)) }
  const fitPresentationOverview = () => {
    const bounds = contentBounds(visualDocument.elements)
    const all = [...areas.map(area => area.bounds), ...(bounds ? [bounds] : [])]
    if (!all.length) return
    const x = Math.min(...all.map(b => b.x)), y = Math.min(...all.map(b => b.y))
    setViewport(fitViewportToContent({ x, y, width: Math.max(...all.map(b => b.x + b.width)) - x, height: Math.max(...all.map(b => b.y + b.height)) - y }, { width: canvasSize.width, height: Math.max(1, canvasSize.height - 64) }))
  }
  const activeAiOperation = aiPlayback && playbackStep < aiPlayback.operations.length ? aiPlayback.operations[playbackStep] : undefined
  const aiCursor = useMemo(() => {
    if (!activeAiOperation) return undefined
    const cursorLabel = (action: string) => aiPlayback?.label ? `${action} · ${aiPlayback.label}` : action
    if (activeAiOperation.op === 'add_element') return { x: activeAiOperation.element.x + activeAiOperation.element.width / 2, y: activeAiOperation.element.y + activeAiOperation.element.height / 2, label: cursorLabel('创建图形') }
    if (activeAiOperation.op === 'add_edge') {
      const from = visualDocument.elements.find(item => item.id === activeAiOperation.edge.from)
      const to = visualDocument.elements.find(item => item.id === activeAiOperation.edge.to)
      if (from && to) return { x: (from.x + from.width / 2 + to.x + to.width / 2) / 2, y: (from.y + from.height / 2 + to.y + to.height / 2) / 2, label: cursorLabel('连接图形') }
    }
    if (activeAiOperation.op === 'patch_element' || activeAiOperation.op === 'delete_element') {
      const item = visualDocument.elements.find(value => value.id === activeAiOperation.id) || document.elements.find(value => value.id === activeAiOperation.id)
      if (item) return { x: item.x + item.width / 2, y: item.y + item.height / 2, label: cursorLabel(activeAiOperation.op === 'delete_element' ? '移除图形' : '调整图形') }
    }
    if (activeAiOperation.op === 'patch_edge' || activeAiOperation.op === 'delete_edge') {
      const edge = visualDocument.edges.find(value => value.id === activeAiOperation.id) || document.edges.find(value => value.id === activeAiOperation.id)
      const from = edge && (visualDocument.elements.find(value => value.id === edge.from) || document.elements.find(value => value.id === edge.from))
      const to = edge && (visualDocument.elements.find(value => value.id === edge.to) || document.elements.find(value => value.id === edge.to))
      if (from && to) return { x: (from.x + from.width / 2 + to.x + to.width / 2) / 2, y: (from.y + from.height / 2 + to.y + to.height / 2) / 2, label: cursorLabel(activeAiOperation.op === 'delete_edge' ? '移除连线' : '调整连线') }
    }
    if (activeAiOperation.op === 'replace_document' && activeAiOperation.document.elements.length) {
      const elements = activeAiOperation.document.elements
      const left = Math.min(...elements.map(item => item.x)), top = Math.min(...elements.map(item => item.y))
      const right = Math.max(...elements.map(item => item.x + item.width)), bottom = Math.max(...elements.map(item => item.y + item.height))
      return { x: (left + right) / 2, y: (top + bottom) / 2, label: cursorLabel('载入图形') }
    }
    return undefined
  }, [activeAiOperation, aiPlayback?.label, document.elements, visualDocument.elements])
  const aiWorking = Boolean(aiWork || aiPlayback)
  const aiWorkId = aiWork?.id || aiPlayback?.id || null
  useEffect(() => {
    if (!aiWorking) {
      aiWorkIdRef.current = null
      setAiRestPoint(null)
      return
    }
    if (aiWorkId !== aiWorkIdRef.current) {
      aiWorkIdRef.current = aiWorkId
      setAiRestPoint(aiWork?.anchor || null)
      return
    }
    if (aiCursor) {
      setAiRestPoint({ x: aiCursor.x, y: aiCursor.y })
      return
    }
    if (!aiRestPoint && rootRef.current) {
      const bounds = rootRef.current.getBoundingClientRect()
      setAiRestPoint({
        x: (bounds.width / 2 - viewport.x) / viewport.zoom,
        y: (bounds.height / 2 - viewport.y) / viewport.zoom,
      })
    }
  }, [aiCursor?.x, aiCursor?.y, aiRestPoint, aiWork?.anchor?.x, aiWork?.anchor?.y, aiWorkId, aiWorking, viewport.x, viewport.y, viewport.zoom])
  const aiPointer = aiCursor || aiRestPoint
  const aiWorkLabel = aiCursor?.label || aiWork?.label || aiPlayback?.label || 'AI 正在处理画板'
  const aiScreenPoint = useMemo(() => {
    if (!rootRef.current || !aiPointer) return { x: '50%', y: '50%' }
    const bounds = rootRef.current.getBoundingClientRect()
    const x = viewport.x + aiPointer.x * viewport.zoom
    const y = viewport.y + aiPointer.y * viewport.zoom
    return {
      x: `${Math.round(Math.max(42, Math.min(bounds.width - 42, x)))}px`,
      y: `${Math.round(Math.max(42, Math.min(bounds.height - 42, y)))}px`,
    }
  }, [aiPointer, viewport.x, viewport.y, viewport.zoom])
  // Keep the active AI action within the reading area. This is deliberately a
  // camera move (not a zoom) so the user retains spatial context while the
  // assistant draws a large diagram beyond the initial viewport.
  useEffect(() => {
    if (!followAi || !aiCursor || !rootRef.current) return
    const bounds = rootRef.current.getBoundingClientRect()
    const screenX = viewport.x + aiCursor.x * viewport.zoom
    const screenY = viewport.y + aiCursor.y * viewport.zoom
    const marginX = Math.min(180, bounds.width * .22), marginY = Math.min(130, bounds.height * .22)
    if (screenX >= marginX && screenX <= bounds.width - marginX && screenY >= marginY && screenY <= bounds.height - marginY) return
    const from = viewport; const target = { ...from, x: bounds.width / 2 - aiCursor.x * from.zoom, y: bounds.height / 2 - aiCursor.y * from.zoom }; const started = performance.now(); let frame = 0
    const animate = (time: number) => { const progress = Math.min(1, (time - started) / 220); const eased = 1 - (1 - progress) ** 3; setViewport({ ...from, x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased }); if (progress < 1) frame = window.requestAnimationFrame(animate) }
    frame = window.requestAnimationFrame(animate); return () => window.cancelAnimationFrame(frame)
  }, [aiCursor?.x, aiCursor?.y, followAi, viewport.zoom])
  // Containers are a visual background, never a layer that can hide their
  // child cards. This also repairs older/generated boards whose zIndex values
  // were written in tool-call order rather than visual order.
  const elementById = useMemo(() => new Map(visualDocument.elements.map(item => [item.id, item])), [visualDocument.elements])
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const { background: backgroundElements, foreground: foregroundElements } = useMemo(() => elementLayers(visualDocument.elements), [visualDocument.elements])
  const sortedEdges = useMemo(() => [...visualDocument.edges].sort((a,b)=>(a.zIndex??0)-(b.zIndex??0)), [visualDocument.edges])
  const selectedVisualElements = useMemo(() => visualDocument.elements.filter(item => selectedIdSet.has(item.id)), [selectedIdSet, visualDocument.elements])
  const groupSelectionBounds = selectedVisualElements.length >= 2 ? boundsForElements(selectedVisualElements) : null
  const groupSelectionCanResize = Boolean(groupSelectionBounds) && selectedVisualElements.every(item => !item.locked)
  const center = (element: BoardElement): Point => ({ x: element.x + element.width / 2, y: element.y + element.height / 2 })
  const connectionTargetId = connectionDrag ? targetAt(connectionDrag.point, connectionDrag.from)?.id : undefined
  const editTextFromMenu = (id: string) => { const element = document.elements.find(item => item.id === id); if (!element || element.locked) return; setContextMenu(null); onSelect([id]); setEditing({ id, value: element.text, kind: 'element' }) }
  const editEdgeLabelFromMenu = (id: string) => { const edge = document.edges.find(item => item.id === id); if (!edge) return; setContextMenu(null); onSelect([id]); setEditing({ id, value: edge.label || '', kind: 'edge', at: edgeLabelAnchor(edge) }) }

  // Rendering must not silently rewrite user-owned dimensions.
  const foregroundRects = useMemo(() => sceneObstacles(visualDocument.elements), [visualDocument.elements])
  const edgeGeometry = useMemo(() => {
    const routes = documentEdgeRoutes(visualDocument.elements, sortedEdges)
    return sortedEdges.map(edge => {
      const from = elementById.get(edge.from), to = elementById.get(edge.to)
      if ((!from && !edge.freeStart) || (!to && !edge.freeEnd)) return null
      const obstacles = foregroundRects.filter(item => item.id !== edge.from && item.id !== edge.to)
      const route = routes.get(edge.id)
      if (!route) return null
      const { start, end, points, pathPoints } = route
      const style = edgeDefaults(edge)
      return { edge, start, end, style, points, obstacles, pathPoints }
    }).filter(Boolean) as Array<{ edge: BoardEdge; start: Point; end: Point; style: ReturnType<typeof edgeDefaults>; points: Point[]; obstacles: CanvasRect[]; pathPoints: Point[] }>
  }, [elementById, foregroundRects, sortedEdges])
  const edgeLabels = useMemo(() => {
    const occupiedLabels: CanvasRect[] = []
    const labels = new Map<string, ReturnType<typeof placeEdgeLabel>>()
    for (const geometry of edgeGeometry) if (geometry.edge.label) {
      const placement = placeEdgeLabel(geometry.pathPoints, geometry.edge.label, foregroundRects, occupiedLabels)
      labels.set(geometry.edge.id, placement); occupiedLabels.push({ x: placement.x - placement.width / 2, y: placement.y - placement.height / 2, width: placement.width, height: placement.height })
    }
    return labels
  }, [edgeGeometry, foregroundRects])
  const miniMapContent = useMemo(() => contentBounds(visualDocument.elements), [visualDocument.elements])
  const miniMapVisible = visibleWorldBounds(viewport, canvasSize)
  const miniMapEligible = Boolean(miniMapContent && shouldShowMiniMap(miniMapContent, miniMapVisible))
  // Presenters also need orientation while pointing, even when the whole board fits.
  const showMiniMap = miniMapHint && (presenting ? Boolean(miniMapContent) : miniMapEligible)

  const renderElement = (original: BoardElement) => {
    const live = resize?.element.id === original.id ? { ...original, ...resize.current } : original
    const x = live.x; const y = live.y; const selected = selectedIdSet.has(live.id)
    const showingPorts = connectionTargetId === live.id || (selected && tool === 'edge')
    const isEditing = editing?.id === live.id && editing.kind === 'element'
    const textAlign = live.textAlign || 'center'
    const textLayout = layoutNodeText(live)
    const textStyle = { padding: '0 4px', fontSize: textLayout.fontSize, color: live.textColor || '#263145', fontFamily: live.fontFamily || 'Inter', fontWeight: live.fontWeight || 'normal', fontStyle: live.fontStyle || 'normal', textDecoration: live.textDecoration || 'none', textAlign, justifyContent: textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center', alignItems: live.verticalAlign === 'top' ? 'flex-start' : live.verticalAlign === 'bottom' ? 'flex-end' : 'center' } as const
    return <g key={live.id} data-element-id={live.id} className={`board-element ${selected ? 'selected' : ''} ${live.locked ? 'locked' : ''} ${edgeSource === live.id ? 'edge-source' : ''}`} transform={`translate(${x} ${y}) rotate(${live.rotation || 0} ${live.width / 2} ${live.height / 2})`} onPointerDown={event => startElementDrag(event, live.id)} onContextMenu={event => showContextMenu(event, live.id)} onDoubleClick={event => startEditing(event, original)}>
      {live.kind === 'image' ? <><rect width={live.width} height={live.height} rx={8} fill="#f1f5f9" stroke={live.stroke || '#64748b'} strokeWidth={live.strokeWidth || 1}/>{typeof live.metadata?.attachmentId === 'string' && imageSources[live.metadata.attachmentId] ? <image href={imageSources[live.metadata.attachmentId]} width={live.width} height={live.height} preserveAspectRatio="xMidYMid meet" pointerEvents="none"/> : <text className="image-loading-label" x={live.width / 2} y={live.height / 2} textAnchor="middle">图片载入中…</text>}</> : live.kind === 'text' ? <g pointerEvents="none"><Shape element={live}/></g> : <Shape element={live}/>}
      {live.kind !== 'image' && <foreignObject x="8" y="4" width={Math.max(1, live.width - 16)} height={Math.max(1, live.height - 8)} opacity={live.opacity ?? 1} pointerEvents={isEditing ? 'auto' : 'none'}>
        {isEditing
          ? <textarea ref={editorRef} className="element-text-editor" value={editing.value} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onChange={event => setEditing(current => current ? { ...current, value: event.target.value } : current)} onBlur={() => finishEditing()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); finishEditing(false) } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finishEditing() } }}/>
          : <div className="element-text" style={textStyle}><span className="element-text-hit" style={{ pointerEvents: 'auto', cursor: 'text', maxWidth: '100%' }}>{textLayout.lines.join('\n')}</span></div>}
      </foreignObject>}
      {selected && !groupSelectionBounds && <g className="selection-ui"><rect className="selection-outline" x="-5" y="-5" width={live.width + 10} height={live.height + 10} rx="6"/>{selectedVisualElements.length === 1 && !live.locked && handles.map(handle => <rect key={handle.id} className={`resize-handle handle-${handle.id}`} x={live.width * handle.x - 5} y={live.height * handle.y - 5} width="10" height="10" rx="2" onPointerDown={event => startResize(event, original, handle.id)}/>)}{!live.locked && selectedVisualElements.length === 1 && quickAddPorts.map(port => <g key={port.id} className="quick-add-node" transform={`translate(${live.width * port.x + (port.x === 0 ? -26 : port.x === 1 ? 26 : 0)} ${live.height * port.y + (port.y === 0 ? -26 : port.y === 1 ? 26 : 0)})`} onPointerDown={event => event.stopPropagation()} onClick={event => addLinkedNode(event, original, { x: port.x, y: port.y })}><circle r="12"/><path d="M -4 0 H 4 M 0 -4 V 4"/></g>)}</g>}
      {showingPorts && !live.locked && <g className={`connection-ports ${connectionTargetId === live.id ? 'is-target' : ''}`}>{connectionPorts(live).map(port => <circle key={port.id} className="connection-port" cx={live.width * port.x} cy={live.height * port.y} r="5.5" onPointerDown={event => startConnection(event, original, { x: port.x, y: port.y })}/>)}</g>}
    </g>
  }

  const renderEpoch = useRef(0)
  useLayoutEffect(() => {
    if (!projectId || !rootRef.current) return
    trackBoardVersion(projectId, document)
    const epoch = ++renderEpoch.current
    return registerRenderProbe(projectId, () => ({
      document: visualDocument, root: rootRef.current!, epoch,
      pending: Boolean(aiPlayback || editing || dragStart || resize || groupResize || edgeControlDrag || edgeEndpointDrag || visualDocument.elements.some(item => item.kind === 'image' && !imageSources[String(item.metadata?.attachmentId || '')])),
    }))
  }, [projectId, document, visualDocument, aiPlayback, editing, dragStart, resize, groupResize, edgeControlDrag, edgeEndpointDrag, imageSources, viewport])

  return <div className={`canvas-root ${presenting ? 'is-presenting' : ''} tool-${tool} ${panStart?'is-panning':''} ${isWheeling?'is-wheeling':''} ${aiWorking ? 'ai-working' : ''}`} ref={rootRef} onPointerDown={pointerDownBackground} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelGesture} onDragOver={event => { if ([...event.dataTransfer.items].some(item => item.kind === 'file' && /image\//i.test(item.type))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }} onDrop={event => { const files = [...event.dataTransfer.files]; const images = files.filter(file => /^image\//i.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name)); if (!images.length || !window.tugo) return; event.preventDefault(); event.stopPropagation(); const paths = images.map(file => window.tugo!.system.getPathForFile(file)).filter((path): path is string => Boolean(path)); if (paths.length) void onDropImages(paths, toWorld(event.clientX,event.clientY)) }} onDoubleClick={event => { if (tool === 'edge' && freeEdgeDraft) { event.stopPropagation(); finishFreeEdge(toWorld(event.clientX,event.clientY)); return } if (tool === 'select') { const element = targetAt(toWorld(event.clientX,event.clientY)); if (element && element.kind !== 'image') startEditing(event, element) } }} onContextMenu={event=>showContextMenu(event)} onWheel={handleWheel}>
    <div className="presentation-controls glass" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      {!presenting && <button type="button" aria-label="Edit presentation areas" aria-pressed={editingSlides} onClick={() => { cancelGesture(); setFollowAi(false); onSelect([]); setEditingSlides(value => !value) }}>Slides</button>}
      {presenting && <>
        <select className="presentation-area-picker" aria-label="Presentation area" value={currentArea?.id || ''} onChange={event => { cancelGesture(); setLaserPoint(null); setPresentationAreaId(event.target.value || null); if (!event.target.value) fitPresentationOverview() }}>
          <option value="">Overview — {areas.length} areas</option>
          {areas.map((area, index) => <option key={area.id} value={area.id}>{index + 1}. {area.name.slice(0, 80)}</option>)}
        </select>
        <button type="button" aria-label="Previous area" title="Previous area (←)" disabled={!areas.length || areaIndex === 0} onClick={() => changeArea(-1)}>‹</button>
        <span className="presentation-area-count" aria-live="polite" title={currentArea?.name}>{currentArea ? `${areaIndex + 1} / ${areas.length}` : `${areas.length} areas`}</span>
        <button type="button" aria-label="Next area" title="Next area (→)" disabled={!areas.length || areaIndex === areas.length - 1} onClick={() => changeArea(1)}>›</button>
        <button type="button" aria-pressed={!currentArea} onClick={() => { cancelGesture(); setLaserPoint(null); setPresentationAreaId(null); fitPresentationOverview() }}>Overview</button>
      </>}
      {presenting && <button type="button" aria-pressed={laser} onClick={() => { setLaser(value => !value); setLaserPoint(null) }} title="Laser pointer (L); turn off to pan">{laser ? '● Laser on' : '✋ Pan'}</button>}
      <button type="button" data-e2e="canvas-display" aria-pressed={presenting} aria-label={presenting ? 'Exit presentation' : 'Start presentation'} onClick={togglePresentation} title={presenting ? 'Exit presentation (Esc)' : 'Present this board'}>{presenting ? <X size={18} aria-hidden="true"/> : <Play size={18} aria-hidden="true"/>}</button>
    </div>
    {editingSlides && !presenting && <PresentationAreaEditor areas={areas} viewport={viewport} onClose={() => setEditingSlides(false)} onChange={presentationAreas => onCommit([{ op: 'replace_document', document: { ...document, presentationAreas } }])}/>}
    {presenting && <div className={`presentation-surface ${laser ? 'is-laser' : ''}`} aria-label="Presentation canvas"
      onPointerDown={event => { event.stopPropagation(); if (!laser) pointerDownBackground(event) }}
      onPointerMove={event => { event.stopPropagation(); revealMiniMap(); if (laser) { const rect = rootRef.current?.getBoundingClientRect(); if (rect) setLaserPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }) } else pointerMove(event) }}
      onPointerUp={event => { event.stopPropagation(); pointerUp(event) }}
      onPointerLeave={() => setLaserPoint(null)} onDoubleClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
      onDragOver={event => { event.preventDefault(); event.stopPropagation() }} onDrop={event => { event.preventDefault(); event.stopPropagation() }}>
      {!currentArea && areas.map((area, index) => <div key={area.id} className="presentation-area-outline" style={{ left: viewport.x + area.bounds.x * viewport.zoom, top: viewport.y + area.bounds.y * viewport.zoom, width: area.bounds.width * viewport.zoom, height: area.bounds.height * viewport.zoom }}><span>{index + 1}. {area.name.slice(0, 60)}</span></div>)}
      {laser && laserPoint && <span className="presentation-laser" aria-hidden="true" style={{ left: laserPoint.x, top: laserPoint.y }}/>}
    </div>}
    {aiWorking && <>
      <div className="ai-work-wash" aria-hidden="true" />
      <div className="ai-work-overlay" aria-live="polite" aria-label={aiWorkLabel}>
        <div className="ai-work-focus" style={{ left: aiScreenPoint.x, top: aiScreenPoint.y }} />
        <div className={`ai-work-cursor cursor-theme-${cursorStyle}`} style={{ left: aiScreenPoint.x, top: aiScreenPoint.y, '--ai-cursor-color': cursorColor } as React.CSSProperties}>
          <AiCursorGlyph cursorStyle={cursorStyle} color={cursorColor}/>
          <span className="ai-work-label"><i /><span>{aiWorkLabel}</span></span>
        </div>
      </div>
    </>}
    {aiPlayback && <div className="ai-playback-controls glass" onPointerDown={event => event.stopPropagation()}><button type="button" className={followAi ? 'active' : ''} onClick={() => setFollowAi(value => !value)}>{followAi ? '跟随 AI' : '保持视角'}</button><button type="button" onClick={() => { setPlaybackStep(aiPlayback.operations.length); onAiPlaybackComplete?.(aiPlayback.id) }}>跳过动画</button></div>}
    <div className="canvas-toolbar glass" onPointerDown={event=>event.stopPropagation()}>{toolbar.map(item=><button key={item.id} data-e2e={`canvas-tool-${item.id}`} className={tool===item.id?'active':''} title={item.label} aria-label={item.label} onClick={()=>{ if (item.id === 'image_import') { const rect=rootRef.current?.getBoundingClientRect(); void onAddImage(toWorld((rect?.left || 0)+(rect?.width || 800)/2,(rect?.top || 0)+(rect?.height || 600)/2)); return } setTool(item.id as Tool); setEdgeSource(null); if (item.id !== 'batch_export') setBatchRegions([]) }}><item.icon size={18}/></button>)}<span className="toolbar-separator"/><button data-e2e="canvas-undo" title="撤销" disabled={!canUndo} onClick={onUndo}><Undo2 size={18}/></button><button data-e2e="canvas-redo" title="重做" disabled={!canRedo} onClick={onRedo}><Redo2 size={18}/></button></div>
    {tool === 'batch_export' && <div className="batch-capture-bar glass" onPointerDown={event => event.stopPropagation()}>
      <div><strong>批量框选</strong><span>{batchRegions.length ? `已收集 ${batchRegions.length} 个区域` : '连续拖拽选择多个区域'}</span></div>
      <button className="soft-btn" disabled={!batchRegions.length} onClick={() => setBatchRegions(current => current.slice(0, -1))}>撤销上个</button>
      <button className="soft-btn" disabled={!batchRegions.length} onClick={() => setBatchRegions([])}>清空</button>
      <button className="primary-btn" disabled={!batchRegions.length} onClick={() => { onBatchExportRegions(batchRegions); setBatchRegions([]); setTool('select') }}>完成</button>
      <small>Esc 取消 · ⌫ 撤销 · Enter 完成</small>
    </div>}
    <div className="zoom-controls glass" onPointerDown={event=>event.stopPropagation()}><button onClick={()=>zoomBy(1/1.16)}><ZoomOut size={16}/></button><button className="zoom-value" onClick={()=>{setFollowAi(false);setViewport({x:0,y:0,zoom:1})}}>{Math.round(viewport.zoom*100)}%</button><button onClick={()=>zoomBy(1.16)}><ZoomIn size={16}/></button></div>
    {showMiniMap && <CanvasMiniMap document={visualDocument} viewport={viewport} screen={canvasSize} onNavigate={navigateFromMiniMap} onFit={fitCanvasContent}/>}
    <svg className="board-svg"><defs><pattern id="minorGrid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--grid-dot)"/></pattern>{(['arrow','triangle','circle','diamond'] as const).flatMap(kind=>['start','end'].map(position=>{const id=`marker-${kind}-${position}`;const orient=position==='start'?'auto-start-reverse':'auto';return <marker key={id} id={id} markerWidth="10" markerHeight="10" refX={kind==='circle'?5:9} refY="5" orient={orient} markerUnits="userSpaceOnUse">{kind==='circle'?<circle cx="5" cy="5" r="3.2" fill="context-stroke"/>:kind==='diamond'?<path d="M1 5 L5 1 L9 5 L5 9 Z" fill="context-stroke"/>:kind==='triangle'?<path d="M1 1 L9 5 L1 9 Z" fill="context-stroke"/>:<path d="M1 1 L9 5 L1 9" fill="none" stroke="context-stroke" strokeWidth="1.6"/>}</marker>}))}</defs>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}><rect x="-20000" y="-20000" width="40000" height="40000" fill="url(#minorGrid)"/>
        {dragAssist && <g className="drag-assist" pointerEvents="none">
          {dragAssist.guides.map((guide, index) => guide.axis === 'x'
            ? <line key={`x-${index}`} x1={guide.position} x2={guide.position} y1={guide.start} y2={guide.end}/>
            : <line key={`y-${index}`} x1={guide.start} x2={guide.end} y1={guide.position} y2={guide.position}/>) }
          <g className="drag-size-label"><rect x={dragAssist.bounds.x + dragAssist.bounds.width / 2 - 24} y={dragAssist.bounds.y - 25} width="48" height="17" rx="5"/><text x={dragAssist.bounds.x + dragAssist.bounds.width / 2} y={dragAssist.bounds.y - 13} textAnchor="middle">W {Math.round(dragAssist.bounds.width)}</text></g>
          <g className="drag-size-label"><rect x={dragAssist.bounds.x + dragAssist.bounds.width + 8} y={dragAssist.bounds.y + dragAssist.bounds.height / 2 - 8} width="48" height="17" rx="5"/><text x={dragAssist.bounds.x + dragAssist.bounds.width + 32} y={dragAssist.bounds.y + dragAssist.bounds.height / 2 + 4} textAnchor="middle">H {Math.round(dragAssist.bounds.height)}</text></g>
          {dragAssist.distances.map((distance, index) => distance.axis === 'x'
            ? <g key={`dx-${index}`} className="drag-distance"><line x1={distance.from} x2={distance.to} y1={distance.at} y2={distance.at}/><line x1={distance.from} x2={distance.from} y1={distance.at - 5} y2={distance.at + 5}/><line x1={distance.to} x2={distance.to} y1={distance.at - 5} y2={distance.at + 5}/><text x={(distance.from + distance.to) / 2} y={distance.at - 7} textAnchor="middle">{distance.label}</text></g>
            : <g key={`dy-${index}`} className="drag-distance"><line x1={distance.at} x2={distance.at} y1={distance.from} y2={distance.to}/><line x1={distance.at - 5} x2={distance.at + 5} y1={distance.from} y2={distance.from}/><line x1={distance.at - 5} x2={distance.at + 5} y1={distance.to} y2={distance.to}/><text x={distance.at + 7} y={(distance.from + distance.to) / 2 + 3}>{distance.label}</text></g>) }
        </g>}
        <g className="background-element-layer">{backgroundElements.map(renderElement)}</g>
        <g className="edge-visual-layer">{edgeGeometry.map(({ edge, start, end, style, points, obstacles }) => {
          const liveStart = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'from' ? edgeEndpointDrag.point : start
          const liveEnd = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'to' ? edgeEndpointDrag.point : end
          const routedPoints = liveControlPoints(edge, style.routing, points, start, end, liveStart, liveEnd, obstacles)
          const activePoints = routedPoints.map((point, index) => edgeControlDrag?.edgeId === edge.id && edgeControlDrag.index === index
            ? (style.routing === 'curve' && points.length === 1 && index === 0 ? quadraticControlForMidpoint(liveStart, edgeControlDrag.point, liveEnd) : edgeControlDrag.point)
            : point)
          const d = edgePath(style.routing, liveStart.x, liveStart.y, liveEnd.x, liveEnd.y, activePoints), selected = selectedIdSet.has(edge.id)
          return <g key={edge.id} data-edge-id={edge.id} className={`board-edge ${selected ? 'selected' : ''}`}><path d={d} fill="none" stroke={edge.stroke} strokeWidth={edge.strokeWidth} strokeDasharray={strokeDasharray(style.strokeStyle)} opacity={style.opacity} markerStart={style.startArrow !== 'none' ? `url(#marker-${style.startArrow}-start)` : undefined} markerEnd={style.endArrow !== 'none' ? `url(#marker-${style.endArrow}-end)` : undefined}/></g>
        })}</g>
        {connectionDrag&&<path className="connection-preview" d={`M ${edgeAttachmentPoint(document.elements.find(item=>item.id===connectionDrag.from)!,connectionDrag.anchor).x} ${edgeAttachmentPoint(document.elements.find(item=>item.id===connectionDrag.from)!,connectionDrag.anchor).y} L ${connectionDrag.point.x} ${connectionDrag.point.y}`} />}
        {freeEdgeDraft && <path className="connection-preview" d={edgePath('polyline', freeEdgeDraft.start.x, freeEdgeDraft.start.y, freeEdgeDraft.cursor.x, freeEdgeDraft.cursor.y, freeEdgeDraft.points)}/>}
        {/* Hit targets follow visual stacking: nodes and editors win over lines. */}
        <g className="edge-hit-layer">
          {edgeGeometry.map(({ edge, start, end, style, points, obstacles }) => {
            const liveStart = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'from' ? edgeEndpointDrag.point : start
            const liveEnd = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'to' ? edgeEndpointDrag.point : end
            const routedPoints = liveControlPoints(edge, style.routing, points, start, end, liveStart, liveEnd, obstacles)
            const activePoints = routedPoints.map((point, index) => edgeControlDrag?.edgeId === edge.id && edgeControlDrag.index === index
              ? (style.routing === 'curve' && points.length === 1 && index === 0 ? quadraticControlForMidpoint(liveStart, edgeControlDrag.point, liveEnd) : edgeControlDrag.point)
              : point)
            const d = edgePath(style.routing, liveStart.x, liveStart.y, liveEnd.x, liveEnd.y, activePoints)
            return <path key={`edge-hit-${edge.id}`} className="edge-hit" d={d} fill="none" onPointerDown={event => { event.stopPropagation(); if(event.button === 1 || tool === 'hand' || isSpaceDown){pointerDownBackground(event);return} if(event.button !== 0)return; setContextMenu(null); onSelect(event.shiftKey ? [...new Set([...selectedIds, edge.id])] : [edge.id]) }} onContextMenu={event => showContextMenu(event, edge.id)} onDoubleClick={event => { if (tool === 'edge' && freeEdgeDraft) return; event.stopPropagation(); if (tool === 'select') startEdgeLabelEditing(event, edge) }}/>
          })}
        </g>
        <g className="foreground-element-layer">{foregroundElements.map(renderElement)}</g>
        <g className="edge-label-layer">{edgeGeometry.map(({ edge }) => {
          const isEditingLabel = editing?.kind === 'edge' && editing.id === edge.id
          const placement = edgeLabels.get(edge.id); if (!edge.label || !placement || isEditingLabel) return null
          const lines = edgeLabelLines(edge.label)
          const firstLineY = placement.y - (lines.length - 1) * 9 + 4.5
          return <g key={`label-${edge.id}`} data-label-edge-id={edge.id} className="edge-label-group" onPointerDown={event => { event.stopPropagation(); if(event.button === 1 || tool === 'hand' || isSpaceDown){pointerDownBackground(event);return} if(event.button !== 0)return; setContextMenu(null); onSelect(event.shiftKey ? [...new Set([...selectedIds, edge.id])] : [edge.id]) }} onDoubleClick={event => { if (tool === 'edge' && freeEdgeDraft) return; event.stopPropagation(); if (tool === 'select') startEdgeLabelEditing(event, edge) }} onContextMenu={event => showContextMenu(event, edge.id)}><rect className="edge-label-background" x={placement.x - placement.width / 2} y={placement.y - placement.height / 2} width={placement.width} height={placement.height} rx="6"/><text x={placement.x} y={firstLineY} textAnchor="middle" className="edge-label">{lines.map((line, index) => <tspan key={index} x={placement.x} y={firstLineY + index * 18}>{line}</tspan>)}</text></g>
        })}
          {editing?.kind === 'edge' && (() => {
            const geometry = edgeGeometry.find(item => item.edge.id === editing.id); if (!geometry) return null
            const size = edgeLabelSize(editing.value || '新标签')
            const first = geometry.pathPoints[0], last = geometry.pathPoints[geometry.pathPoints.length - 1]
            const at = editing.at || (first && last ? { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 } : undefined); if (!at) return null
            const width = Math.max(200, size.width + 32), height = Math.max(40, size.height + 14)
            return <foreignObject key={`label-editor-${editing.id}`} x={at.x - width / 2} y={at.y - height / 2} width={width} height={height}>
              <textarea ref={editorRef} className="element-text-editor edge-label-editor" value={editing.value} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onChange={event => setEditing(current => current ? { ...current, value: event.target.value } : current)} onBlur={() => finishEditing()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); finishEditing(false) } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finishEditing() } }}/>
            </foreignObject>
          })()}</g>

        {/* Control points are editing UI. Render them above cards just like
            endpoints, otherwise a card covering a bend steals its drag. */}
        <g className="edge-control-layer">
          {edgeGeometry.filter(({ edge }) => selectedIdSet.has(edge.id) && !editing).map(({ edge, start, end, style, points, obstacles }) => {
            const liveStart = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'from' ? edgeEndpointDrag.point : start
            const liveEnd = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'to' ? edgeEndpointDrag.point : end
            const routedPoints = liveControlPoints(edge, style.routing, points, start, end, liveStart, liveEnd, obstacles)
            const activePoints = routedPoints.map((point, index) => edgeControlDrag?.edgeId === edge.id && edgeControlDrag.index === index
              ? (style.routing === 'curve' && points.length === 1 && index === 0 ? quadraticControlForMidpoint(liveStart, edgeControlDrag.point, liveEnd) : edgeControlDrag.point)
              : point)
            return <g key={`control-handles-${edge.id}`}>{activePoints.map((point, index) => {
              const handlePoint = style.routing === 'curve' && points.length === 1 && index === 0 ? quadraticMidpoint(liveStart, point, liveEnd) : point
              return <circle key={index} className="edge-control-handle" cx={handlePoint.x} cy={handlePoint.y} r="10" onDoubleClick={event => { if (tool === "select") startEdgeLabelEditing(event, edge) }} onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setEdgeControlDrag({ edgeId: edge.id, index, point: handlePoint }) }}/>
            })}</g>
          })}
        </g>
        {/* Endpoints must sit above cards.  When they were rendered with the
            edge itself, the target card covered the exact handle users need
            to drag for reconnection. */}
        {edgeGeometry.filter(({ edge }) => selectedIdSet.has(edge.id) && !editing).map(({ edge, start, end }) => {
          const liveStart = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'from' ? edgeEndpointDrag.point : start
          const liveEnd = edgeEndpointDrag?.edgeId === edge.id && edgeEndpointDrag.endpoint === 'to' ? edgeEndpointDrag.point : end
          return <g key={`endpoint-handles-${edge.id}`} className="edge-endpoint-layer"><circle className="edge-endpoint-handle" cx={liveStart.x} cy={liveStart.y} r="9" onPointerDown={event => { event.stopPropagation(); rootRef.current?.setPointerCapture(event.pointerId); setEdgeEndpointDrag({ edgeId: edge.id, endpoint: 'from', point: liveStart }) }}/><circle className="edge-endpoint-handle" cx={liveEnd.x} cy={liveEnd.y} r="9" onPointerDown={event => { event.stopPropagation(); rootRef.current?.setPointerCapture(event.pointerId); setEdgeEndpointDrag({ edgeId: edge.id, endpoint: 'to', point: liveEnd }) }}/></g>
        })}
        {groupSelectionBounds && <g className="group-selection-ui"><rect className="group-selection-outline" x={groupSelectionBounds.x - 6} y={groupSelectionBounds.y - 6} width={groupSelectionBounds.width + 12} height={groupSelectionBounds.height + 12} rx="8"/>{groupSelectionCanResize && handles.map(handle => <rect key={`group-${handle.id}`} className={`resize-handle group-resize-handle handle-${handle.id}`} x={groupSelectionBounds.x + groupSelectionBounds.width * handle.x - 6} y={groupSelectionBounds.y + groupSelectionBounds.height * handle.y - 6} width="12" height="12" rx="3" onPointerDown={event => startGroupResize(event, handle.id)}/>)}</g>}
        {preview&&<rect className="draw-preview" x={preview.x} y={preview.y} width={preview.width} height={preview.height} rx="10"/>}{marqueeRect&&<rect className="selection-marquee" x={marqueeRect.x} y={marqueeRect.y} width={marqueeRect.width} height={marqueeRect.height}/>} {batchRegions.map((region,index)=><g key={`${region.x}:${region.y}:${region.width}:${region.height}:${index}`} className="batch-export-marquee"><rect x={region.x} y={region.y} width={region.width} height={region.height} rx="5"/><circle cx={region.x+14} cy={region.y+14} r="11"/><text x={region.x+14} y={region.y+18} textAnchor="middle">{index+1}</text></g>)} {exportRect&&<g className="export-marquee"><rect x={exportRect.x} y={exportRect.y} width={exportRect.width} height={exportRect.height} rx="4"/><text x={exportRect.x+10} y={exportRect.y+22}>{Math.round(exportRect.width)} × {Math.round(exportRect.height)}</text></g>}
      </g></svg>{edgeSource&&<div className="canvas-hint">选择另一个节点完成连线 · Esc 取消</div>}{contextMenu&&<CanvasContextMenu x={contextMenu.x} y={contextMenu.y} document={document} selectedIds={selectedIds} canPaste={canvasClipboard.hasContent} onCommit={onCommit} onSelect={onSelect} onCopy={copySelection} onPaste={pasteSelection} onDuplicate={duplicateSelection} onEditText={editTextFromMenu} onEditEdgeLabel={editEdgeLabelFromMenu} onAddToChat={onAddToChat} onClose={()=>setContextMenu(null)}/>}
  </div>
}

// Streaming chat updates arrive much more often than the canvas changes. Without
// memoization every token rebuilt the complete SVG tree (including all edge
// geometry), which made larger boards appear to freeze while the Agent replied.
export const InfiniteCanvas = memo(InfiniteCanvasComponent)
