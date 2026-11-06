import {it,expect} from 'vitest'
import {TuGoRuntimeApplication} from '../src/tugo/runtimeApplication.js'
import type {RunCheckpoint} from '../src/contracts.js'
it('feeds blockers back at most twice then discloses unresolved state',async()=>{
 const result={observation:{observation_id:'evidence',verdict:'needs_decision',blocking_count:1,checks:{render:'failed'},findings:[{type:'edge_occluded',refs:['edge','node']}]}}
 const app=new TuGoRuntimeApplication({} as never,async()=>result)
 const c={projectId:'p',middlewareState:{boardObservation:{hasMutation:true,lastObservationId:'evidence',autoRounds:1}}} as RunCheckpoint
 const signal=new AbortController().signal
 expect((await app.delivery(c,signal)).feedback).toContain('edge_occluded')
 expect((await app.delivery(c,signal)).feedback).toContain('不要重放')
 const stopped=await app.delivery(c,signal);expect(stopped.feedback).toBeUndefined();expect(stopped.disclosure).toContain('未解决')
})
it('does not spend another feedback round on unknown rendering or exhausted observation budget',async()=>{
 for(const observation of [{verdict:'partially_verified',blocking_count:0},{verdict:'needs_decision',blocking_count:1}]){
  const app=new TuGoRuntimeApplication({} as never,async()=>({observation:{observation_id:'e',...observation}}))
  const c={projectId:'p',middlewareState:{boardObservation:{hasMutation:true,lastObservationId:'e',autoRounds:3}}} as RunCheckpoint
  expect((await app.delivery(c,new AbortController().signal)).feedback).toBeUndefined()
 }
})
const result=(id:string,value=1,extra:Record<string,unknown>={})=>({observation:{observation_id:id,verdict:'needs_decision',checks:{render:'failed'},blocking_count:1,findings:[{type:'label_over_text',refs:['e','n'],severity:'blocking',message:'标签挡住标题',measure:{kind:'overlap_fraction',value}}],...extra}})
const write=(app:TuGoRuntimeApplication,c:RunCheckpoint,id:string,target='n')=>app.recordResult(c,{id,name:'board_patch_element',arguments:{operation:{op:'patch_element',id:target,patch:{x:100}}}},{ok:true})
it('concludes partially only after two relevant unsuccessful repair attempts, never observation reads alone',()=>{
 const app=new TuGoRuntimeApplication({} as never,async()=>({})),c={projectId:'p',middlewareState:{}} as RunCheckpoint
 app.startRun(c,'completed');app.recordResult(c,{id:'a',name:'board_observe',arguments:{}},result('a'))
 for(const id of ['read-1','read-2'])app.recordResult(c,{id,name:'board_observe',arguments:{}},result(id))
 expect(app.conclusion(c)).toBeUndefined()
 write(app,c,'w1');app.recordResult(c,{id:'b',name:'board_observe',arguments:{}},result('b'))
 expect(app.conclusion(c)).toBeUndefined()
 app.recordResult(c,{id:'read',name:'board_get_observation',arguments:{}},result('b'))
 expect(app.conclusion(c)).toBeUndefined()
 write(app,c,'unrelated','other');app.recordResult(c,{id:'unrelated-check',name:'board_observe',arguments:{}},result('unrelated-check'))
 expect(app.conclusion(c)).toBeUndefined()
 write(app,c,'w2');app.recordResult(c,{id:'c',name:'board_observe',arguments:{}},result('c'))
 expect(app.stopReason(c)).toBeUndefined();expect(app.conclusion(c)).toMatchObject({code:'QUALITY_REPAIR_STALLED'})
 expect(app.deliveryEvidence(c)).toMatchObject({passed:false,reasons:['repair_stalled']})
 app.startRun(c,'completed');expect(app.conclusion(c)).toBeUndefined();expect(c.middlewareState?.boardObservation).toMatchObject({hasMutation:true})
})
it('recognizes reduced overlap as progress even with identical issue IDs and count',()=>{
 const app=new TuGoRuntimeApplication({} as never,async()=>({})),c={middlewareState:{}} as RunCheckpoint
 app.startRun(c,'completed');app.recordResult(c,{id:'a',name:'board_observe',arguments:{}},result('a',.9))
 for(const [id,value] of [['b',.6],['c',.2]] as const){write(app,c,'w'+id);app.recordResult(c,{id,name:'board_observe',arguments:{}},result(id,value))}
 expect(app.conclusion(c)).toBeUndefined();expect(c.middlewareState?.boardObservation).toMatchObject({noProgress:0})
})
it('does not infer no progress from IDs when metrics, stable rendering or complete findings are missing',()=>{
 for(const extra of [{verdict:'stale'},{checks:{render:'unknown'}},{blocking_count:2},{findings:[{type:'node_overlap',refs:['e','n'],severity:'blocking'}]}]){
  const app=new TuGoRuntimeApplication({} as never,async()=>({})),c={middlewareState:{}} as RunCheckpoint
  app.startRun(c,'completed')
  for(const id of ['a','b','c']){write(app,c,'w'+id);app.recordResult(c,{id,name:'board_observe',arguments:{}},result(id,.9,extra))}
  expect(app.conclusion(c)).toBeUndefined()
 }
})

it('does not count rejected mutations as repair attempts',()=>{
 const app=new TuGoRuntimeApplication({} as never,async()=>({})),c={middlewareState:{}} as RunCheckpoint
 app.startRun(c,'completed');app.recordResult(c,{id:'initial',name:'board_observe',arguments:{}},result('initial'))
 for(const id of ['a','b','c']){
  app.recordResult(c,{id:'w'+id,name:'board_patch_element',arguments:{operation:{id:'n'}}},{ok:false})
  app.recordResult(c,{id,name:'board_observe',arguments:{}},result(id))
 }
 expect(app.conclusion(c)).toBeUndefined()
})
