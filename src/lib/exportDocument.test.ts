import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import type { BoardDocument, BoardElement } from '../types'
import { buildRegionPptx, buildRegionsPptx, documentForRegion, renderRegionSvg, toDrawIoXml } from './exportDocument'
import { edgeAnchor } from './edgeGeometry'

const node = (id: string, x: number, y: number, text = id): BoardElement => ({
  id, kind: 'rectangle', x, y, width: 100, height: 60, text,
  fill: '#ffffff', stroke: '#334155', strokeWidth: 2, fontSize: 16,
})

const document: BoardDocument = {
  version: 3,
  viewport: { x: 90, y: 40, zoom: .8 },
  elements: [node('inside', 30, 30, 'A & B'), node('partial', 180, 50), node('outside', 360, 200)],
  edges: [
    { id: 'kept', from: 'inside', to: 'partial', stroke: '#64748b', strokeWidth: 2 },
    { id: 'removed', from: 'partial', to: 'outside', stroke: '#64748b', strokeWidth: 2 },
  ],
}

describe('single-page region export', () => {
  const region = { x: 20, y: 20, width: 190, height: 120 }

  it('keeps intersecting elements and only internal edges', () => {
    const clipped = documentForRegion(document, region)
    expect(clipped.elements.map(item => item.id)).toEqual(['inside', 'partial'])
    expect(clipped.edges.map(item => item.id)).toEqual(['kept'])
    expect(clipped.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('anchors lines on shape boundaries instead of centers', () => {
    const box = node('box', 100, 100)
    expect(edgeAnchor(box, { x: 400, y: 130 })).toEqual({ x: 200, y: 130 })
    const ellipse = { ...box, kind: 'ellipse' as const }
    const ellipseAnchor = edgeAnchor(ellipse, { x: 400, y: 130 })
    expect(ellipseAnchor.x).toBeCloseTo(200)
    expect(ellipseAnchor.y).toBeCloseTo(130)
  })

  it('renders a cropped SVG with escaped text', () => {
    const svg = renderRegionSvg(document, region)
    expect(svg).toContain('viewBox="0 0 190 120"')
    expect(svg).toContain('A &amp; B')
    expect(svg).not.toContain('outside')
  })

  it('creates editable draw.io vertices and edges in region coordinates', () => {
    const drawio = toDrawIoXml(document, region)
    expect(drawio).toContain('vertex="1"')
    expect(drawio).toContain('edge="1"')
    expect(drawio).toContain('source="inside" target="partial"')
    expect(drawio).toContain('x="10" y="10"')
    expect(drawio).toContain('A &amp; B')
    expect(drawio).not.toContain('id="outside"')
    expect(drawio).not.toContain('id="removed"')
  })

  it('builds a valid one-slide PPTX with editable shapes and text', async () => {
    const output = await buildRegionPptx(document, region, 'Region test').write({ outputType: 'uint8array', compression: true })
    const bytes = output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer)
    const zip = await JSZip.loadAsync(bytes)
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string')
    expect(slideXml).toContain('<p:sp>')
    expect(slideXml).toContain('A &amp; B')
    expect(slideXml).toContain('<a:prstGeom prst="line">')
    expect(slideXml!.indexOf('prst="line"')).toBeLessThan(slideXml!.indexOf('prst="rect"'))
    expect(zip.file('ppt/slides/slide2.xml')).toBeNull()
  })

  it('places every batch region on its own editable PPTX slide', async () => {
    const output = await buildRegionsPptx(document, [region, { x: 330, y: 170, width: 120, height: 120 }], 'Batch test').write({ outputType: 'uint8array', compression: true })
    const zip = await JSZip.loadAsync(output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer))
    expect(await zip.file('ppt/slides/slide1.xml')?.async('string')).toContain('A &amp; B')
    expect(await zip.file('ppt/slides/slide2.xml')?.async('string')).toContain('outside')
  })

  it('keeps free and mixed-endpoint canvas lines editable in PPTX', async () => {
    const free = {
      ...document,
      edges: [
        { id: 'free', from: '', to: '', freeStart: { x: 36, y: 145 }, freeEnd: { x: 310, y: 215 }, routing: 'polyline' as const, controlPoints: [{ x: 130, y: 260 }], stroke: '#7c3aed', strokeWidth: 3, endArrow: 'triangle' as const },
        { id: 'mixed', from: 'inside', to: '', freeEnd: { x: 320, y: 32 }, routing: 'straight' as const, stroke: '#0f766e', strokeWidth: 2, endArrow: 'diamond' as const },
      ],
    }
    const output = await buildRegionPptx(free, { x: 0, y: 0, width: 360, height: 300 }, 'Free lines').write({ outputType: 'uint8array', compression: true })
    const zip = await JSZip.loadAsync(output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer))
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string') || ''
    // One polyline makes two native line segments; the mixed edge adds one.
    expect((slideXml.match(/<a:prstGeom prst="line(?:Inv)?"/g) || []).length).toBeGreaterThanOrEqual(3)
  })

  it('scales editable text with the fitted board and keeps it above late card geometry', async () => {
    const title: BoardElement = { ...node('title', 80, 18, 'Agent 能力是固定集合，不同时代的能力边界不同'), kind: 'text', width: 1080, height: 42, fontSize: 31 }
    const lateBackground: BoardElement = { ...node('background', 40, 80, ''), width: 1120, height: 920, fill: '#cfe3f8' }
    const label: BoardElement = { ...node('label', 180, 260, 'Harness 负责范围'), kind: 'text', width: 220, height: 60, fontSize: 17 }
    // The same order produced by an Agent: labels exist before a later range
    // rectangle. PPT must still emit the rectangle before every text layer.
    const output = await buildRegionPptx({ ...document, elements: [title, label, lateBackground], edges: [] }, { x: 0, y: 0, width: 1200, height: 1100 }, 'Fitted typography').write({ outputType: 'uint8array', compression: true })
    const zip = await JSZip.loadAsync(output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer))
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string') || ''
    // 31 canvas pixels at this fitted scale is about 14pt, not the old fixed
    // 17pt. The range leaves room for renderer rounding between PPT versions.
    const titleSize = Number(slideXml.match(/<a:rPr[^>]*sz="(\d+)"/)?.[1] || 0)
    expect(titleSize).toBeGreaterThan(900); expect(titleSize).toBeLessThan(1550)
    expect(slideXml.indexOf('prst="rect"')).toBeLessThan(slideXml.indexOf('Harness 负责范围'))
  })

  it('keeps the actual fill and border of decorated text cards in editable PPT', async () => {
    const titleStrip: BoardElement = {
      ...node('title-strip', 40, 24, 'Harness 不是固定脚手架，而是 Agent 的可控设计维度'),
      kind: 'text', width: 1080, height: 48, fill: '#DCEBFF', stroke: '#6EA8FE', strokeWidth: 2, fontSize: 26,
    }
    const bareCaption: BoardElement = {
      ...node('bare-caption', 40, 92, '这是纯文字，不应该凭空出现外框'),
      kind: 'text', width: 560, height: 34, fill: 'transparent', stroke: 'transparent', strokeWidth: 0, fontSize: 16,
    }
    const output = await buildRegionPptx({ ...document, elements: [titleStrip, bareCaption], edges: [] }, { x: 0, y: 0, width: 1160, height: 180 }, 'Decorated text').write({ outputType: 'uint8array', compression: true })
    const zip = await JSZip.loadAsync(output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer))
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string') || ''
    // Both strings remain editable, but only the title strip exports a visible
    // background/border geometry. This is the canvas appearance from the
    // original screenshot rather than a title-only approximation.
    expect(slideXml).toContain('Harness 不是固定脚手架')
    expect(slideXml).toContain('这是纯文字')
    expect(slideXml).toContain('val="DCEBFF"')
    expect(slideXml).toContain('val="6EA8FE"')
  })

  it('uses positive PPT connector extents without fragile line transforms', async () => {
    const right = node('right', 160, 20)
    const left = node('left', 20, 90)
    const output = await buildRegionPptx({ ...document, elements: [right, left], edges: [{ id: 'backward', from: 'right', to: 'left', stroke: '#2563eb', strokeWidth: 2, arrowEnd: true }] }, { x: 0, y: 0, width: 260, height: 180 }, 'Backward line').write({ outputType: 'uint8array', compression: true })
    const bytes = output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer)
    const zip = await JSZip.loadAsync(bytes)
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string') || ''
    // PPT line and lineInv are both native editable geometries. They avoid
    // negative extents and flipH/flipV transforms that Office misrenders.
    expect(slideXml.slice(0, slideXml.indexOf('prst="rect"'))).not.toMatch(/flip[HV]="1"/)
    expect(slideXml).not.toMatch(/<a:ext cx="-/)
    // A routing mode omitted by an old board means "curve". Its default
    // canvas control point must be scaled once, rather than being interpreted
    // as a 50-inch PowerPoint offset.
    expect(slideXml).not.toMatch(/<a:off [^>]*y="-/)
    expect(slideXml).toContain('type="arrow"')
  })

  it('preserves elbow and curve control geometry, labels and arrow styles in PPT', async () => {
    const a = node('a', 20, 20), b = node('b', 260, 190)
    const edges = [
      { id: 'elbow', from: 'a', to: 'b', label: '路由', stroke: '#7c3aed', strokeWidth: 2, routing: 'elbow' as const, controlPoints: [{ x: 150, y: 50 }, { x: 150, y: 220 }], startArrow: 'circle' as const, endArrow: 'diamond' as const },
      { id: 'curve', from: 'b', to: 'a', label: '回流', stroke: '#2563eb', strokeWidth: 2, routing: 'curve' as const, controlPoints: [{ x: 310, y: 20 }], endArrow: 'triangle' as const },
    ]
    const output = await buildRegionPptx({ ...document, elements: [a, b], edges }, { x: 0, y: 0, width: 400, height: 300 }, 'All routes').write({ outputType: 'uint8array', compression: true })
    const bytes = output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer)
    const zip = await JSZip.loadAsync(bytes); const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string') || ''
    expect((slideXml.match(/prst="(?:line|lineInv)"/g) || []).length).toBeGreaterThanOrEqual(15) // 3 elbow segments + 12 curve samples
    expect(slideXml).toContain('type="oval"'); expect(slideXml).toContain('type="diamond"'); expect(slideXml).toContain('路由'); expect(slideXml).toContain('回流')
    expect(slideXml).not.toMatch(/<a:ext c[xy]="-/)
  })
})
