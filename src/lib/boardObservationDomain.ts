import {ObservationScheduler} from '../../runtime-ts/src/observationScheduler'
import type { BoardDocument } from '../types'
import { reflectDiagramAsync } from './diagramQuality'
import { documentEdgeRoutesAsync } from './edgeRoute'
import { layoutNodeText } from './textLayout'

import {documentSignature,boardContentHash,unavailableBoardRenderPort,type BoardRenderPort,type Observation,type ObservationFinding} from './boardObservationProtocol'
export const observationSummary = (observation: Observation) => ({observation_id:observation.observation_id,cause_id:observation.cause_id,document_seq:observation.document_seq,content_hash:observation.content_hash,renderer_fingerprint:observation.renderer_fingerprint,verdict:observation.verdict,checks:observation.checks,verification_level:observation.verification_level,blocking_count:observation.blocking_count,warning_count:observation.warning_count,findings:observation.findings.slice(0,5),side_effects:observation.side_effects.slice(0,5),changes:observation.changes,indirectly_affected_count:observation.changes.indirect_ids.length,automatic_fixes:observation.automatic_fixes,repair_plan:observation.repair_plan,summary:observation.summary})

/** Paging never changes full blocker counts or immutable stored evidence. */
export function observationPage(observation:Observation,offset?:unknown,limit?:unknown) {
  if(offset===undefined && limit===undefined)return observation
  const start=Math.max(0,Math.floor(Number(offset)||0)),size=Math.min(50,Math.max(1,Math.floor(Number(limit)||5)))
  return {...observation,findings:observation.findings.slice(start,start+size),findings_total:observation.findings.length,findings_offset:start,findings_next:start+size<observation.findings.length?start+size:null}
}

