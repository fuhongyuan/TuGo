import {describe,it,expect} from 'vitest'
import {createRecoveryBudget,consumeRecoveryBudget,decideRecovery,type ExecutionContract} from '../src/recoveryPolicy.js'
const verified:ExecutionContract={origin:'platform',effect:'write',idempotency:'none',statusQuery:true}
const budget=()=>createRecoveryBudget({id:'b',owner:'executor',maxAttempts:3,timeoutMs:1000,now:100})
const decide=(contract:ExecutionContract=verified,outcome:'unknown'|'not_started'|'failed'|'succeeded'='unknown',category='transient')=>decideRecovery({contract,outcome,category,budget:budget(),now:200})
describe('recovery ownership and shared budget contract',()=>{
 it('queries unknown writes before replay',()=>expect(decide().action).toBe('query_status'))
 it('never retries an unknown unsafe write without status query',()=>expect(decide({...verified,statusQuery:false}).action).toBe('escalate'))
 it('does not trust MCP hints as read-only/idempotency guarantees',()=>expect(decide({origin:'untrusted',effect:'read',idempotency:'guaranteed',statusQuery:true,idempotentUntil:9999}).action).toBe('escalate'))
 it('permits safe reads and bounded idempotent writes',()=>{
  expect(decide({...verified,effect:'read'}).action).toBe('retry')
  expect(decide({...verified,statusQuery:false,idempotency:'guaranteed',idempotentUntil:1000}).action).toBe('retry')
  expect(decide({...verified,statusQuery:false,idempotency:'guaranteed',idempotentUntil:150}).action).toBe('escalate')
 })
 it.each(['authentication','permission','validation','unknown'])('does not retry %s',c=>expect(decide({...verified,effect:'read'},'failed',c).action).toBe('escalate'))
 it('confirmed no execution can safely retry transient failure',()=>expect(decide(verified,'not_started').action).toBe('retry'))
 it('never retries already succeeded calls',()=>expect(decide(verified,'succeeded').action).toBe('done'))
 it('charges one budget across layers and rejects another owner or duplicate attempts',()=>{
  const b=budget()
  expect(()=>consumeRecoveryBudget(b,{owner:'tool-internal',attemptId:'one',now:200})).toThrow()
  consumeRecoveryBudget(b,{owner:'executor',attemptId:'one',now:200})
  expect(()=>consumeRecoveryBudget(b,{owner:'executor',attemptId:'one',now:200})).toThrow()
  const resumed=JSON.parse(JSON.stringify(b))
  consumeRecoveryBudget(resumed,{owner:'executor',attemptId:'two',now:210})
  consumeRecoveryBudget(resumed,{owner:'executor',attemptId:'three',now:220})
  expect(decideRecovery({contract:{...verified,effect:'read'},outcome:'unknown',category:'transient',budget:resumed,now:230}).action).toBe('escalate')
 })
 it('deadline and cancellation preclude further attempts',()=>{
  const b=budget(),controller=new AbortController();controller.abort()
  expect(()=>consumeRecoveryBudget(b,{owner:'executor',attemptId:'x',now:200,signal:controller.signal})).toThrow()
  expect(b.attempts).toHaveLength(0)
  expect(()=>consumeRecoveryBudget(b,{owner:'executor',attemptId:'x',now:1100})).toThrow()
 })
 it.each([0,-1,NaN,Infinity,1.5])('rejects invalid attempt limit %s',max=>expect(()=>createRecoveryBudget({id:'b',owner:'o',maxAttempts:max,timeoutMs:100,now:0})).toThrow())
})
