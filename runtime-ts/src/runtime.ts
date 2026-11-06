/** Desktop/platform composition root; backwards-compatible public entry. */
import {AgentRuntimeCore} from './agentLoop.js'
import {ToolRegistry} from './tools.js'
import {TuGoRuntimeApplication} from './tugo/runtimeApplication.js'
import type {RuntimeToHost} from './contracts.js'
import type {RuntimeExecutionServices} from './toolExecutionPolicies.js'
import type {DomainAdapter} from './domainObservation.js'
export class TuGoRuntime extends AgentRuntimeCore {
 constructor(dataDir:string,defaultsPath:string,send:(message:RuntimeToHost)=>void,executionServices:RuntimeExecutionServices={},domains:readonly DomainAdapter[]=[]) {
  super(dataDir,defaultsPath,send,executionServices,domains,({repository,mcp,bridge})=>{
   const tools=new ToolRegistry(repository,mcp,bridge)
   return {tools,application:new TuGoRuntimeApplication(repository,(checkpoint,signal,id)=>tools.observe(checkpoint,signal,id))}
  })
 }
}
