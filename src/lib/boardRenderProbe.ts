/** Renderer host adapter. All native scene/paint inspection lives here. */
import type {BoardDocument} from '../types'
import {documentSignature,type RenderEvidence,type ObservationFinding,type BoardRenderPort} from './boardObservationProtocol'
import {edgeDefaults} from './canvasStyle'
declare const __TUGO_RENDERER_BUILD_ID__: string
export const RENDERER_FINGERPRINT = typeof __TUGO_RENDERER_BUILD_ID__ === 'undefined' ? 'development-observer-1' : __TUGO_RENDERER_BUILD_ID__
export type Probe = { document: BoardDocument; root: HTMLElement; pending: boolean; epoch: number }
// Identity and DOM revision prevent unmount/remount and equal-content ABA reuse.
type Registration={read:()=>Probe;token:string;root?:HTMLElement;observer?:MutationObserver;revision:number;disposeFonts?:()=>void}
const probes = new Map<string, Registration>()
export function registerRenderProbe(projectId: string, read: () => Probe) {
 const previous=probes.get(projectId);previous?.observer?.disconnect();previous?.disposeFonts?.()
 const entry:Registration={read,token:crypto.randomUUID(),revision:0};probes.set(projectId,entry)
 return ()=>{if(probes.get(projectId)===entry){entry.observer?.disconnect();entry.disposeFonts?.();probes.delete(projectId)}}
}
function sample(projectId:string) {
 const entry=probes.get(projectId);if(!entry)return undefined
 const probe=entry.read()
 if(entry.root!==probe.root){
  entry.observer?.disconnect();entry.disposeFonts?.();entry.root=probe.root;entry.revision++
  entry.observer=new MutationObserver(records=>{if(records.length)entry.revision++})
  entry.observer.observe(probe.root,{subtree:true,attributes:true,childList:true,characterData:true})
  const fonts=probe.root.ownerDocument.fonts,changed=()=>{entry.revision++}
  fonts?.addEventListener('loading',changed);fonts?.addEventListener('loadingdone',changed);fonts?.addEventListener('loadingerror',changed)
  entry.disposeFonts=()=>{fonts?.removeEventListener('loading',changed);fonts?.removeEventListener('loadingdone',changed);fonts?.removeEventListener('loadingerror',changed)}
 }
 if(entry.observer?.takeRecords().length)entry.revision++
 const bounds=probe.root.getBoundingClientRect(),style=getComputedStyle(probe.root)
 const visible=probe.root.isConnected && bounds.width>0 && bounds.height>0 && style.visibility!=='hidden' && style.display!=='none' && Number(style.opacity || 1)!==0
 const ready=(!probe.root.ownerDocument.fonts || probe.root.ownerDocument.fonts.status==='loaded') && [...probe.root.querySelectorAll('img')].every(img=>img.complete&&img.naturalWidth>0)
 return {probe,stamp:{signature:documentSignature(probe.document),epoch:probe.epoch,pending:probe.pending,connected:probe.root.isConnected,visible,ready,scene_token:`${entry.token}:${entry.revision}`}}
}
function invisibleStroke(path:SVGPathElement) {
 const style=getComputedStyle(path)
 if(style.stroke==='none'||style.stroke==='transparent'||/rgba\([^)]*,\s*0(?:\.0*)?\)/.test(style.stroke)||Number(style.strokeOpacity || 1)===0||parseFloat(style.strokeWidth)===0)return true
 for(let node:Element|null=path;node;node=node.parentElement){const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity || 1)===0)return true}
 return false
}
const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
const intersectionArea=(a:DOMRect,b:DOMRect)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))
/** Actual text fragments, not the flex span box or the union of multiline text.
 * A union would incorrectly cover the whitespace between unequal-length lines. */
