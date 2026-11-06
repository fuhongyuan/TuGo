/** Deterministic non-drawing domain used only by tests, never seeded to users. */
import {DomainContractError,type DomainAdapter,type DomainContext,type DomainResult} from '../../src/domainObservation.js'
export function queryFixture(options:{mode?:'complete'|'page'|'partial'|'summary';knownTotal?:boolean;count?:number;textSize?:number}={}) {
 const rows=Array.from({length:options.count??23},(_,id)=>({id,value:`row-${id}${'x'.repeat(options.textSize??0)}`}))
 let calls=0
 const adapter:DomainAdapter={id:'fixture.query',version:'1',tools:[{name:'fixture_query',description:'查询测试数据，明确明细或汇总；分页不表示已交付全部。',inputSchema:{type:'object',required:['representation'],additionalProperties:false,properties:{representation:{enum:['detail','summary']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}}},timeoutMs:1000,observe:async(args,context)=>{
  calls++
  if(!['detail','summary'].includes(String(args.representation)))throw new DomainContractError('explicit representation required')
  const mode=options.mode??'page',summary=args.representation==='summary'
  if(mode==='summary'&&!summary)throw new DomainContractError('detail request cannot be silently replaced by summary')
  const offset=Number(args.offset??0),limit=Number(args.limit??5)
  const selected=summary?[]:mode==='complete'?rows:rows.slice(offset,offset+limit)
  const known=options.knownTotal!==false
  const kind=summary?'summary':mode==='complete'?'complete':mode==='partial'?'partial':'page'
  const more=!summary&&kind!=='complete'&&offset+selected.length<rows.length
  const detail={tool:'fixture_query',args:{representation:'detail',offset:more?offset+selected.length:0,limit}}
  const record:DomainResult['record']={schemaVersion:1,id:`${context.callId}-${offset}`,scope:{...context.scope},source:{component:'fixture.query',layer:'domain'},target:{id:'fixture-table',revision:'1',sessionId:context.sessionId},createdAt:context.createdAt,execution:{state:'succeeded',callId:context.callId},validity:'current',range:{kind,returned:selected.length,...(known?{total:rows.length}:{}),...(more?{nextRef:`fixture_query:offset:${offset+selected.length}`}:{})},checks:[{name:'query-snapshot',status:kind==='complete'?'passed':'unknown',coverage:kind==='complete'?'all fixture rows':'only returned rows; no claim about unseen rows'}],findings:[],treatments:[],references:[]}
  return {record,data:{rows:selected,...(summary?{aggregate:{known_count:known?rows.length:null},businessRepresentation:'summary'}:{businessRepresentation:'detail'})},note:summary?'明确请求的汇总；尚未交付明细。':kind==='complete'?'此快照明细完整。':`${kind}结果，只交付本批；剩余明细尚未交付，总数${known?'已知':'未知'}。`,...(kind!=='complete'?{detail}: {})}
 }}]}
 return {adapter,rows,get calls(){return calls}}
}
