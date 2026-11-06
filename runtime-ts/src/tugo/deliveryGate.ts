import type {JsonObject} from '../contracts.js'
const object=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{}
/** Only call with a fresh trusted host lookup, never model-supplied JSON. */
export function assessBoardDelivery(result:unknown,projectId:string,requestedId?:string) {
 const e=object(object(result).observation),checks=object(e.checks),render=object(e.render),reasons:string[]=[]
 if(!e.observation_id||requestedId&&e.observation_id!==requestedId)reasons.push('observation_identity')
 if(e.project_id!==projectId)reasons.push('target_mismatch')
 if(typeof e.session_id!=='string'||!e.session_id||!Number.isSafeInteger(e.document_seq)||Number(e.document_seq)<1||typeof e.content_hash!=='string'||!/^[a-f0-9]{64}$/.test(e.content_hash)||!e.renderer_fingerprint)reasons.push('version_identity_missing')
 if(e.verdict!=='verified'||checks.geometry!=='passed'||checks.render!=='passed')reasons.push('checks_not_passed')
 if(e.blocking_count!==0||!Array.isArray(e.findings)||e.findings.some(f=>object(f).severity==='blocking'))reasons.push('unresolved_or_unknown_blockers')
 if(e.verification_level!=='geometry_and_dom'||render.status!=='passed'||render.target!=='canvas_scene'||typeof render.coverage!=='string'||!render.coverage.startsWith('full_scene_dom_and_paint_order')||!Number.isSafeInteger(render.render_epoch)||!render.scene_token)reasons.push('coverage_or_scene_missing')
 return {passed:reasons.length===0,scope:'geometry_and_canvas_dom',observation_id:e.observation_id??null,project_id:projectId,document_seq:e.document_seq??null,content_hash:e.content_hash??null,renderer_fingerprint:e.renderer_fingerprint??null,session_id:e.session_id??null,reasons,pixels:'not_checked',pptx:'not_checked'}
}
