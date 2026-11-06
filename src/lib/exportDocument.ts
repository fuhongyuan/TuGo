import { layoutNodeText } from './textLayout'
import {sceneObstacles} from './sceneObstacles'
import { elementLayers } from './boardCommands'
import { documentEdgeRoutes, resolveEdgeRoute, routePath } from './edgeRoute'
import PptxGenJS from 'pptxgenjs'
import { jsPDF } from 'jspdf'
import type { BoardDocument, BoardEdge, BoardElement, ElementKind } from '../types'
import { edgeLabelLines, placeEdgeLabel, type CanvasRect } from './canvasGeometry'
import { edgeDefaults } from './canvasStyle'

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
  const { lines, fontSize, lineHeight } = layoutNodeText(item)
  const startY = item.verticalAlign === 'top' ? 10 + lineHeight / 2 : item.verticalAlign === 'bottom' ? item.height - 10 - (lines.length - .5) * lineHeight : item.height / 2 - ((lines.length - 1) * lineHeight) / 2
  const anchor = item.textAlign === 'left' ? 'start' : item.textAlign === 'right' ? 'end' : 'middle'
  const x = item.textAlign === 'left' ? 10 : item.textAlign === 'right' ? item.width - 10 : item.width / 2
  // Shape paint is inherited through the parent group. Text needs independent
  // paint, while the group's overall opacity must still apply to the object.
  return `<text x="${x}" y="${startY}" text-anchor="${anchor}" dominant-baseline="middle" fill="${xml(item.textColor || '#263145')}" fill-opacity="1" stroke="none" stroke-width="0" stroke-dasharray="none" font-family="${xml(item.fontFamily || 'Arial')}" font-size="${fontSize}" font-weight="${item.fontWeight === 'bold' ? 700 : 400}" font-style="${item.fontStyle || 'normal'}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${xml(line)}</tspan>`).join('')}</text>`
}

export function renderRegionSvg(document: BoardDocument, region: ExportRegion, transparent = false) {
  const clipped = documentForRegion(document, region)
  const routes = documentEdgeRoutes(document.elements, document.edges)
  const obstacles = sceneObstacles(document.elements)
  const occupied: CanvasRect[] = []
  const labels = [...clipped.edges].sort((a,b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)).filter(edge => edge.label).map(edge => {
    const points = routes.get(edge.id)?.pathPoints || []
    if (!points.length) return ''
    const center = placeEdgeLabel(points, edge.label || '', obstacles, occupied), lines = edgeLabelLines(edge.label || '')
    occupied.push({x: center.x-center.width/2, y:center.y-center.height/2, width:center.width, height:center.height})
    return `<rect x="${center.x-region.x-center.width/2}" y="${center.y-region.y-center.height/2}" width="${center.width}" height="${center.height}" rx="6" fill="white" stroke="#dbe0e8"/><text x="${center.x - region.x}" y="${center.y - region.y - (lines.length - 1) * 9}" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="13" fill="${xml(edge.stroke || '#64748b')}" stroke="white" stroke-width="5" stroke-linejoin="round" paint-order="stroke" opacity="${edge.opacity ?? 1}">${lines.map((line, index) => `<tspan x="${center.x - region.x}" y="${center.y - region.y - (lines.length - 1) * 9 + index * 18}">${xml(line)}</tspan>`).join('')}</text>`
  }).join('')
  return renderRegionSvgBase(document, region, transparent).replace('</g></svg>', `${labels}</g></svg>`)
}

function renderRegionSvgBase(document: BoardDocument, region: ExportRegion, transparent = false) {
  const clipped = documentForRegion(document, region)
  const elements = [...clipped.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
  const routes = documentEdgeRoutes(document.elements, document.edges)
  const edges = [...clipped.edges].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))
  const renderElements = (elements: BoardElement[]) => elements.map(item=>`<g transform="translate(${item.x-region.x} ${item.y-region.y}) rotate(${item.rotation||0} ${item.width/2} ${item.height/2})" fill="${xml(item.fill)}" fill-opacity="${item.fillOpacity??1}" stroke="${xml(item.stroke)}" stroke-width="${item.strokeWidth}" opacity="${item.opacity??1}" ${item.strokeStyle==='dashed'?'stroke-dasharray="10 7"':item.strokeStyle==='dotted'?'stroke-dasharray="2 6"':''}>${shapeSvg(item)}${textSvg(item)}</g>`).join('')
  const layers = elementLayers(elements)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${region.width}" height="${region.height}" viewBox="0 0 ${region.width} ${region.height}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="context-stroke" stroke-width="1.6"/></marker><marker id="triangle" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 1 L9 5 L1 9 Z" fill="context-stroke"/></marker><marker id="circle" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><circle cx="5" cy="5" r="3.2" fill="context-stroke"/></marker><marker id="diamond" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 5 L5 1 L9 5 L5 9 Z" fill="context-stroke"/></marker><clipPath id="crop"><rect width="${region.width}" height="${region.height}"/></clipPath></defs>${transparent ? '' : `<rect width="100%" height="100%" fill="#ffffff"/>`}<g clip-path="url(#crop)">${renderElements(layers.background)}${edges.map(edge => { const from=clipped.elements.find(item=>item.id===edge.from);const to=clipped.elements.find(item=>item.id===edge.to);if((!from&&!edge.freeStart)||(!to&&!edge.freeEnd))return '';const style=edgeDefaults(edge);const dash=style.strokeStyle==='dashed'?'10 7':style.strokeStyle==='dotted'?'2 6':'';return `<path d="${(() => { const r = routes.get(edge.id)!; const shift = (p: PptPoint) => ({ x: p.x - region.x, y: p.y - region.y }); return routePath(r.routing, shift(r.start), shift(r.end), r.points.map(shift)) })()}" fill="none" stroke="${xml(edge.stroke)}" stroke-width="${edge.strokeWidth}" ${dash?`stroke-dasharray="${dash}"`:''} opacity="${style.opacity}" ${style.startArrow!=='none'?`marker-start="url(#${style.startArrow})"`:''} ${style.endArrow&&style.endArrow!=='none'?`marker-end="url(#${style.endArrow})"`:''}/>` }).join('')}${renderElements(layers.foreground)}</g></svg>`
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

