import {describe,it,expect} from 'vitest'
import {readEvidenceView} from '../src/evidenceProjection.js'
import type {EvidencePort,EvidenceEntry} from '../src/evidencePort.js'
const entry:EvidenceEntry={record:{schemaVersion:1,id:'o',scope:{applicationId:'a',workspaceId:'w',runId:'r'},source:{component:'q',layer:'domain'},target:{id:'table',revision:'1',sessionId:'s'},createdAt:'2026-10-30T00:00:00Z',execution:{state:'succeeded',callId:'c'},validity:'unknown',range:{kind:'partial',returned:1000},checks:[{name:'query',status:'unknown',coverage:'partial'}],findings:Array.from({length:24},(_,i)=>({id:'f'+i,code:'issue',severity:i<20?'blocking':'warning',message:'issue'+i,refs:['row'],owner:'domain'})),treatments:[],references:[]},payload:{rows:Array.from({length:1000},(_,i)=>({id:i,text:'数据'+i}))},expiresAt:'2099-01-01T00:00:00Z'}
const port:EvidencePort={get:async()=>structuredClone(entry),put:async()=>{throw new Error('read must not write')},cleanup:async()=>{throw new Error('read must not clean')}}
describe('reversible evidence views',()=>{
 it('restores useful Unicode text pages while keeping collection pages bounded',async()=>{
  const payload='中文🙂'.repeat(5000),textPort={...port,get:async()=>structuredClone({...entry,payload})}
  const page=await readEvidenceView(textPort,'ref',entry.record.scope,{limit:12000})
  expect(page.page.items.join('')).toBe(Array.from(payload).slice(0,12000).join(''))
  expect(page.page.nextOffset).toBe(12000)
  await expect(readEvidenceView(port,'ref',entry.record.scope,{path:['rows'],limit:12000})).rejects.toMatchObject({code:'invalid'})
 })
 it('restores all stored rows without claiming the source query was complete',async()=>{
  const all:unknown[]=[];let offset=0
  do{const v=await readEvidenceView(port,'ref',entry.record.scope,{path:['rows'],offset,limit:100});all.push(...v.page.items);expect(v.sourceRange.kind).toBe('partial');if(v.page.nextOffset===null)break;offset=v.page.nextOffset}while(true)
  expect(all).toEqual((entry.payload as {rows:unknown[]}).rows)
 })
 it('keeps full blocker counts and identity in a compact view',async()=>{
  const v=await readEvidenceView(port,'ref',entry.record.scope,{path:['rows'],limit:1,findingLimit:3})
  expect(v.evidenceRef).toBe('ref');expect(v.observationId).toBe('o');expect(v.findings).toMatchObject({total:24,blocking:20,warning:4,nextOffset:3});expect(v.findings.items).toHaveLength(3);expect(v.verdict).toBe('needs_action')
  expect(entry.record.findings).toHaveLength(24)
 })
 it('pages findings separately from payload data',async()=>{
  const v=await readEvidenceView(port,'ref',entry.record.scope,{path:['rows'],findingOffset:20,findingLimit:4})
  expect(v.findings.items.map(f=>f.id)).toEqual(['f20','f21','f22','f23']);expect(v.findings.blocking).toBe(20);expect(v.findings.nextOffset).toBe(null)
 })
 it('rejects invalid selectors and page ranges',async()=>{
  for(const request of [{path:['__proto__']},{path:['missing']},{offset:-1},{limit:0},{limit:101},{findingLimit:51},{offset:NaN}])await expect(readEvidenceView(port,'ref',entry.record.scope,request)).rejects.toMatchObject({code:'invalid'})
 })
 it('preserves Unicode and exposes object keys without silently summarizing',async()=>{
  const text={...entry,payload:'中文🙂测试'}
  const p={...port,get:async()=>text}
  const v=await readEvidenceView(p,'ref',entry.record.scope,{limit:3})
  expect(v.page.items).toEqual(['中','文','🙂']);expect(v.page.storedTotal).toBe(5)
  const o=await readEvidenceView(port,'ref',entry.record.scope,{limit:1});expect(o.page.kind).toBe('object');expect(o.page.items[0]).toEqual(['rows',(entry.payload as {rows:unknown[]}).rows])
 })
 it('preserves declared totals when legacy evidence contains only an excerpt',async()=>{
  const excerpt=structuredClone(entry);excerpt.record.findings=excerpt.record.findings.slice(0,2);excerpt.record.findingTotals={blocking:20,warning:4,total:24}
  const v=await readEvidenceView({...port,get:async()=>excerpt},'ref',entry.record.scope,{path:['rows'],limit:1})
  expect(v.findings).toMatchObject({blocking:20,total:24,storedTotal:2});expect(v.verdict).toBe('needs_action')
 })
 it('does not swallow access or expiration failures',async()=>{
  const p={...port,get:async()=>{throw Object.assign(new Error('expired'),{code:'expired'})}}
  await expect(readEvidenceView(p,'ref',entry.record.scope)).rejects.toMatchObject({code:'expired'})
 })
})
