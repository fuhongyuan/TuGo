import type {BoardDocument} from '../../src/types'
import {createBoardObserver} from '../../src/lib/boardObservationDomain'
import {liveBoardRenderPort,registerRenderProbe} from '../../src/lib/boardRenderProbe'
/** Actual Chromium DOM fixture. No image export substituted for observation. */
export async function observationPerformance(document:BoardDocument,iterations=30) {
 const root=globalThis.document.querySelector<HTMLElement>('.canvas-root')!
 const hostTimes:number[]=[]
 const service=createBoardObserver({...liveBoardRenderPort,measure:async(...args)=>{const start=performance.now();try{return await liveBoardRenderPort.measure(...args)}finally{hostTimes.push(performance.now()-start)}}}),projectId='performance-fixture'
 let pending=false
 const dispose=registerRenderProbe(projectId,()=>({document,root,pending,epoch:1}))
 const observe=(waitMs=1200,signal?:AbortSignal)=>service.observeBoard({projectId,document,waitMs,signal})
 const samples:number[]=[],bytes:number[]=[],heap:number[]=[]
 const nodesBefore=root.querySelectorAll('*').length
 try{
  for(let i=0;i<iterations+5;i++){
   const start=performance.now(),result=await observe()
   if(result.checks.render!=='passed')throw new Error('Performance fixture did not pass DOM: '+JSON.stringify(result.render))
   if(i>=5){samples.push(performance.now()-start);bytes.push(new TextEncoder().encode(JSON.stringify(result)).length);const memory=(performance as Performance & {memory?:{usedJSHeapSize:number}}).memory;if(memory)heap.push(memory.usedJSHeapSize)}
  }
  const stableController=new AbortController(),stableStart=performance.now()
  const stableCancelled=observe(2500,stableController.signal),stableTimer=setTimeout(()=>stableController.abort(),25)
  try{await stableCancelled;throw new Error('Stable scene cancellation ignored')}catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))throw error}finally{clearTimeout(stableTimer)}
  const stableCancelMs=performance.now()-stableStart
  if(stableCancelMs>2000)throw new Error(`Stable scene cancellation exceeded unchanged guard: ${stableCancelMs}`)
  pending=true
  let start=performance.now();const timeout=await observe(100);const unstableMs=performance.now()-start
  if(timeout.checks.render==='passed')throw new Error('Unstable scene passed')
  const controller=new AbortController();start=performance.now()
  const cancelled=observe(2500,controller.signal);const timer=setTimeout(()=>controller.abort(),25)
  try{await cancelled;throw new Error('Cancellation ignored')}catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))throw error}finally{clearTimeout(timer)}
  const cancelMs=performance.now()-start
  if(unstableMs>2000||cancelMs>2000)throw new Error(`Fixture wait/cancel exceeded bounded guard: ${unstableMs}/${cancelMs}`)
  samples.sort((a,b)=>a-b)
  return {scenario:'46-node-live-dom-observation',warmup:5,iterations,p50_ms:samples[Math.ceil(iterations*.5)-1],p95_ms:samples[Math.ceil(iterations*.95)-1],max_ms:samples.at(-1),host_measure_ms:hostTimes,output_bytes_min:Math.min(...bytes),output_bytes_max:Math.max(...bytes),sampled_js_heap_max_bytes:heap.length?Math.max(...heap):null,nodes_before:nodesBefore,nodes_after:root.querySelectorAll('*').length,unstable_status:timeout.checks.render,unstable_wait_requested_ms:100,unstable_elapsed_ms:unstableMs,cancel_requested_after_ms:25,cancel_elapsed_ms:cancelMs,stable_cancel_elapsed_ms:stableCancelMs,guard_ms:2000,coverage:'actual DOM; not pixel/Office; includes synchronous geometry; Chromium JS heap is not process RSS'}
 }finally{dispose()}
}
