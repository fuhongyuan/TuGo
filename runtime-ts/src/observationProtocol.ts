/** Host-neutral evidence contract. No product, persistence, DOM or model dependencies. */
export type ObservationLayer = 'loop' | 'execution' | 'domain' | 'environment'
export type ExecutionState = 'not_started' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
export type CheckStatus = 'passed' | 'failed' | 'unknown' | 'not_checked' | 'stale'
export type ObservationRecord = {
  schemaVersion: 1
  id: string
  scope: { applicationId: string; workspaceId: string; runId: string; conversationId?: string }
  source: { component: string; layer: ObservationLayer }
  target: { id: string; revision: string; sessionId: string; rendererVersion?: string }
  createdAt: string
  execution: { state: ExecutionState; callId: string; attemptId?: string; receiptRef?: string }
  validity: 'current' | 'stale' | 'unknown'
  range: { kind: 'complete' | 'page' | 'summary' | 'partial'; returned: number; total?: number; nextRef?: string }
  checks: Array<{name: string; status: CheckStatus; coverage: string}>
  findings: Array<{id: string; code: string; severity: 'blocking' | 'warning'; message: string; refs: string[]; owner: ObservationLayer; evidenceRef?: string}>
  findingTotals?: {blocking:number;warning:number;total:number}
  treatments: Array<{id: string; kind: 'retry' | 'query_status' | 'filter' | 'compress' | 'repair' | 'escalate'; state: 'proposed' | 'applied' | 'rejected' | 'failed'; persisted: boolean; refs: string[]; message: string; verificationRef?: string}>
  references: string[]
  causeId?: string
}
const layers = ['loop','execution','domain','environment']
const fail = (path: string): never => { throw new Error(`Invalid observation: ${path}`) }
function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return fail(path)
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`)
  return value as Record<string,unknown>
}
function string(value: unknown, path: string) { if(typeof value !== 'string' || !value.trim())fail(path) }
function optionalString(obj: Record<string,unknown>,key: string,path: string) {if(key in obj)string(obj[key],`${path}.${key}`)}
function choice(value:unknown,values:readonly string[],path:string) {if(typeof value!=='string'||!values.includes(value))fail(path)}
function array(value:unknown,path:string):unknown[]{if(!Array.isArray(value))return fail(path);return value}
function strings(value:unknown,path:string){for(const item of array(value,path))string(item,path)}
function count(value:unknown,path:string){if(!Number.isSafeInteger(value)||Number(value)<0)fail(path)}
/** Validates both shape and semantic invariants, then returns a detached JSON record. */
export function validateObservation(value:unknown):ObservationRecord {
  const r=object(value,'record',['schemaVersion','id','scope','source','target','createdAt','execution','validity','range','checks','findings','treatments','references','causeId','findingTotals'])
  if(r.schemaVersion!==1)fail('schemaVersion')
  string(r.id,'id');string(r.createdAt,'createdAt')
  if(!/^\d{4}-\d{2}-\d{2}T/.test(String(r.createdAt))||!Number.isFinite(Date.parse(String(r.createdAt))))fail('createdAt')
  optionalString(r,'causeId','record')
  const scope=object(r.scope,'scope',['applicationId','workspaceId','runId','conversationId'])
  for(const key of ['applicationId','workspaceId','runId'])string(scope[key],`scope.${key}`)
  optionalString(scope,'conversationId','scope')
  const source=object(r.source,'source',['component','layer']);string(source.component,'source.component');choice(source.layer,layers,'source.layer')
  const target=object(r.target,'target',['id','revision','sessionId','rendererVersion'])
  for(const key of ['id','revision','sessionId'])string(target[key],`target.${key}`)
  optionalString(target,'rendererVersion','target')
  const execution=object(r.execution,'execution',['state','callId','attemptId','receiptRef'])
  choice(execution.state,['not_started','succeeded','failed','unknown','cancelled'],'execution.state');string(execution.callId,'execution.callId')
  optionalString(execution,'attemptId','execution');optionalString(execution,'receiptRef','execution')
  choice(r.validity,['current','stale','unknown'],'validity')
  const range=object(r.range,'range',['kind','returned','total','nextRef'])
  choice(range.kind,['complete','page','summary','partial'],'range.kind');count(range.returned,'range.returned')
  if('total'in range){count(range.total,'range.total');if(Number(range.returned)>Number(range.total))fail('range.returned > total')}
  optionalString(range,'nextRef','range')
  if(range.kind==='complete' && ('nextRef'in range || ('total'in range&&range.returned!==range.total)))fail('range.complete')
  const checks=array(r.checks,'checks'),names=new Set<string>()
  for(const raw of checks){const c=object(raw,'check',['name','status','coverage']);string(c.name,'check.name');string(c.coverage,'check.coverage');choice(c.status,['passed','failed','unknown','not_checked','stale'],'check.status');if(names.has(String(c.name)))fail('duplicate check');names.add(String(c.name))}
  const findings=array(r.findings,'findings'),findingIds=new Set<string>()
  for(const raw of findings){const f=object(raw,'finding',['id','code','severity','message','refs','owner','evidenceRef']);for(const key of ['id','code','message'])string(f[key],`finding.${key}`);choice(f.severity,['blocking','warning'],'finding.severity');choice(f.owner,layers,'finding.owner');strings(f.refs,'finding.refs');optionalString(f,'evidenceRef','finding');if(findingIds.has(String(f.id)))fail('duplicate finding');findingIds.add(String(f.id))}
  if('findingTotals'in r){
    const totals=object(r.findingTotals,'findingTotals',['blocking','warning','total'])
    for(const key of ['blocking','warning','total'])count(totals[key],`findingTotals.${key}`)
    const actual=findings.map(f=>f as Record<string,unknown>)
    if(Number(totals.total)!==Number(totals.blocking)+Number(totals.warning)||Number(totals.blocking)<actual.filter(f=>f.severity==='blocking').length||Number(totals.warning)<actual.filter(f=>f.severity==='warning').length)fail('findingTotals inconsistent')
  }
  const treatments=array(r.treatments,'treatments'),treatmentIds=new Set<string>()
  for(const raw of treatments){const t=object(raw,'treatment',['id','kind','state','persisted','refs','message','verificationRef']);string(t.id,'treatment.id');string(t.message,'treatment.message');choice(t.kind,['retry','query_status','filter','compress','repair','escalate'],'treatment.kind');choice(t.state,['proposed','applied','rejected','failed'],'treatment.state');if(typeof t.persisted!=='boolean'||(t.persisted&&t.state!=='applied'))fail('treatment.persisted');strings(t.refs,'treatment.refs');optionalString(t,'verificationRef','treatment');if(treatmentIds.has(String(t.id)))fail('duplicate treatment');treatmentIds.add(String(t.id))}
  strings(r.references,'references')
  return JSON.parse(JSON.stringify(r)) as ObservationRecord
}
/** This verdict is scoped to the declared checks; it is never a global semantic guarantee. */
export function observationVerdict(input:ObservationRecord):'passed'|'needs_action'|'unverified'|'stale' {
  const r=validateObservation(input)
  if(r.validity==='stale'||r.checks.some(c=>c.status==='stale'))return 'stale'
  if((r.findingTotals?.blocking??0)>0||r.findings.some(f=>f.severity==='blocking')||r.checks.some(c=>c.status==='failed'))return 'needs_action'
  if((r.findingTotals?.total??0)>r.findings.length||r.validity!=='current'||r.execution.state!=='succeeded'||r.range.kind!=='complete'||!r.checks.length||r.checks.some(c=>c.status!=='passed'))return 'unverified'
  return 'passed'
}
