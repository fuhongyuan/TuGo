import {it,expect} from 'vitest'
import {runCooperatively} from './cooperativeTask'
import {documentEdgeRoutes,documentEdgeRoutesAsync} from './edgeRoute'
import {reflectDiagram,reflectDiagramAsync} from './diagramQuality'
import fixture from '../../artifacts/seam-regression/fixture.json'
import type {BoardDocument} from '../types'
it('keeps representative route and audit results identical in deterministic execution order',async()=>{
 const full=fixture as BoardDocument
 const edges=full.edges.slice(0,6),ids=new Set(edges.flatMap(e=>[e.from,e.to]))
 const doc={...full,elements:full.elements.filter(e=>ids.has(e.id)),edges}
 expect([...await documentEdgeRoutesAsync(doc.elements,doc.edges)]).toEqual([...documentEdgeRoutes(doc.elements,doc.edges)])
 expect(await reflectDiagramAsync(doc,{inspectUnconnected:true})).toEqual(reflectDiagram(doc,{inspectUnconnected:true}))
},20000)
it('yields to timers and stops subsequent pure work on cancellation',async()=>{
 let executed=0;const controller=new AbortController()
 function* steps(){for(let i=0;i<100;i++){const start=performance.now();while(performance.now()-start<2){}executed++;yield}return executed}
 const timer=setTimeout(()=>controller.abort(),20)
 await expect(runCooperatively(steps(),controller.signal)).rejects.toThrow('Cancelled');clearTimeout(timer)
 expect(executed).toBeLessThan(100)
})
it('rejects pre-aborted work before starting the generator',async()=>{
 const controller=new AbortController();controller.abort();let touched=false
 function* steps(){touched=true;yield;return 1}
 await expect(runCooperatively(steps(),controller.signal)).rejects.toThrow('Cancelled');expect(touched).toBe(false)
})

it('closes cancelled generators so their captured state can be released',async()=>{
 const controller=new AbortController();let closed=false
 function* steps(){try{while(true){const start=performance.now();while(performance.now()-start<2){}yield}}finally{closed=true}}
 const timer=setTimeout(()=>controller.abort(),15)
 await expect(runCooperatively(steps(),controller.signal)).rejects.toThrow('Cancelled');clearTimeout(timer);expect(closed).toBe(true)
})
