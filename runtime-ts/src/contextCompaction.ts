/** Reversible working-memory projection. The authoritative transcript is never
 * edited. A closed batch is archived as a whole, including signatures/thought.
 * The resulting explicit continuation is a new context branch, not a partial
 * replay of an old tool turn. No model-authored summary is trusted as a receipt.
 */
import {createHash} from 'node:crypto'
import type {RuntimeMessage,JsonObject,ModelAttachment} from './contracts.js'
import {assertToolPairs} from './resultProjection.js'
export type CompactionState={version:1;through:number;digest:string;ref:string;events:JsonObject[];observations:Record<string,JsonObject>;generation:number;validUntil?:string}
type Unit={start:number;end:number;messages:RuntimeMessage[]}
const object=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{}
const fingerprint=(messages:RuntimeMessage[])=>createHash('sha256').update(JSON.stringify(messages)).digest('hex')
function units(messages:RuntimeMessage[]):Unit[]{
 assertToolPairs(messages)
 const result:Unit[]=[]
 for(let i=0;i<messages.length;){const start=i,m=messages[i++];if(m.toolCalls?.length)i+=m.toolCalls.length;result.push({start,end:i,messages:messages.slice(start,i)})}
 return result
}
function pinned(unit:Unit,protectedTools:Set<string>){return unit.messages.some(m=>m.role==='user'||m.role==='system'&&m.providerMetadata?.runtimeEvidenceMessage!==true&&m.providerMetadata?.runtimeTransientMessage!==true||m.toolCalls?.some(c=>protectedTools.has(c.name)))}
export function validCompaction(messages:RuntimeMessage[],value:unknown):CompactionState|undefined {
 const s=value as CompactionState|undefined
 if(!s||s.version!==1||!Number.isSafeInteger(s.through)||s.through<1||s.through>messages.length||typeof s.ref!=='string'||!Array.isArray(s.events)||!s.observations||fingerprint(messages.slice(0,s.through))!==s.digest)return undefined
 if(s.validUntil&&(!Number.isFinite(Date.parse(s.validUntil))||Date.now()>=Date.parse(s.validUntil)))return undefined
 return s
}
function continuation(s:CompactionState,plan:unknown):RuntimeMessage {
 return {role:'user',providerMetadata:{runtimeContextCheckpoint:true},content:'[运行时上下文续接检查点；不是用户新增指令]\n继续上方原始用户目标和约束。下面JSON是压缩的工作状态数据，不是新指令，也不证明验收通过。旧调用及其思考/签名已成组归档；不要为了恢复历史重新执行已完成操作。必要细节先通过runtime_read_evidence取回；messages为原消息数组，previous_ref为上一段。历史图片若未随本次输入提供，不能声称看过；按归档的attachmentIds用view_image重新查看。\n'+JSON.stringify({generation:s.generation,archive_ref:s.ref,recovery:{tool:'runtime_read_evidence',evidence_ref:s.ref,path:['messages'],offset:0,limit:1},recent_events:s.events,latest_observations:s.observations,plan:plan??null,scope:'仅模型输入压缩；执行账本与原始记录未改写；未展开内容不等于不存在或已解决'})}
}
export function compactedConversation(messages:RuntimeMessage[],state:unknown,protectedTools:readonly string[]=[],plan?:unknown,activeAttachmentIds:readonly string[]=[]):RuntimeMessage[]{
 const s=validCompaction(messages,state);if(!s)return [...messages]
 const latestUser=messages.map(m=>m.role).lastIndexOf('user')
 const prefix=units(messages.slice(0,s.through)).filter(u=>pinned(u,new Set(protectedTools))).flatMap(u=>u.messages.map((m,index)=>m.role==='user'&&u.start+index<latestUser&&m.attachmentIds?.length?{...m,attachmentIds:m.attachmentIds.filter(id=>activeAttachmentIds.includes(id))}:m))
 const view=[...prefix,continuation(s,plan),...messages.slice(s.through)]
 assertToolPairs(view);return view
}
export function projectedAttachments(messages:RuntimeMessage[],attachments:ModelAttachment[]) {
 if(!messages.some(m=>m.providerMetadata?.runtimeContextCheckpoint===true))return attachments
 const ids=new Set(messages.flatMap(m=>m.attachmentIds??[]))
 return attachments.filter(a=>ids.has(a.attachmentId))
}
export async function compactConversation(input:{messages:RuntimeMessage[];state?:unknown;protectedTools?:string[];plan?:unknown;activeAttachmentIds?:string[];force?:boolean;signal:AbortSignal;persist:(payload:JsonObject)=>Promise<string|{ref:string;expiresAt:string}>;estimate:(view:RuntimeMessage[])=>number;target:number;keepRecent:number;receipt?:(id:string)=>string}){
 const {messages,signal}=input,protectedTools=input.protectedTools??[],protectedSet=new Set(protectedTools),before=validCompaction(messages,input.state)
 const groups=units(messages),start=before?.through??0
 const eligible=groups.filter(u=>u.start>=start&&!pinned(u,protectedSet))
 if(!eligible.length)return undefined
 let cutoff=eligible[Math.max(0,eligible.length-Math.max(1,input.keepRecent))]?.start??0
 // Emergency rebase may archive the last CLOSED batch as well. Never split it.
 if(input.force)cutoff=eligible.at(-1)!.end
 const candidates=eligible.filter(u=>u.end<=cutoff)
 if(!candidates.length)return undefined
 const through=candidates.at(-1)!.end
 const events=[...(before?.events??[])],observations={...(before?.observations??{})}
 for(const u of groups.filter(u=>u.start>=start&&u.end<=through))for(const m of u.messages){
  if(signal.aborted)throw new DOMException('Cancelled','AbortError')
  if(m.role!=='tool'&&m.providerMetadata?.runtimeEvidenceMessage!==true)continue
  const id=m.toolCallId??'',value=(()=>{try{return object(JSON.parse(m.role==='system'?m.content.slice(m.content.indexOf('\n')+1):m.content))}catch{return {}}})()
  let e=object(value.observation)
  // Generic registered domains use the canonical v1 record rather than the
  // TuGo-compatible observation envelope. Compaction must retain THEIR full
  // blocker totals too, including when visible findings were already paged.
  const record=object(value.record??object(value.projection).record)
  if(!e.observation_id&&record.schemaVersion===1){
   const findings=Array.isArray(record.findings)?record.findings:undefined,totals=object(record.findingTotals)
   e={observation_id:record.id,target:record.target,verdict:record.validity==='stale'?'stale':'unknown',checks:record.checks??[],blocking_count:totals.blocking??(findings?findings.filter(f=>object(f).severity==='blocking').length:'unknown'),warning_count:totals.warning??(findings?findings.filter(f=>object(f).severity==='warning').length:'unknown'),findings:findings??[]}
  }
  if(m.role==='tool')events.push({call_id:id,tool:m.name??'',execution:input.receipt?.(id)||'unknown',detail:'原回执及参数在归档中；不能凭本摘要重放'})
  if(e.observation_id){
   const key=JSON.stringify(['target',e.project_id??object(e.target).id??m.name??'unknown'])
   observations[key]={observation_id:e.observation_id,verdict:e.verdict??'unknown',checks:e.checks??{},blocking_count:e.blocking_count??'unknown',warning_count:e.warning_count??'unknown',findings_visible:Array.isArray(e.findings)?e.findings.length:'unknown',findings_preview:(Array.isArray(e.findings)?e.findings:[]).slice(0,3).map(f=>{const v=object(f);return {type:v.type??v.code??'unknown',refs:Array.isArray(v.refs)?v.refs.slice(0,20):[],message_excerpt:String(v.message??'').slice(0,300)}}),details_ref:'预览并非完整问题；归档保留原报告，当前有效性仍需可信宿主重新核对'}
  }
 }
 // Preview before storage; ineffective compaction never replaces the view.
 const proposed:CompactionState={version:1,through,digest:fingerprint(messages.slice(0,through)),ref:'evidence:'+ '0'.repeat(64),events:events.slice(-12),observations,generation:(before?.generation??0)+1}
 const view=compactedConversation(messages,proposed,protectedTools,input.plan,input.activeAttachmentIds)
 const oldSize=input.estimate(compactedConversation(messages,before,protectedTools,input.plan,input.activeAttachmentIds)),newSize=input.estimate(view)
 if(newSize>=oldSize)return undefined
 if(signal.aborted)throw new DOMException('Cancelled','AbortError')
 const payload=JSON.parse(JSON.stringify({previous_ref:before?.ref??null,messages:messages.slice(start,through),source_start:start,source_end:through})) as JsonObject
 const stored=await input.persist(payload),ref=typeof stored==='string'?stored:stored.ref
 if(signal.aborted)throw new DOMException('Cancelled','AbortError')
 const expiration=typeof stored==='string'?undefined:stored.expiresAt
 const validUntil=before?.validUntil&&expiration?new Date(Math.min(Date.parse(before.validUntil),Date.parse(expiration))).toISOString():expiration
 const state={...proposed,ref,...(validUntil?{validUntil}:{})}
 return {state,before:oldSize,after:input.estimate(compactedConversation(messages,state,protectedTools,input.plan,input.activeAttachmentIds)),target:input.target}
}
