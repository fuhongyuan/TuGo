import { performance } from 'node:perf_hooks'
import { buildRegionPptx, renderRegionSvg, toDrawIoXml } from '../src/lib/exportDocument.ts'
import { normalizeDocument } from '../src/lib/boardState.ts'
import type { BoardDocument, BoardElement } from '../src/types.ts'

const count = Math.max(10, Number(process.env.TUGO_SCALE_ELEMENTS || 1000))
const columns = 25
const elements: BoardElement[] = Array.from({ length: count }, (_, index) => ({
  id: `scale-node-${index}`, kind: index % 5 === 0 ? 'rounded_rectangle' : index % 5 === 1 ? 'ellipse' : index % 5 === 2 ? 'diamond' : index % 5 === 3 ? 'hexagon' : 'rectangle',
  x: (index % columns) * 220, y: Math.floor(index / columns) * 120, width: 160, height: 72,
  text: `规模节点 ${index + 1}`, fill: '#ffffff', stroke: '#475569', strokeWidth: 2, fontSize: 15,
}))
const document: BoardDocument = {
  version: 3, viewport: { x: 0, y: 0, zoom: 1 }, elements,
  edges: Array.from({ length: count }, (_, index) => {
    const from = `scale-node-${index}`
    const to = `scale-node-${(index + 1) % count}`
    return { id: `scale-edge-${index}`, from, to, stroke: '#64748b', strokeWidth: 2, routing: index % 3 === 0 ? 'elbow' : index % 3 === 1 ? 'curve' : 'straight', endArrow: 'arrow' as const }
  }),
}
const region = { x: 0, y: 0, width: columns * 220, height: Math.ceil(count / columns) * 120 }
const measure = async <T,>(name: string, work: () => T | Promise<T>) => {
  const started = performance.now(); const result = await work(); return { name, ms: Math.round((performance.now() - started) * 100) / 100, result }
}

const normalized = await measure('normalize', () => normalizeDocument(document))
const svg = await measure('svg', () => renderRegionSvg(normalized.result, region))
const drawio = await measure('drawio', () => toDrawIoXml(normalized.result, region))
const pptx = await measure('pptx', async () => {
  const value = buildRegionPptx(normalized.result, region, 'TuGo scale benchmark')
  const bytes = await value.write({ outputType: 'uint8array', compression: true })
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer)
})
if (normalized.result.elements.length !== count || normalized.result.edges.length !== count) throw new Error('scale fixture was not preserved by normalization')
if (!svg.result.includes('规模节点 2') || !drawio.result.includes('scale-node-1') || pptx.result.byteLength < 20_000) throw new Error('scale export lost diagram content')
const timings = [normalized, svg, drawio, pptx].map(({ name, ms }) => ({ name, ms }))
const slowest = Math.max(...timings.map(item => item.ms))
if (slowest > 30_000) throw new Error(`scale benchmark exceeded 30s: ${JSON.stringify(timings)}`)
console.log(JSON.stringify({ elements: count, edges: count, svgBytes: Buffer.byteLength(svg.result), drawioBytes: Buffer.byteLength(drawio.result), pptxBytes: pptx.result.byteLength, timings }, null, 2))
