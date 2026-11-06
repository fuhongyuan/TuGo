import {describe,it,expect} from 'vitest'
import {projectToolResult,boundedEvidenceView} from '../src/resultProjection.js'
import {EvidenceError,type EvidenceEntry,type EvidencePort} from '../src/evidencePort.js'
const context={id:'obs',scope:{applicationId:'a',workspaceId:'w',runId:'r'},target:{id:'t',revision:'unknown',sessionId:'s'},createdAt:'2026-10-30T00:00:00Z',confirmedExecution:'succeeded' as const,callId:'call'}
function memory(){let entry:EvidenceEntry;const port:EvidencePort={put:async(record,payload)=>{entry=structuredClone({record,payload,expiresAt:'2099-01-01T00:00:00Z'});return 'ref'},get:async()=>structuredClone(entry),cleanup:async()=>0};return port}
describe('lossless referenced collections',()=>{
 it('keeps deterministic answers, constraints, unknown checks, range, counts and treatment history',async()=>{
  const value={saved:true,constraint:'不修改锁定对象',pending:['fix overlap'],observation:{blocking_count:30,warning_count:0,checks:{render:'unknown'},range:{kind:'partial'},automatic_fixes:[{applied:false}],findings:Array.from({length:30},(_,i)=>({id:'f'+i,type:'occluded',severity:'blocking',message:'line '+i,refs:['e'+i]}))},rows:Array.from({length:3000},(_,id)=>({id,text:'明细'+id}))}
  const port=memory(),v=await projectToolResult(port,value,context);const compact=JSON.parse(v.content)
  const answers=(x:typeof value)=>[x.saved,x.constraint,x.pending,x.observation.blocking_count,x.observation.checks,x.observation.range,x.observation.automatic_fixes]
  expect(answers(compact)).toEqual(answers(value));expect(compact.projection.record.execution.state).toBe('succeeded');expect(compact.projection.record.validity).toBe('unknown')
  expect(compact.projection.collections[0]).toMatchObject({path:['rows'],returned:0,storedTotal:3000})
  const restored:unknown[]=[];let offset=0
  for(;;){const view=await boundedEvidenceView(port,'ref',context.scope,{path:['rows'],offset,limit:100});restored.push(...view.page.items);if(view.page.nextOffset===null)break;offset=view.page.nextOffset}
  expect(restored).toEqual(value.rows)
  const findings=await boundedEvidenceView(port,'ref',context.scope,{path:['observation','findings'],offset:29,limit:1});expect(findings.page.items).toEqual([value.observation.findings[29]])
 })
 it('never compacts arbitrary instructions, unknown metadata or large constraints',async()=>{
  const port=memory(),text='禁止修改约束'.repeat(10000)
  expect((await projectToolResult(port,text,context)).content).toBe(text)
  expect(JSON.parse((await projectToolResult(port,[text],context)).content)).toEqual([text])
  const v={constraint:text,rows:[1,2]};expect(JSON.parse((await projectToolResult(port,v,context)).content).constraint).toBe(text)
 })
 it('preserves full data and execution facts on storage failure, never requests replay',async()=>{
  const port={...memory(),put:async()=>{throw new EvidenceError('quota')}}
  const value={rows:Array.from({length:1000},(_,i)=>i)}
  const v=JSON.parse((await projectToolResult(port,value,context,100)).content)
  expect(v.result).toEqual(value);expect(v.projection).toMatchObject({evidenceUnavailable:'quota',execution:{state:'succeeded'},replay:false})
 })
 it('does not echo credentials rejected by the evidence policy into a new model message',async()=>{
  const port={...memory(),put:async()=>{throw new EvidenceError('sensitive')}}
  const view=await projectToolResult(port,{secret:'private',rows:[1,2]},context,1)
  expect(view.content).not.toContain('private');expect(JSON.parse(view.content).projection).toMatchObject({evidenceUnavailable:'sensitive',execution:{state:'succeeded'},replay:false})
 })
 it('adapts large pages without truncating a value or changing stored totals',async()=>{
  const port=memory();await projectToolResult(port,{rows:Array.from({length:100},()=>({text:'x'.repeat(1000)}))},context)
  const view=await boundedEvidenceView(port,'ref',context.scope,{path:['rows'],limit:100},4000)
  expect(view.page.storedTotal).toBe(100);expect(view.page.items.length).toBeLessThan(100);expect(JSON.stringify(view).length).toBeLessThanOrEqual(4000)
 })
 it('rejects a single huge object rather than hiding nested values; a deeper text path works',async()=>{
  const port=memory();await projectToolResult(port,{rows:[{text:'x'.repeat(50000)}]},context)
  await expect(boundedEvidenceView(port,'ref',context.scope,{path:['rows'],limit:1})).rejects.toMatchObject({code:'quota'})
  const view=await boundedEvidenceView(port,'ref',context.scope,{path:['rows','0','text'],limit:100});expect(view.page.items.join('')).toBe('x'.repeat(100))
 })
})

describe('transcript and minimum context protection',()=>{
 it('preserves pairing across compaction and rejects incomplete/orphan/duplicate batches',async()=>{
  const {assertToolPairs}=await import('../src/resultProjection.js')
  const messages:import('../src/contracts.js').RuntimeMessage[]=[{role:'user',content:'目标与约束'},{role:'assistant',content:'',toolCalls:[{id:'a',name:'query',arguments:{}}]},{role:'tool',toolCallId:'a',content:'{}'}]
  expect(()=>assertToolPairs(messages)).not.toThrow()
  for(const bad of [messages.slice(0,-1),[messages[2]],[...messages,messages[2]],[messages[0],messages[1],messages[0],messages[2]]])expect(()=>assertToolPairs(bad)).toThrow('工具协议不配对')
 })
 it('compacts collections once and stops if protected metadata still exceeds the safe budget',async()=>{
  const {projectContext}=await import('../src/contextProjection.js')
  const port=memory(),value={constraint:'必须保留的约束'.repeat(2000),rows:Array.from({length:3000},(_,i)=>i)}
  const compact=await projectToolResult(port,value,context)
  expect(JSON.parse(compact.content).constraint).toBe(value.constraint)
  expect(()=>projectContext({messages:[{role:'tool',content:compact.content}],outputTokens:512},{contextWindow:8192})).toThrow('安全预算不足')
  const small=await projectToolResult(port,{...value,constraint:'不得改动目标'},context)
  expect(projectContext({messages:[{role:'tool',content:small.content}],outputTokens:512},{contextWindow:8192}).decision.admitted).toBe(true)
 })
 it('does not overwrite an unknown projection field or lose undeclared finding totals',async()=>{
  const port=memory(),value={projection:{constraint:'retain'},rows:Array.from({length:3000},(_,i)=>i)}
  expect(JSON.parse((await projectToolResult(port,value,context)).content)).toEqual(value)
  const observation={findings:Array.from({length:40},(_,i)=>({type:'blocked',severity:'blocking',message:'issue'+i}))}
  const view=JSON.parse((await projectToolResult(port,{observation},context,100)).content)
  expect(view.projection.record.findingTotals).toEqual({blocking:40,warning:0,total:40});expect(view.projection.storedFindings).toBe(40)
 })
})
