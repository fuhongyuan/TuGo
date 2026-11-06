/** Kernel read-only domain port. Only trusted host registrations execute here;
 * this is not a plugin loader, sandbox, or a second Agent Loop. */
import type {JsonObject,ToolDefinition} from './contracts.js'
import type {AttemptContext} from './toolExecutor.js'
import {validateObservation,type ObservationRecord} from './observationProtocol.js'
export type DomainIdentity={workspaceId:string;runId:string;conversationId:string;sessionId:string}
export type DomainContext=DomainIdentity&{scope:ObservationRecord['scope'];callId:string;createdAt:string;attempt:AttemptContext;signal:AbortSignal}
export type DomainResult={record:ObservationRecord;data:JsonObject;note:string;detail?:{tool:string;args:JsonObject}}
export type DomainTool={name:string;description:string;inputSchema:JsonObject;timeoutMs:number;observe:(args:JsonObject,context:DomainContext)=>Promise<DomainResult>}
export type DomainAdapter={id:string;version:string;tools:DomainTool[]}
export class DomainContractError extends Error { constructor(message:string){super(`Domain contract: ${message}`);this.name='DomainContractError'} }
function copyJson<T>(value:T):T {
 const seen=new Set<object>()
 const visit=(v:unknown)=>{
  if(v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isFinite(v)))return
  if(!v||typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))))throw new DomainContractError('non JSON result')
  if(Object.getOwnPropertySymbols(v).length||(Array.isArray(v)&&(Object.keys(v).length!==v.length||Object.keys(v).some(k=>! /^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length))))throw new DomainContractError('non JSON result')
  seen.add(v);for(const item of Object.values(v))visit(item);seen.delete(v)
 }
 visit(value);return JSON.parse(JSON.stringify(value)) as T
}
export class DomainObservationRegistry {
 private adapters:DomainAdapter[]=[]
 private bindings=new WeakMap<ToolDefinition,{adapter:DomainAdapter;tool:DomainTool}>()
 constructor(adapters:readonly DomainAdapter[]=[]) {
  const ids=new Set<string>(),names=new Set<string>()
  for(const adapter of adapters){
   if(!/^[a-z][a-z0-9.-]{0,79}$/.test(adapter.id)||['runtime-tool-results','host-tools'].includes(adapter.id)||!adapter.version?.trim()||ids.has(adapter.id))throw new DomainContractError('invalid or duplicate adapter')
   ids.add(adapter.id)
   const tools=adapter.tools.map(tool=>{
    if(!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(tool.name)||tool.name==='runtime_read_evidence'||names.has(tool.name)||!Number.isSafeInteger(tool.timeoutMs)||tool.timeoutMs<=0||tool.timeoutMs>120000||typeof tool.observe!=='function')throw new DomainContractError('invalid or duplicate tool')
    names.add(tool.name);return {...tool,inputSchema:copyJson(tool.inputSchema)}
   })
   this.adapters.push({id:adapter.id,version:adapter.version,tools})
  }
 }
 hasApplication(id:string){return this.adapters.some(a=>a.id===id)}
 resolve(existing:ToolDefinition[]):ToolDefinition[] {
  if(!this.adapters.length)return existing
  const names=new Set(existing.map(t=>t.name)),result=[...existing]
  for(const adapter of this.adapters)for(const tool of adapter.tools){
   if(names.has(tool.name))throw new DomainContractError('tool name collision')
   names.add(tool.name)
   const definition:ToolDefinition={name:tool.name,description:tool.description,inputSchema:copyJson(tool.inputSchema),timeoutMs:tool.timeoutMs,source:'builtin',handlerKey:`domain-observation:${adapter.id}`}
   this.bindings.set(definition,{adapter,tool});result.push(definition)
  }
  return result
 }
 owns(tool:ToolDefinition){return this.bindings.has(tool)}
 snapshot(){return this.adapters.map(a=>({id:a.id,version:a.version,tools:a.tools.map(t=>t.name),read_only:true}))}
 async execute(definition:ToolDefinition,args:JsonObject,identity:DomainIdentity,attempt:AttemptContext):Promise<DomainResult> {
  const binding=this.bindings.get(definition);if(!binding)throw new DomainContractError('unregistered tool identity')
  if(attempt.signal.aborted)throw new DOMException('Cancelled','AbortError')
  const scope={applicationId:binding.adapter.id,workspaceId:identity.workspaceId,runId:identity.runId,conversationId:identity.conversationId}
  const context:DomainContext={...identity,scope:Object.freeze({...scope}),callId:attempt.callId,createdAt:new Date().toISOString(),attempt,signal:attempt.signal}
  const result=await binding.tool.observe(copyJson(args),Object.freeze(context))
  const record=validateObservation(result.record)
  if((Object.keys(scope) as Array<keyof typeof scope>).some(k=>record.scope[k]!==scope[k])||record.execution.callId!==attempt.callId||record.execution.state!=='succeeded'||record.target.sessionId!==identity.sessionId||record.source.layer!=='domain'||record.source.component!==binding.adapter.id)throw new DomainContractError('evidence identity mismatch')
  if(!result.data||typeof result.data!=='object'||Array.isArray(result.data)||typeof result.note!=='string'||!result.note.trim())throw new DomainContractError('missing data or scope disclosure')
  if(result.detail&&!binding.adapter.tools.some(t=>t.name===result.detail!.tool))throw new DomainContractError('unregistered detail route')
  return copyJson({...result,record})
 }
}