function textFragments(span:Element) {
 const walker=span.ownerDocument.createTreeWalker(span,NodeFilter.SHOW_TEXT),rects:DOMRect[]=[]
 for(let node=walker.nextNode();node;node=walker.nextNode()) {
  if(!node.textContent?.trim())continue
  const range=span.ownerDocument.createRange();range.selectNodeContents(node)
  rects.push(...Array.from(range.getClientRects()).filter(r=>r.width>0&&r.height>0))
 }
 return rects
}
function visibleText(span:Element,root:Element){
 for(let node:Element|null=span;node;node=node.parentElement){const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity||1)===0)return false;if(node===root)break}
 const color=getComputedStyle(span).color
 return color!=='transparent'&&!/rgba\([^)]*,\s*0(?:\.0*)?\)/.test(color)
}
function inspectProbe(probe: Probe): RenderEvidence {
  const findings: ObservationFinding[] = [], root = probe.root
  const add = (type: string, refs: string[], message: string,measure?:ObservationFinding['measure']) => {
    const nodes=probe.document.elements.filter(node=>refs.includes(node.id)||probe.document.edges.some(e=>refs.includes(e.id)&&(e.from===node.id||e.to===node.id)))
    const region=nodes.length?{x:Math.min(...nodes.map(n=>n.x))-12,y:Math.min(...nodes.map(n=>n.y))-12,width:Math.max(...nodes.map(n=>n.x+n.width))-Math.min(...nodes.map(n=>n.x))+24,height:Math.max(...nodes.map(n=>n.y+n.height))-Math.min(...nodes.map(n=>n.y))+24}:undefined
    findings.push({ id: `${type}:${refs.join(':')}`, type, refs, severity: 'blocking', message, source: 'live_dom',region,...(measure?{measure}:{}),options:['保持内容与箭头语义，扩大局部间距或调整走线通道','使用问题区域截图核对实际显示；不要重放已保存的操作'] })
  }
  const elements = [...root.querySelectorAll<SVGGElement>('[data-element-id]')]
  const renderedIds=new Set(elements.map(group=>group.dataset.elementId))
  for (const node of probe.document.elements) if(!renderedIds.has(node.id)) add('element_missing',[node.id],`数据中存在 ${node.id}，实际场景没有对应图形。`)
  for (const id of renderedIds) if(!probe.document.elements.some(node=>node.id===id)) add('unexpected_element',[id!],`实际场景出现不属于当前版本的对象 ${id}。`)
  const textRegions=new Map<string,{fragments:DOMRect[];clip:DOMRect}>()
  for (const group of elements) {
    const id = group.dataset.elementId!, text = group.querySelector<HTMLElement>('.element-text-hit'), box = group.querySelector('foreignObject')
    if (!text || !box || !text.textContent?.trim()||!visibleText(text,root)) continue
    const fragments=textFragments(text),b=box.getBoundingClientRect()
    textRegions.set(id,{fragments,clip:b})
    if(fragments.some(a=>a.top<b.top-2||a.bottom>b.bottom+2||a.left<b.left-2||a.right>b.right+2)){
      const area=fragments.reduce((sum,a)=>sum+a.width*a.height,0),inside=fragments.reduce((sum,a)=>sum+intersectionArea(a,b),0)
      add('text_clipped',[id],`图形 ${id} 的实际文字超出显示区域；请扩大框或调整局部布局。`,{kind:'outside_fraction',value:Math.max(0,Math.min(1,1-inside/Math.max(1,area)))})
    }
  }
  for (const group of root.querySelectorAll<SVGGElement>('[data-label-edge-id]')) {
    const id = group.dataset.labelEdgeId!, text = group.querySelector('text'), box = group.querySelector('rect')
    if (!text || !box) continue
    const a = text.getBBox(), b = box.getBBox()
    if (a.x < b.x - 1 || a.y < b.y - 1 || a.x+a.width > b.x+b.width+1 || a.y+a.height > b.y+b.height+1) add('label_clipped', [id], `连线 ${id} 的文字超出标签底板。`)
    const label = box.getBoundingClientRect()
    for (const [nodeId,{fragments,clip}] of textRegions) {
      const visible=fragments.map(r=>new DOMRect(Math.max(r.left,clip.left),Math.max(r.top,clip.top),Math.max(0,Math.min(r.right,clip.right)-Math.max(r.left,clip.left)),Math.max(0,Math.min(r.bottom,clip.bottom)-Math.max(r.top,clip.top))))
      const area=visible.filter(r=>overlaps(label,r)).reduce((sum,r)=>sum+intersectionArea(label,r),0)
      if(area>0)add('label_over_text',[id,nodeId],`连线 ${id} 的标签覆盖了 ${nodeId} 的实际文字；需要调整局部标签或通道。`,{kind:'overlap_fraction',value:Math.min(1,area/Math.max(1,label.width*label.height))})
    }
  }
  const paths = [...root.querySelectorAll<SVGPathElement>('[data-edge-id] > path')]
  for(const edge of probe.document.edges) if(!paths.some(path=>path.parentElement?.getAttribute('data-edge-id')===edge.id)) add('edge_missing',[edge.id],`数据中存在连线 ${edge.id}，实际场景没有对应路径。`)
  const opaque = elements.flatMap(group => [...group.querySelectorAll<SVGGeometryElement>('path,rect,ellipse,circle,polygon,polyline')].filter(shape=>shape instanceof SVGGeometryElement && !shape.closest('.selection-ui,.connection-ports,.quick-add-node')).filter(shape => {
    const style = getComputedStyle(shape)
    return style.fill !== 'none' && style.fill !== 'transparent' && !/rgba\([^)]*,\s*0\)/.test(style.fill) && Number(style.fillOpacity || 1) * Number(style.opacity || 1) > .1
  }).map(shape => ({ shape, group, bounds: shape.getBoundingClientRect() })))
  for (const path of paths) {
    const id = path.parentElement!.getAttribute('data-edge-id')!, edge = probe.document.edges.find(edge => edge.id === id), matrix = path.getScreenCTM()
    if (!edge) continue
    if(edgeDefaults(edge).opacity>0 && invisibleStroke(path))add('edge_invisible',[id],`连线 ${id} 的DOM存在，但实际描边不可见。`)
    if (!matrix) continue
    const length = path.getTotalLength(), count = Math.min(2048, Math.max(2, Math.ceil(length / 4)))
    const bounds=path.getBoundingClientRect(), screenPoints=Array.from({length:count-1},(_,i)=>{const p=path.getPointAtLength(length*(i+1)/count);return new DOMPoint(p.x,p.y).matrixTransform(matrix)})
    for (const candidate of opaque) {
      if(bounds.right<candidate.bounds.left||bounds.left>candidate.bounds.right||bounds.bottom<candidate.bounds.top||bounds.top>candidate.bounds.bottom)continue
      if (candidate.group.dataset.elementId === edge.from || candidate.group.dataset.elementId === edge.to || !(path.compareDocumentPosition(candidate.shape) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
      const inverse = candidate.shape.getScreenCTM()?.inverse(); if (!inverse) continue
      let covered = false
      for (const screen of screenPoints) {
        if(covered)break
        if (screen.x <= candidate.bounds.left || screen.x >= candidate.bounds.right || screen.y <= candidate.bounds.top || screen.y >= candidate.bounds.bottom) continue
        covered = candidate.shape.isPointInFill(screen.matrixTransform(inverse))
      }
      if (covered) add('edge_occluded', [id, candidate.group.dataset.elementId!], `连线 ${id} 的实际路径被后绘制的不透明图形 ${candidate.group.dataset.elementId} 覆盖。`)
    }
    const style=getComputedStyle(path), expected=edgeDefaults(edge)
    for (const [position,marker] of [['终点',style.markerEnd],['起点',style.markerStart]]) {
      const requested=position==='终点'?expected.endArrow:expected.startArrow
      const markerId=marker?.match(/#([^)"]+)/)?.[1]
      if (requested!=='none' && (!marker || marker==='none' || !markerId || !root.querySelector(`[id="${CSS.escape(markerId)}"]`)))add('arrow_missing',[id],`连线 ${id} 请求了${position}箭头，但实际路径缺少有效marker。`)
    }
  }
  const unsupported=probe.document.elements.some(n=>n.rotation || n.kind==='image') || paths.some(path=>{const s=getComputedStyle(path);return s.clipPath!=='none'&&Boolean(s.clipPath)||s.mask!=='none'&&Boolean(s.mask)})
  return { availability:'available',status: findings.length ? 'failed' : unsupported?'unknown':'passed', target: 'canvas_scene', coverage: 'full_scene_dom_and_paint_order; pixels_not_verified', findings, measured_elements: elements.length, measured_edges: paths.length, render_epoch: probe.epoch, pixel_verification: 'not_checked',...(unsupported?{reason:'旋转文字、图像解码或自定义裁剪需补充视觉证据，不能仅凭DOM边界通过。'}:{}) }
}
async function probeRender(projectId: string, signature: string, waitMs: number, signal?:AbortSignal): Promise<RenderEvidence> {
  const unknown = (reason: string): RenderEvidence => ({ status:'unknown',target:'canvas_scene',coverage:'none',findings:[],measured_elements:0,measured_edges:0,render_epoch:0,pixel_verification:'not_checked',reason,availability:'unavailable' })
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError')
  if(typeof document==='undefined')return {...unknown('当前宿主没有DOM，拒绝实时画板检查；导出图不是实时证据。'),availability:'unsupported'}
  const deadline = Date.now() + Math.min(2500, Math.max(0, waitMs)); let previous = '', stable = 0
  do {
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError')
    try {
      const sampled=sample(projectId)
      if(!sampled)return unknown('目标画板未挂载，不能用导出图冒充当前画板观察。')
      const {probe,stamp}=sampled
      if(!stamp.connected||!stamp.visible)return unknown('目标画板隐藏或已卸载，实际呈现不可验证。')
      if(!stamp.pending && stamp.signature===signature && stamp.ready){
        const fingerprint=JSON.stringify(stamp)
        stable=fingerprint===previous?stable+1:0;previous=fingerprint
        if(stable>=1){
          const evidence=inspectProbe(probe),after=sample(projectId)
          if(!after||JSON.stringify(after.stamp)!==fingerprint)return {...unknown('采样期间场景改变，需重新观察。'),status:'stale'}
          return {...evidence,scene_token:stamp.scene_token}
        }
      } else {stable=0;previous=''}
    } catch(error){return unknown(`渲染检测能力不可用：${error instanceof Error?error.message:String(error)}`)}
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 35))
  } while (Date.now() <= deadline)
  return unknown('画板版本、字体或播放投影尚未稳定；观察未通过，不应重放已经保存的操作。')
}

export const liveBoardRenderPort:BoardRenderPort={
 fingerprint:RENDERER_FINGERPRINT,
 measure:probeRender,
 current(projectId){
  try {
   return sample(projectId)?.stamp
  } catch {return undefined}
 },
}
