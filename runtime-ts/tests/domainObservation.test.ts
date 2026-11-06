import {describe,it,expect} from 'vitest'
import {DomainObservationRegistry,type DomainAdapter} from '../src/domainObservation.js'
import {queryFixture} from './fixtures/queryDomain.js'
import {observationVerdict} from '../src/observationProtocol.js'
const identity={workspaceId:'w',runId:'r',conversationId:'thread',sessionId:'s'}
const attempt={callId:'c',attemptId:'a',budget:{} as never,signal:new AbortController().signal,beginInternalAttempt:async()=>{}}
async function query(mode:'complete'|'page'|'partial'|'summary',knownTotal=true,representation='detail'){
 const fixture=queryFixture({mode,knownTotal}),registry=new DomainObservationRegistry([fixture.adapter]),tool=registry.resolve([])[0]
 return {fixture,result:await registry.execute(tool,{representation,offset:0,limit:5},identity,attempt)}
}
describe('trusted domain observation registration',()=>{
 it.each(['complete','page','partial'] as const)('represents %s without claiming unseen data passed',async mode=>{
  const {result,fixture}=await query(mode)
  expect(result.record.range).toMatchObject({kind:mode,returned:mode==='complete'?23:5,total:23})
  expect(result.data.rows).toEqual(mode==='complete'?fixture.rows:fixture.rows.slice(0,5))
  expect(observationVerdict(result.record)).toBe(mode==='complete'?'passed':'unverified')
  if(mode!=='complete')expect(result.detail?.args.offset).toBe(5)
 })
 it('returns a summary only when requested, discloses it and keeps a detail route',async()=>{
  const {result}=await query('page',true,'summary')
  expect(result.record.range.kind).toBe('summary');expect(result.detail?.args.representation).toBe('detail');expect(result.note).toContain('尚未交付明细');expect(observationVerdict(result.record)).toBe('unverified')
  await expect(query('summary')).rejects.toThrow('cannot be silently replaced')
 })
 it('does not invent totals for unknown-size sources',async()=>{
  const {result}=await query('partial',false)
  expect(result.record.range).not.toHaveProperty('total');expect(result.note).toContain('总数未知')
 })
 it('recovers all pages without rereporting them as one complete source query',async()=>{
  const fixture=queryFixture(),registry=new DomainObservationRegistry([fixture.adapter]),tool=registry.resolve([])[0],all:unknown[]=[]
  for(let offset=0;offset<23;offset+=5){const result=await registry.execute(tool,{representation:'detail',offset,limit:5},identity,{...attempt,callId:'c'+offset});all.push(...result.data.rows as unknown[]);expect(result.record.range.kind).toBe('page')}
  expect(all).toEqual(fixture.rows);expect(fixture.calls).toBe(5)
 })
 it('rejects duplicate registrations, name conflicts and forged definition objects',async()=>{
  const fixture=queryFixture();expect(()=>new DomainObservationRegistry([fixture.adapter,fixture.adapter])).toThrow('duplicate')
  const registry=new DomainObservationRegistry([fixture.adapter]),tool=registry.resolve([])[0]
  expect(()=>registry.resolve([tool])).toThrow('collision')
  await expect(registry.execute({...tool},{representation:'detail'},identity,attempt)).rejects.toThrow('unregistered tool identity')
 })
 it('does not invoke adapters after pre-cancellation',async()=>{
  const fixture=queryFixture(),registry=new DomainObservationRegistry([fixture.adapter]),tool=registry.resolve([])[0],controller=new AbortController();controller.abort()
  await expect(registry.execute(tool,{},identity,{...attempt,signal:controller.signal})).rejects.toThrow('Cancelled');expect(fixture.calls).toBe(0)
 })
 it('rejects non-JSON data instead of silently dropping fields during serialization',async()=>{
  const fixture=queryFixture(),base=fixture.adapter.tools[0].observe
  const bad:DomainAdapter={...fixture.adapter,tools:[{...fixture.adapter.tools[0],observe:async(args,context)=>{const r=await base(args,context);const rows=[1,,];Object.assign(rows,{hidden:'must not silently disappear'});r.data={rows};return r}}]}
  const registry=new DomainObservationRegistry([bad]),tool=registry.resolve([])[0]
  await expect(registry.execute(tool,{representation:'detail'},identity,attempt)).rejects.toThrow('non JSON result')
 })
 it('rejects mismatched scope or fabricated successful execution identity',async()=>{
  const fixture=queryFixture(),base=fixture.adapter.tools[0].observe
  const bad:DomainAdapter={...fixture.adapter,tools:[{...fixture.adapter.tools[0],observe:async(args,context)=>{const r=await base(args,context);r.record.scope.workspaceId='other';return r}}]}
  const registry=new DomainObservationRegistry([bad]),tool=registry.resolve([])[0]
  await expect(registry.execute(tool,{representation:'detail'},identity,attempt)).rejects.toThrow('identity mismatch')
 })
})
