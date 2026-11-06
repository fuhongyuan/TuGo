/** A reversible, host-neutral read view; context token budgeting belongs to the Loop. */
import {EvidenceError,type EvidencePort,type EvidenceScope} from './evidencePort.js'
import {observationVerdict,validateObservation} from './observationProtocol.js'
export type EvidenceViewRequest={path?:string[];offset?:number;limit?:number;findingOffset?:number;findingLimit?:number}
function integer(value:unknown,fallback:number,max=Number.MAX_SAFE_INTEGER){const n=value===undefined?fallback:value;if(!Number.isSafeInteger(n)||Number(n)<0||Number(n)>max)throw new EvidenceError('invalid');return Number(n)}
export async function readEvidenceView(port:EvidencePort,ref:string,scope:EvidenceScope,request:EvidenceViewRequest={}) {
 const offset=integer(request.offset,0),limit=integer(request.limit,50,12000),findingOffset=integer(request.findingOffset,0),findingLimit=integer(request.findingLimit,5,50)
 if(!limit||!findingLimit)throw new EvidenceError('invalid')
 const path=request.path??[]
 if(!Array.isArray(path)||path.length>32||path.some(p=>typeof p!=='string'||!p||['__proto__','prototype','constructor'].includes(p)))throw new EvidenceError('invalid')
 const entry=await port.get(ref,scope),record=validateObservation(entry.record)
 let selected=entry.payload
 for(const segment of path){if(!selected||typeof selected!=='object'||!Object.prototype.hasOwnProperty.call(selected,segment))throw new EvidenceError('invalid');selected=(selected as Record<string,unknown>)[segment]}
 const kind=Array.isArray(selected)?'array':typeof selected==='string'?'text':selected!==null&&typeof selected==='object'?'object':'scalar'
 if(kind!=='text'&&limit>100)throw new EvidenceError('invalid')
 const items:unknown[]=Array.isArray(selected)?selected:typeof selected==='string'?Array.from(selected):selected!==null&&typeof selected==='object'?Object.entries(selected):[selected]
 const blocking=record.findingTotals?.blocking??record.findings.filter(f=>f.severity==='blocking').length
 const warning=record.findingTotals?.warning??record.findings.filter(f=>f.severity==='warning').length
 return {
  evidenceRef:ref,observationId:record.id,scope:record.scope,target:record.target,source:record.source,createdAt:record.createdAt,expiresAt:entry.expiresAt,
  execution:record.execution,validity:record.validity,verdict:observationVerdict(record),checks:record.checks,sourceRange:record.range,
  findings:{total:blocking+warning,blocking,warning,storedTotal:record.findings.length,offset:findingOffset,items:record.findings.slice(findingOffset,findingOffset+findingLimit),nextOffset:findingOffset+findingLimit<record.findings.length?findingOffset+findingLimit:null},
  treatments:{total:record.treatments.length,items:record.treatments.slice(0,5)},references:record.references,
  page:{kind,path:[...path],offset,limit,storedTotal:items.length,items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null},
 }
}