function canvasRoutePoints(edge: BoardEdge, from?: BoardElement, to?: BoardElement): PptPoint[] {
  return resolveEdgeRoute(edge, [from, to].filter((item): item is BoardElement => Boolean(item)))?.pathPoints || []
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
  const horizontalInset = 12 * scale; const verticalInset = 4 * scale
  return {
    x: p.x + horizontalInset, y: p.y + verticalInset,
    w: Math.max(.01, p.w - horizontalInset * 2), h: Math.max(.01, p.h - verticalInset * 2),
    margin: 0, rotate: item.rotation || 0, fontFace: item.fontFamily || 'Arial',
    fontSize: pptPoints(layoutNodeText(item).fontSize, scale, 4.5), bold: item.fontWeight === 'bold', italic: item.fontStyle === 'italic',
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
  // PowerPoint uses insertion order as z-order: backgrounds, connectors,
  // foreground cards, then connector labels (the same order as the canvas).
  const layers = elementLayers(clipped.elements)
  const addGeometry = (item: BoardElement) => {
    if (!hasVisibleGeometry(item)) return
    const p = pos(item)
    const line = { color: color(item.stroke), width: pptLine(item.strokeWidth, scale), dashType: item.strokeStyle === 'dashed' ? 'dash' as const : item.strokeStyle === 'dotted' ? 'sysDot' as const : 'solid' as const, transparency: Math.round((1 - (item.opacity ?? 1)) * 100) }
    if (item.kind === 'actor') {
      const head = Math.min(p.w, p.h) * .27
      slide.addShape(pptx.ShapeType.ellipse, { x: p.x + (p.w - head) / 2, y: p.y, w: head, h: head, fill: { color: 'FFFFFF', transparency: 100 }, line })
      const cx = p.x + p.w / 2, bodyTop = p.y + head, hip = p.y + p.h * .65
      for (const segment of [[cx, bodyTop, cx, hip], [p.x + p.w * .2, p.y + p.h * .42, p.x + p.w * .8, p.y + p.h * .42], [cx, hip, p.x + p.w * .22, p.y + p.h * .96], [cx, hip, p.x + p.w * .78, p.y + p.h * .96]]) slide.addShape(pptx.ShapeType.line, { x: segment[0], y: segment[1], w: segment[2] - segment[0], h: segment[3] - segment[1], line })
    } else slide.addShape(pptShape(item.kind, pptx), { ...p, rotate: item.rotation || 0, fill: { color: color(item.fill, 'FFFFFF'), transparency: Math.round((1 - (item.fillOpacity ?? 1)) * 100) }, line })
  }
  for (const item of layers.background) {
    addGeometry(item)
    if (item.text) slide.addText(layoutNodeText(item).lines.join('\n'), pptTextBox(item, pos(item), scale))
  }
  const labels: Array<() => void> = []
  const exportRoutes = documentEdgeRoutes(document.elements, document.edges)
  const labelObstacles = sceneObstacles(document.elements)
  const occupiedLabels: CanvasRect[] = []
  for (const edge of [...clipped.edges].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))) {
    const from = clipped.elements.find(item => item.id === edge.from); const to = clipped.elements.find(item => item.id === edge.to)
    if ((!from && !edge.freeStart) || (!to && !edge.freeEnd)) continue
    const line = { color: color(edge.stroke), width: pptLine(edge.strokeWidth, scale), dashType: edge.strokeStyle === 'dashed' ? 'dash' as const : edge.strokeStyle === 'dotted' ? 'sysDot' as const : 'solid' as const, transparency: Math.round((1 - (edge.opacity ?? 1)) * 100) }
    const points = (exportRoutes.get(edge.id)?.pathPoints || []).map(point)
    if (points.length < 2) continue
    const startArrow = edge.startArrow || (edge.arrowStart ? 'arrow' : 'none')
    const endArrow = edge.endArrow || (edge.arrowEnd ? 'arrow' : 'none')
    for (let index = 0; index < points.length - 1; index += 1) addPptLine(slide, pptx, points[index], points[index + 1], line, index === 0 ? arrow(startArrow) : undefined, index === points.length - 2 ? arrow(endArrow) : undefined)
    if (edge.label) {
      const placement = placeEdgeLabel(exportRoutes.get(edge.id)!.pathPoints, edge.label, labelObstacles, occupiedLabels)
      occupiedLabels.push({x:placement.x-placement.width/2,y:placement.y-placement.height/2,width:placement.width,height:placement.height})
      const label = point(placement), boxW = placement.width * scale, boxH = placement.height * scale
      labels.push(() => slide.addText(edge.label!, { x: label.x-boxW/2, y:label.y-boxH/2,w:boxW,h:boxH,margin:0,fill:{color:'FFFFFF'},fontFace:'Arial',fontSize:pptPoints(13,scale,4.5),color:color(edge.stroke),align:'center',valign:'middle',fit:'shrink' }))
    }
  }
  for (const item of layers.foreground) addGeometry(item)
  for (const item of layers.foreground) if (item.text) slide.addText(layoutNodeText(item).lines.join('\n'), pptTextBox(item, pos(item), scale))
  for (const addLabel of labels) addLabel()

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

