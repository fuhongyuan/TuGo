import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { buildRegionPptx, renderRegionSvg } from '../src/lib/exportDocument.ts'
import type { BoardDocument, BoardElement } from '../src/types.ts'

const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
})
const node = (id: string, x: number, y: number, text: string, kind: BoardElement['kind'] = 'rounded_rectangle'): BoardElement => ({ id, kind, x, y, width: 180, height: 76, text, fill: '#ffffff', stroke: '#334155', strokeWidth: 2, fontSize: 16 })
const document: BoardDocument = {
  version: 3, viewport: { x: 0, y: 0, zoom: 1 },
  elements: [
    { ...node('title', 42, 12, 'TuGo 导出视觉黄金图', 'text'), width: 514, height: 38, fill: '#dbeafe', stroke: '#60a5fa', fontSize: 24, fontWeight: 'bold' },
    { ...node('frame', 20, 64, '服务编排', 'frame'), width: 560, height: 334, fill: '#f8fafc', fillOpacity: .75, stroke: '#cbd5e1', fontSize: 16 },
    { ...node('a', 48, 126, '入口'), fill: '#eff6ff', stroke: '#2563eb' },
    { ...node('b', 374, 126, '服务', 'hexagon'), fill: '#f0fdf4', stroke: '#16a34a' },
    { ...node('c', 211, 286, '数据层', 'database'), fill: '#fff7ed', stroke: '#ea580c' },
  ],
  edges: [
    { id: 'curve', from: 'a', to: 'b', label: '请求', stroke: '#2563eb', strokeWidth: 2, routing: 'curve', controlPoints: [{ x: 286, y: 70 }], endArrow: 'triangle' },
    { id: 'elbow', from: 'b', to: 'c', label: '写入', stroke: '#16a34a', strokeWidth: 2, routing: 'elbow', controlPoints: [{ x: 464, y: 240 }, { x: 300, y: 240 }], endArrow: 'diamond' },
    { id: 'free', from: '', to: '', label: '注释', freeStart: { x: 56, y: 372 }, freeEnd: { x: 180, y: 372 }, stroke: '#7c3aed', strokeWidth: 2, routing: 'straight', endArrow: 'arrow' },
  ],
}
const region = { x: 0, y: 0, width: 600, height: 420 }
const fixturePath = resolve('scripts/fixtures/export-visual-baseline.json')

