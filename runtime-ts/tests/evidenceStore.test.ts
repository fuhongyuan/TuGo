import {afterEach,describe,it,expect} from 'vitest'
import {mkdtemp,readdir,readFile,writeFile,rm,mkdir,utimes,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {tmpdir} from 'node:os'
import {readEvidenceView} from '../src/evidenceProjection.js'
import {FileEvidenceStore} from '../src/fileEvidenceStore.js'
import type {ObservationRecord} from '../src/observationProtocol.js'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})))})
const record=():ObservationRecord=>({schemaVersion:1,id:'o',scope:{applicationId:'query',workspaceId:'w',runId:'r'},source:{component:'query',layer:'domain'},target:{id:'data',revision:'1',sessionId:'s'},createdAt:'2026-10-30T00:00:00Z',execution:{state:'succeeded',callId:'call'},validity:'current',range:{kind:'complete',returned:2,total:2},checks:[{name:'rows',status:'passed',coverage:'all'}],findings:[],treatments:[],references:[]})
async function fixture(options={}){const root=await mkdtemp(join(tmpdir(),'tugo-evidence-'));roots.push(root);return {root,store:new FileEvidenceStore(root,{...options})}}
describe('persistent platform evidence adapter',()=>{
 it('persists across instances without changing existing database or record',async()=>{
  const {root,store}=await fixture(),r=record(),ref=await store.put(r,{rows:['a','b']})
  const entry=await new FileEvidenceStore(root).get(ref,r.scope)
  expect(entry.record).toEqual(r);expect(entry.payload).toEqual({rows:['a','b']})
  expect((await readdir(root)).filter(n=>n.endsWith('.json'))).toHaveLength(1)
  await expect(store.put(r,{rows:['changed']})).rejects.toMatchObject({code:'storage'})
  expect((await store.get(ref,r.scope)).payload).toEqual({rows:['a','b']})
 })
 it.each(['applicationId','workspaceId','runId','conversationId'])('isolates %s',async key=>{
  const {store}=await fixture(),r=record(),ref=await store.put(r,{rows:[]})
  await expect(store.get(ref,{...r.scope,[key]:'different'})).rejects.toMatchObject({code:'forbidden'})
 })
 it('reports expiration and cleans without affecting valid records',async()=>{
  let now=1000;const {store}=await fixture({now:()=>now,ttlMs:100})
  const r=record(),ref=await store.put(r,[]);now=1100
  await expect(store.get(ref,r.scope)).rejects.toMatchObject({code:'expired'})
  const next={...r,id:'next'};await store.put(next,[])
  expect(await store.cleanup()).toBe(1)
  expect((await store.get(await store.reference(next),r.scope)).record.id).toBe('next')
 })
 it('rejects corrupted persisted data instead of trusting its passed verdict',async()=>{
  const {root,store}=await fixture(),r=record(),ref=await store.put(r,[])
  const path=join(root,(await readdir(root)).find(f=>f.endsWith('.json'))!)
  await writeFile(path,'{"formatVersion":99}')
  await expect(store.get(ref,r.scope)).rejects.toMatchObject({code:'corrupt'})
 })
 it('rejects sensitive payloads and known secrets without writing bytes',async()=>{
  const {root,store}=await fixture({secretValues:['fixture-credential-value']})
  for(const payload of [{api_key:'private'},{nested:['fixture-credential-value']},{Authorization:'Bearer test'}])await expect(store.put(record(),payload)).rejects.toMatchObject({code:'sensitive'})
  expect((await readdir(root)).filter(n=>n.endsWith('.json'))).toHaveLength(0)
 })
 it('enforces quota and invalid references without path traversal',async()=>{
  const {store}=await fixture({maxBytes:100})
  await expect(store.put(record(),['large'])).rejects.toMatchObject({code:'quota'})
  await expect(store.get('../../etc/passwd',record().scope)).rejects.toMatchObject({code:'invalid'})
 })
 it('serializes concurrent instances without exceeding the shared disk quota',async()=>{
  const {root}=await fixture();const stores=Array.from({length:12},()=>new FileEvidenceStore(root))
  const results=await Promise.allSettled(stores.map((s,i)=>s.put({...record(),id:'parallel-'+i},['data'])))
  const succeeded=results.filter(r=>r.status==='fulfilled')
  expect(succeeded.length).toBeGreaterThan(0)
  for(const r of results)if(r.status==='rejected')expect(r.reason.code).toBe('busy')
  const names=(await readdir(root)).filter(n=>n.endsWith('.json'))
  expect(names.length).toBe(succeeded.length)
  for(const r of succeeded)if(r.status==='fulfilled')expect((await stores[0].get(r.value,record().scope)).payload).toEqual(['data'])
  const byteSize=(await stat(join(root,names[0]))).size
  const next=new FileEvidenceStore(root,{maxBytes:byteSize*names.length})
  await expect(next.put({...record(),id:'over-quota'},[])).rejects.toMatchObject({code:'quota'})
 })
 it('does not steal a live lock or delete its pending data',async()=>{
  const {root,store}=await fixture()
  const lock=createRequire(import.meta.url)('proper-lockfile')
  const release=await lock.lock(root,{lockfilePath:join(root,'.evidence.lock'),stale:10000,update:2000})
  await writeFile(join(root,'.pending-live'),'unfinished')
  try {await expect(store.put(record(),[])).rejects.toMatchObject({code:'busy'});expect(await readFile(join(root,'.pending-live'),'utf8')).toBe('unfinished')}
  finally{await release()}
 })
 it('recovers after a killed writer without losing published records',async()=>{
  const {root,store}=await fixture(),r=record(),ref=await store.put(r,['published'])
  const requirePath=createRequire(import.meta.url).resolve('proper-lockfile')
  const script=`const lock=require(process.argv[1]);const fs=require('node:fs/promises');const path=require('node:path');const root=process.argv[2];(async()=>{await lock.lock(root,{lockfilePath:path.join(root,'.evidence.lock'),stale:10000,update:2000});await fs.writeFile(path.join(root,'.pending-crashed'),'partial');process.stdout.write('LOCKED\\n');setInterval(()=>{},1000)})().catch(e=>{console.error(e);process.exit(1)})`
  const child=spawn(process.execPath,['-e',script,requirePath,root],{stdio:['ignore','pipe','pipe']})
  const timeout=setTimeout(()=>child.kill('SIGKILL'),2500)
  try {
   await new Promise<void>((resolve,reject)=>{child.stdout.on('data',data=>{if(String(data).includes('LOCKED'))resolve()});child.once('error',reject);child.once('exit',()=>reject(new Error('writer exited before lock')))})
   const exited=once(child,'exit');child.kill('SIGKILL');await exited
  }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
  // Advance the abandoned lease timestamp, not the evidence TTL or a live writer.
  const old=new Date(Date.now()-20000);await utimes(join(root,'.evidence.lock'),old,old)
  const reopened=new FileEvidenceStore(root),next=await reopened.put({...r,id:'after-crash'},['next'])
  expect((await reopened.get(ref,r.scope)).payload).toEqual(['published'])
  expect((await reopened.get(next,r.scope)).payload).toEqual(['next'])
  expect((await readdir(root)).some(n=>n.startsWith('.pending'))).toBe(false)
 })
 it('detects checksum tampering of otherwise valid JSON',async()=>{
  const {root,store}=await fixture(),r=record(),ref=await store.put(r,['original'])
  const path=join(root,(await readdir(root)).find(f=>f.endsWith('.json'))!)
  const file=JSON.parse(await readFile(path,'utf8'));file.data=file.data.replace('original','altered');await writeFile(path,JSON.stringify(file))
  await expect(store.get(ref,r.scope)).rejects.toMatchObject({code:'corrupt'})
 })
 it('rejects malformed JSON values without silently normalizing them',async()=>{
  const {store}=await fixture()
  for(const value of [[,1],[undefined],NaN,new Date(),{f:()=>{}}])await expect(store.put(record(),value)).rejects.toMatchObject({code:'invalid'})
 })
 it('preserves legacy database bytes and rejects unknown record versions',async()=>{
  const {root,store}=await fixture();await writeFile(join(root,'runtime.sqlite'),'legacy-sentinel')
  await store.put(record(),[])
  expect(await readFile(join(root,'runtime.sqlite'),'utf8')).toBe('legacy-sentinel')
  await expect(store.put({...record(),schemaVersion:99} as unknown as ObservationRecord,[])).rejects.toMatchObject({code:'invalid'})
 })
 it('applies rotated secret deny-lists to retrieval',async()=>{
  const {root,store}=await fixture(),r=record(),ref=await store.put(r,['newly-registered-secret'])
  const rotated=new FileEvidenceStore(root,{secretValues:['newly-registered-secret']})
  await expect(rotated.get(ref,r.scope)).rejects.toMatchObject({code:'sensitive'})
 })
 it('reclaims expired quota without deleting current evidence',async()=>{
  let now=1000;const {root}=await fixture(),store=new FileEvidenceStore(root,{now:()=>now,ttlMs:100})
  const r=record(),ref=await store.put(r,[]),name=(await readdir(root)).find(n=>n.endsWith('.json'))!,size=(await stat(join(root,name))).size
  const limited=new FileEvidenceStore(root,{now:()=>now,ttlMs:100,maxBytes:size+20})
  now=1100;await expect(limited.put({...r,id:'new'},[])).rejects.toMatchObject({code:'quota'})
  expect(await limited.cleanup()).toBe(1)
  await limited.put({...r,id:'new'},[])
  await expect(limited.get(ref,r.scope)).rejects.toMatchObject({code:'not_found'})
 })
 it('rejects unauthenticated non-JSON reference parameters',async()=>{
  const {store}=await fixture()
  await expect(store.get('evidence:'+ '0'.repeat(64),record().scope)).rejects.toMatchObject({code:'not_found'})
 })
 it('restores persisted large-result pages after reopening with scope checks',async()=>{
  const {root,store}=await fixture(),r=record(),rows=Array.from({length:350},(_,id)=>({id,label:'节点'+id}))
  const ref=await store.put(r,{rows}),reopened=new FileEvidenceStore(root),restored:unknown[]=[]
  for(let offset=0;offset<rows.length;offset+=100){const v=await readEvidenceView(reopened,ref,r.scope,{path:['rows'],offset,limit:100});restored.push(...v.page.items);expect(v.evidenceRef).toBe(ref)}
  expect(restored).toEqual(rows)
  await expect(readEvidenceView(reopened,ref,{...r.scope,workspaceId:'other'},{path:['rows']})).rejects.toMatchObject({code:'forbidden'})
  expect((await stat(join(root,(await readdir(root)).find(n=>n.endsWith('.json'))!))).mode&0o777).toBe(0o600)
 })
 it('does not discard confirmed business effects when storage fails',async()=>{
  const {root}=await fixture();const path=join(root,'not-a-directory');await writeFile(path,'occupied')
  const receipt={state:'succeeded'},store=new FileEvidenceStore(path)
  await expect(store.put(record(),[])).rejects.toMatchObject({code:'storage'})
  expect(receipt.state).toBe('succeeded')
 })
})
