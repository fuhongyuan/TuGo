/** Native Chromium tests; no synthetic DOM implementation. */
import type {BoardDocument} from '../../src/types'
import {registerRenderProbe} from '../../src/lib/boardRenderProbe'
import {createBoardObserver} from '../../src/lib/boardObservationDomain'
import {liveBoardRenderPort} from '../../src/lib/boardRenderProbe'
export async function observationStability(document:BoardDocument) {
 const root=globalThis.document.querySelector<HTMLElement>('.canvas-root')!
 if(!root)throw new Error('Missing actual InfiniteCanvas root')
 const observer=createBoardObserver(liveBoardRenderPort),projectId='stability-fixture'
 let pending=false,epoch=1,current=structuredClone(document)
 const read=()=>({root,document:current,pending,epoch})
 let dispose=registerRenderProbe(projectId,read)
 const observe=(waitMs=300,signal?:AbortSignal)=>observer.observeBoard({projectId,document:current,current:()=>current,waitMs,signal})
 const result:Record<string,unknown>={}
 const assert=(ok:unknown,message:string)=>{if(!ok)throw new Error(message)}
 try {
  const baseline=await observe();assert(baseline.checks.render==='passed',JSON.stringify(baseline.render));result.baseline=baseline.verdict
  pending=true;result.playback=(await observe(0)).checks.render
  assert(result.playback==='unknown','playback must not pass');assert(observer.getObservation(baseline.observation_id,projectId,current).verdict==='stale','pending invalidates old proof');pending=false
  const fonts=globalThis.document.fonts,descriptor=Object.getOwnPropertyDescriptor(fonts,'status')
  try{Object.defineProperty(fonts,'status',{configurable:true,value:'loading'});result.fonts=(await observe(0)).checks.render;assert(result.fonts==='unknown','fonts must not pass');assert(observer.getObservation(baseline.observation_id,projectId,current).verdict==='stale','fonts invalidate old proof')}
  finally{if(descriptor)Object.defineProperty(fonts,'status',descriptor);else delete (fonts as unknown as {status?:string}).status}
  const fresh=await observe();dispose();result.unmounted=(await observe(0)).checks.render;assert(result.unmounted==='unknown','unmounted must not pass')
  dispose=registerRenderProbe(projectId,read);result.remounted=observer.getObservation(fresh.observation_id,projectId,current).verdict;assert(result.remounted==='stale','same epoch remount must not reuse proof')
  const fontABA=await observe();fonts.dispatchEvent(new Event('loading'));fonts.dispatchEvent(new Event('loadingdone'));result.fontABA=observer.getObservation(fontABA.observation_id,projectId,current).verdict;assert(result.fontABA==='stale','font cycle must invalidate');
  const aba=await observe();root.setAttribute('data-probe-test','B');root.removeAttribute('data-probe-test');result.domABA=observer.getObservation(aba.observation_id,projectId,current).verdict;assert(result.domABA==='stale','DOM ABA must invalidate')
  const docABA=await observe();const saved=current;current={...current,elements:[]};observer.trackBoardVersion(projectId,current);current=saved;observer.trackBoardVersion(projectId,current);result.documentABA=observer.getObservation(docABA.observation_id,projectId,current).verdict;assert(result.documentABA==='stale','document ABA must invalidate')
  const racing=observe();current=structuredClone(current);current.elements[0].text+=' changed';observer.trackBoardVersion(projectId,current);result.versionRace=(await racing).verdict;assert(result.versionRace!=='verified','version race must not pass');current=structuredClone(document)
  const before=await observe();epoch++;result.epoch=observer.getObservation(before.observation_id,projectId,current).verdict;assert(result.epoch==='stale','epoch invalidates')
  const controller=new AbortController();pending=true;const cancelled=observe(300,controller.signal);controller.abort();try{await cancelled;throw new Error('cancel did not reject')}catch(error){assert(error instanceof DOMException&&error.name==='AbortError','cancel must propagate');result.cancel='AbortError'}finally{pending=false}
  dispose();dispose=registerRenderProbe(projectId,()=>{throw new Error('host unavailable')});result.hostError=(await observe(0)).checks.render;assert(result.hostError==='unknown','host error must be unknown')
  return result
 }finally{dispose()}
}
