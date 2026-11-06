/** Reversible tool-result projection. Payload semantics are not summarized. */
import {EvidenceError,type EvidencePort} from './evidencePort.js'
import {validateObservation,type ObservationRecord} from './observationProtocol.js'
import {adaptLegacyObservation,type LegacyObservationContext} from './legacyObservation.js'
import {readEvidenceView,type EvidenceViewRequest} from './evidenceProjection.js'
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
export async function projectToolResult(port:EvidencePort,value:unknown,context:LegacyObservationContext&{record?:ObservationRecord},threshold=4000) {
 const content=typeof value==='string'?value:JSON.stringify(value??null)
 if(content.length<=threshold&&!context.record)return {content}
 // Only move explicit data collections. Arbitrary text (Skills, instructions,
 // constraints), scalar metadata, unknown fields and treatment history stay whole.
 const source=obj(value),observation=obj(source.observation)
 if(Object.prototype.hasOwnProperty.call(source,'projection')&&!context.record)return {content}
 const paths:string[][]=[]
 if(Array.isArray(source.rows))paths.push(['rows'])
 if(context.record&&Array.isArray(obj(source.data).rows))paths.push(['data','rows'])
 if(Array.isArray(observation.findings))paths.push(['observation','findings'])
 if(!paths.length&&!context.record)return {content}
 const record=context.record?validateObservation(context.record):adaptLegacyObservation(value,context)
 let ref:string
 try{ref=await port.put(record,value)}catch(error){
  if(error instanceof EvidenceError&&error.code==='sensitive')return {content:JSON.stringify({projection:{kind:'unavailable',evidenceUnavailable:'sensitive',execution:record.execution,replay:false,disclosure:'凭据策略拒绝证据保存；不将原始敏感内容放进模型消息，也不重放原操作。'}})}
  return {content:JSON.stringify({result:value,projection:{kind:'full',evidenceUnavailable:error instanceof EvidenceError?error.code:'storage',execution:record.execution,replay:false}})}
 }
 if(context.record&&(content.length<=threshold||!paths.length))return {ref,content:JSON.stringify({...source,projection:{kind:'full',evidenceRef:ref,record,recovery:{tool:'runtime_read_evidence',evidence_ref:ref}}})}
 const projected:Record<string,unknown>=structuredClone(source)
 const collections=paths.map(path=>{
  let selected:unknown=value
  for(const segment of path)selected=obj(selected)[segment]
  if(path.length){let parent=projected;for(const segment of path.slice(0,-1))parent=parent[segment] as Record<string,unknown>;parent[path.at(-1)!]=[]}
  return {path,returned:0,storedTotal:(selected as unknown[]).length,nextOffset:0}
 })
 return {ref,content:JSON.stringify({...projected,projection:{kind:'referenced_collections',evidenceRef:ref,record:{...record,findingTotals:record.findingTotals??{blocking:record.findings.filter(f=>f.severity==='blocking').length,warning:record.findings.filter(f=>f.severity==='warning').length,total:record.findings.length},findings:record.findings.slice(0,3)},storedFindings:record.findings.length,collections,recovery:{tool:'runtime_read_evidence',evidence_ref:ref},disclosure:'集合明细未呈现，不是已完成交付或业务汇总；使用引用按需取回。标量、约束、未知字段及处理记录未压缩。'}})}
}
/** Byte/character bounded pages: never cut JSON. Large individual values must
 * be selected by a deeper path; this read cannot silently make a new summary. */
export async function boundedEvidenceView(port:EvidencePort,ref:string,scope:LegacyObservationContext['scope'],request:EvidenceViewRequest={},maxCharacters=16000){
 let limit=request.limit??50,findingLimit=request.findingLimit??5
 for(let attempt=0;attempt<16;attempt++){
  const view=await readEvidenceView(port,ref,scope,{...request,limit,findingLimit})
  if(JSON.stringify(view).length<=maxCharacters)return view
  if(limit===1&&findingLimit===1)throw new EvidenceError('quota')
  limit=Math.max(1,Math.floor(limit/2));findingLimit=Math.max(1,Math.floor(findingLimit/2))
 }
 throw new EvidenceError('quota')
}

/** Validate before transport; never repair pairs by dropping execution facts. */
export function assertToolPairs(messages:import('./contracts.js').RuntimeMessage[]) {
 let pending=new Set<string>()
 for(const message of messages){
  if(message.role==='tool'){
   if(!message.toolCallId||!pending.delete(message.toolCallId))throw new Error('工具协议不配对：拒绝发送孤立或重复结果')
  } else {
   if(pending.size)throw new Error('工具协议不配对：调用批次缺少结果')
   if(message.toolCalls?.length){
    const ids=message.toolCalls.map(c=>c.id)
    if(message.role!=='assistant'||ids.some(id=>!id)||new Set(ids).size!==ids.length)throw new Error('工具协议不配对：非法调用批次')
    pending=new Set(ids)
   }
  }
 }
 if(pending.size)throw new Error('工具协议不配对：调用批次未结束')
}
