import {it,expect} from 'vitest'
import {assessBoardDelivery} from '../src/tugo/deliveryGate.js'
const fixture=()=>({observation:{observation_id:'o',project_id:'p',session_id:'s',document_seq:1,content_hash:'a'.repeat(64),renderer_fingerprint:'build',verdict:'verified',checks:{geometry:'passed',render:'passed'},blocking_count:0,findings:[],verification_level:'geometry_and_dom',render:{status:'passed',target:'canvas_scene',coverage:'full_scene_dom_and_paint_order; pixels_not_verified',render_epoch:1,scene_token:'scene'}}})
it('accepts only scoped host evidence and never claims pixels or PPT',()=>{expect(assessBoardDelivery(fixture(),'p','o')).toMatchObject({passed:true,pixels:'not_checked',pptx:'not_checked'})})
for(const fault of ['missing','stale','blockers','target','id','scene','scope','hash','unknown','spoof'] as const)it(`rejects ${fault}`,()=>{
 const result=fixture(),e=result.observation
 if(fault==='missing')delete (result as Partial<typeof result>).observation
 if(fault==='stale')e.verdict='stale'
 if(fault==='blockers')e.blocking_count=1
 if(fault==='target')e.project_id='other'
 if(fault==='id')e.observation_id='other'
 if(fault==='scene')e.render.scene_token=''
 if(fault==='scope')e.render.coverage='partial'
 if(fault==='hash')e.content_hash=''
 if(fault==='unknown')e.checks.render='unknown'
 if(fault==='spoof')Object.assign(e,{verdict:'verified',checks:{geometry:'failed',render:'passed'}})
 expect(assessBoardDelivery(result,'p','o').passed).toBe(false)
})

it('looks up trusted current evidence instead of accepting saved/model verdicts and invalidates before re-observe',async()=>{
 const {TuGoRuntimeApplication}=await import('../src/tugo/runtimeApplication.js')
 const current=fixture();let reads=0
 const app=new TuGoRuntimeApplication({} as never,async()=>{reads++;return current})
 const checkpoint={projectId:'p',middlewareState:{boardObservation:{hasMutation:true,lastObservationId:'o',autoRounds:1},boardDeliveryGate:{passed:true}}} as import('../src/contracts.js').RunCheckpoint
 expect((await app.delivery(checkpoint,new AbortController().signal)).disclosure).toBe('');expect(reads).toBe(1)
 current.observation.verdict='stale'
 expect((await app.delivery(checkpoint,new AbortController().signal)).observation).toBeDefined()
 expect(app.deliveryEvidence(checkpoint)).toMatchObject({passed:false})
 current.observation.verdict='verified';current.observation.content_hash=''
 expect((await app.delivery(checkpoint,new AbortController().signal)).disclosure).toContain('未验收')
 expect(app.deliveryEvidence(checkpoint)).toMatchObject({passed:false})
})
