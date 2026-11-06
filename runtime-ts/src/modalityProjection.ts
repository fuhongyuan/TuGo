/** Kernel modality policy. Configuration is not proof of visual inspection. */
import type {ModelAttachment,RuntimeMessage,ToolDefinition} from './contracts.js'
export type VisionMode='vision'|'text'|'unknown'
export const visionMode=(capability:unknown):VisionMode=>capability===true?'vision':capability===false?'text':'unknown'
export function projectModalities(input:{capability:unknown;messages:RuntimeMessage[];attachments:ModelAttachment[];tools:ToolDefinition[]}) {
 const mode=visionMode(input.capability),visual=mode==='vision'
 const omitted=visual?[]:input.attachments.filter(a=>/^image\//i.test(a.mimeType)).map(a=>a.attachmentId)
 const disclosure=omitted.length?`视觉输入限制：当前模型${mode==='unknown'?'的图片能力未知':'不支持图片'}，未向模型发送 ${omitted.length} 个图片输入。本回复不能作为这些图片已查看或视觉核验通过的证明；只能依据文字或结构化证据，需要视觉结论时应请求用户确认可用能力。未自动切换模型。`:''
 return {mode,messages:disclosure?[...input.messages,{role:'system' as const,content:`${disclosure}\n图片引用：${JSON.stringify(omitted)}。不得声称看到了未发送的图片，不得把几何/结构化结果当像素验证。`}]:[...input.messages],attachments:visual?[...input.attachments]:input.attachments.filter(a=>!/^image\//i.test(a.mimeType)),tools:visual?[...input.tools]:input.tools.filter(t=>!t.requiresVision&&t.handlerKey!=='view-image'),disclosure,omitted}
}
