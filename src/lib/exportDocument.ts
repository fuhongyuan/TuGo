import PptxGenJS from 'pptxgenjs'
import { jsPDF } from 'jspdf'
import type { BoardDocument, BoardEdge, BoardElement, ElementKind } from '../types'
import { resolvedEdgeAnchor } from './edgeGeometry'

export type ExportRegion = { x: number; y: number; width: number; height: number }
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'pptx' | 'drawio'
export type ExportOptions = { format: ExportFormat; scale?: number; transparent?: boolean }

const xml = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const color = (value?: string, fallback = '64748B') => String(value || `#${fallback}`).replace('#', '').toUpperCase()
const safeName = (value: string) => value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80) || 'TuGo'
const intersects = (item: BoardElement, region: ExportRegion) => item.x < region.x + region.width && item.x + item.width > region.x && item.y < region.y + region.height && item.y + item.height > region.y
// `text` is an editing mode, not necessarily a visually bare object. Agents
// often use it for slide titles and section strips with a fill/border. Only
// omit its rectangle in PPT when the canvas rectangle is genuinely invisible.
const transparentPaint = (value?: string) => {
  const paint = String(value || '').trim().toLowerCase()
  return !paint || paint === 'transparent' || paint === 'none' || /^rgba\([^)]*,\s*0\s*\)$/.test(paint) || /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(paint) && /(?:0{1}|00)$/.test(paint.slice(-2))
}
const hasVisibleGeometry = (item: BoardElement) => item.kind !== 'text' || (item.opacity ?? 1) > 0 && ((item.fillOpacity ?? 1) > 0 && !transparentPaint(item.fill) || item.strokeWidth > 0 && !transparentPaint(item.stroke))

export function documentForRegion(document: BoardDocument, region: ExportRegion): BoardDocument {
  const elements = document.elements.filter(item => intersects(item, region))
  const ids = new Set(elements.map(item => item.id))
  return { ...document, elements, edges: document.edges.filter(edge => (ids.has(edge.from) || edge.freeStart) && (ids.has(edge.to) || edge.freeEnd)), viewport: { x: 0, y: 0, zoom: 1 } }
}

const edgePath = (edge: BoardEdge, from: BoardElement | undefined, to: BoardElement | undefined, region: ExportRegion) => {
  const start = from ? resolvedEdgeAnchor(from, to ? { x: to.x + to.width / 2, y: to.y + to.height / 2 } : edge.freeEnd!, edge.fromAnchor) : edge.freeStart!
  const finish = to ? resolvedEdgeAnchor(to, from ? { x: from.x + from.width / 2, y: from.y + from.height / 2 } : edge.freeStart!, edge.toAnchor) : edge.freeEnd!
  const x1 = start.x - region.x; const y1 = start.y - region.y
  const x2 = finish.x - region.x; const y2 = finish.y - region.y
  if (edge.routing === 'elbow') return `M ${x1} ${y1} L ${(x1 + x2) / 2} ${y1} L ${(x1 + x2) / 2} ${y2} L ${x2} ${y2}`
  if (edge.routing === 'polyline') return `M ${x1} ${y1}${(edge.controlPoints || []).map(point => ` L ${point.x - region.x} ${point.y - region.y}`).join('')} L ${x2} ${y2}`
  if (edge.routing === 'curve') return `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`
  return `M ${x1} ${y1} L ${x2} ${y2}`
}

