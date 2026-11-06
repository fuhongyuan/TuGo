import {describe,it,expect} from 'vitest'
import {validateObservation,observationVerdict,type ObservationRecord} from '../src/observationProtocol.js'
const record=():ObservationRecord=>({schemaVersion:1,id:'obs',scope:{applicationId:'query',workspaceId:'workspace',runId:'run'},source:{component:'query',layer:'domain'},target:{id:'table',revision:'r1',sessionId:'session'},createdAt:'2026-10-30T00:00:00Z',execution:{state:'succeeded',callId:'call'},validity:'current',range:{kind:'complete',returned:2,total:2},checks:[{name:'integrity',status:'passed',coverage:'rows'}],findings:[],treatments:[],references:[]})
describe('versioned observation protocol',()=>{
 it('round trips plain JSON without depending on DOM or Node',()=>expect(validateObservation(JSON.parse(JSON.stringify(record())))).toEqual(record()))
 it('separates saved facts from unknown rendering',()=>{const r=record();r.checks.push({name:'render',status:'unknown',coverage:'none'});expect(validateObservation(r).execution.state).toBe('succeeded');expect(observationVerdict(r)).toBe('unverified')})
 it('never promotes unknown execution, unchecked coverage, stale or partial results to passed',()=>{
  for(const patch of [{execution:{state:'unknown',callId:'call'}},{checks:[]},{checks:[{name:'render',status:'not_checked',coverage:'none'}]},{validity:'stale'},{range:{kind:'partial',returned:1,total:2}}])expect(observationVerdict(validateObservation({...record(),...patch}))).not.toBe('passed')
 })
 it('blocking evidence overrides passed checks',()=>{const r=record();r.findings=[{id:'f',code:'collision',severity:'blocking',message:'collision',refs:['n'],owner:'domain'}];expect(observationVerdict(validateObservation(r))).toBe('needs_action')})
 it.each([['version',{schemaVersion:2}],['date',{createdAt:'yesterday'}],['range',{range:{kind:'complete',returned:3,total:2}}],['complete range',{range:{kind:'complete',returned:1,total:2}}],['identity',{id:''}],['check',{checks:[{name:'x',status:'invented',coverage:'all'}]}],['unknown field',{passed:true}],['treatment',{treatments:[{id:'fix',kind:'repair',state:'rejected',persisted:true,refs:[],message:'not applied'}]}]])('rejects invalid %s',(_name,patch)=>expect(()=>validateObservation({...record(),...patch})).toThrow())
 it('validates declared finding totals and does not lose hidden blockers',()=>{
  const r=record();r.findingTotals={blocking:20,warning:4,total:24}
  expect(observationVerdict(validateObservation(r))).toBe('needs_action')
  expect(()=>validateObservation({...r,findingTotals:{blocking:20,warning:4,total:1}})).toThrow()
 })
 it('rejects non-JSON values instead of silently losing evidence',()=>{const r=record() as unknown as Record<string,unknown>;r.references=[undefined];expect(()=>validateObservation(r)).toThrow();r.references=[];r.extra=()=>{};expect(()=>validateObservation(r)).toThrow()})
})
