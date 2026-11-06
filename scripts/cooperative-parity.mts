import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {documentEdgeRoutes,documentEdgeRoutesAsync} from '../src/lib/edgeRoute'
import {reflectDiagram,reflectDiagramAsync} from '../src/lib/diagramQuality'
import type {BoardDocument} from '../src/types'
const document=JSON.parse(await readFile('artifacts/seam-regression/fixture.json','utf8')) as BoardDocument
const start=performance.now()
assert.deepEqual([...await documentEdgeRoutesAsync(document.elements,document.edges)],[...documentEdgeRoutes(document.elements,document.edges)])
assert.deepEqual(await reflectDiagramAsync(document,{inspectUnconnected:true}),reflectDiagram(document,{inspectUnconnected:true}))
assert.ok(performance.now()-start<20000,'Four complete parity calculations exceeded 20s')
console.log(JSON.stringify({scenario:'full-46-node-cooperative-parity',elements:document.elements.length,edges:document.edges.length,elapsed_ms:performance.now()-start,passed:true}))