const shapeSvg = (item: BoardElement) => {
  const w = item.width; const h = item.height
  if (item.kind === 'ellipse') return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"/>`
  if (item.kind === 'diamond') return `<path d="M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z"/>`
  if (item.kind === 'triangle') return `<path d="M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z"/>`
  if (item.kind === 'hexagon') return `<path d="M ${w * .24} 0 L ${w * .76} 0 L ${w} ${h / 2} L ${w * .76} ${h} L ${w * .24} ${h} L 0 ${h / 2} Z"/>`
  if (item.kind === 'database') return `<path d="M 0 16 C 0 -5 ${w} -5 ${w} 16 L ${w} ${h - 16} C ${w} ${h + 5} 0 ${h + 5} 0 ${h - 16} Z M 0 16 C 0 37 ${w} 37 ${w} 16 M 0 ${h - 16} C 0 ${h - 37} ${w} ${h - 37} ${w} ${h - 16}"/>`
  if (item.kind === 'cloud') return `<path d="M ${w*.2} ${h*.78} C ${w*.02} ${h*.78} ${w*.01} ${h*.47} ${w*.21} ${h*.43} C ${w*.2} ${h*.2} ${w*.48} ${h*.1} ${w*.61} ${h*.3} C ${w*.79} ${h*.21} ${w*.96} ${h*.39} ${w*.9} ${h*.55} C ${w*1.05} ${h*.71} ${w*.86} ${h*.85} ${w*.72} ${h*.78} Z"/>`
  if (item.kind === 'actor') return `<g fill="none"><circle cx="${w/2}" cy="${h*.17}" r="${Math.min(w,h)*.13}"/><path d="M ${w/2} ${h*.3} V ${h*.65} M ${w*.2} ${h*.43} H ${w*.8} M ${w/2} ${h*.65} L ${w*.22} ${h*.96} M ${w/2} ${h*.65} L ${w*.78} ${h*.96}"/></g>`
  return `<rect width="${w}" height="${h}" rx="${item.kind === 'rounded_rectangle' ? item.borderRadius ?? 28 : item.kind === 'text' ? 0 : item.borderRadius ?? 8}"/>`
}

const textSvg = (item: BoardElement) => {
  const lines = String(item.text || '').split(/\n/)
  const lineHeight = item.fontSize * 1.25
  const startY = item.height / 2 - ((lines.length - 1) * lineHeight) / 2
  const anchor = item.textAlign === 'left' ? 'start' : item.textAlign === 'right' ? 'end' : 'middle'
  const x = item.textAlign === 'left' ? 10 : item.textAlign === 'right' ? item.width - 10 : item.width / 2
  return `<text x="${x}" y="${startY}" text-anchor="${anchor}" dominant-baseline="middle" fill="${xml(item.textColor || '#263145')}" font-family="${xml(item.fontFamily || 'Arial')}" font-size="${item.fontSize}" font-weight="${item.fontWeight === 'bold' ? 700 : 400}" font-style="${item.fontStyle || 'normal'}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${xml(line)}</tspan>`).join('')}</text>`
}

export function renderRegionSvg(document: BoardDocument, region: ExportRegion, transparent = false) {
  const clipped = documentForRegion(document, region)
  const elements = [...clipped.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
  const edges = [...clipped.edges].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}" viewBox="0 0 ${region.width} ${region.height}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M1 1 L9 5 L1 9" fill="none" stroke="context-stroke" stroke-width="1.6"/></marker><marker id="triangle" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M1 1 L9 5 L1 9 Z" fill="context-stroke"/></marker><clipPath id="crop"><rect width="${region.width}" height="${region.height}"/></clipPath></defs>${transparent ? '' : `<rect width="100%" height="100%" fill="#ffffff"/>`}<g clip-path="url(#crop)">${edges.map(edge => { const from=clipped.elements.find(item=>item.id===edge.from);const to=clipped.elements.find(item=>item.id===edge.to);if((!from&&!edge.freeStart)||(!to&&!edge.freeEnd))return '';const dash=edge.strokeStyle==='dashed'?'10 7':edge.strokeStyle==='dotted'?'2 6':'';return `<path d="${edgePath(edge,from,to,region)}" fill="none" stroke="${xml(edge.stroke)}" stroke-width="${edge.strokeWidth}" ${dash?`stroke-dasharray="${dash}"`:''} opacity="${edge.opacity??1}" ${edge.endArrow&&edge.endArrow!=='none'?`marker-end="url(#${edge.endArrow==='triangle'?'triangle':'arrow'})"`:''}/>` }).join('')}${elements.map(item=>`<g transform="translate(${item.x-region.x} ${item.y-region.y}) rotate(${item.rotation||0} ${item.width/2} ${item.height/2})" fill="${xml(item.fill)}" fill-opacity="${item.fillOpacity??1}" stroke="${xml(item.stroke)}" stroke-width="${item.strokeWidth}" opacity="${item.opacity??1}" ${item.strokeStyle==='dashed'?'stroke-dasharray="10 7"':item.strokeStyle==='dotted'?'stroke-dasharray="2 6"':''}>${shapeSvg(item)}${textSvg(item)}</g>`).join('')}</g></svg>`
}

