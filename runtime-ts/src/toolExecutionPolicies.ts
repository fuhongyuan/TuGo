/** Trusted platform defaults, not annotations supplied by an MCP server or model. */
import type {ToolDefinition} from './contracts.js'
import type {ExecutionContract} from './recoveryPolicy.js'
import type {ToolReceipt,AttemptContext} from './toolExecutor.js'
export type RuntimeExecutionServices={
 contractFor?:(tool:ToolDefinition)=>ExecutionContract|undefined
 queryStatus?:(tool:ToolDefinition,identity:{runId:string;callId:string},context:AttemptContext)=>Promise<ToolReceipt>
 classify?:(error:unknown)=>{category:string;outcome:'not_started'|'failed'|'unknown';retryAfterMs?:number}
 maxAttempts?:number
 timeBudgetMs?:number
}
export function platformToolContract(tool:ToolDefinition):ExecutionContract|undefined {
 if(tool.source==='builtin'&&['read-file','web-fetch','web-search'].includes(tool.handlerKey||''))return {origin:'platform',effect:'read',idempotency:'none',statusQuery:false}
 return undefined
}
