/** Policies only: no retries, timers, tool execution or product-specific names here. */
import type {ExecutionState} from './observationProtocol.js'
export type ExecutionContract = {
  origin:'platform'|'untrusted'
  effect:'read'|'write'|'unknown'
  idempotency:'guaranteed'|'none'|'unknown'
  idempotentUntil?:number
  statusQuery:boolean
}
export type RecoveryBudget = {id:string;owner:string;maxAttempts:number;startedAt:number;deadline:number;attempts:string[]}
function validateBudget(b:RecoveryBudget,now:number) {
 if(!b || !b.id?.trim() || !b.owner?.trim() || !Number.isSafeInteger(b.maxAttempts) || b.maxAttempts<1 || !Number.isFinite(b.startedAt) || !Number.isFinite(b.deadline) || b.deadline<=b.startedAt || !Number.isFinite(now) || now<b.startedAt || !Array.isArray(b.attempts) || b.attempts.some(a=>typeof a!=='string'||!a.trim()) || new Set(b.attempts).size!==b.attempts.length || b.attempts.length>b.maxAttempts)throw new Error('Invalid recovery budget')
}
export function createRecoveryBudget(input:{id:string;owner:string;maxAttempts:number;timeoutMs:number;now:number}):RecoveryBudget {
 const budget={id:input.id,owner:input.owner,maxAttempts:input.maxAttempts,startedAt:input.now,deadline:input.now+input.timeoutMs,attempts:[]}
 validateBudget(budget,input.now);return budget
}
/** The controller passes the same budget to inner adapters; attempts must be persisted by the executor before invoking a tool. */
export function consumeRecoveryBudget(budget:RecoveryBudget,input:{owner:string;attemptId:string;now:number;signal?:AbortSignal}) {
 validateBudget(budget,input.now)
 if(input.signal?.aborted)throw new Error('Recovery cancelled')
 if(input.owner!==budget.owner)throw new Error('Recovery owned by another controller')
 if(!input.attemptId?.trim()||budget.attempts.includes(input.attemptId))throw new Error('Invalid or duplicate recovery attempt')
 if(input.now>=budget.deadline||budget.attempts.length>=budget.maxAttempts)throw new Error('Recovery budget exhausted')
 budget.attempts.push(input.attemptId)
}
export function decideRecovery(input:{contract?:ExecutionContract;outcome:ExecutionState;category:string;budget:RecoveryBudget;now:number;signal?:AbortSignal}):{action:'done'|'stop'|'retry'|'query_status'|'escalate';reason:string;owner:string} {
 validateBudget(input.budget,input.now)
 const result=(action:'done'|'stop'|'retry'|'query_status'|'escalate',reason:string)=>({action,reason,owner:input.budget.owner})
 if(input.outcome==='succeeded')return result('done','Execution already confirmed; do not replay')
 if(input.signal?.aborted||input.outcome==='cancelled')return result('stop','Cancelled; no new attempt')
 if(input.now>=input.budget.deadline||input.budget.attempts.length>=input.budget.maxAttempts)return result('escalate','Shared recovery budget exhausted')
 if(!['transient','rate_limit'].includes(input.category))return result('escalate','Failure does not authorize automatic retry')
 const c=input.contract
 if(!c || c.origin!=='platform')return result('escalate','Untrusted or absent execution contract')
 if(input.outcome==='unknown'&&c.effect!=='read'&&c.statusQuery)return result('query_status','Determine actual effects before another write')
 if(input.outcome==='not_started'||c.effect==='read')return result('retry','Confirmed safe to attempt under the shared budget')
 if(c.idempotency==='guaranteed'&&Number.isFinite(c.idempotentUntil)&&input.now<c.idempotentUntil!)return result('retry','Trusted idempotency guarantee is still valid')
 return result('escalate','Unknown effects or no live idempotency guarantee; do not replay')
}
