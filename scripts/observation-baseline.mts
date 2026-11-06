/** Deterministic no-observation Agent Loop baseline. No network or real credentials. */
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {performance} from 'node:perf_hooks'
import assert from 'node:assert/strict'
import {TuGoRuntime} from '../runtime-ts/src/runtime.ts'
import type {RuntimeToHost} from '../runtime-ts/src/contracts.ts'

const iterations=30, warmup=5
const root=await mkdtemp(join(tmpdir(),'tugo-observation-baseline-'))
const originalFetch=globalThis.fetch
let calls=0,bytes=0,end:(()=>void)|undefined,failed=false
const runtime=new TuGoRuntime(root,join(root,'defaults.json'),(message:RuntimeToHost)=>{
 bytes+=Buffer.byteLength(JSON.stringify(message))
 if(message.kind==='tool_call')throw new Error('baseline unexpectedly invoked a tool')
 if(message.kind==='event'&&message.event.type==='session.failed')failed=true
 if(message.kind==='stream_end')end?.()
})
try {
 const defaults=JSON.parse(await readFile('templates/runtime-defaults.json','utf8'))
 defaults.agent.middleware={...defaults.agent.middleware,title:{enabled:false},plan:{enabled:false},maxSteps:4}
 await writeFile(join(root,'defaults.json'),JSON.stringify(defaults))
 globalThis.fetch=async()=>{calls++;return new Response('data: '+JSON.stringify({choices:[{delta:{content:'基线完成'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})}
 await runtime.start()
 runtime.setSecrets({'benchmark-secret':'synthetic-not-a-real-key'})
 const model=await runtime.http('POST','/api/models',{name:'fixture',provider_id:'openai',model:'fixture',display_name:'fixture',extra_config:{api_key_ref:'benchmark-secret',base_url:'https://example.invalid/v1'}}) as Record<string,unknown>
 runtime.repository.recordModelProbe(String(model.model_id),true,'deterministic fixture')
 const resources=await runtime.http('POST','/api/runtime/bootstrap',{model_id:model.model_id}) as {agent:Record<string,unknown>}
 const times:number[]=[],sizes:number[]=[],memory:number[]=[]
 for(let i=0;i<iterations+warmup;i++){
  const thread=await runtime.http('POST','/api/threads',{assistant_id:resources.agent.agent_id}) as {thread_id:string}
  const before=bytes,started=performance.now()
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('baseline timeout')),5000)
   end=()=>{clearTimeout(timer);resolve()}
   runtime.startRun({thread_id:thread.thread_id,agent_id:String(resources.agent.agent_id),content:'返回基线完成，不调用工具',subscription_id:'baseline-'+i})
  })
  assert.equal(failed,false)
  if(i>=warmup){times.push(performance.now()-started);sizes.push(bytes-before);memory.push(process.memoryUsage().rss)}
 }
 assert.equal(calls,iterations+warmup)
 times.sort((a,b)=>a-b)
 console.log(JSON.stringify({scenario:'fresh-thread-single-model-turn-no-observation',node:process.version,warmup,iterations,p50_ms:times[Math.ceil(iterations*.50)-1],p95_ms:times[Math.ceil(iterations*.95)-1],peak_sampled_rss_bytes:Math.max(...memory),event_bytes_min:Math.min(...sizes),event_bytes_max:Math.max(...sizes),model_calls:calls,tool_calls:0,network:'stubbed',method:'fresh thread per run; measure startRun through stream_end; exclude bootstrap and thread creation; RSS sampled after every run'},null,2))
} finally {await runtime.close();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true})}
