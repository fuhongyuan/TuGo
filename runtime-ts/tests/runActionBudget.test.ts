import {it,expect} from 'vitest'
import {reserveRunAction,type RunActionBudget} from '../src/runActionBudget.js'
const budget=():RunActionBudget=>({runId:'r',limit:3,deadline:1000,used:0,byLayer:{}})
it('shares a single ceiling across observation, projection and tool recovery',()=>{
 const b=budget();for(const layer of ['observation','context_projection','tool_attempt'])reserveRunAction(b,layer,1)
 expect(b.used).toBe(3);expect(()=>reserveRunAction(b,'observation_feedback',2)).toThrow('预算耗尽');expect(b.used).toBe(3)
})
it('restores counts and deadline from serialized state without resetting limits',()=>{
 const b=budget();reserveRunAction(b,'tool_attempt',1);const restored=JSON.parse(JSON.stringify(b));reserveRunAction(restored,'tool_attempt',2);expect(restored.used).toBe(2);expect(()=>reserveRunAction(restored,'observation',1000)).toThrow('预算耗尽')
})
it('rejects cancelled actions before consuming capacity',()=>{
 const c=new AbortController();c.abort();const b=budget();expect(()=>reserveRunAction(b,'tool_attempt',1,c.signal)).toThrow('Cancelled');expect(b.used).toBe(0)
})
it('counts nested attempts through the executor durable boundary',async()=>{
 const {executeObservedTool}=await import('../src/toolExecutor.js'),{createRecoveryBudget}=await import('../src/recoveryPolicy.js')
 const b=budget();b.limit=2;b.deadline=Date.now()+10000;let nested=0
 await expect(executeObservedTool({callId:'call',contract:{origin:'platform',effect:'read',idempotency:'none',statusQuery:false},budget:createRecoveryBudget({id:'recovery',owner:'executor',maxAttempts:5,timeoutMs:10000,now:Date.now()}),signal:new AbortController().signal,record:async event=>{if(event.phase==='before')reserveRunAction(b,event.kind,Date.now())},invoke:async context=>{await context.beginInternalAttempt('inner1');nested++;await context.beginInternalAttempt('inner2');nested++;return 1}})).rejects.toThrow('预算耗尽')
 expect(b.used).toBe(2);expect(nested).toBe(1)
})

it('denies receipt lookup when the shared ceiling is exhausted without replaying the write',async()=>{
 const {executeObservedTool,ExecutionFault}=await import('../src/toolExecutor.js'),{createRecoveryBudget}=await import('../src/recoveryPolicy.js')
 const b=budget();b.limit=1;b.deadline=Date.now()+10000;let writes=0,queries=0
 await expect(executeObservedTool({callId:'w',contract:{origin:'platform',effect:'write',idempotency:'none',statusQuery:true},budget:createRecoveryBudget({id:'r',owner:'executor',maxAttempts:5,timeoutMs:10000,now:Date.now()}),signal:new AbortController().signal,record:async event=>{if(event.phase==='before')reserveRunAction(b,event.kind,Date.now())},invoke:async()=>{writes++;throw new ExecutionFault('transient','unknown')},queryStatus:async()=>{queries++;return {state:'unknown'}}})).rejects.toThrow('预算耗尽')
 expect(writes).toBe(1);expect(queries).toBe(0)
})