async function svgToBlob(svg: string, width: number, height: number, mime: 'image/png'|'image/jpeg'|'image/webp', scale: number, transparent: boolean) {
  const image = new Image(); const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('无法渲染导出区域')); image.src = url })
    const canvas = window.document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d'); if (!context) throw new Error('当前设备不支持图片导出')
    if (!transparent || mime === 'image/jpeg') { context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height) }
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片编码失败')), mime, .94))
  } finally { URL.revokeObjectURL(url) }
}

/**
 * Produce a bounded PNG data URL for the visual inspection tool. This uses the
 * same document-to-SVG renderer as export, so the model sees the persisted
 * board rather than temporary selection handles or the surrounding app UI.
 */
export async function renderRegionPngDataUrl(document: BoardDocument, region: ExportRegion, maxDimension = 2048) {
  const longestSide = Math.max(region.width, region.height, 1)
  const scale = Math.max(.1, Math.min(2, maxDimension / longestSide))
  const blob = await svgToBlob(renderRegionSvg(document, region), region.width, region.height, 'image/png', scale, false)
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('截图编码失败'))
    reader.readAsDataURL(blob)
  })
  const base64 = dataUrl.split(',', 2)[1] || ''
  if (!base64) throw new Error('截图编码失败')
  // A vision request should remain well below provider body limits. PNGs of
  // normal diagrams are much smaller; this is a final safety boundary.
  if (base64.length > 8 * 1024 * 1024) throw new Error('截图过大，请缩小截图范围后重试')
  return { base64, width: Math.max(1, Math.round(region.width * scale)), height: Math.max(1, Math.round(region.height * scale)), scale }
}

function download(blob: Blob, fileName: string) { const url=URL.createObjectURL(blob);const anchor=window.document.createElement('a');anchor.href=url;anchor.download=fileName;anchor.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000) }

export function toDrawIoXml(document: BoardDocument, region: ExportRegion) {
  const clipped = documentForRegion(document, region)
  const vertices = clipped.elements.map(item => `<mxCell id="${xml(item.id)}" value="${xml(item.text)}" style="rounded=${item.kind==='rounded_rectangle'?1:0};whiteSpace=wrap;html=1;fillColor=${xml(item.fill)};strokeColor=${xml(item.stroke)};fontColor=${xml(item.textColor||'#263145')};fontSize=${item.fontSize};opacity=${Math.round((item.opacity??1)*100)};" vertex="1" parent="1"><mxGeometry x="${item.x-region.x}" y="${item.y-region.y}" width="${item.width}" height="${item.height}" as="geometry"/></mxCell>`).join('')
  const edges = clipped.edges.map(edge => `<mxCell id="${xml(edge.id)}" value="${xml(edge.label||'')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=${xml(edge.stroke)};strokeWidth=${edge.strokeWidth};endArrow=${edge.endArrow==='none'?'none':'classic'};" edge="1" parent="1" source="${xml(edge.from)}" target="${xml(edge.to)}"><mxGeometry relative="1" as="geometry"/></mxCell>`).join('')
  return `<mxfile host="TuGo"><diagram name="Page-1"><mxGraphModel dx="${region.width}" dy="${region.height}" grid="1" gridSize="10" page="1" pageWidth="${Math.ceil(region.width)}" pageHeight="${Math.ceil(region.height)}"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${vertices}${edges}</root></mxGraphModel></diagram></mxfile>`
}

