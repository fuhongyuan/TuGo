/** Domain proposals only. This module never commits, persists or edits history. */
import type {BoardDocument,BoardElement,BoardOperation} from '../types'
import {documentEdgeRoutes} from './edgeRoute'
import {segmentHitsRect} from './canvasGeometry'
import {reflectDiagram} from './diagramQuality'
import {layoutNodeText,textObstacle} from './textLayout'
import {elementLayers} from './boardCommands'
import {boardContentHash,type RepairRecord,type RepairBudget} from './boardObservationProtocol'
export type RepairOptions={before?:BoardDocument;causeId?:string;allowRepair?:boolean;allowedIds?:readonly string[];maxNodes?:number;maxCandidates?:number;maxGrowth?:number}
export type RepairPlan={id:string;document:BoardDocument;patches:BoardOperation[];fixes:RepairRecord[];budget:RepairBudget}
const plans=new WeakMap<RepairPlan,{base?:BoardDocument;candidate?:BoardDocument;fixes:RepairRecord[]}>()
const shapeSignature=(d:BoardDocument)=>JSON.stringify([d.elements,d.edges,d.paletteId,d.presentationAreas])
const cap=(value:number|undefined,fallback:number,max:number)=>{if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<0)throw new Error('修复预算必须为非负整数');return Math.min(value,max)}
// Semantic graph audits omit free strokes; guard their actual routes too.
const routeCollisions=(d:BoardDocument)=>{
 const result=new Set<string>(),routes=documentEdgeRoutes(d.elements,d.edges)
 const nodes=elementLayers(d.elements).foreground
 for(const edge of d.edges){const points=routes.get(edge.id)?.pathPoints||[]
  for(const n of nodes){if(n.id===edge.from||n.id===edge.to)continue;const rect=n.kind==='text'?textObstacle(n):n
   if(points.slice(1).some((p,i)=>segmentHitsRect(points[i],p,rect)))result.add(JSON.stringify([edge.id,n.id]))
   if(result.size>=10001)return result
  }
 }
 return result
}
const locked=(n:BoardElement)=>Boolean(n.locked||n.metadata?.layoutLocked||n.metadata?.preserveSize)
export function repairNewNodes(document:BoardDocument,operations:BoardOperation[],options:RepairOptions={}):RepairPlan {
 const id=`repair_${crypto.randomUUID()}`,cause=options.causeId||id
 const budget={maxNodes:cap(options.maxNodes,8,8),maxCandidates:cap(options.maxCandidates,48,48),maxGrowth:cap(options.maxGrowth,24,24),usedCandidates:0,maxAuditElements:256,maxAuditEdges:512,maxAuditTextCharacters:64000}
 const fixes:RepairRecord[]=[],patches:BoardOperation[]=[]
 const oldIds=new Set(options.before?.elements.map(n=>n.id)||[]),added=new Set(operations.filter(op=>op.op==='add_element').map(op=>op.element.id))
 if(document.elements.length>budget.maxAuditElements||document.edges.length>budget.maxAuditEdges||document.elements.reduce((n,e)=>n+(e.text?.length||0),0)>budget.maxAuditTextCharacters){
  const fixes:RepairRecord[]=[{type:'repair_budget_exhausted',refs:[...added].slice(0,8),persisted:false,state:'skipped',repair_id:`${id}:scope`,cause_id:cause,message:'画板或文字量超过本层修复审计预算，未自动修改；保留问题，需要上层缩小范围或显式处理。'}]
  const plan:RepairPlan={id,document,patches:[],fixes,budget};plans.set(plan,{fixes:structuredClone(fixes)});return plan
 }
 const allowed=options.allowedIds?new Set(options.allowedIds):undefined,byId=new Map(document.elements.map(n=>[n.id,n])),oldById=new Map(options.before?.elements.map(n=>[n.id,n])||[])
 const foreground=elementLayers(document.elements).foreground.filter(n=>n.kind!=='text'),working=new Map(document.elements.map(n=>[n.id,n]))
 const record=(node:BoardElement,state:'proposed'|'rejected'|'skipped',type:string,message:string)=>fixes.push({type,refs:[node.id],persisted:false,state,repair_id:`${id}:${node.id}`,cause_id:cause,message})
 let nodes=0
 for(const node of foreground){
  if(!added.has(node.id)||node.kind==='image')continue
  const layout=layoutNodeText(node)
  if(!layout.overflow&&layout.fontSize>=Math.min(node.fontSize,11))continue
  const ancestors:BoardElement[]=[],seen=new Set([node.id]);let parentId=node.groupId,invalidParent=false
  while(parentId){const p=byId.get(parentId);if(!p||seen.has(parentId)){invalidParent=true;break}seen.add(parentId);ancestors.push(p);parentId=p.groupId}
  if(options.allowRepair===false||allowed&&!allowed.has(node.id)||oldIds.has(node.id)||locked(node)||node.rotation||invalidParent||ancestors.some(n=>locked(n)||n.rotation||Boolean(oldById.get(n.id)&&locked(oldById.get(n.id)!)))){
   record(node,'skipped','repair_not_authorized','候选未应用：权限/锁定/保留尺寸/既有对象或父级边界不允许自动修复。');continue
  }
  if(nodes>=budget.maxNodes||budget.usedCandidates>=budget.maxCandidates){record(node,'skipped','repair_budget_exhausted','候选未检查：修复预算已耗尽，保留问题交由上层决定。');continue}
  nodes++
  let accepted=false,reason='可用空间或字号不足，约束内没有安全候选。'
  for(let growth=4;growth<=budget.maxGrowth;growth+=4){
   if(budget.usedCandidates>=budget.maxCandidates){reason='修复候选预算耗尽，未应用。';break}
   budget.usedCandidates++
   const candidate={...node,height:node.height+growth},text=layoutNodeText(candidate)
   if(text.overflow||text.fontSize<Math.min(node.fontSize,11))continue
   if(ancestors.some(p=>candidate.x<p.x+6||candidate.y<p.y+6||candidate.x+candidate.width>p.x+p.width-6||candidate.y+candidate.height>p.y+p.height-6)){reason='父级空间不足，候选未应用。';break}
   if(foreground.some(original=>{const n=working.get(original.id)!;return n.id!==node.id&&!ancestors.some(p=>p.id===n.id)&&candidate.x<n.x+n.width+4&&candidate.x+candidate.width>n.x-4&&candidate.y<n.y+n.height+4&&candidate.y+candidate.height>n.y-4})){reason='局部空间存在碰撞，候选未应用。';break}
   if(document.elements.filter(n=>n.kind==='text'&&n.text).map(textObstacle).some(n=>candidate.x<n.x+n.width+3&&candidate.x+candidate.width>n.x-3&&candidate.y<n.y+n.height+3&&candidate.y+candidate.height>n.y-3)){reason='独立文字占用空间，候选未应用。';break}
   patches.push({op:'patch_element',id:node.id,patch:{height:candidate.height}});working.set(node.id,candidate)
   record(node,'proposed','fit_new_node',`候选高度增加 ${growth}px，保持位置/内容/关系不变；尚未确认保存。`);fixes.at(-1)!.proposal={height:candidate.height};accepted=true;break
  }
  if(!accepted)record(node,'rejected','repair_rejected',reason)
 }
 let candidate:BoardDocument=patches.length?{...structuredClone(document),elements:document.elements.map(n=>structuredClone(working.get(n.id)!))}:document
 if(patches.length){
  let regressionRefs:string[]=[]
  try{
   const key=(i:ReturnType<typeof reflectDiagram>['issues'][number])=>`${i.type}:${[...i.ids].sort().join(':')}`
   const oldRoutes=routeCollisions(document),newRoutes=routeCollisions(candidate)
   const newOcclusions=[...newRoutes].filter(key=>!oldRoutes.has(key))
   regressionRefs=[...new Set(newOcclusions.flatMap(key=>JSON.parse(key) as string[]))]
   if(newOcclusions.length||oldRoutes.size>=10001||newRoutes.size>=10001)throw new Error(newOcclusions.length?`引入 ${newOcclusions.length} 个新的路径遮挡`:'路径审计覆盖达到上限')
   const before=reflectDiagram(document,{maxIssues:10001,inspectUnconnected:true}).issues,after=reflectDiagram(candidate,{maxIssues:10001,inspectUnconnected:true}).issues
   const high=new Set(before.filter(i=>i.severity==='high').map(key)),regression=after.filter(i=>i.severity==='high'&&!high.has(key(i)))
   if(regression.length)regressionRefs=[...new Set(regression.flatMap(i=>i.ids))]
   if(before.length>=10001||after.length>=10001||regression.length)throw new Error(regression.length?`引入 ${regression.length} 个新的高严重度问题`:'审计覆盖达到上限，无法确认无回退')
  }catch(error){
   for(const f of fixes)if(f.state==='proposed'){f.type='repair_rejected';f.state='rejected';f.refs=[...new Set([...f.refs,...regressionRefs])];f.message=`局部扩高候选${error instanceof Error?error.message:String(error)}，未提交；需要上层调整。`}
   patches.length=0;candidate=document
  }
 }
 const plan:RepairPlan={id,document:candidate,patches,fixes,budget}
 plans.set(plan,{...(fixes.some(f=>f.state==='proposed')?{base:structuredClone(document),candidate:structuredClone(candidate)}:{}),fixes:structuredClone(fixes)})
 return plan
}
/** Called only after the host persistence ACK. A receipt is not a write or retry.
 * Derived DSL/cache changes do not affect geometry; exact shape equality does. */
export async function confirmRepair(plan:RepairPlan,savedDocument:BoardDocument,receipt:{acknowledged:boolean}):Promise<RepairRecord[]> {
 const trusted=plans.get(plan);if(!trusted)throw new Error('未注册的修复候选，不能确认已应用')
 const fixes=structuredClone(trusted.fixes)
 if(!fixes.some(f=>f.state==='proposed'))return fixes
 const matches=shapeSignature(savedDocument)===shapeSignature(trusted.candidate!),confirmed=receipt.acknowledged===true&&matches
 const before=await boardContentHash(trusted.base!),after=confirmed?await boardContentHash(savedDocument):undefined
 return fixes.map(f=>f.state!=='proposed'?f:{...f,state:confirmed?'applied':'unknown',persisted:confirmed,before_revision:before,...(after?{after_revision:after}:{}),message:confirmed?'候选已收到匹配版本的保存确认，质量以关联的新观察为准。':'保存未确认或版本不匹配，修复结果未知；先核对状态，不要重放原操作。'})
}
