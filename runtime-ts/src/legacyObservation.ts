import {validateObservation,type ObservationRecord,type ExecutionState,type CheckStatus} from './observationProtocol.js'
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
const text=(v:unknown,fallback:string)=>typeof v==='string'&&v.trim()?v:fallback
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):undefined
export type LegacyObservationContext={
 id:string;scope:ObservationRecord['scope'];target:ObservationRecord['target'];createdAt:string
 /** Must come from the executor's receipt, never from result.ok or a model-authored review. */
 confirmedExecution?:ExecutionState
 callId?:string
}
/** Conservative transitional adapter. Legacy payload cannot establish current validity. */
export function adaptLegacyObservation(value:unknown,context:LegacyObservationContext):ObservationRecord {
 const result=object(value),raw=object(result.observation),oldChecks=object(raw.checks)
 const statuses:CheckStatus[]=['passed','failed','unknown','not_checked','stale']
 const checks=Object.entries(oldChecks).map(([name,v])=>({name,status:statuses.includes(v as CheckStatus)?v as CheckStatus:'unknown' as const,coverage:'legacy_declared_only'}))
 if(!checks.length)checks.push({name:'legacy_coverage',status:'not_checked',coverage:'none'})
 const rawFindings=Array.isArray(raw.findings)?raw.findings:[]
 const findings:ObservationRecord['findings']=rawFindings.map((v,index)=>{
  const f=object(v)
  return {id:`legacy-${index}-${text(f.id,'finding')}`,code:text(f.type,'legacy_unknown'),severity:f.severity==='blocking'||f.severity==='high'?'blocking':'warning',message:text(f.message,'旧结果未提供问题说明'),refs:Array.isArray(f.refs)?f.refs.filter((v):v is string=>typeof v==='string'&&Boolean(v.trim())):[],owner:'domain'}
 })
 const blockers=count(raw.blocking_count),warnings=count(raw.warning_count)
 const total=blockers!==undefined&&warnings!==undefined&&Number.isSafeInteger(blockers+warnings)?blockers+warnings:undefined
 const visibleBlockers=findings.filter(f=>f.severity==='blocking').length
 const incomplete=(blockers!==undefined&&blockers>visibleBlockers)||(total!==undefined&&total>findings.length)
 if(incomplete)findings.push({id:'legacy-incomplete',code:'legacy_findings_incomplete',severity:blockers!==undefined&&blockers>visibleBlockers?'blocking':'warning',message:`旧摘要声明 ${blockers??'未知'} 项阻断、${warnings??'未知'} 项警告；摘要不足以恢复完整证据，请重新观察。`,refs:[],owner:'loop'})
 return validateObservation({schemaVersion:1,id:context.id,scope:context.scope,source:{component:'legacy-tool-adapter',layer:'execution'},target:context.target,createdAt:context.createdAt,execution:{state:context.confirmedExecution||'unknown',callId:context.callId||context.id},validity:raw.verdict==='stale'?'stale':'unknown',range:{kind:incomplete?'partial':'complete',returned:rawFindings.length,...(total!==undefined&&total>=rawFindings.length?{total}: {})},checks,findings,...(blockers!==undefined&&warnings!==undefined?{findingTotals:{blocking:Math.max(blockers,findings.filter(f=>f.severity==='blocking').length),warning:Math.max(warnings,findings.filter(f=>f.severity==='warning').length),total:Math.max(blockers,findings.filter(f=>f.severity==='blocking').length)+Math.max(warnings,findings.filter(f=>f.severity==='warning').length)}}:{}),treatments:[],references:[]})
}
