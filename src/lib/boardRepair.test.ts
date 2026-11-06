// @vitest-environment node
import {describe,it,expect} from 'vitest'
import {repairNewNodes,confirmRepair} from './boardRepair'
import {createBoardObserver} from './boardObservationDomain'
import {commit,undo,redo,applyBoardOperations} from './boardState'
import type {BoardDocument,BoardElement,BoardOperation} from '../types'
const node=(id='small',x=0):BoardElement=>({id,kind:'rectangle',x,y:0,width:120,height:20,text:'第一行\n第二行',fill:'#fff',stroke:'#000',strokeWidth:2,fontSize:16})
const doc=(elements:BoardElement[]=[]):BoardDocument=>({version:3,viewport:{x:0,y:0,zoom:1},elements,edges:[]})
const add=(n:BoardElement):BoardOperation=>({op:'add_element',element:n})
describe('bounded repair proposals and confirmed receipts',()=>{
 it('plans changes without mutating input or claiming they have persisted',()=>{
  const d=doc([node()]),before=JSON.stringify(d),plan=repairNewNodes(d,[add(d.elements[0])],{causeId:'call'})
  expect(JSON.stringify(d)).toBe(before);expect(plan.patches).toHaveLength(1)
  expect(plan.fixes[0]).toMatchObject({state:'proposed',persisted:false,cause_id:'call',repair_id:expect.any(String)})
  expect(plan.document.elements[0]).toMatchObject({text:d.elements[0].text,x:0,y:0,width:120,fontSize:16})
  expect(plan.document.elements[0].height).toBeLessThanOrEqual(44)
 })
 it('respects explicit permission, target allowlist, current and ancestor locks and existing ids',()=>{
  const n=node(),parent={...node('parent'),kind:'frame' as const,width:500,height:500,locked:true}
  for(const [d,options] of [[doc([n]),{allowRepair:false}],[doc([n]),{allowedIds:['other']}],[doc([{...n,locked:true}]),{}],[doc([parent,{...n,groupId:'parent'}]),{}],[doc([{...parent,locked:false},{...n,groupId:'parent'}]),{before:doc([parent])}],[doc([n]),{before:doc([n])}]] as const){
   const p=repairNewNodes(d,[add(n)],options);expect(p.patches).toEqual([]);expect(p.fixes.every(f=>!f.persisted)).toBe(true)
  }
 })
 it('does not grow into blocked space or outside a parent',()=>{
  for(const d of [doc([node(),{...node('block'),y:22,height:80}]),doc([{...node('parent'),kind:'frame',width:300,height:25},{...node(),groupId:'parent'}])]){
   const p=repairNewNodes(d,[add(d.elements.at(-1)!.id==='small'?d.elements.at(-1)!:d.elements[0])]);expect(p.patches).toEqual([]);expect(p.fixes.some(f=>f.state==='rejected')).toBe(true)
  }
 })
 it('honors finite candidate and node budgets without marking skipped work applied',()=>{
  const d=doc(Array.from({length:12},(_,i)=>node('n'+i,i*300)))
  const p=repairNewNodes(d,d.elements.map(add),{maxCandidates:1,maxNodes:1})
  expect(p.budget.usedCandidates).toBeLessThanOrEqual(1);expect(p.patches.length).toBeLessThanOrEqual(1);expect(p.fixes.every(f=>!f.persisted)).toBe(true)
  const capped=repairNewNodes(d,d.elements.map(add),{maxCandidates:999,maxNodes:999,maxGrowth:999});expect(capped.budget.maxCandidates).toBe(48);expect(capped.budget.maxNodes).toBe(8);expect(capped.budget.maxGrowth).toBe(24)
 })
 it('declines oversized audit scope before layout work instead of running an unbounded repair search',async()=>{
  const large=doc(Array.from({length:257},(_,i)=>node('n'+i,i*300))),before=JSON.stringify(large)
  const p=repairNewNodes(large,[add(large.elements[0])]);expect(p.patches).toEqual([]);expect(p.budget.usedCandidates).toBe(0);expect(JSON.stringify(large)).toBe(before)
  expect(p.fixes[0]).toMatchObject({state:'skipped',persisted:false,type:'repair_budget_exhausted'})
  expect((await confirmRepair(p,large,{acknowledged:true}))[0].persisted).toBe(false)
  const text=doc([{...node(),text:'x'.repeat(64001)}]);expect(repairNewNodes(text,[add(text.elements[0])]).budget.usedCandidates).toBe(0)
 })
 it('rejects a candidate that introduces a severe route collision even when nodes have free space',async()=>{
  const d=doc([node()]);d.edges=[{id:'free',from:'',to:'',freeStart:{x:-50,y:32},freeEnd:{x:180,y:32},routing:'straight',stroke:'#000',strokeWidth:2}]
  const p=repairNewNodes(d,[add(d.elements[0])]);expect(p.patches).toEqual([]);expect(p.document).toEqual(d);expect(p.fixes.some(f=>f.type==='repair_rejected'&&f.state==='rejected'&&!f.persisted)).toBe(true);expect(p.fixes[0].refs).toContain('free');expect(p.fixes[0].proposal?.height).toBeGreaterThan(20)
  const receipts=await confirmRepair(p,d,{acknowledged:true});expect(receipts.every(f=>!f.persisted&&f.state==='rejected')).toBe(true)
  const o=await createBoardObserver().observeBoard({projectId:'rejected',document:d,fixes:receipts,render:false});expect(o.summary).toContain('0 项有界修复')
 })
 it('confirms only an acknowledged, matching candidate; missing acknowledgement is unknown, not safe to replay',async()=>{
  const d=doc([node()]),p=repairNewNodes(d,[add(d.elements[0])],{causeId:'call'})
  const unknown=await confirmRepair(p,p.document,{acknowledged:false});expect(unknown[0]).toMatchObject({state:'unknown',persisted:false});expect(unknown[0].message).toContain('不要重放')
  const mismatch=await confirmRepair(p,doc(),{acknowledged:true});expect(mismatch[0]).toMatchObject({state:'unknown',persisted:false})
  const applied=await confirmRepair(p,p.document,{acknowledged:true});expect(applied[0]).toMatchObject({state:'applied',persisted:true,cause_id:'call',before_revision:expect.any(String),after_revision:expect.any(String)})
  await expect(confirmRepair(structuredClone(p),p.document,{acknowledged:true})).rejects.toThrow('未注册')
 })
 it('keeps user operation and repair in one undo step and links verification to the new version',async()=>{
  const before=doc(),op=add(node()),added=applyBoardOperations(before,[op]),p=repairNewNodes(added,[op],{before,causeId:'call'})
  const h=commit({current:before,past:[],future:[]},[op,...p.patches]);expect(h.past).toHaveLength(1)
  const fixes=await confirmRepair(p,h.current,{acknowledged:true}),observer=createBoardObserver()
  const evidence=await observer.observeBoard({projectId:'p',document:h.current,before,causeId:'call',fixes,render:false})
  expect(evidence.automatic_fixes[0]).toMatchObject({persisted:true,state:'applied',verification_ref:evidence.observation_id,verification:{render:'not_checked'}})
  expect(evidence.automatic_fixes[0].after_revision).toBe(evidence.content_hash);expect(evidence.cause_id).toBe('call');expect(evidence.summary).toContain('1 项有界修复')
  const undone=undo(h);expect(undone.current.elements).toEqual([]);observer.trackBoardVersion('p',undone.current)
  const redone=redo(undone);expect(redone.current.elements).toEqual(h.current.elements);observer.trackBoardVersion('p',redone.current)
  expect(observer.getObservation(evidence.observation_id,'p',redone.current).verdict).toBe('stale')
 })
})