const decodePng = (bytes: Uint8Array) => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (signature.some((value, index) => bytes[index] !== value)) throw new Error('Expected a PNG render')
  let offset = 8, width = 0, height = 0, channels = 0
  const idat: Uint8Array[] = []
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0); offset += 4
    const type = new TextDecoder().decode(bytes.subarray(offset, offset + 4)); offset += 4
    const chunk = bytes.subarray(offset, offset + length); offset += length + 4
    if (type === 'IHDR') { width = new DataView(chunk.buffer, chunk.byteOffset, 4).getUint32(0); height = new DataView(chunk.buffer, chunk.byteOffset + 4, 4).getUint32(0); if (chunk[8] !== 8 || ![2, 6].includes(chunk[9])) throw new Error('Unsupported PNG format'); channels = chunk[9] === 6 ? 4 : 3 }
    if (type === 'IDAT') idat.push(chunk)
  }
  const compressed = Buffer.concat(idat.map(value => Buffer.from(value)))
  const raw = inflateSync(compressed); const stride = width * channels; const pixels = new Uint8Array(width * height * channels); let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++]; const row = pixels.subarray(y * stride, (y + 1) * stride); const previous = y ? pixels.subarray((y - 1) * stride, y * stride) : undefined
    for (let x = 0; x < stride; x += 1) { const value = raw[source++]; const left = x >= channels ? row[x - channels] : 0; const up = previous?.[x] || 0; const upLeft = previous && x >= channels ? previous[x - channels] : 0; const pa = Math.abs(up - upLeft), pb = Math.abs(left - upLeft), pc = Math.abs(left + up - upLeft - upLeft); const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; row[x] = (value + predictor) & 255 }
  }
  return { width, height, channels, pixels }
}
const fingerprint = (bytes: Uint8Array) => {
  const image = decodePng(bytes); const side = 32; const values = new Uint8Array(side * side)
  for (let gy = 0; gy < side; gy += 1) for (let gx = 0; gx < side; gx += 1) {
    let total = 0, count = 0; const startX = Math.floor(gx * image.width / side), endX = Math.max(startX + 1, Math.floor((gx + 1) * image.width / side)), startY = Math.floor(gy * image.height / side), endY = Math.max(startY + 1, Math.floor((gy + 1) * image.height / side))
    for (let y = startY; y < endY; y += 1) for (let x = startX; x < endX; x += 1) { const p = (y * image.width + x) * image.channels; total += .2126 * image.pixels[p] + .7152 * image.pixels[p + 1] + .0722 * image.pixels[p + 2]; count += 1 }
    values[gy * side + gx] = Math.round(total / count)
  }
  return { width: image.width, height: image.height, grayscale: Buffer.from(values).toString('base64') }
}
const rms = (a: string, b: string) => { const left = Buffer.from(a, 'base64'), right = Buffer.from(b, 'base64'); if (left.length !== right.length) return Infinity; return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0) / left.length) }
const root = await mkdtemp(join(tmpdir(), 'tugo-visual-'))
try {
  const svg = renderRegionSvg(document, region)
  await writeFile(join(root, 'golden.svg'), svg)
  const pptx = buildRegionPptx(document, region, 'TuGo visual golden')
  const bytes = await pptx.write({ outputType: 'uint8array', compression: true })
  await writeFile(join(root, 'golden.pptx'), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer))
  // LibreOffice otherwise reuses a desktop profile/lock and may report a
  // successful launch while refusing to write the requested PDF. Every gate
  // run gets an isolated profile so it is deterministic beside an open app.
  const officeProfile = `file://${join(root, 'libreoffice-profile')}`
  await run(process.env.SOFFICE || 'soffice', [`-env:UserInstallation=${officeProfile}`, '--headless', '--convert-to', 'pdf', '--outdir', root, join(root, 'golden.pptx')])
  await run('pdftoppm', ['-png', '-singlefile', '-r', '144', join(root, 'golden.pdf'), join(root, 'pptx-render')])
  const png = await readFile(join(root, 'pptx-render.png'))
  if (png.length < 4_000) throw new Error('PPTX visual render is unexpectedly empty')
  const zip = await JSZip.loadAsync(bytes)
  const slide = await zip.file('ppt/slides/slide1.xml')?.async('string') || ''
  if ((slide.match(/<p:sp>/g) || []).length < document.elements.length || (slide.match(/<a:prstGeom prst="line(?:Inv)?"/g) || []).length < 3) throw new Error('PPTX lost editable shapes or connector geometry')
  const baseline = { version: 1, svg_sha256: createHash('sha256').update(svg).digest('hex'), pptx: fingerprint(png) }
  if (process.argv.includes('--update')) { await mkdir(resolve('scripts/fixtures'), { recursive: true }); await writeFile(fixturePath, `${JSON.stringify(baseline, null, 2)}\n`) }
  else {
    const expected = JSON.parse(await readFile(fixturePath, 'utf8')) as typeof baseline
    if (expected.version !== baseline.version || expected.svg_sha256 !== baseline.svg_sha256) throw new Error('SVG visual golden changed; inspect the export and run with --update only for an intentional baseline change')
    if (expected.pptx.width !== baseline.pptx.width || expected.pptx.height !== baseline.pptx.height) throw new Error('PPTX render size changed unexpectedly')
    const difference = rms(expected.pptx.grayscale, baseline.pptx.grayscale)
    if (difference > 7) throw new Error(`PPTX visual baseline drift is too large (RMS ${difference.toFixed(2)} > 7)`)
  }
  console.log(`visual export passed: ${png.length} bytes`)
} finally { await rm(root, { recursive: true, force: true }) }