const pptShape = (kind: ElementKind, pptx: PptxGenJS) => {
  const shape = pptx.ShapeType
  return ({ rectangle: shape.rect, rounded_rectangle: shape.roundRect, ellipse: shape.ellipse, diamond: shape.diamond, triangle: shape.triangle, hexagon: shape.hexagon, database: shape.can, cloud: shape.cloud, actor: shape.rect, frame: shape.rect, text: shape.rect, note: shape.rect, image: shape.rect } as Record<ElementKind, PptxGenJS.ShapeType>)[kind] || shape.rect
}

type PptPoint = { x: number; y: number }

function boundaryPoint(item: BoardElement, toward: PptPoint, pos: (item: BoardElement) => { x: number; y: number; w: number; h: number }): PptPoint {
  const box = pos(item)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (Math.abs(dx) < .001 && Math.abs(dy) < .001) return { x: cx, y: cy }
  if (item.kind === 'ellipse' || item.kind === 'actor') {
    const radius = 1 / Math.sqrt((dx * dx) / (box.w * box.w / 4) + (dy * dy) / (box.h * box.h / 4))
    return { x: cx + dx * radius, y: cy + dy * radius }
  }
  const scale = Math.min((box.w / 2) / Math.abs(dx || Number.EPSILON), (box.h / 2) / Math.abs(dy || Number.EPSILON))
  return { x: cx + dx * scale, y: cy + dy * scale }
}

const finitePoints = (value: BoardEdge['controlPoints']) => Array.isArray(value) ? value.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y)) : []
const quadratic = (a: PptPoint, control: PptPoint, b: PptPoint, slices = 12) => Array.from({ length: slices + 1 }, (_, index) => {
  const t = index / slices; const u = 1 - t
  return { x: u * u * a.x + 2 * u * t * control.x + t * t * b.x, y: u * u * a.y + 2 * u * t * control.y + t * t * b.y }
})
// This is the single canvas-path translation used for editable PPT lines.
// It mirrors InfiniteCanvas: endpoints are anchored using the opposite node's
// centre, elbow/curve control points are preserved, and a curve is the same
// quadratic Bézier sampled into safe native PPT line segments.
function canvasRoutePoints(edge: BoardEdge, from?: BoardElement, to?: BoardElement): PptPoint[] {
  // A free endpoint is a first-class canvas line, not an incomplete connector.
  // Keep the export route in the same coordinate model as SVG/InfiniteCanvas so
  // free and mixed edges survive the editable PPTX translation.
  if ((!from && !edge.freeStart) || (!to && !edge.freeEnd)) return []
  const toCenter = to ? { x: to.x + to.width / 2, y: to.y + to.height / 2 } : edge.freeEnd!
  const fromCenter = from ? { x: from.x + from.width / 2, y: from.y + from.height / 2 } : edge.freeStart!
  // Keep routing math in board coordinates until the route is complete. The
  // old export mixed scaled PowerPoint points with the canvas default `-50`,
  // effectively treating it as *50 inches*. That is the root cause of the
  // huge arcs/vertical lines seen in exported decks.
  const start = from ? resolvedEdgeAnchor(from, toCenter, edge.fromAnchor) : edge.freeStart!
  const end = to ? resolvedEdgeAnchor(to, fromCenter, edge.toAnchor) : edge.freeEnd!
  const control = finitePoints(edge.controlPoints)
  const routing = edge.routing || 'curve'
  if (routing === 'straight') return [start, end]
  if (routing === 'elbow') {
    const first = control[0] || { x: (start.x + end.x) / 2, y: start.y }
    const second = control[1] || { x: first.x, y: end.y }
    return [start, first, second, end]
  }
  const curveControl = control[0] || { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 50 }
  return quadratic(start, curveControl, end)
}

function pptRoutePoints(edge: BoardEdge, from: BoardElement | undefined, to: BoardElement | undefined, point: (value: PptPoint) => PptPoint) {
  return canvasRoutePoints(edge, from, to).map(point)
}

