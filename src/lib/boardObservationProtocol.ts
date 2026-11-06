import type {BoardDocument} from '../types'
export const documentSignature = (doc: BoardDocument) => JSON.stringify([doc.elements, doc.edges, doc.paletteId, doc.presentationAreas, doc.dsl])
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('')
export const boardContentHash = (document: BoardDocument) => digest(JSON.stringify({elements:document.elements,edges:document.edges,paletteId:document.paletteId}))
type Status = 'passed' | 'failed' | 'unknown' | 'not_checked' | 'stale'
export type ObservationFinding = { id: string; type: string; severity: 'blocking' | 'warning'; refs: string[]; message: string; source: string; region?: { x: number; y: number; width: number; height: number }; options?: string[];measure?:{kind:'overlap_fraction'|'outside_fraction';value:number} }
export type RenderEvidence = { status: Status; target: 'canvas_scene'; coverage: string; findings: ObservationFinding[]; measured_elements: number; measured_edges: number; render_epoch: number; scene_token?: string; pixel_verification: 'not_checked'; reason?: string; availability?: 'available' | 'unavailable' | 'unsupported' }
export type RepairBudget={maxNodes:number;maxCandidates:number;maxGrowth:number;usedCandidates:number;maxAuditElements?:number;maxAuditEdges?:number;maxAuditTextCharacters?:number}
export type RepairRecord={type:string;refs:string[];persisted:boolean;message:string;state?:'proposed'|'applied'|'rejected'|'skipped'|'unknown';proposal?:{height:number};repair_id?:string;cause_id?:string;before_revision?:string;after_revision?:string;verification_ref?:string;verification?:{geometry:Status;render:Status;target?:'observed_document';content_hash?:string;document_seq?:number}}
export type Observation = {
  observation_id: string; project_id: string; session_id: string; document_seq: number; content_hash: string; renderer_fingerprint: string; created_at: string
  execution: 'committed' | 'read_only'; cause_id?: string; checks: { geometry: Status; render: Status; reference_semantics: 'not_checked'; pptx_render: 'not_checked' }
  verdict: 'verified' | 'needs_decision' | 'partially_verified' | 'unverified' | 'stale'
  verification_level: 'geometry_and_dom' | 'geometry_only' | 'unverified'; coverage: string; findings: ObservationFinding[]; blocking_count: number; warning_count: number
  changes: { direct_ids: string[]; indirect_ids: string[] }; side_effects: Array<{ type: string; refs: string[]; message: string }>
  repair_plan?:{id:string;budget:RepairBudget}; automatic_fixes: RepairRecord[]; render: RenderEvidence; summary: string
}

/** Serialized host boundary: no element handles or DOM types cross it. */
export type RenderStamp={signature:string;epoch:number;pending:boolean;connected:boolean;visible:boolean;ready?:boolean;scene_token?:string}
export type BoardRenderPort={
 fingerprint:string
 measure(projectId:string,signature:string,waitMs:number,signal?:AbortSignal):Promise<RenderEvidence>
 current(projectId:string):RenderStamp|undefined
}
export const unavailableBoardRenderPort:BoardRenderPort={
 fingerprint:'headless-no-live-renderer',
 measure:async(_projectId,_signature,_waitMs,signal)=>{
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError')
  return {status:'unknown',availability:'unsupported',target:'canvas_scene',coverage:'none',findings:[],measured_elements:0,measured_edges:0,render_epoch:0,pixel_verification:'not_checked',reason:'宿主没有实时画板呈现能力；拒绝执行DOM检查，不会以导出图片替代。'}
 },
 current:()=>undefined,
}
