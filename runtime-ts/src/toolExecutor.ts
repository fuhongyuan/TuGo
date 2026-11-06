import type {ExecutionState} from './observationProtocol.js'
import {consumeRecoveryBudget,decideRecovery,type ExecutionContract,type RecoveryBudget} from './recoveryPolicy.js'
export class ExecutionFault extends Error {
 constructor(readonly category:string,readonly outcome:ExecutionState,readonly retryAfterMs=0){super(`Tool execution: ${category}`)}
}
export class ObservedToolFailure extends Error {
 constructor(readonly original:unknown,readonly outcome:ExecutionState){super(original instanceof Error?original.message:String(original));this.name='ObservedToolFailure'}
}
export type ExecutionEvent={callId:string;attemptId:string;kind:'invoke'|'query_status';phase:'before'|'result'|'failure'|'backoff'|'late_result';outcome:ExecutionState;budget:RecoveryBudget;category?:string;delayMs?:number}
export type AttemptContext={callId:string;attemptId:string;budget:RecoveryBudget;signal:AbortSignal;beginInternalAttempt:(attemptId:string)=>Promise<void>}
export type ToolReceipt={state:'succeeded';result:unknown}|{state:'not_started'|'unknown'}
export type ExecutionInput={
 callId:string;contract?:ExecutionContract;budget:RecoveryBudget;signal:AbortSignal
 invoke:(context:AttemptContext)=>Promise<unknown>
 queryStatus?:(context:AttemptContext)=>Promise<ToolReceipt>
 record:(event:ExecutionEvent)=>Promise<void>
 classify?:(error:unknown)=>{category:string;outcome:ExecutionState;retryAfterMs?:number}
}
const aborted=()=>new DOMException('Cancelled','AbortError')
function sleep(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
 const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(aborted())}
 const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve()},ms)
 signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
})}
/** The only automatic recovery controller. The durable callback must finish before each attempt. */
export async function executeObservedTool(input:ExecutionInput):Promise<unknown>{
 let outcome:ExecutionState=input.budget.attempts.length?'unknown':'not_started'
 let kind:'invoke'|'query_status'='invoke',last:unknown=new ExecutionFault('transient',outcome),category='transient',retryAfterMs=0
 const emit=async(phase:ExecutionEvent['phase'],attemptId:string,extra:Partial<ExecutionEvent>={})=>input.record({callId:input.callId,attemptId,kind,phase,outcome,budget:structuredClone(input.budget),...extra})
 // A recovered attempted call has unknown effects until a trusted receipt says otherwise.
 if(input.budget.attempts.length){const decision=decideRecovery({contract:input.contract,outcome,category,budget:input.budget,now:Date.now(),signal:input.signal});if(decision.action==='query_status'&&input.queryStatus)kind='query_status';else throw new ObservedToolFailure(last,outcome)}
 while(true){
  const attemptId=`${input.budget.id}:${input.budget.attempts.length+1}`
  try{consumeRecoveryBudget(input.budget,{owner:input.budget.owner,attemptId,now:Date.now(),signal:input.signal});await emit('before',attemptId);if(Date.now()>=input.budget.deadline)throw new Error('Recovery deadline elapsed during persistence')}
  catch(error){throw new ObservedToolFailure(error,outcome)}
  const attemptKind=kind
  const controller=new AbortController()
  let ended=false,timedOut=false
  const cancel=()=>controller.abort(input.signal.reason)
  input.signal.addEventListener('abort',cancel,{once:true})
  if(input.signal.aborted)cancel()
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.max(0,input.budget.deadline-Date.now()))
  let value:unknown,invoked=false
  try{
   if(controller.signal.aborted)throw aborted()
   const context:AttemptContext={callId:input.callId,attemptId,budget:input.budget,signal:controller.signal,beginInternalAttempt:async internalId=>{consumeRecoveryBudget(input.budget,{owner:input.budget.owner,attemptId:internalId,now:Date.now(),signal:controller.signal});await emit('before',internalId);if(controller.signal.aborted||Date.now()>=input.budget.deadline)throw aborted()}}
   const work=Promise.resolve().then(()=>{if(controller.signal.aborted)throw aborted();invoked=true;return attemptKind==='query_status'?input.queryStatus!(context):input.invoke(context)})
   // Late results are observations only; they never resolve the cancelled caller or replay a write.
   void work.then(()=>{if(ended)return input.record({callId:input.callId,attemptId,kind:attemptKind,phase:'late_result',outcome:'succeeded',budget:structuredClone(input.budget)})},()=>{if(ended)return input.record({callId:input.callId,attemptId,kind:attemptKind,phase:'late_result',outcome:'unknown',budget:structuredClone(input.budget)})}).catch(()=>undefined)
   value=await new Promise((resolve,reject)=>{
    const abort=()=>reject(timedOut?new ExecutionFault('transient','unknown'):aborted())
    controller.signal.addEventListener('abort',abort,{once:true})
    work.then(v=>{controller.signal.removeEventListener('abort',abort);resolve(v)},e=>{controller.signal.removeEventListener('abort',abort);reject(e)})
    if(controller.signal.aborted)abort()
   })
  }catch(error){
   ended=true;clearTimeout(timer);input.signal.removeEventListener('abort',cancel)
   let detail:{category:string;outcome:ExecutionState;retryAfterMs?:number}|undefined
   try{detail=error instanceof ExecutionFault?error:input.classify?.(error)}catch{/* A classifier failure cannot authorize replay. */}
   category=detail?.category||'unknown';outcome=detail?.outcome||(invoked?'unknown':outcome);retryAfterMs=detail?.retryAfterMs||0;last=error
   if(attemptKind==='query_status')outcome='unknown'
   try{await emit('failure',attemptId,{category})}catch(persistError){throw new ObservedToolFailure(persistError,outcome)}
   if(attemptKind==='query_status'||input.signal.aborted)throw new ObservedToolFailure(error,outcome)
   const decision=decideRecovery({contract:input.contract,outcome,category,budget:input.budget,now:Date.now(),signal:input.signal})
   if(decision.action==='query_status'&&input.queryStatus){kind='query_status';continue}
   if(decision.action!=='retry')throw new ObservedToolFailure(error,outcome)
   const delay=Math.max(10,Math.min(250,10*2**Math.min(5,input.budget.attempts.length-1)),Number.isFinite(retryAfterMs)?Math.max(0,retryAfterMs):0)
   if(Date.now()+delay>=input.budget.deadline)throw new ObservedToolFailure(error,outcome)
   try{await emit('backoff',attemptId,{category,delayMs:delay});await sleep(delay,input.signal)}catch(e){throw new ObservedToolFailure(e,outcome)}
   kind='invoke';continue
  }finally{clearTimeout(timer);input.signal.removeEventListener('abort',cancel)}
  if(attemptKind==='query_status'){
   const receipt=value as ToolReceipt
   if(!receipt||!['succeeded','not_started','unknown'].includes(receipt.state))throw new ObservedToolFailure(new Error('Invalid execution receipt'),'unknown')
   if(receipt.state==='succeeded'&&!Object.prototype.hasOwnProperty.call(receipt,'result'))throw new ObservedToolFailure(new Error('Missing receipt result'),'unknown')
   outcome=receipt.state
   try{await emit('result',attemptId)}catch(error){throw new ObservedToolFailure(error,outcome)}
   if(receipt.state==='succeeded'){
    return receipt.result
   }
   if(receipt.state==='unknown')throw new ObservedToolFailure(last,'unknown')
   kind='invoke';continue
  }
  outcome='succeeded'
  try{await emit('result',attemptId)}catch(error){throw new ObservedToolFailure(error,'succeeded')}
  return value
 }
}