export async function exportBoardFile(document: BoardDocument, format: string, requestedRegion: unknown, name: string) {
  if (!['svg','drawio','png','jpeg','webp','pdf','pptx'].includes(format)) throw new Error('不支持的导出格式')
  const items = document.elements
  const routes = document.edges.flatMap(edge => canvasRoutePoints(edge, items.find(item => item.id === edge.from), items.find(item => item.id === edge.to)))
  const left = [...items.map(item => item.x), ...routes.map(point => point.x)]
  const top = [...items.map(item => item.y), ...routes.map(point => point.y)]
  const x = (left.length ? Math.min(...left) : 0) - 32, y = (top.length ? Math.min(...top) : 0) - 32
  const right = Math.max(x + 236, ...items.map(item => item.x + item.width), ...routes.map(point => point.x))
  const bottom = Math.max(y + 136, ...items.map(item => item.y + item.height), ...routes.map(point => point.y))
  const region = (requestedRegion || { x, y, width: right - x + 32, height: bottom - y + 32 }) as ExportRegion
  if (![region.x,region.y,region.width,region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0 || region.width > 16000 || region.height > 16000 || region.width * region.height > 40_000_000) throw new Error('导出范围无效或过大，请通过 region 指定较小范围')
  if (format === 'svg') return { file: { encoding: 'utf8', data: renderRegionSvg(document, region) } }
  if (format === 'drawio') return { file: { encoding: 'utf8', data: toDrawIoXml(document, region) } }
  if (format === 'pptx') return { file: { encoding: 'base64', data: await buildRegionsPptxBase64(document, [region], name) } }
  const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
  const blob = await svgToBlob(renderRegionSvg(document, region), region.width, region.height, mime, 1, false)
  const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob) })
  if (format === 'pdf') {
    const pdf = new jsPDF({ orientation: region.width >= region.height ? 'landscape' : 'portrait', unit: 'pt', format: [region.width, region.height] })
    pdf.addImage(dataUrl, 'PNG', 0, 0, region.width, region.height)
    return { file: { encoding: 'base64', data: pdf.output('datauristring').split(',')[1] } }
  }
  return { file: { encoding: 'base64', data: dataUrl.split(',')[1] } }
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
