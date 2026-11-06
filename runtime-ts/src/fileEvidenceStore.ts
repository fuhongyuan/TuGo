/** Platform adapter. A dedicated versioned directory leaves existing databases untouched. */
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile,readdir,stat,link,unlink,open} from 'node:fs/promises'
import {join} from 'node:path'
import {validateObservation,type ObservationRecord} from './observationProtocol.js'
import {EvidenceError,type EvidencePort,type EvidenceScope,type EvidenceEntry} from './evidencePort.js'
const lockfile=createRequire(import.meta.url)('proper-lockfile') as {lock(path:string,options:Record<string,unknown>):Promise<()=>Promise<void>>}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
type Options={now?:()=>number;ttlMs?:number;maxBytes?:number;secretValues?:string[]}
type Envelope={formatVersion:1;data:string;sha256:string}
export class FileEvidenceStore implements EvidencePort {
 private readonly clock:()=>number
 private readonly ttlMs:number
 private readonly maxBytes:number
 private readonly secrets:string[]
 constructor(private readonly directory:string,options:Options={}) {
  this.clock=options.now||Date.now;this.ttlMs=options.ttlMs??7*24*60*60*1000;this.maxBytes=options.maxBytes??32*1024*1024
  if(!Number.isSafeInteger(this.ttlMs)||this.ttlMs<=0||!Number.isSafeInteger(this.maxBytes)||this.maxBytes<=0)throw new EvidenceError('invalid')
  this.secrets=[...(options.secretValues||[])].filter(Boolean)
 }
 reference(record:ObservationRecord) {return `evidence:${hash(JSON.stringify([record.scope.applicationId,record.scope.workspaceId,record.scope.runId,record.scope.conversationId||null,record.id]))}`}
 private path(ref:string) {if(!/^evidence:[a-f0-9]{64}$/.test(ref))throw new EvidenceError('invalid');return join(this.directory,ref.slice(9)+'.json')}
 private timestamp(){const n=this.clock();if(!Number.isFinite(n)||n<0)throw new EvidenceError('invalid');return n}
 private json(value:unknown):string {
  const seen=new Set<object>()
  const inspect=(v:unknown,key='')=>{
   if(/^(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)$/i.test(key))throw new EvidenceError('sensitive')
   if(typeof v==='string'&&(this.secrets.some(s=>v.includes(s))||/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{20,}/i.test(v)))throw new EvidenceError('sensitive')
   if(v===null||typeof v==='string'||typeof v==='boolean')return
   if(typeof v==='number'&&Number.isFinite(v))return
   if(typeof v!=='object'||!v||seen.has(v)||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))))throw new EvidenceError('invalid')
   if(Array.isArray(v) && (Object.keys(v).length!==v.length || Object.keys(v).some(k=>! /^(0|[1-9][0-9]*)$/.test(k))))throw new EvidenceError('invalid')
   if(Object.getOwnPropertySymbols(v).length)throw new EvidenceError('invalid')
   seen.add(v);for(const [k,item] of Object.entries(v))inspect(item,k);seen.delete(v)
  }
  inspect(value)
  return JSON.stringify(value)
 }
 private async syncDirectory() {
  // Node cannot open/fsync directory handles on Windows. File contents are
  // still flushed before exclusive publication; directory-entry power-loss
  // durability on Windows remains a filesystem guarantee, not ours.
  if(process.platform==='win32')return
  const handle=await open(this.directory,'r')
  try{await handle.sync()}finally{await handle.close()}
 }
 private async locked<T>(work:(assertHeld:()=>void)=>Promise<T>):Promise<T> {
  await mkdir(this.directory,{recursive:true,mode:0o700})
  let compromised=false,release:()=>Promise<void>
  try {release=await lockfile.lock(this.directory,{lockfilePath:join(this.directory,'.evidence.lock'),stale:10000,update:2000,retries:0,onCompromised:()=>{compromised=true}})}
  catch(e){if((e as NodeJS.ErrnoException).code==='ELOCKED')throw new EvidenceError('busy');throw e}
  const assertHeld=()=>{if(compromised)throw new EvidenceError('busy')}
  try {
   // No other compatible writer can own pending data while this lease is held.
   // Unknown legacy locks remain conservative rather than being guessed stale.
   if((await readdir(this.directory)).includes('.write-lock'))throw new EvidenceError('busy')
   for(const name of await readdir(this.directory))if(name==='.pending'||/^\.pending-[A-Za-z0-9-]+$/.test(name)){assertHeld();await unlink(join(this.directory,name))}
   await this.syncDirectory();assertHeld()
   return await work(assertHeld)
  }finally{await release()}
 }
 async put(input:ObservationRecord,payload:unknown):Promise<string> {
  try {
   let record:ObservationRecord
   try{record=validateObservation(input)}catch{throw new EvidenceError('invalid')}
   const ref=this.reference(record)
   const expiresAt=new Date(this.timestamp()+this.ttlMs).toISOString()
   const data=this.json({record,payload,expiresAt}),serialized=JSON.stringify({formatVersion:1,data,sha256:hash(data)} satisfies Envelope)
   await this.locked(async(assertHeld)=>{
    const names=(await readdir(this.directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))
    let bytes=0;for(const name of names)bytes+=(await stat(join(this.directory,name))).size
    if(bytes+Buffer.byteLength(serialized)>this.maxBytes)throw new EvidenceError('quota')
    const temporary=join(this.directory,'.pending-'+randomUUID())
    try {
     await writeFile(temporary,serialized,{flag:'wx',mode:0o600})
     const h=await open(temporary,'r+');try{await h.sync()}finally{await h.close()}
     assertHeld()
     await link(temporary,this.path(ref)) // exclusive immutable publish; no overwrite
     await this.syncDirectory()
    }finally{await unlink(temporary).catch(()=>undefined)}
   })
   return ref
  }catch(error){if(error instanceof EvidenceError)throw error;throw new EvidenceError('storage')}
 }
 private async read(ref:string):Promise<EvidenceEntry>{
  let raw:string
  try{raw=await readFile(this.path(ref),'utf8')}catch(error){if(error instanceof EvidenceError)throw error;throw new EvidenceError((error as NodeJS.ErrnoException).code==='ENOENT'?'not_found':'storage')}
  try{
   const envelope=JSON.parse(raw) as Envelope
   if(envelope.formatVersion!==1||typeof envelope.data!=='string'||envelope.sha256!==hash(envelope.data))throw new Error('format or checksum')
   const entry=JSON.parse(envelope.data) as EvidenceEntry
   entry.record=validateObservation(entry.record)
   if(this.reference(entry.record)!==ref||!Number.isFinite(Date.parse(entry.expiresAt)))throw new Error('identity or expiration')
   return entry
  }catch{throw new EvidenceError('corrupt')}
 }
 async get(ref:string,scope:EvidenceScope):Promise<EvidenceEntry>{
  const entry=await this.read(ref),owner=entry.record.scope
  if(owner.applicationId!==scope.applicationId||owner.workspaceId!==scope.workspaceId||owner.runId!==scope.runId||owner.conversationId!==scope.conversationId)throw new EvidenceError('forbidden')
  if(this.timestamp()>=Date.parse(entry.expiresAt))throw new EvidenceError('expired')
  this.json(entry) // Reject newly registered/rotated secret values on reads as well.
  return entry
 }
 async cleanup():Promise<number>{
  try{return await this.locked(async(assertHeld)=>{
   let count=0
   for(const name of await readdir(this.directory)){
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue
    const entry=await this.read('evidence:'+name.slice(0,-5))
    if(this.timestamp()>=Date.parse(entry.expiresAt)){assertHeld();await unlink(join(this.directory,name));count++}
   }
   await this.syncDirectory();return count
  })}catch(error){if(error instanceof EvidenceError)throw error;throw new EvidenceError('storage')}
 }
}
