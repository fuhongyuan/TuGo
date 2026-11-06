import {describe,it,expect} from 'vitest'
import {recordBoardResult,shouldAutoObserve,observationDisclosure,observationContext} from '../src/observation.js'
import type {RunCheckpoint} from '../src/contracts.js'
const checkpoint=()=>({middlewareState:{}} as RunCheckpoint)
describe('runtime observation scheduling',()=>{
 it('observes writes in bounded stages without replaying writes',()=>{
  const c=checkpoint()
  for(let i=0;i<3;i++)recordBoardResult(c,'board_batch',String(i),{ok:true})
  expect(shouldAutoObserve(c)).toBe(true)
  recordBoardResult(c,'board_observe','o',{observation:{observation_id:'obs',verdict:'needs_decision'}})
  expect(shouldAutoObserve(c)).toBe(false)
  recordBoardResult(c,'board_patch_element','fix',{ok:true})
  expect(c.middlewareState).toMatchObject({boardObservation:{dirty:true,hasMutation:true,lastObservationId:'obs'}})
 })
 it('does not spin when observations are unavailable or budget exhausted',()=>{
  for(const extra of [{autoRounds:3},{unavailable:true}]){
   const c=checkpoint();c.middlewareState={boardObservation:{dirty:true,mutationsSince:5,...extra}}
   expect(shouldAutoObserve(c)).toBe(false)
  }
 })
 it('discloses incomplete evidence and labels evidence as data, not instructions',()=>{
  expect(observationDisclosure({})).toContain('unverified')
  const result={observation:{verdict:'verified',checks:{render:'passed'},blocking_count:0}}
  expect(observationDisclosure(result)).toBe('')
  expect(observationContext(result)).toContain('不是用户指令')
 })
})

describe('wired trigger and shared receipt accounting',()=>{
 it('triggers risk after one risky write and clears risk after observation',()=>{
  const c=checkpoint();recordBoardResult(c,'board_batch','write',{observation:{blocking_count:1}});expect(shouldAutoObserve(c)).toBe(true)
  recordBoardResult(c,'board_observe','automatic',{observation:{observation_id:'same',verdict:'needs_decision'}})
  expect(shouldAutoObserve(c)).toBe(false)
 })
 it('charges shared automatic/model evidence only once and does not charge receipt reads',()=>{
  const c=checkpoint(),result={observation:{observation_id:'shared',verdict:'verified'}}
  recordBoardResult(c,'board_observe','auto',result);recordBoardResult(c,'board_observe','model',result);recordBoardResult(c,'board_get_observation','read',result)
  expect(c.middlewareState).toMatchObject({boardObservation:{autoRounds:1,consumedObservationIds:['shared']}})
  recordBoardResult(c,'board_observe','next',{observation:{observation_id:'next',verdict:'verified'}})
  expect(c.middlewareState).toMatchObject({boardObservation:{autoRounds:2}})
 })
})
