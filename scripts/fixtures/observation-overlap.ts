/** Native DOM regression: actual text fragments vs whitespace and progress metrics. */
import type {BoardDocument} from '../../src/types'
import {registerRenderProbe,liveBoardRenderPort} from '../../src/lib/boardRenderProbe'
import {documentSignature} from '../../src/lib/boardObservationProtocol'
export async function observationOverlap() {
 const root=document.createElement('div');root.style.cssText='position:fixed;left:0;top:0;width:700px;height:400px;z-index:9999;background:white'
 root.innerHTML='<svg width="700" height="400"><g data-element-id="container"><rect width="600" height="300" fill="#fff"/><foreignObject x="0" y="0" width="600" height="300"><div xmlns="http://www.w3.org/1999/xhtml" style="font:20px Arial;line-height:30px;white-space:pre-wrap"><span class="element-text-hit" style="display:block;width:600px;height:200px">Actual heading</span></div></foreignObject></g><g data-edge-id="e"><path d="M 300 250 L 500 250" fill="none" stroke="#000"/></g><g data-label-edge-id="e"><rect x="450" y="100" width="80" height="26" fill="white"/><text x="490" y="118" text-anchor="middle" style="font:13px Arial">link</text></g></svg>'
 document.body.append(root)
 const doc:BoardDocument={version:1,paletteId:'default',viewport:{x:0,y:0,zoom:1},elements:[{id:'container',kind:'rectangle',x:0,y:0,width:600,height:300,text:'Actual heading',fontSize:20,fill:'#fff',stroke:'#000',strokeWidth:1}],edges:[{id:'e',from:'container',to:'container',routing:'straight',stroke:'#000',strokeWidth:1,startArrow:'none',endArrow:'none'}]}
 const dispose=registerRenderProbe('overlap-regression',()=>({document:doc,root,pending:false,epoch:1}))
 const observe=()=>liveBoardRenderPort.measure('overlap-regression',documentSignature(doc),300)
 const label=root.querySelector('[data-label-edge-id] rect')!,text=root.querySelector('[data-label-edge-id] text')!,span=root.querySelector('.element-text-hit')!
 const move=(x:number,y:number)=>{label.setAttribute('x',String(x));label.setAttribute('y',String(y));text.setAttribute('x',String(x+40));text.setAttribute('y',String(y+18))}
 const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message)}
 try {
  const blank=await observe();assert(!blank.findings.some(f=>f.type==='label_over_text'),'blank span area is not visible text')
  move(20,0);const first=await observe(),blocked=first.findings.find(f=>f.type==='label_over_text');assert(blocked,'real overlap must still block')
  move(20,15);const partial=await observe(),reduced=partial.findings.find(f=>f.type==='label_over_text');assert(reduced&&reduced.measure!.value<blocked!.measure!.value,'reduced overlap needs a smaller normalized metric')
  span.textContent='A much longer heading on the first line\nX';move(250,35);const gap=await observe();assert(!gap.findings.some(f=>f.type==='label_over_text'),'multiline union must not fill whitespace')
  move(0,0);(span as HTMLElement).style.opacity='0';const hidden=await observe();assert(!hidden.findings.some(f=>f.type==='label_over_text'),'invisible text must not block')
  return {blank:'passed',real_overlap:'detected',initial_fraction:blocked!.measure!.value,reduced_fraction:reduced!.measure!.value,multiline_gap:'passed',hidden_text:'passed'}
 } finally {dispose();root.remove()}
}
