import {it,expect} from 'vitest'
import {TuGoRuntimeApplication} from '../src/tugo/runtimeApplication.js'
import {createBoardObserver} from '../../src/lib/boardObservationDomain'
import {emptyDocument} from '../../src/types'
import type {RunCheckpoint} from '../src/contracts.js'
it('shares domain sampling and application budget between automatic and model paths',async()=>{
 let samples=0,release!:()=>void
 const observer=createBoardObserver({fingerprint:'test-host',current:()=>undefined,measure:async()=>{samples++;await new Promise<void>(r=>release=r);return {status:'unknown',target:'canvas_scene',coverage:'test',findings:[],measured_elements:0,measured_edges:0,render_epoch:0,pixel_verification:'not_checked'}}})
 const doc=emptyDocument(),checkpoint={projectId:'p',middlewareState:{}} as RunCheckpoint
 const inspect=async()=>({observation:await observer.observeBoard({projectId:'p',document:doc})})
 const application=new TuGoRuntimeApplication({} as never,inspect)
 application.startRun(checkpoint,'completed')
 const automatic=application.observe(checkpoint,new AbortController().signal,'auto')
 const model=inspect().then(result=>{application.recordResult(checkpoint,{id:'model',name:'board_observe',arguments:{}},result);return result})
 await new Promise(r=>setTimeout(r,0));expect(samples).toBe(1);release();const [a,b]=await Promise.all([automatic,model]);expect(a.observation).toEqual(b.observation)
 expect(checkpoint.middlewareState).toMatchObject({boardObservation:{autoRounds:1}})
})