/** Domain-owned version/evidence state; host sampling is injected. */
export function createBoardObserver(renderPort:BoardRenderPort=unavailableBoardRenderPort) {
 const session=crypto.randomUUID()
 const states=new Map<string,{signature:string;seq:number}>()
 const observations=new Map<string,Observation>()
 const scheduler=new ObservationScheduler<Observation>()
function trackBoardVersion(projectId: string, document: BoardDocument) {
  const signature = documentSignature(document), current = states.get(projectId)
  if (!current || current.signature !== signature) states.set(projectId, { signature, seq: (current?.seq || 0) + 1 })
  return states.get(projectId)!
}
function getObservation(id: string, projectId: string, document: BoardDocument): Observation {
  const found = observations.get(id)
  if (!found || found.project_id !== projectId) throw new Error('观察不存在或不属于当前画板，请重新 board_observe。')
  const state = trackBoardVersion(projectId, document), value = structuredClone(found)
  if (value.session_id !== session || value.document_seq !== state.seq || value.renderer_fingerprint !== renderPort.fingerprint) { value.verdict = 'stale'; value.checks.geometry = 'stale'; value.checks.render = 'stale'; value.summary = '画板或渲染器已改变，旧观察不能作为当前验收依据。' }
  if(value.checks.render==='passed') {
    const probe=renderPort.current(projectId)
    if(!probe || probe.pending || !probe.connected || !probe.visible || probe.ready===false || (value.render.scene_token!==undefined && probe.scene_token!==value.render.scene_token) || probe.epoch!==value.render.render_epoch || probe.signature!==documentSignature(document)) {
      value.verdict='stale';value.checks.render='stale';value.summary='实际画板的渲染场景已变化或正在交互，需重新观察。'
    }
  }
  return value
}

async function inspectBoard(input: {projectId:string; document:BoardDocument; current?:()=>BoardDocument; before?:BoardDocument; directIds?:string[]; fixes?:Observation['automatic_fixes']; causeId?:string; waitMs?:number; render?:boolean;signal?:AbortSignal;repairPlan?:Observation['repair_plan']}) {
  if(input.signal?.aborted)throw new DOMException('Cancelled','AbortError')
  const originalDocument=input.document
  input={...input,document:structuredClone(originalDocument)}
  const signature = documentSignature(input.document), tracked = trackBoardVersion(input.projectId,input.document), seq=tracked.seq
  const initialScene=input.render===false?undefined:renderPort.current(input.projectId)
  const deferGeometry=!!initialScene&&(initialScene.pending||initialScene.ready===false||!initialScene.connected||!initialScene.visible)
  const audit = deferGeometry?{issues:[]}:await reflectDiagramAsync(input.document, { maxIssues: 10000, inspectUnconnected:true },input.signal)
  const findings: ObservationFinding[] = audit.issues.map(issue=>({id:`${issue.type}:${[...issue.ids].sort().join(':')}`,type:issue.type,severity:issue.severity==='high'?'blocking':'warning',refs:issue.ids,message:issue.message,source:'geometry',options:issue.fixable?['局部修复；保持锁定位置、文字和箭头语义不变']:undefined}))
  const sideEffects: Observation['side_effects'] = [], direct = new Set(input.directIds || [])
  if (input.before && !deferGeometry) {
    const oldRoutes=await documentEdgeRoutesAsync(input.before.elements,input.before.edges,input.signal), newRoutes=await documentEdgeRoutesAsync(input.document.elements,input.document.edges,input.signal)
    for (const [id,route] of newRoutes) if (oldRoutes.has(id) && JSON.stringify(oldRoutes.get(id)?.pathPoints)!==JSON.stringify(route.pathPoints)) sideEffects.push({type:'route_changed',refs:[id],message:direct.has(id)?'目标连线路径已改变。':'未直接修改的连线因节点/通道变化而被重新路由。'})
  }
  for (const node of (deferGeometry?[]:input.document.elements.filter(n=>n.text))) {
    const layout=layoutNodeText(node)
    if (layout.fontSize < node.fontSize) sideEffects.push({type:'effective_font_reduced',refs:[node.id],message:`渲染字号从 ${node.fontSize}px 适配为 ${layout.fontSize}px；保存文字未变。`})
  }
  const render = input.render === false ? {status:'not_checked' as const,target:'canvas_scene' as const,coverage:'none',findings:[],measured_elements:0,measured_edges:0,render_epoch:0,pixel_verification:'not_checked' as const,reason:'本次仅进行几何观察。'} : await renderPort.measure(input.projectId,signature,input.waitMs ?? 1200,input.signal)
  if(deferGeometry&&render.status==='passed'){render.status='unknown';render.reason='场景刚恢复稳定，本次未做几何审计；请重新观察，不能作为通过证据。'}
  findings.push(...render.findings)
  findings.sort((a,b)=>Number(b.severity==='blocking')-Number(a.severity==='blocking'))
  const blocking=findings.filter(f=>f.severity==='blocking').length, warnings=findings.length-blocking
  const hash=await boardContentHash(input.document)
  const nowDoc = input.current?.() || originalDocument, current=trackBoardVersion(input.projectId,nowDoc), documentStale=current.seq!==seq || current.signature!==signature
  if(input.signal?.aborted)throw new DOMException('Cancelled','AbortError')
  const stamp=render.status==='passed'?renderPort.current(input.projectId):undefined
  const sceneChangedDuringGeometry=!deferGeometry&&initialScene?.scene_token!==undefined&&render.scene_token!==undefined&&initialScene.scene_token!==render.scene_token
  const renderStale=render.status==='stale' || (render.status==='passed' && (sceneChangedDuringGeometry || !stamp || stamp.pending || !stamp.connected || !stamp.visible || stamp.ready===false || stamp.epoch!==render.render_epoch || stamp.signature!==signature || (render.scene_token!==undefined && stamp.scene_token!==render.scene_token)))
  const stale=documentStale || renderStale
  const observation: Observation = {observation_id:`obs_${crypto.randomUUID()}`,project_id:input.projectId,session_id:session,document_seq:seq,content_hash:hash,renderer_fingerprint:renderPort.fingerprint,created_at:new Date().toISOString(),execution:input.before?'committed':'read_only',cause_id:input.causeId,checks:{geometry:stale?'stale':deferGeometry?'not_checked':findings.some(f=>f.source==='geometry'&&f.severity==='blocking')?'failed':'passed',render:stale?'stale':render.status,reference_semantics:'not_checked',pptx_render:'not_checked'},verdict:stale?'stale':blocking?'needs_decision':render.status==='passed'?'verified':'partially_verified',verification_level:deferGeometry?'unverified':render.status==='passed'?'geometry_and_dom':'geometry_only',coverage:render.coverage,findings,blocking_count:blocking,warning_count:warnings,changes:{direct_ids:[...direct],indirect_ids:[...new Set(sideEffects.flatMap(e=>e.refs).filter(id=>!direct.has(id)))]},side_effects:sideEffects,automatic_fixes:input.fixes || [],render,summary:stale?'观察期间画板改变，报告已失效。':`${input.before?'修改已保存。':''}${input.fixes?.filter(f=>f.persisted&&f.state==='applied').length || 0} 项有界修复；${blocking} 项阻断、${warnings} 项警告。${render.status==='passed'?'实际 DOM 与绘制顺序已检查，像素与外部 PPT 显示未验证。':render.reason || '实际渲染未检查。'}`}
  if(input.repairPlan)observation.repair_plan=structuredClone(input.repairPlan)
  observation.automatic_fixes=(input.fixes||[]).map(f=>({...structuredClone(f),verification_ref:observation.observation_id,verification:{geometry:observation.checks.geometry,render:observation.checks.render,target:'observed_document',content_hash:observation.content_hash,document_seq:observation.document_seq}}))
  observations.set(observation.observation_id,structuredClone(observation)); if(observations.size>128)observations.delete(observations.keys().next().value!)
  return observation
}


function observeBoard(input:Parameters<typeof inspectBoard>[0]):Promise<Observation> {
 // Repair/cause reports carry caller-specific facts and must not be merged.
 if(input.before || input.fixes?.length || input.causeId || input.directIds?.length || input.repairPlan)return inspectBoard(input)
 if(input.signal?.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'))
 const original=input.document
 input={...input,document:structuredClone(original),current:input.current??(()=>original)}
 const version=trackBoardVersion(input.projectId,input.document)
 return scheduler.request({application:'tugo',workspace:input.projectId,session,target:input.projectId,revision:JSON.stringify([version.seq,version.signature]),scope:input.render===false?['geometry']:['geometry','canvas_dom'],mode:JSON.stringify({waitMs:input.waitMs??1200})},signal=>inspectBoard({...input,signal}),input.signal)
}
return {trackBoardVersion,getObservation,observeBoard}
}