const arrow = (value: BoardEdge['startArrow']): PptxGenJS.ShapeLineProps['beginArrowType'] | undefined => {
  if (!value || value === 'none') return undefined
  return value === 'circle' ? 'oval' : value === 'diamond' ? 'diamond' : value === 'triangle' ? 'triangle' : 'arrow'
}
const routeMidpoint = (points: PptPoint[]) => {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y))
  const half = lengths.reduce((sum, value) => sum + value, 0) / 2; let walked = 0
  for (let index = 0; index < lengths.length; index += 1) {
    if (walked + lengths[index] >= half) { const t = (half - walked) / (lengths[index] || 1); return { x: points[index].x + (points[index + 1].x - points[index].x) * t, y: points[index].y + (points[index + 1].y - points[index].y) * t } }
    walked += lengths[index]
  }
  return points[Math.floor(points.length / 2)] || { x: 0, y: 0 }
}


function addPptLine(slide: PptxGenJS.Slide, pptx: PptxGenJS, a: PptPoint, b: PptPoint, line: PptxGenJS.ShapeLineProps, beginArrowType?: PptxGenJS.ShapeLineProps['beginArrowType'], endArrowType?: PptxGenJS.ShapeLineProps['endArrowType']) {
  if (Math.abs(a.x - b.x) < .001 && Math.abs(a.y - b.y) < .001) return
  // DrawingML extents must be positive. Do not use flipH/flipV: Office can
  // misplace flipped line shapes inside a routed diagram. DrawingML has two
  // native editable geometries instead: line (↘) and lineInv (↗). Pick the
  // correct geometry from the canonical left endpoint, then only swap arrows
  // when the original edge itself runs right-to-left.
  const dx = b.x - a.x; const dy = b.y - a.y
  const vertical = Math.abs(dx) < .001
  const reverse = vertical ? dy < 0 : dx < 0
  const left = reverse && !vertical ? b : a; const right = reverse && !vertical ? a : b
  const begin = reverse ? endArrowType : beginArrowType
  const end = reverse ? beginArrowType : endArrowType
  const shape = !vertical && left.y > right.y ? pptx.ShapeType.lineInv : pptx.ShapeType.line
  slide.addShape(shape, {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(dx), h: Math.abs(dy),
    line: { ...line, beginArrowType: begin, endArrowType: end },
  })
}

// Board dimensions are CSS-pixel-like units while PowerPoint text and line
// sizes are points. Positions were scaled to the slide but typography used a
// fixed point value, which made a fitted large canvas wrap and overlap text.
const pptPoints = (boardPixels: number, scale: number, minimum = 0) => Math.max(minimum, boardPixels * scale * 72)
const pptLine = (boardPixels: number, scale: number) => pptPoints(boardPixels, scale, .25)
const pptTextBox = (item: BoardElement, p: { x: number; y: number; w: number; h: number }, scale: number) => {
  const horizontalInset = 8 * scale; const verticalInset = 6 * scale
  return {
    x: p.x + horizontalInset, y: p.y + verticalInset,
    w: Math.max(.01, p.w - horizontalInset * 2), h: Math.max(.01, p.h - verticalInset * 2),
    margin: 0, rotate: item.rotation || 0, fontFace: item.fontFamily || 'Arial',
    fontSize: pptPoints(item.fontSize, scale, 4.5), bold: item.fontWeight === 'bold', italic: item.fontStyle === 'italic',
    underline: item.textDecoration === 'underline' ? { color: color(item.textColor) } : undefined,
    color: color(item.textColor, '263145'), align: item.textAlign || 'center',
    valign: (item.verticalAlign === 'top' ? 'top' : item.verticalAlign === 'bottom' ? 'bottom' : 'middle') as 'top' | 'bottom' | 'middle',
    breakLine: false, fit: 'shrink' as const,
  }
}

