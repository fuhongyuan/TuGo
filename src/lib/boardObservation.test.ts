import {describe,it,expect} from 'vitest'
import type {BoardDocument,BoardElement} from '../types'
import {observeBoard,getObservation,trackBoardVersion,repairNewNodes,observationSummary,observationPage,registerRenderProbe} from './boardObservation'
const node=(id:string,x=0,y=0):BoardElement=>({id,kind:'rectangle',x,y,width:120,height:60,text:id,fill:'#fff',stroke:'#000',strokeWidth:2,fontSize:16})
const doc=(elements:BoardElement[]=[node('a')]):BoardDocument=>({version:3,viewport:{x:0,y:0,zoom:1},elements,edges:[]})
describe('trusted board observations',()=>{
 it('separates committed geometry from actual render and keeps snapshots immutable',async()=>{
  const d=doc(),o=await observeBoard({projectId:'one',document:d,before:doc([]),directIds:['a'],render:false})
  expect(o).toMatchObject({execution:'committed',checks:{render:'not_checked',reference_semantics:'not_checked',pptx_render:'not_checked'},verdict:'partially_verified'})
  o.verdict='verified'
  expect(getObservation(o.observation_id,'one',d).verdict).toBe('partially_verified')
  expect(()=>getObservation(o.observation_id,'other',d)).toThrow()
 })
 it('does not mistake an export or inactive canvas for actual render',async()=>{
  const o=await observeBoard({projectId:'inactive',document:doc()})
  expect(o.checks.render).toBe('unknown');expect(o.verdict).not.toBe('verified')
 })
 it('rejects stale observations including undo/ABA and edits during observation',async()=>{
  const a=doc(),b=doc([node('b')])
  const o=await observeBoard({projectId:'aba',document:a,render:false})
  trackBoardVersion('aba',b);trackBoardVersion('aba',a)
  expect(getObservation(o.observation_id,'aba',a).verdict).toBe('stale')
  expect((await observeBoard({projectId:'race',document:a,current:()=>b,render:false})).verdict).toBe('stale')
 })
 it('preserves full blocking counts rather than hiding issues beyond a summary',async()=>{
  const elements=Array.from({length:24},(_,i)=>node('n'+i,i*300,0))
  const d=doc(elements)
  d.edges=elements.map((n,i)=>({id:'e'+i,from:n.id,to:'missing-'+i,stroke:'#000',strokeWidth:2}))
  const o=await observeBoard({projectId:'many',document:d,render:false}),summary=observationSummary(o)
  expect(o.findings.length).toBeGreaterThan(16)
  expect(summary.findings.length).toBeLessThanOrEqual(5)
  expect(summary.blocking_count).toBe(o.blocking_count)
  expect(o.blocking_count).toBeGreaterThan(16)
 })
 it('reports rerouted edges as indirect effects of a node edit',async()=>{
  const before=doc([node('a'),node('b',300,0)])
  before.edges=[{id:'edge',from:'a',to:'b',routing:'elbow',stroke:'#000',strokeWidth:2}]
  const after={...before,elements:[before.elements[0],{...before.elements[1],y:180}]}
  const o=await observeBoard({projectId:'effects',document:after,before,directIds:['b'],render:false})
  expect(o.changes.indirect_ids).toContain('edge')
  expect(o.side_effects.some(e=>e.type==='route_changed'&&e.refs.includes('edge'))).toBe(true)
 })
 it('returns unknown while playback has not settled',async()=>{
  const d=doc(),root=document.createElement('div');document.body.append(root)
  root.getBoundingClientRect=()=>({width:100,height:100} as DOMRect)
  const cleanup=registerRenderProbe('busy',()=>({document:d,root,pending:true,epoch:1}))
  try {expect((await observeBoard({projectId:'busy',document:d,waitMs:0})).checks.render).toBe('unknown')}
  finally{cleanup();root.remove()}
 })
 it('repairs only new, unlocked nodes within bounded free space',()=>{
  const n={...node('small'),height:20,text:'第一行\n第二行',fontSize:16},d=doc([n])
  const result=repairNewNodes(d,[{op:'add_element',element:n}])
  expect(result.patches.length).toBe(1)
  expect(result.document.elements[0].height).toBeLessThanOrEqual(44)
  expect(result.document.elements[0].text).toBe(n.text)
  expect(repairNewNodes(d,[]).patches).toEqual([])
  expect(repairNewNodes(doc([{...n,locked:true}]),[{op:'add_element',element:n}]).patches).toEqual([])
  expect(repairNewNodes(doc([n,node('block',0,22)]),[{op:'add_element',element:n}]).patches).toEqual([])
  const fixed=result.document.elements[0]
  expect(repairNewNodes(result.document,[{op:'add_element',element:fixed}]).patches).toEqual([])
 })
 it('invalidates formerly passed evidence during a new render projection',async()=>{
  const d=doc([]),root=document.createElement('div');document.body.append(root)
  root.getBoundingClientRect=()=>({width:100,height:100} as DOMRect)
  let pending=false
  const cleanup=registerRenderProbe('projection',()=>({document:d,root,pending,epoch:1}))
  try {
   const o=await observeBoard({projectId:'projection',document:d,waitMs:100})
   expect(o.checks.render).toBe('passed')
   pending=true
   expect(getObservation(o.observation_id,'projection',d).checks.render).toBe('stale')
  }finally{cleanup();root.remove()}
 })
 it('checks unreadable isolated nodes rather than skipping all unconnected geometry',async()=>{
  const o=await observeBoard({projectId:'tiny',document:doc([{...node('tiny'),height:1,text:'文字完全放不下'}]),render:false})
  expect(o.checks.geometry).toBe('failed')
  const page=observationPage(o,0,1)
  expect(page.findings).toHaveLength(1);expect(page.blocking_count).toBe(o.blocking_count)
 })
 it('does not count rejected repairs as applied changes',async()=>{
  const o=await observeBoard({projectId:'rejected',document:doc(),render:false,fixes:[{type:'repair_rejected',persisted:false,refs:['a'],message:'not applied'}]})
  expect(o.summary).toContain('0 项有界修复')
 })
})
