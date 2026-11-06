/** Kernel admission projection. Never changes task semantics, history or JSON. */
import {contextTokenBreakdown,type ContextBudgetInput} from './contextBudget.js'
export type ContextPolicy={contextWindow:number;safetyRatio?:number;imageTokenReserve?:number}
export type ContextDecision={
 admitted:boolean
 reason:'fits_safe_budget'|'context_exceeds_safe_budget'
 estimator:'utf8-byte-upper-estimate-v1'|'measured-output-echo-v1'|'reference-bpe-with-margin-v1'
 contextWindow:number
 safetyRatio:number
 safeBudget:number
 estimatedTokens:number
 headroomTokens:number
 imageTokenReserve:number
 breakdown:ReturnType<typeof contextTokenBreakdown>
 limitations:string[]
}
export class ContextProjectionError extends Error {
 constructor(readonly decision:ContextDecision){
  super(`本地上下文安全预算不足：计量 ${decision.estimatedTokens} tokens（含保守估算，非服务端实际计数），安全预算 ${decision.safeBudget}（模型窗口 ${decision.contextWindow}，含输出预留）。本次模型请求尚未发送，未截断消息或重放工具；请减少输入或调整已配置的预算。`)
  this.name='ContextProjectionError'
 }
}
export function projectContext(input:ContextBudgetInput,policy:ContextPolicy) {
 const {contextWindow}=policy,safetyRatio=policy.safetyRatio??.95,imageTokenReserve=policy.imageTokenReserve??16384
 if(!Number.isSafeInteger(contextWindow)||contextWindow<256)throw new Error('模型 Context Window 配置无效')
 if(!Number.isFinite(safetyRatio)||safetyRatio<.5||safetyRatio>.98)throw new Error('上下文安全比例必须在 0.5–0.98 之间')
 if(!Number.isSafeInteger(imageTokenReserve)||imageTokenReserve<2048)throw new Error('图片 token 预留必须是至少 2048 的整数')
 if(input.outputTokens!==undefined&&(!Number.isSafeInteger(input.outputTokens)||input.outputTokens<0))throw new Error('模型输出预留配置无效')
 const breakdown=contextTokenBreakdown({...input,imageTokenReserve})
 const estimatedTokens=breakdown.framingTokens+breakdown.systemTokens+breakdown.historyTokens+breakdown.toolTokens+breakdown.attachmentTokens+breakdown.outputTokens
 const safeBudget=Math.floor(contextWindow*safetyRatio),admitted=Number.isSafeInteger(estimatedTokens)&&estimatedTokens<=safeBudget
 const decision:ContextDecision={admitted,reason:admitted?'fits_safe_budget':'context_exceeds_safe_budget',estimator:breakdown.measuredMessages?'measured-output-echo-v1':input.textEstimator==='reference_bpe'?'reference-bpe-with-margin-v1':'utf8-byte-upper-estimate-v1',contextWindow,safetyRatio,safeBudget,estimatedTokens,headroomTokens:safeBudget-estimatedTokens,imageTokenReserve,breakdown,limitations:['not_a_provider_tokenizer',...(input.textEstimator==='reference_bpe'?['o200k_reference_encoding_with_25_percent_margin']:[]),...(breakdown.measuredMessages?['exact_output_echo_uses_reported_completion_usage_with_margin']:[]),...(breakdown.attachmentOccurrences?['media_tokens_are_configured_estimates']:[])]}
 if(!admitted)throw new ContextProjectionError(decision)
 return {messages:[...input.messages],tools:[...(input.tools??[])],attachments:[...(input.attachments??[])],decision}
}

/** Count-only journal DTO. Avoid credential-shaped keys in the shared redactor;
 * do not weaken that redactor or copy any model text/provider credentials here. */
export function contextDecisionTelemetry(d:ContextDecision) {
 const b=d.breakdown
 return {admitted:d.admitted,reason:d.reason,estimator:d.estimator,unit:'estimated_tokens',contextWindow:d.contextWindow,safetyRatio:d.safetyRatio,safeBudget:d.safeBudget,estimatedUnits:d.estimatedTokens,headroomUnits:d.headroomTokens,imageReserve:d.imageTokenReserve,measuredMessages:b.measuredMessages,measurementSavings:b.measurementSavings,partitions:{framing:b.framingTokens,system:b.systemTokens,history:b.historyTokens,toolDefinitions:b.toolTokens,media:b.attachmentTokens,outputReserve:b.outputTokens,mediaOccurrences:b.attachmentOccurrences},limitations:[...d.limitations]}
}
