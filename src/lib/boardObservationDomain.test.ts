// @vitest-environment node
import {describe,it,expect} from 'vitest'
import {readFile} from 'node:fs/promises'
import type {BoardDocument} from '../types'
import {createBoardObserver} from './boardObservationDomain'
import {documentSignature,type BoardRenderPort} from './boardObservationProtocol'
const documentFixture=():BoardDocument=>({version:3,viewport:{x:0,y:0,zoom:1},elements:[{id:'a',kind:'rectangle',x:0,y:0,width:120,height:60,text:'A',fill:'#fff',stroke:'#000',strokeWidth:2,fontSize:16}],edges:[]})
describe('headless domain observation boundary',()=>{
 it('runs without a browser and rejects live DOM capability rather than exporting a substitute',async()=>{
  expect(typeof document).toBe('undefined')
  const observer=createBoardObserver(),doc=documentFixture(),before=JSON.stringify(doc)
  const result=await observer.observeBoard({projectId:'p',document:doc})
  expect(result.render).toMatchObject({status:'unknown',availability:'unsupported',coverage:'none',pixel_verification:'not_checked'})
  expect(result.render.reason).toContain('拒绝执行DOM检查');expect(result.verdict).not.toBe('verified');expect(result.checks.pptx_render).toBe('not_checked');expect(JSON.stringify(doc)).toBe(before)
 })
 it('allows explicitly requested geometry-only work without claiming a render check',async()=>{
  const result=await createBoardObserver().observeBoard({projectId:'p',document:documentFixture(),render:false})
  expect(result.checks.geometry).toBe('passed');expect(result.checks.render).toBe('not_checked');expect(result.verification_level).toBe('geometry_only')
 })
 it('isolates evidence and ABA revisions between service instances',async()=>{
  const a=createBoardObserver(),b=createBoardObserver(),doc=documentFixture()
  const result=await a.observeBoard({projectId:'p',document:doc,render:false})
  expect(()=>b.getObservation(result.observation_id,'p',doc)).toThrow('观察不存在')
  a.trackBoardVersion('p',{...doc,elements:[]});a.trackBoardVersion('p',doc)
  expect(a.getObservation(result.observation_id,'p',doc).verdict).toBe('stale')
  expect(b.trackBoardVersion('p',doc).seq).toBe(1)
 })
 it('consumes only serialized host stamps and invalidates passed render evidence when hidden or changed',async()=>{
  const doc=documentFixture();let epoch=1,visible=true
  const port:BoardRenderPort={fingerprint:'fake-host-test',measure:async()=>({status:'passed',target:'canvas_scene',coverage:'fake-test-not-production',findings:[],measured_elements:1,measured_edges:0,render_epoch:epoch,pixel_verification:'not_checked'}),current:()=>({signature:documentSignature(doc),epoch,pending:false,connected:true,visible})}
  const observer=createBoardObserver(port),result=await observer.observeBoard({projectId:'p',document:doc})
  expect(result.verdict).toBe('verified');expect(observer.getObservation(result.observation_id,'p',doc).verdict).toBe('verified')
  visible=false;expect(observer.getObservation(result.observation_id,'p',doc).checks.render).toBe('stale')
  visible=true;epoch++;expect(observer.getObservation(result.observation_id,'p',doc).verdict).toBe('stale')
 })
 it('honors cancellation even with a no-UI or geometry-only request',async()=>{
  const controller=new AbortController();controller.abort()
  for(const render of [true,false])await expect(createBoardObserver().observeBoard({projectId:'p',document:documentFixture(),render,signal:controller.signal})).rejects.toThrow('Cancelled')
 })
 it('observes frozen business state without planning or applying repairs',async()=>{
  const doc=documentFixture();doc.elements[0]={...doc.elements[0],height:1,text:'文字超出框'}
  const freeze=(v:unknown)=>{if(v&&typeof v==='object'){Object.freeze(v);for(const child of Object.values(v))freeze(child)}};freeze(doc)
  const before=JSON.stringify(doc),o=await createBoardObserver().observeBoard({projectId:'readonly',document:doc,render:false})
  expect(JSON.stringify(doc)).toBe(before);expect(o.automatic_fixes).toEqual([]);expect(o.checks.geometry).toBe('failed')
  const source=await readFile(new URL('boardObservationDomain.ts',import.meta.url),'utf8');expect(source).not.toMatch(/boardRepair|applyBoardOperations|\bcommit\(/)
 })
 it('does not import a renderer host or native element handles into the domain boundary',async()=>{
  for(const name of ['boardObservationDomain.ts','boardObservationProtocol.ts']){
   const source=await readFile(new URL(name,import.meta.url),'utf8')
   expect(source).not.toMatch(/from ['"].*(?:boardRenderProbe|electron)['"]|HTMLElement|SVGGeometryElement|DOMRect|getComputedStyle|querySelector/)
  }
 })
})

describe('render evidence publication races',()=>{
 for(const invalid of ['pending','fonts','scene','epoch','missing','stale'] as const)it(`rejects ${invalid} at publication, not only later retrieval`,async()=>{
  const doc=documentFixture();let sampled=false
  const port:BoardRenderPort={fingerprint:'race',measure:async()=>{sampled=true;return {status:invalid==='stale'?'stale':'passed',target:'canvas_scene',coverage:'test',findings:[],measured_elements:1,measured_edges:0,render_epoch:1,scene_token:'original',pixel_verification:'not_checked'}},current:()=>!sampled?({signature:documentSignature(doc),epoch:1,pending:false,connected:true,visible:true,ready:true,scene_token:'original'}):invalid==='missing'?undefined:({signature:documentSignature(doc),epoch:invalid==='epoch'?2:1,pending:invalid==='pending',connected:true,visible:true,ready:invalid!=='fonts',scene_token:invalid==='scene'?'new':'original'})}
  const result=await createBoardObserver(port).observeBoard({projectId:'p',document:doc})
  expect(result.verdict).toBe('stale');expect(result.checks.render).toBe('stale')
 })
 it('freezes the sampled input while host work is pending',async()=>{
  const doc=documentFixture(),before=structuredClone(doc)
  const port:BoardRenderPort={fingerprint:'race',measure:async()=>{doc.elements[0].text='changed';return {status:'unknown',target:'canvas_scene',coverage:'none',findings:[],measured_elements:0,measured_edges:0,render_epoch:0,pixel_verification:'not_checked'}},current:()=>undefined}
  const result=await createBoardObserver(port).observeBoard({projectId:'p',document:doc})
  const {boardContentHash}=await import('./boardObservationProtocol')
  expect(result.content_hash).toBe(await boardContentHash(before));expect(result.verdict).toBe('stale')
 })
})

describe('actual board domain scheduling entry',()=>{
 it('coalesces auto/model equivalent reads at the same trusted version',async()=>{
  let calls=0,release!:()=>void;const doc=documentFixture()
  const port:BoardRenderPort={fingerprint:'host',measure:async()=>{calls++;await new Promise<void>(r=>release=r);return {status:'unknown',target:'canvas_scene',coverage:'none',findings:[],measured_elements:0,measured_edges:0,render_epoch:0,pixel_verification:'not_checked'}},current:()=>undefined}
  const observer=createBoardObserver(port),a=observer.observeBoard({projectId:'p',document:doc}),b=observer.observeBoard({projectId:'p',document:structuredClone(doc)})
  await new Promise(r=>setTimeout(r,0));expect(calls).toBe(1);release();const [x,y]=await Promise.all([a,b]);expect(x.observation_id).toBe(y.observation_id);expect(x).not.toBe(y)
 })
 it('keeps scope, revision, and write-specific facts separate',async()=>{
  let calls=0;const doc=documentFixture()
  const port:BoardRenderPort={fingerprint:'host',measure:async()=>{calls++;return {status:'unknown',target:'canvas_scene',coverage:'none',findings:[],measured_elements:0,measured_edges:0,render_epoch:0,pixel_verification:'not_checked'}},current:()=>undefined}
  const observer=createBoardObserver(port)
  const results=await Promise.all([observer.observeBoard({projectId:'p',document:doc}),observer.observeBoard({projectId:'p',document:doc,render:false}),observer.observeBoard({projectId:'p',document:{...doc,elements:[]}}),observer.observeBoard({projectId:'p',document:doc,causeId:'write'})])
  expect(calls).toBe(3);expect(new Set(results.map(r=>r.observation_id)).size).toBe(4);expect(results[3].cause_id).toBe('write')
 })
})

it('defers geometry while the host is pending and never promotes a newly stable render alone',async()=>{
 const doc=documentFixture();doc.elements[0].height=1
 const port:BoardRenderPort={fingerprint:'host',current:()=>({signature:documentSignature(doc),epoch:1,pending:true,connected:true,visible:true}),measure:async()=>({status:'passed',target:'canvas_scene',coverage:'test',findings:[],measured_elements:1,measured_edges:0,render_epoch:1,pixel_verification:'not_checked'})}
 const result=await createBoardObserver(port).observeBoard({projectId:'p',document:doc})
 expect(result.checks.geometry).toBe('not_checked');expect(result.checks.render).toBe('unknown');expect(result.verification_level).toBe('unverified');expect(result.verdict).not.toBe('verified')
})

it('invalidates geometry sampled before a font/scene revision even if the final DOM is stable',async()=>{
 const doc=documentFixture();let sampled=false
 const port:BoardRenderPort={fingerprint:'host',current:()=>({signature:documentSignature(doc),epoch:1,pending:false,connected:true,visible:true,scene_token:sampled?'new':'old'}),measure:async()=>{sampled=true;return {status:'passed',target:'canvas_scene',coverage:'test',findings:[],measured_elements:1,measured_edges:0,render_epoch:1,scene_token:'new',pixel_verification:'not_checked'}}}
 const result=await createBoardObserver(port).observeBoard({projectId:'p',document:doc})
 expect(result.verdict).toBe('stale');expect(result.checks.geometry).toBe('stale')
})
