/** Application boundary consumed by the one Agent Loop. Trusted platform
 * assembly supplies tools and product policy; model arguments cannot do so. */
import AjvModule,{type ValidateFunction} from 'ajv'
import type {JsonObject,RunCheckpoint,ToolCall,ToolDefinition} from './contracts.js'
import type {AttemptContext} from './toolExecutor.js'
import type {RuntimeRepository} from './repository.js'
import type {McpManager} from './mcp.js'
import type {RuntimePromptLocale} from './promptLocale.js'
import {ToolExecutionError} from './toolErrors.js'
export type HostToolBridge=(name:string,args:JsonObject,context:JsonObject,signal:AbortSignal,timeoutMs:number)=>Promise<unknown>
export interface ApplicationToolPort {
 resolve(agentId:string):Promise<ToolDefinition[]>
 validate(tool:ToolDefinition,args:JsonObject):unknown
 execute(tool:ToolDefinition,args:JsonObject,checkpoint:RunCheckpoint,signal:AbortSignal,options?:{repair?:boolean;execution?:AttemptContext}):Promise<unknown>
}
export type ApplicationObservationRequest={name:string;purpose:string;actor:string}
export type MaterializedResult={result:unknown;exposeAttachment?:boolean}
export type ApplicationConclusion={code:string;content:string}
export interface RuntimeApplication {
 id:string
 workspaceBusyMessage?:string
 title?(value:string):string
 soul?(value:string,locale:RuntimePromptLocale):string
 context?(checkpoint:RunCheckpoint,locale:RuntimePromptLocale):{contract:string;binding:string}
 startRun?(checkpoint:RunCheckpoint,previousStatus:string):void
 tools?(definitions:ToolDefinition[]):ToolDefinition[]
 stopReason?(checkpoint:RunCheckpoint):string|undefined
 conclusion?(checkpoint:RunCheckpoint):ApplicationConclusion|undefined
 loopObservation?(checkpoint:RunCheckpoint):ApplicationObservationRequest|undefined
 observe?(checkpoint:RunCheckpoint,signal:AbortSignal,callId:string):Promise<JsonObject>
 deliveryEvidence?(checkpoint:RunCheckpoint):unknown
 delivery?(checkpoint:RunCheckpoint,signal:AbortSignal):Promise<{observation?:ApplicationObservationRequest;disclosure?:string;feedback?:string}>
 syntheticResult?(checkpoint:RunCheckpoint,call:ToolCall):{result:unknown}|undefined
 materialize?(checkpoint:RunCheckpoint,call:ToolCall,value:unknown,visionEnabled:boolean):Promise<MaterializedResult>
 recordResult?(checkpoint:RunCheckpoint,call:ToolCall,result:unknown):void
 afterResult?(checkpoint:RunCheckpoint,call:ToolCall,result:unknown):void
 fatalToolFailure?(name:string,message:string,outcome:string):string|undefined
}
export type ApplicationFactory=(services:{repository:RuntimeRepository;mcp:McpManager;bridge:HostToolBridge})=>{tools:ApplicationToolPort;application:RuntimeApplication}
/** Minimal generic host: registered domain tools and evidence reads use these
 * validators, while no application implementation or product tool is loaded. */
class DomainOnlyTools implements ApplicationToolPort {
 private ajv=new (AjvModule as unknown as new(options?:JsonObject)=>{compile(schema:JsonObject):ValidateFunction;errorsText(errors?:unknown):string})({allErrors:true,strict:false})
 async resolve(){return []}
 validate(tool:ToolDefinition,args:JsonObject){const validate=this.ajv.compile(tool.inputSchema);if(!validate(args))throw new ToolExecutionError(`工具参数不合法：${this.ajv.errorsText(validate.errors)}`,'validation',true)}
 async execute():Promise<unknown>{throw new ToolExecutionError('No application tool executor registered','unavailable')}
}
export const domainOnlyApplication:ApplicationFactory=()=>({tools:new DomainOnlyTools(),application:{id:'generic'}})
