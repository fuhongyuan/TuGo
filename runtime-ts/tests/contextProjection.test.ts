import {describe,expect,it} from 'vitest'
import {projectContext,ContextProjectionError} from '../src/contextProjection.js'
import type {RuntimeMessage,ToolDefinition} from '../src/contracts.js'
const tool:ToolDefinition={name:'query',description:'返回明细',inputSchema:{type:'object',properties:{query:{type:'string'}}},source:'mcp',timeoutMs:1000}
const image={attachmentId:'a',name:'image.png',mimeType:'image/png',dataBase64:'abcd'}
describe('model context admission projection',()=>{
 it.each([4096,8192,32768,128000])('accounts for all text partitions and output within window %s',contextWindow=>{
  const messages:RuntimeMessage[]=[{role:'system',content:'不可修改目标约束'},{role:'user',content:'列出数据明细'},{role:'assistant',content:'',toolCalls:[{id:'c1',name:'query',arguments:{query:'all'}}]},{role:'tool',toolCallId:'c1',content:JSON.stringify({rows:[1,2,3],total:3})}]
  const before=JSON.stringify(messages)
  const view=projectContext({messages,tools:[tool],outputTokens:512},{contextWindow})
  expect(view.decision.admitted).toBe(true)
  expect(view.decision.estimatedTokens).toBeLessThanOrEqual(view.decision.safeBudget)
  expect(view.decision.breakdown.systemTokens).toBeGreaterThan(0)
  expect(view.decision.breakdown.historyTokens).toBeGreaterThan(0)
  expect(view.decision.breakdown.toolTokens).toBeGreaterThan(0)
  expect(view.decision.breakdown.outputTokens).toBe(512)
  expect(JSON.stringify(view.messages)).toBe(before)
  expect(view.messages[2].toolCalls?.[0].id).toBe(view.messages[3].toolCallId)
 })
 it('retains a complete valid large result when it fits, stops without truncating when it does not',()=>{
  const payload=JSON.stringify({rows:Array.from({length:3000},(_,id)=>({id,text:'明细'}))})
  const messages:RuntimeMessage[]=[{role:'tool',content:payload,toolCallId:'c'}]
  expect(projectContext({messages,outputTokens:512},{contextWindow:256000}).messages[0].content).toBe(payload)
  expect(()=>projectContext({messages,outputTokens:512},{contextWindow:4096})).toThrow(ContextProjectionError)
  expect(JSON.parse(messages[0].content).rows).toHaveLength(3000)
 })
 it('reserves safety headroom even when the request fits the nominal window',()=>{
  try {projectContext({messages:[{role:'user',content:'x'.repeat(3850)}],outputTokens:128},{contextWindow:4096});throw Error('should reject')}
  catch(error){expect(error).toBeInstanceOf(ContextProjectionError);const report=(error as ContextProjectionError).decision;expect(report.admitted).toBe(false);expect(report.estimatedTokens).toBeGreaterThan(report.safeBudget);expect(report.estimatedTokens).toBeLessThan(4096);expect(report.reason).toBe('context_exceeds_safe_budget')}
 })
 it('counts UTF-8 text, tool ids, raw arguments and provider metadata rather than only content',()=>{
  const base=projectContext({messages:[{role:'assistant',content:'x'}]},{contextWindow:128000})
  const rich=projectContext({messages:[{role:'assistant',content:'中',name:'agent',toolCallId:'id',reasoning:'thinking',providerMetadata:{signature:'s'.repeat(100)},toolCalls:[{id:'c',name:'query',arguments:{},rawArguments:'x'.repeat(100)}]}]},{contextWindow:128000})
  expect(rich.decision.estimatedTokens).toBeGreaterThan(base.decision.estimatedTokens+200)
  expect(rich.decision.estimator).toBe('utf8-byte-upper-estimate-v1')
 })
 it('counts repeated image bindings as repeated provider inputs; unused images are not billed',()=>{
  const view=projectContext({messages:[{role:'user',content:'first',attachmentIds:['a']},{role:'user',content:'again',attachmentIds:['a']}],attachments:[image,{...image,attachmentId:'unused'}]},{contextWindow:128000})
  expect(view.decision.breakdown.attachmentOccurrences).toBe(2)
  expect(view.decision.breakdown.attachmentTokens).toBe(32768)
  expect(view.decision.limitations).toContain('media_tokens_are_configured_estimates')
 })
 it('counts legacy unbound attachments only once on the final user message',()=>{
  const view=projectContext({messages:[{role:'user',content:'one'},{role:'user',content:'two'}],attachments:[image]},{contextWindow:128000})
  expect(view.decision.breakdown.attachmentOccurrences).toBe(1)
 })
 it('blocks oversized schemas, images, and output reserves rather than silently discarding them',()=>{
  for(const input of [{messages:[],tools:[{...tool,description:'x'.repeat(10000)}]},{messages:[{role:'user' as const,content:'image'}],attachments:[image]},{messages:[],outputTokens:4000}])expect(()=>projectContext(input,{contextWindow:4096})).toThrow(ContextProjectionError)
 })
 it.each([NaN,Infinity,-1,0,1.1])('rejects invalid window %s',contextWindow=>{
  expect(()=>projectContext({messages:[]},{contextWindow})).toThrow()
 })
 it.each([NaN,Infinity,-1,0,.99,1])('rejects unsafe safety ratio %s',safetyRatio=>{
  expect(()=>projectContext({messages:[]},{contextWindow:4096,safetyRatio})).toThrow()
 })
 it('rejects invalid reserves; records policy knobs explicitly',()=>{
  expect(()=>projectContext({messages:[],outputTokens:NaN},{contextWindow:4096})).toThrow()
  expect(()=>projectContext({messages:[]},{contextWindow:4096,imageTokenReserve:1})).toThrow()
  const report=projectContext({messages:[],outputTokens:256},{contextWindow:8192,safetyRatio:.9,imageTokenReserve:8192}).decision
  expect(report.safeBudget).toBe(Math.floor(8192*.9));expect(report.imageTokenReserve).toBe(8192);expect(report.breakdown.outputTokens).toBe(256)
 })
})
