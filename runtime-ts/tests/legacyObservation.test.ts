import {describe,it,expect} from 'vitest'
import {adaptLegacyObservation} from '../src/legacyObservation.js'
import {observationVerdict} from '../src/observationProtocol.js'
const ctx={id:'converted',scope:{applicationId:'tugo',workspaceId:'w',runId:'r'},target:{id:'board',revision:'r1',sessionId:'s'},createdAt:'2026-10-30T00:00:00Z'}
describe('legacy observation compatibility',()=>{
 it.each([{ok:true},{ok:true,observation:{verdict:'verified',checks:{render:'passed'}}},{visual_review:{status:'passed'}},null])('never promotes old success or self-authored reviews',old=>expect(observationVerdict(adaptLegacyObservation(old,ctx))).toBe('unverified'))
 it('preserves confirmed execution independent of actual rendering',()=>{
  const r=adaptLegacyObservation({ok:true,observation:{checks:{geometry:'passed',render:'unknown'}}},{...ctx,confirmedExecution:'succeeded'})
  expect(r.execution.state).toBe('succeeded');expect(r.validity).toBe('unknown');expect(r.checks.find(c=>c.name==='render')?.status).toBe('unknown')
 })
 it('keeps visible blockers and discloses omitted ones',()=>{
  const r=adaptLegacyObservation({observation:{blocking_count:20,warning_count:3,findings:[{id:'one',type:'edge_occluded',severity:'blocking',refs:['edge'],message:'hidden'}]}},ctx)
  expect(r.findings.some(f=>f.code==='edge_occluded')).toBe(true)
  expect(r.findings.some(f=>f.code==='legacy_findings_incomplete'&&f.message.includes('20'))).toBe(true)
  expect(r.range.kind).toBe('partial');expect(observationVerdict(r)).toBe('needs_action')
 })
 it('preserves explicit stale or not_checked and is detached',()=>{
  const old={observation:{verdict:'stale',checks:{render:'not_checked'},findings:[]}}
  const r=adaptLegacyObservation(old,ctx);expect(r.validity).toBe('stale');expect(observationVerdict(r)).toBe('stale')
  old.observation.checks.render='passed';expect(r.checks.find(c=>c.name==='render')?.status).toBe('not_checked')
 })
})
