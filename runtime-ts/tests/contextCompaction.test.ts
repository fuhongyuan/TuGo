import {describe,it,expect} from 'vitest'
import {compactConversation,compactedConversation,validCompaction,projectedAttachments} from '../src/contextCompaction.js'
import type {RuntimeMessage,JsonObject} from '../src/contracts.js'
import {assertToolPairs} from '../src/resultProjection.js'
const estimate=(m:RuntimeMessage[])=>JSON.stringify(m).length
const transcript=():RuntimeMessage[]=>[{role:'user',content:'必须保留约束：不要删节点。'},...Array.from({length:4},(_,i):RuntimeMessage[]=>[{role:'assistant',content:'',reasoning:'思考'.repeat(4000),providerMetadata:{signed:'signature-'+i},toolCalls:[{id:'c'+i,name:'query',arguments:{i}}]},{role:'tool',name:'query',toolCallId:'c'+i,content:JSON.stringify({details:'数据'.repeat(1000),observation:{observation_id:'o'+i,project_id:'p'+i%2,blocking_count:i+1,checks:{render:'unknown'},findings:[]}})}]).flat()]
function harness(messages=transcript()) {
 const saved:JsonObject[]=[],signal=new AbortController().signal
 const input={messages,signal,keepRecent:1,target:2000,estimate,persist:async(payload:JsonObject)=>{saved.push(payload);return 'ref-'+saved.length},receipt:()=> 'succeeded'}
 return {input,saved}
}
describe('reversible context lifecycle',()=>{
 it('retains canonical non-drawing domain blocker totals rather than only TuGo envelope fields',async()=>{
  const {input}=harness()
  input.messages[2].content=JSON.stringify({data:{value:'large'.repeat(5000)},record:{schemaVersion:1,id:'query-report',target:{id:'query-target'},validity:'unknown',checks:[{name:'query',status:'unknown'}],findingTotals:{blocking:120,warning:7,total:127},findings:[{severity:'blocking',code:'partial',refs:['row-1'],message:'分页未交付'}]}})
  const result=await compactConversation({...input,force:true})
  const report=Object.values(result!.state.observations).find(o=>o.observation_id==='query-report')!
  expect(report).toMatchObject({blocking_count:120,warning_count:7,verdict:'unknown',findings_visible:1})
  expect(JSON.stringify(report.findings_preview)).toContain('row-1')
 })
 it('distinguishes immutable system policy from runtime evidence and retains unresolved blocker counts',async()=>{
  const {input}=harness()
  input.messages.unshift({role:'system',content:'永久约束：禁止改权限'})
  input.messages.splice(2,0,{role:'system',providerMetadata:{runtimeEvidenceMessage:true},content:'运行时证据\n'+JSON.stringify({observation:{observation_id:'blocked',project_id:'separate',blocking_count:99,checks:{render:'unknown'},findings:[{type:'occluded',refs:['edge-1'],message:'线被挡住'}]}})})
  const result=await compactConversation({...input,force:true})
  const view=compactedConversation(input.messages,result!.state)
  expect(view[0]).toEqual(input.messages[0])
  expect(view.some(m=>m.providerMetadata?.runtimeEvidenceMessage)).toBe(false)
  expect(JSON.stringify(result!.state.observations)).toContain('99');expect(JSON.stringify(result!.state.observations)).toContain('edge-1')
 })
 it('archives closed signed/thinking batches atomically, pins user constraints and plan, retains recent complete pairs',async()=>{
  const {input,saved}=harness(),raw=JSON.stringify(input.messages),plan={steps:[{status:'blocked',description:'检查剩余遮挡'}]}
  const result=await compactConversation({...input,plan})
  expect(result).toBeDefined();const view=compactedConversation(input.messages,result!.state,[],plan)
  expect(()=>assertToolPairs(view)).not.toThrow();expect(view[0]).toEqual(input.messages[0])
  expect(view.at(-2)).toEqual(input.messages.at(-2));expect(view.at(-1)).toEqual(input.messages.at(-1))
  expect(JSON.stringify(saved)).toContain('signature-0');expect(JSON.stringify(saved)).toContain('思考')
  expect(JSON.stringify(view)).toContain('检查剩余遮挡');expect(JSON.stringify(view)).toContain('blocking_count')
  expect(result!.after).toBeLessThan(result!.before);expect(JSON.stringify(input.messages)).toBe(raw)
 })
 it('chains deltas and rebuilds after serialization; edits and expiration invalidate old projections',async()=>{
  const {input,saved}=harness(),first=await compactConversation(input)
  const appended=[...input.messages,{role:'user' as const,content:'继续，仍不要删节点'},{role:'assistant' as const,content:'结果'.repeat(10000)}]
  const next=await compactConversation({...input,messages:appended,state:JSON.parse(JSON.stringify(first!.state)),force:true})
  expect(saved[1].previous_ref).toBe(first!.state.ref)
  expect([...(saved[0].messages as RuntimeMessage[]),...(saved[1].messages as RuntimeMessage[])]).toEqual(appended.slice(0,next!.state.through))
  expect(validCompaction(appended,{...next!.state,validUntil:'2000-01-01T00:00:00Z'})).toBeUndefined()
  const changed=structuredClone(appended);changed[0].content='new constraint'
  expect(compactedConversation(changed,next!.state)).toEqual(changed)
 })
 it('refuses incomplete protocol, ineffective compaction and persistence failure without changing source',async()=>{
  const {input}=harness(),before=JSON.stringify(input.messages)
  await expect(compactConversation({...input,messages:input.messages.slice(0,-1)})).rejects.toThrow('工具协议')
  await expect(compactConversation({...input,persist:async()=>{throw Error('disk full')}})).rejects.toThrow('disk full')
  expect(JSON.stringify(input.messages)).toBe(before)
  let writes=0
  expect(await compactConversation({...input,messages:[{role:'user',content:'goal'},{role:'assistant',content:'ok'}],force:true,persist:async()=>{writes++;return 'ref'}})).toBeUndefined()
  expect(writes).toBe(0)
 })
 it('never removes loaded Skill batches; cancellation cannot commit a projection',async()=>{
  const {input,saved}=harness();input.messages[1].toolCalls![0].name='load_skill'
  const result=await compactConversation({...input,protectedTools:['load_skill']})
  const view=compactedConversation(input.messages,result!.state,['load_skill'])
  expect(view).toContain(input.messages[1]);expect(view).toContain(input.messages[2])
  const controller=new AbortController();controller.abort()
  await expect(compactConversation({...input,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'})
  const count=saved.length
  await expect(compactConversation({...input,signal:new AbortController().signal,persist:async()=>{throw Error('quota')}})).rejects.toThrow('quota')
  expect(saved).toHaveLength(count)
 })
 it('archives old media references without resending hidden images via legacy fallback, keeps current images and original text',async()=>{
  const {input}=harness();input.messages[0].attachmentIds=['old']
  input.messages.push({role:'user',content:'看当前图',attachmentIds:['current']},{role:'assistant',content:'答复'.repeat(10000)})
  const result=await compactConversation({...input,force:true,activeAttachmentIds:['current']})
  const view=compactedConversation(input.messages,result!.state,[],undefined,['current'])
  expect(view.find(m=>m.content==='看当前图')?.attachmentIds).toEqual(['current'])
  expect(view[0].content).toBe(input.messages[0].content);expect(view[0].attachmentIds).toEqual([])
  const attachments=['old','current'].map(attachmentId=>({attachmentId,name:'image',mimeType:'image/png',dataBase64:'AA=='}))
  expect(projectedAttachments(view,attachments).map(a=>a.attachmentId)).toEqual(['current'])
  expect(input.messages[0].attachmentIds).toEqual(['old'])
 })
})
