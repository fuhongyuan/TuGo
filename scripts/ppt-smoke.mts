import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildRegionPptx } from '../src/lib/exportDocument'
import type { BoardDocument, BoardElement } from '../src/types'

// A deliberately mixed-direction drawing used to visually verify the
// editable PowerPoint connector translation. Keep this script as a manual
// regression check alongside the XML-level unit tests.
const node = (id: string, x: number, y: number, text: string): BoardElement => ({
  id, kind: 'rounded_rectangle', x, y, width: 150, height: 70, text,
  fill: '#ffffff', stroke: '#334155', strokeWidth: 2, fontSize: 16,
})

const document: BoardDocument = {
  version: 3,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [
    node('web', 120, 20, 'Web'),
    node('mobile', 420, 20, 'Mobile'),
    node('gateway', 270, 220, 'Gateway'),
    node('service', 270, 450, 'Service'),
    node('left', 20, 340, 'Left'),
    node('right', 570, 340, 'Right'),
  ],
  edges: [
    { id: 'forward-down', from: 'web', to: 'gateway', label: 'forward', stroke: '#2563eb', strokeWidth: 2, endArrow: 'triangle' },
    { id: 'backward-up', from: 'mobile', to: 'web', label: 'back', stroke: '#7c3aed', strokeWidth: 2, routing: 'curve', controlPoints: [{ x: 350, y: -110 }], endArrow: 'triangle' },
    { id: 'elbow', from: 'gateway', to: 'service', label: 'route', stroke: '#16a34a', strokeWidth: 2, routing: 'elbow', controlPoints: [{ x: 510, y: 255 }, { x: 510, y: 485 }], endArrow: 'diamond' },
    { id: 'horizontal-left', from: 'right', to: 'left', label: 'left', stroke: '#ea580c', strokeWidth: 2, endArrow: 'arrow' },
    { id: 'vertical-up', from: 'service', to: 'gateway', label: 'up', stroke: '#dc2626', strokeWidth: 2, startArrow: 'circle', endArrow: 'triangle' },
  ],
}

const outputPath = resolve(process.env.TUGO_PPT_SMOKE_OUTPUT || '/private/tmp/tugo-ppt-smoke.pptx')
const pptx = buildRegionPptx(document, { x: 0, y: -140, width: 760, height: 700 }, 'PPT connector smoke')
const output = await pptx.write({ outputType: 'uint8array', compression: true })
await writeFile(outputPath, output instanceof Uint8Array ? output : new Uint8Array(output as ArrayBuffer))
console.log(outputPath)
