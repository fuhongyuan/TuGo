import {describe,it,expect} from 'vitest'
import {ObservationScheduler,observationTrigger,type ObservationTarget} from '../src/observationScheduler.js'
const target:ObservationTarget={application:'test',workspace:'w',session:'s',target:'object',revision:'1',scope:['geometry','render'],mode:'readonly'}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
describe('observation scheduling primitives',()=>{
 it('coalesces concurrent equivalents and reserves budget only once, never caching completed evidence',async()=>{
  const scheduler=new ObservationScheduler<{count:number}>();let calls=0,release!:()=>void
  const execute=async()=>{calls++;await new Promise<void>(r=>release=r);return {count:calls}}
  const a=scheduler.request(target,execute),b=scheduler.request({...target,scope:['render','geometry','render']},execute)
  await tick();expect(calls).toBe(1);release();const [x,y]=await Promise.all([a,b]);expect(x).toEqual(y);expect(x).not.toBe(y)
  await scheduler.request(target,async()=>({count:++calls}));expect(calls).toBe(2)
 })
 for(const field of ['application','workspace','session','target','revision','scope','mode'] as const)it(`keeps different ${field} separate`,async()=>{
  const scheduler=new ObservationScheduler<number>();let calls=0
  await Promise.all([scheduler.request(target,async()=>++calls),scheduler.request({...target,[field]:field==='scope'?['geometry']:'different'},async()=>++calls)])
  expect(calls).toBe(2)
 })
 it('does not cancel shared work while another consumer remains',async()=>{
  const scheduler=new ObservationScheduler<number>(),controller=new AbortController();let hostSignal!:AbortSignal,release!:()=>void
  const a=scheduler.request(target,async signal=>{hostSignal=signal;await new Promise<void>(r=>release=r);return 42},controller.signal)
  const rejected=expect(a).rejects.toThrow('Cancelled'),b=scheduler.request(target,async()=>0)
  await tick();controller.abort();await rejected;expect(hostSignal.aborted).toBe(false);release();expect(await b).toBe(42)
 })
 it('aborts orphaned work and never starts a pre-cancelled request',async()=>{
  const scheduler=new ObservationScheduler<number>(),controller=new AbortController();controller.abort();let calls=0
  await expect(scheduler.request(target,async()=>++calls,controller.signal)).rejects.toThrow('Cancelled');expect(calls).toBe(0)
  const c=new AbortController();const p=scheduler.request(target,async()=>++calls,c.signal),rejected=expect(p).rejects.toThrow('Cancelled');c.abort();await rejected;await tick();expect(calls).toBe(0)
  expect(await scheduler.request(target,async()=>++calls)).toBe(1)
 })
 it('cleans up rejected tasks so a later explicit request can run',async()=>{
  const scheduler=new ObservationScheduler<number>();await expect(scheduler.request(target,async()=>{throw new Error('unavailable')})).rejects.toThrow('unavailable');expect(await scheduler.request(target,async()=>1)).toBe(1)
 })
 it('selects deterministic lifecycle/change/risk triggers with a hard budget',()=>{
  const base={dirty:true,changes:1,risk:false,delivery:false,unavailable:false,rounds:0,maxRounds:3,changeThreshold:3}
  expect(observationTrigger(base)).toBeUndefined();expect(observationTrigger({...base,changes:3})).toBe('changes');expect(observationTrigger({...base,risk:true})).toBe('risk');expect(observationTrigger({...base,delivery:true})).toBe('delivery');expect(observationTrigger({...base,risk:true,rounds:3})).toBeUndefined();expect(observationTrigger({...base,delivery:true,unavailable:true})).toBeUndefined()
 })
})
