import {describe,it,expect} from 'vitest'
import {measuredOutputCredit,outputUsageCounts,recoverLegacyOutputCredit} from '../src/outputUsageBudget.js'
import {projectContext,ContextProjectionError} from '../src/contextProjection.js'
import type {ModelConfig,RuntimeMessage,RunCheckpoint,JsonObject} from '../src/contracts.js'
const model:ModelConfig={model_id:'fixture',provider_id:'openai',model:'gateway-glm',runtime_extra:{base_url:'https://fixture.invalid',context_window:128000}}
const response:RuntimeMessage={role:'assistant',content:'读取画板',reasoning:'长思考'.repeat(7311),toolCalls:[{id:'state',name:'board_get_state',arguments:{},rawArguments:'{}'}]}
describe('measured output echo budget',()=>{
 it('never reconstructs legacy per-message usage from multiple receipts, seed history, changed text or a mismatched total',()=>{
  const checkpoint:RunCheckpoint={version:1,runId:'old',threadId:'t',agentId:'a',status:'failed',messages:[response],completedToolCalls:{},loopSignatures:[],usage:{outputTokens:20814},step:1}
  const row:JsonObject={event_type:'model.response',status:'completed',output_tokens:20814,payload:{call_id:'c',text:response.content,reasoning:response.reasoning!.slice(0,8000)+'\n…[truncated]',tool_calls:response.toolCalls}}
  expect(recoverLegacyOutputCredit(model,checkpoint,[row])).toBeDefined()
  expect(recoverLegacyOutputCredit(model,checkpoint,[row,row])).toBeUndefined()
  expect(recoverLegacyOutputCredit(model,{...checkpoint,runId:''},[row])).toBeUndefined()
  expect(recoverLegacyOutputCredit(model,{...checkpoint,usage:{outputTokens:99999}},[row])).toBeUndefined()
  expect(recoverLegacyOutputCredit(model,{...checkpoint,messages:[{...response,content:'changed'}]},[row])).toBeUndefined()
 })
 it('admits the 65.8KB reasoning/tool continuation without dropping thought, image, tools or output reserve',()=>{
  const messages:RuntimeMessage[]=[{role:'system',content:'s'.repeat(6900)},{role:'user',content:'画图',attachmentIds:['img']},response,{role:'tool',toolCallId:'state',content:'{}'}]
  const input={messages,tools:[{name:'board',description:'t'.repeat(24300),inputSchema:{type:'object'},source:'builtin' as const,timeoutMs:1000}],attachments:[{attachmentId:'img',name:'fixture.png',mimeType:'image/png',dataBase64:'AA=='}],outputTokens:32768}
  const before=JSON.stringify(input),credit=measuredOutputCredit(model,response,{inputTokens:11858,outputTokens:20814},'model-call')!
  expect(()=>projectContext(input,{contextWindow:128000})).toThrow(ContextProjectionError)
  const view=projectContext({...input,measuredMessageTokens:outputUsageCounts(model,messages,[credit])},{contextWindow:128000})
  expect(view.decision).toMatchObject({admitted:true,estimator:'measured-output-echo-v1',safeBudget:121600})
  expect(view.decision.breakdown).toMatchObject({measuredMessages:1,attachmentTokens:16384,outputTokens:32768})
  expect(view.decision.estimatedTokens).toBeLessThan(110000)
  expect(JSON.stringify(input)).toBe(before);expect(view.messages[2].reasoning).toBe(response.reasoning)
 })
 it('counts new tool results and middleware instructions fully; truly oversized continuations still stop',()=>{
  const messages:RuntimeMessage[]=[response,{role:'tool',toolCallId:'state',content:'x'.repeat(110000)},{role:'system',content:'不可丢约束'}]
  const credit=measuredOutputCredit(model,response,{outputTokens:20814},'model-call')!
  expect(()=>projectContext({messages,outputTokens:32768,measuredMessageTokens:outputUsageCounts(model,messages,[credit])},{contextWindow:128000})).toThrow(ContextProjectionError)
 })
 it('does not reuse another model/configuration or edited response measurement',()=>{
  const credit=measuredOutputCredit(model,response,{outputTokens:20814},'model-call')!
  for(const m of [{...model,model_id:'another'},{...model,model:'other'},{...model,runtime_extra:{...model.runtime_extra,base_url:'https://other.invalid'}}])expect(outputUsageCounts(m,[response],[credit])).toEqual([undefined])
  for(const m of [{...response,reasoning:response.reasoning+'x'},{...response,content:'new'},{...response,toolCalls:[{...response.toolCalls![0],arguments:{extra:true}}]}])expect(outputUsageCounts(model,[m],[credit])).toEqual([undefined])
 })
 it('keeps counts across serialization, consumes each credit once, never uses a cumulative input/output total',()=>{
  const credit=measuredOutputCredit(model,response,{outputTokens:20814,totalTokens:32672,cachedInputTokens:9216},'model-call')!
  const counts=outputUsageCounts(model,[response,response],JSON.parse(JSON.stringify([credit])))
  expect(counts[0]).toBe(Math.ceil(20814*1.1)+128);expect(counts[1]).toBeUndefined()
  expect(outputUsageCounts(model,[response,response],[credit,credit])[1]).toBeUndefined()
 })
 it('falls back for missing, invalid or implausibly small usage, unsupported providers and signed metadata',()=>{
  for(const n of [undefined,0,-1,NaN,Infinity,1.2,1])expect(measuredOutputCredit(model,response,{outputTokens:n},'c')).toBeUndefined()
  expect(measuredOutputCredit({...model,provider_id:'anthropic'},response,{outputTokens:20814},'c')).toBeUndefined()
  expect(measuredOutputCredit(model,{...response,providerMetadata:{signature:'opaque'}},{outputTokens:20814},'c')).toBeUndefined()
  expect(outputUsageCounts(model,[response],[null,{}, {version:1,units:1}])).toEqual([undefined])
 })
})