function appendRegionPptx(pptx: PptxGenJS, document: BoardDocument, region: ExportRegion) {
  const clipped = documentForRegion(document, region)
  const slide = pptx.addSlide(); slide.background = { color: 'FFFFFF' }
  // PowerPoint is a slide, not an infinite canvas. Trim the selected frame to the
  // actual content so a full-canvas drag does not turn into a tiny diagram.
  const pad = 28
  // A selected export can contain a high curve or an elbow that extends beyond
  // its nodes. Include route geometry in the fitted content frame so it never
  // gets clipped merely because its control point is outside a node box.
  const routePoints = clipped.edges.flatMap(edge => {
    const from = clipped.elements.find(item => item.id === edge.from)
    const to = clipped.elements.find(item => item.id === edge.to)
    return canvasRoutePoints(edge, from, to)
  })
  const contentFrame = clipped.elements.length ? {
    x: Math.max(region.x, Math.min(region.x + region.width, Math.min(...clipped.elements.map(item => item.x), ...routePoints.map(point => point.x)) - pad)),
    y: Math.max(region.y, Math.min(region.y + region.height, Math.min(...clipped.elements.map(item => item.y), ...routePoints.map(point => point.y)) - pad)),
    width: 0,
    height: 0,
  } : region
  if (clipped.elements.length) {
    const right = Math.min(region.x + region.width, Math.max(...clipped.elements.map(item => item.x + item.width), ...routePoints.map(point => point.x)) + pad)
    const bottom = Math.min(region.y + region.height, Math.max(...clipped.elements.map(item => item.y + item.height), ...routePoints.map(point => point.y)) + pad)
    contentFrame.width = right - contentFrame.x; contentFrame.height = bottom - contentFrame.y
  }
  const frame = contentFrame.width > 0 && contentFrame.height > 0 ? contentFrame : region
  const margin=.28, availableW=13.333-margin*2, availableH=7.5-margin*2, scale=Math.min(availableW/frame.width,availableH/frame.height), offsetX=(13.333-frame.width*scale)/2, offsetY=(7.5-frame.height*scale)/2
  const pos=(item:BoardElement)=>({x:offsetX+(item.x-frame.x)*scale,y:offsetY+(item.y-frame.y)*scale,w:item.width*scale,h:item.height*scale})
  const point = (value: PptPoint): PptPoint => ({ x: offsetX + (value.x - frame.x) * scale, y: offsetY + (value.y - frame.y) * scale })
  for (const edge of [...clipped.edges].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))) {
    const from = clipped.elements.find(item => item.id === edge.from); const to = clipped.elements.find(item => item.id === edge.to)
    if ((!from && !edge.freeStart) || (!to && !edge.freeEnd)) continue
    const line = { color: color(edge.stroke), width: pptLine(edge.strokeWidth, scale), dashType: edge.strokeStyle === 'dashed' ? 'dash' as const : edge.strokeStyle === 'dotted' ? 'sysDot' as const : 'solid' as const, transparency: Math.round((1 - (edge.opacity ?? 1)) * 100) }
    const points = pptRoutePoints(edge, from, to, point)
    if (points.length < 2) continue
    const startArrow = edge.startArrow || (edge.arrowStart ? 'arrow' : 'none')
    const endArrow = edge.endArrow || (edge.arrowEnd ? 'arrow' : 'none')
    for (let index = 0; index < points.length - 1; index += 1) addPptLine(slide, pptx, points[index], points[index + 1], line, index === 0 ? arrow(startArrow) : undefined, index === points.length - 2 ? arrow(endArrow) : undefined)
    if (edge.label) { const label = routeMidpoint(points); const boxW = Math.max(.35, 92 * scale); const boxH = Math.max(.16, 24 * scale); slide.addText(edge.label, { x: label.x - boxW / 2, y: label.y - boxH / 2, w: boxW, h: boxH, margin: 0, fontFace: 'Arial', fontSize: pptPoints(13, scale, 4.5), color: color(edge.stroke), align: 'center', valign: 'middle', fit: 'shrink' }) }
  }
  const elements = [...clipped.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
  // The canvas keeps labels above cards and coloured ranges. PPT previously
  // emitted every item atomically, allowing a late background rectangle to
  // cover labels that had already been emitted. Keep geometry and text as two
  // editable layers, matching the whiteboard painter model.
  for (const item of elements) {
    if (!hasVisibleGeometry(item)) continue
    const p = pos(item)
    const line = { color: color(item.stroke), width: pptLine(item.strokeWidth, scale), dashType: item.strokeStyle === 'dashed' ? 'dash' as const : item.strokeStyle === 'dotted' ? 'sysDot' as const : 'solid' as const, transparency: Math.round((1 - (item.opacity ?? 1)) * 100) }
    if (item.kind === 'actor') {
      const head = Math.min(p.w, p.h) * .27
      slide.addShape(pptx.ShapeType.ellipse, { x: p.x + (p.w - head) / 2, y: p.y, w: head, h: head, fill: { color: 'FFFFFF', transparency: 100 }, line })
      const cx = p.x + p.w / 2, bodyTop = p.y + head, hip = p.y + p.h * .65
      for (const segment of [[cx, bodyTop, cx, hip], [p.x + p.w * .2, p.y + p.h * .42, p.x + p.w * .8, p.y + p.h * .42], [cx, hip, p.x + p.w * .22, p.y + p.h * .96], [cx, hip, p.x + p.w * .78, p.y + p.h * .96]]) slide.addShape(pptx.ShapeType.line, { x: segment[0], y: segment[1], w: segment[2] - segment[0], h: segment[3] - segment[1], line })
    } else slide.addShape(pptShape(item.kind, pptx), { ...p, rotate: item.rotation || 0, fill: { color: color(item.fill, 'FFFFFF'), transparency: Math.round((1 - (item.fillOpacity ?? 1)) * 100) }, line })
  }
  for (const item of elements) if (item.text) slide.addText(item.text, pptTextBox(item, pos(item), scale))
}

