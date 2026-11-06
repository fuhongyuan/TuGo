import {describe,it,expect,vi} from 'vitest'
import {executeObservedTool,ExecutionFault,ObservedToolFailure,type ExecutionEvent} from '../src/toolExecutor.js'
import {createRecoveryBudget,consumeRecoveryBudget,type ExecutionContract} from '../src/recoveryPolicy.js'
const read:ExecutionContract={origin:'platform',effect:'read',idempotency:'none',statusQuery:false}
const write:ExecutionContract={origin:'platform',effect:'write',idempotency:'none',statusQuery:true}
const setup=(contract:ExecutionContract|undefined=read)=>{
 const events:ExecutionEvent[]=[]
 return {events,input:{callId:'c',contract,budget:createRecoveryBudget({id:'b',owner:'executor',maxAttempts:3,timeoutMs:1000,now:Date.now()}),signal:new AbortController().signal,record:async(e:ExecutionEvent)=>{events.push(e)}}}
}
describe('observed execution controller',()=>{
 it('persists budget before invoking and shares it with the internal adapter',async()=>{
  const {events,input}=setup();let calls=0
  const result=await executeObservedTool({...input,invoke:async context=>{expect(events.at(-1)?.phase).toBe('before');expect(context.budget).toBe(input.budget);calls++;if(calls===1)throw new ExecutionFault('rate_limit','not_started',20);return 'ok'}})
  expect(result).toBe('ok');expect(calls).toBe(2);expect(events.find(e=>e.phase==='backoff')?.delayMs).toBeGreaterThanOrEqual(20)
 })
 it.each(['authentication','permission','validation','unknown'])('does not retry %s failures',async category=>{
  const {input}=setup(),invoke=vi.fn(async()=>{throw new ExecutionFault(category,'not_started')})
  await expect(executeObservedTool({...input,invoke})).rejects.toBeInstanceOf(ObservedToolFailure);expect(invoke).toHaveBeenCalledTimes(1)
 })
 it('does not replay a committed write when the response is lost',async()=>{
  const {input}=setup(write);let writes=0
  const value=await executeObservedTool({...input,invoke:async()=>{writes++;throw new ExecutionFault('transient','unknown')},queryStatus:async()=>({state:'succeeded',result:{saved:true}})})
  expect(value).toEqual({saved:true});expect(writes).toBe(1);expect(input.budget.attempts).toHaveLength(2)
 })
 it('only retries a write after a receipt confirms no execution',async()=>{
  const {input}=setup(write);let calls=0
  const result=await executeObservedTool({...input,invoke:async()=>{if(++calls===1)throw new ExecutionFault('transient','unknown');return 'saved'},queryStatus:async()=>({state:'not_started'})})
  expect(result).toBe('saved');expect(input.budget.attempts).toHaveLength(3)
 })
 it('escalates unknown writes without a status guarantee',async()=>{
  const {input}=setup({...write,statusQuery:false}),invoke=vi.fn(async()=>{throw new ExecutionFault('transient','unknown')})
  await expect(executeObservedTool({...input,invoke})).rejects.toMatchObject({outcome:'unknown'});expect(invoke).toHaveBeenCalledTimes(1)
 })
 it('does not trust annotation-only contracts',async()=>{
  const {input}=setup({...read,origin:'untrusted'}),invoke=vi.fn(async()=>{throw new ExecutionFault('transient','unknown')})
  await expect(executeObservedTool({...input,invoke})).rejects.toMatchObject({outcome:'unknown'});expect(invoke).toHaveBeenCalledTimes(1)
 })
 it('charges internal attempts against the same budget',async()=>{
  const {input}=setup(),invoke=vi.fn(async c=>{await c.beginInternalAttempt('internal-1');await c.beginInternalAttempt('internal-2');throw new ExecutionFault('transient','unknown')})
  await expect(executeObservedTool({...input,invoke})).rejects.toMatchObject({outcome:'unknown'});expect(invoke).toHaveBeenCalledTimes(1)
 })
 it('refuses invocation if a shared internal attempt cannot be persisted',async()=>{
  const {input}=setup();let innerEffects=0
  await expect(executeObservedTool({...input,record:async event=>{if(event.attemptId==='inner')throw new Error('disk full')},invoke:async c=>{await c.beginInternalAttempt('inner');innerEffects++;return true}})).rejects.toBeInstanceOf(ObservedToolFailure)
  expect(innerEffects).toBe(0)
 })
 it('does not manufacture a successful write result from an invalid receipt',async()=>{
  const {input}=setup(write)
  await expect(executeObservedTool({...input,invoke:async()=>{throw new ExecutionFault('transient','unknown')},queryStatus:async()=>({state:'succeeded'}) as never})).rejects.toMatchObject({outcome:'unknown'})
 })
 it('does not call a classifier failure an execution failure with known absence of effects',async()=>{
  const {input}=setup({...write,statusQuery:false})
  await expect(executeObservedTool({...input,invoke:async()=>{throw new Error('lost')},classify:()=>{throw new Error('bad classifier')}})).rejects.toMatchObject({outcome:'unknown'})
 })
 it('preserves confirmed success when result logging fails',async()=>{
  const {input}=setup()
  await expect(executeObservedTool({...input,invoke:async()=>({saved:true}),record:async e=>{if(e.phase==='result')throw new Error('disk full')}})).rejects.toMatchObject({outcome:'succeeded'})
 })
 it('does not dispatch when cancelled while the precondition is being persisted',async()=>{
  const {input}=setup(),controller=new AbortController(),invoke=vi.fn(async()=>true)
  await expect(executeObservedTool({...input,signal:controller.signal,record:async()=>{controller.abort()},invoke})).rejects.toMatchObject({outcome:'not_started'})
  expect(invoke).not.toHaveBeenCalled()
 })
 it('does not dispatch after persistence has consumed the remaining deadline',async()=>{
  const {input}=setup();input.budget.deadline=Date.now()+10
  const invoke=vi.fn(async()=>true)
  await expect(executeObservedTool({...input,invoke,record:async()=>{await new Promise(r=>setTimeout(r,20))}})).rejects.toMatchObject({outcome:'not_started'})
  expect(invoke).not.toHaveBeenCalled()
 })
 it('does not invoke after an aborted signal or failed durable precondition',async()=>{
  const {input}=setup(),invoke=vi.fn(async()=>true),controller=new AbortController();controller.abort()
  await expect(executeObservedTool({...input,signal:controller.signal,invoke})).rejects.toMatchObject({outcome:'not_started'});expect(invoke).not.toHaveBeenCalled()
  await expect(executeObservedTool({...input,record:async()=>{throw new Error('disk full')},invoke})).rejects.toMatchObject({outcome:'not_started'});expect(invoke).not.toHaveBeenCalled()
 })
 it('cancels backoff without starting another attempt',async()=>{
  const {input}=setup(),controller=new AbortController(),invoke=vi.fn(async()=>{setTimeout(()=>controller.abort(),5);throw new ExecutionFault('rate_limit','not_started',500)})
  await expect(executeObservedTool({...input,signal:controller.signal,invoke})).rejects.toMatchObject({outcome:'not_started'});expect(invoke).toHaveBeenCalledTimes(1)
 })
 it('times out ignored cancellation and records late completion without applying it again',async()=>{
  const {input,events}=setup({...write,statusQuery:false});input.budget.deadline=Date.now()+20
  let effects=0
  await expect(executeObservedTool({...input,invoke:async()=>{await new Promise(r=>setTimeout(r,60));effects++;return 'late'}})).rejects.toMatchObject({outcome:'unknown'})
  await new Promise(r=>setTimeout(r,80));expect(effects).toBe(1);expect(events.some(e=>e.phase==='late_result'&&e.outcome==='succeeded')).toBe(true)
 })
 it('never blindly replays a budget recovered after interruption',async()=>{
  const {input}=setup({...write,statusQuery:false});consumeRecoveryBudget(input.budget,{owner:'executor',attemptId:'previous',now:Date.now()})
  const invoke=vi.fn(async()=>true)
  await expect(executeObservedTool({...input,invoke})).rejects.toMatchObject({outcome:'unknown'});expect(invoke).not.toHaveBeenCalled()
 })
})
