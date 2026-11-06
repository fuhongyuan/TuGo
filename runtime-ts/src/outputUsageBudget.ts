/** Trusted completion accounting, not a tokenizer or a model-provided hint.
 * Only an exact, unchanged echo of a measured Chat Completions response gets
 * credit. New text, tool results, schemas and media keep the byte upper bound.
 */
import {createHash} from 'node:crypto'
import type {ModelConfig,RuntimeMessage,Usage,RunCheckpoint,JsonObject} from './contracts.js'
export type OutputUsageCredit={version:1;modelKey:string;callId:string;digest:string;units:number}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const supported=new Set(['openai','openai-compatible','deepseek','qwen','zhipu','glm','minimax','mimo','vllm','mindie'])
export const outputUsageModelKey=(model:ModelConfig)=>hash([model.model_id,model.provider_id,model.model,model.runtime_extra])
function digest(message:RuntimeMessage) {
 if(message.role!=='assistant'||Object.keys(message.providerMetadata??{}).length||message.toolCalls?.some(c=>Object.keys(c.providerMetadata??{}).length))return undefined
 return hash({role:message.role,content:message.content,reasoning:message.reasoning||'',calls:(message.toolCalls??[]).map(c=>({id:c.id,name:c.name,arguments:c.arguments,rawArguments:c.rawArguments||''}))})
}
export function measuredOutputCredit(model:ModelConfig,message:RuntimeMessage,usage:Usage,callId:string):OutputUsageCredit|undefined {
 const units=usage.outputTokens,key=digest(message)
 if(!supported.has(model.provider_id.toLowerCase())||!key||!Number.isSafeInteger(units)||Number(units)<=0)return undefined
 // Reject obviously incomplete gateway usage; do not guess another tokenizer.
 if(Number(units)<Math.ceil(Buffer.byteLength(JSON.stringify(message))/16))return undefined
 return {version:1,modelKey:outputUsageModelKey(model),callId,digest:key,units:Number(units)}
}
export function outputUsageCounts(model:ModelConfig,messages:RuntimeMessage[],ledger:unknown):(number|undefined)[] {
 const modelKey=outputUsageModelKey(model),credits=new Map<string,number[]>(),seen=new Set<string>()
 if(Array.isArray(ledger))for(const entry of ledger.slice(-128)) {
  const c=entry as Partial<OutputUsageCredit>|null
  if(!c||c.version!==1||c.modelKey!==modelKey||typeof c.callId!=='string'||typeof c.digest!=='string'||!Number.isSafeInteger(c.units)||Number(c.units)<=0)continue
  if(seen.has(c.callId))continue
  seen.add(c.callId)
  const list=credits.get(c.digest)??[];list.push(Number(c.units));credits.set(c.digest,list)
 }
 return messages.map(message=>{
  const key=digest(message),units=key?credits.get(key)?.shift():undefined
  // Allow framing/replay overhead and 10% uncertainty without relaxing the
  // existing global safety ratio or reducing the next output reserve.
  return units===undefined?undefined:Math.ceil(units*1.1)+64+64*(message.toolCalls?.length??0)
 })
}

/** Narrow upgrade path for the reported pre-fix failure. Only the runtime's
 * original checkpoint + its one successful response receipt may establish
 * provenance. API-seeded chat history has no run/usage/tool protocol and cannot
 * qualify. Never infer per-message usage from a multi-response aggregate.
 */
export function recoverLegacyOutputCredit(model:ModelConfig,checkpoint:RunCheckpoint,receipts:JsonObject[]):OutputUsageCredit|undefined {
 const responses=receipts.filter(r=>r.event_type==='model.response'&&r.status==='completed')
 const assistants=checkpoint.messages.filter(m=>m.role==='assistant')
 if(!checkpoint.runId||checkpoint.status!=='failed'||responses.length!==1||assistants.length!==1)return undefined
 const row=responses[0],payload=row.payload as JsonObject|undefined,message=assistants[0]
 if(!payload||!message.reasoning||!message.toolCalls?.length||message.content.length>8000||!Number.isSafeInteger(row.output_tokens)||Number(row.output_tokens)<=0||row.output_tokens!==checkpoint.usage.outputTokens)return undefined
 // The original loop never rewrites reasoning. Journal diagnostics shorten it
 // at 8K, whereas the authoritative checkpoint retains the full provider echo.
 const loggedReasoning=message.reasoning.length>8000?message.reasoning.slice(0,8000)+'\n…[truncated]':message.reasoning
 if(payload.reasoning!==loggedReasoning||payload.text!==message.content||JSON.stringify(payload.tool_calls)!==JSON.stringify(message.toolCalls))return undefined
 return measuredOutputCredit(model,message,{outputTokens:Number(row.output_tokens)},String(payload.call_id||''))
}