function createPptx(fileName: string) { const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'TuGo'; pptx.subject = 'TuGo editable canvas export'; pptx.title = fileName; return pptx }

export function buildRegionPptx(document: BoardDocument, region: ExportRegion, fileName: string) {
  const pptx = createPptx(fileName)
  appendRegionPptx(pptx, document, region)
  return pptx
}

export function buildRegionsPptx(document: BoardDocument, regions: ExportRegion[], fileName: string) {
  const pptx = createPptx(fileName)
  regions.forEach(region => appendRegionPptx(pptx, document, region))
  return pptx
}

/** Builds an editable presentation without triggering a browser download. */
export async function buildRegionsPptxBase64(document: BoardDocument, regions: ExportRegion[], fileName: string) {
  const payload = await buildRegionsPptx(document, regions, fileName).write({ outputType: 'base64', compression: true })
  if (typeof payload !== 'string' || !payload) throw new Error('PPT 文件编码失败')
  return payload
}

async function exportPptx(document: BoardDocument, region: ExportRegion, fileName: string) {
  await buildRegionPptx(document,region,fileName).writeFile({ fileName: `${safeName(fileName)}.pptx`, compression: true })
}

export async function exportRegion(document: BoardDocument, region: ExportRegion, fileName: string, options: ExportOptions) {
  const format=options.format, scale=Math.max(1,Math.min(4,options.scale||2)), transparent=Boolean(options.transparent)
  const svg=renderRegionSvg(document,region,transparent)
  if(format==='svg'){download(new Blob([svg],{type:'image/svg+xml'}),`${safeName(fileName)}.svg`);return}
  if(format==='drawio'){download(new Blob([toDrawIoXml(document,region)],{type:'application/xml'}),`${safeName(fileName)}.drawio`);return}
  if(format==='pptx'){await exportPptx(document,region,fileName);return}
  const mime=format==='jpeg'?'image/jpeg':format==='webp'?'image/webp':'image/png';const image=await svgToBlob(svg,region.width,region.height,mime,scale,transparent)
  if(format==='pdf'){const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(image)});const landscape=region.width>=region.height;const pageW=landscape?Math.min(842,595*region.width/region.height):595;const pageH=landscape?595:Math.min(842,595*region.height/region.width);const pdf=new jsPDF({orientation:landscape?'landscape':'portrait',unit:'pt',format:[pageW,pageH]});pdf.addImage(data,'PNG',0,0,pageW,pageH);pdf.save(`${safeName(fileName)}.pdf`);return}
  download(image,`${safeName(fileName)}.${format==='jpeg'?'jpg':format}`)
}
