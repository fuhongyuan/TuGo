/** Kernel scheduling primitives. No product tool names or renderer handles. */
export type ObservationTarget={application:string;workspace:string;session:string;target:string;revision:string;scope:string[];mode:string}
export type ObservationTriggerInput={dirty:boolean;changes:number;risk:boolean;delivery:boolean;unavailable:boolean;rounds:number;maxRounds:number;changeThreshold:number}
export function observationTrigger(input:ObservationTriggerInput):'delivery'|'risk'|'changes'|undefined {
 if(input.unavailable||input.rounds>=input.maxRounds)return undefined
 if(input.delivery)return 'delivery'
 if(!input.dirty)return undefined
 if(input.risk)return 'risk'
 return input.changes>=input.changeThreshold?'changes':undefined
}
const keyOf=(target:ObservationTarget)=>JSON.stringify([target.application,target.workspace,target.session,target.target,target.revision,[...new Set(target.scope)].sort(),target.mode])
const cancelled=()=>new DOMException('Cancelled','AbortError')
/** In-flight only: completed evidence must be revalidated, not cached as passed.
 * A consumer may cancel its own wait; host work is aborted only when all leave.
 * Budget reservation belongs inside execute, which runs once per shared task. */
export class ObservationScheduler<T> {
 private tasks=new Map<string,{controller:AbortController;promise:Promise<T>;waiters:number}>()
 request(target:ObservationTarget,execute:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T> {
  if(signal?.aborted)return Promise.reject(cancelled())
  const key=keyOf(target)
  let task=this.tasks.get(key)
  if(!task){
   const controller=new AbortController()
   const entry={controller,waiters:0,promise:undefined as unknown as Promise<T>}
   entry.promise=Promise.resolve().then(()=>{if(controller.signal.aborted)throw cancelled();return execute(controller.signal)}).finally(()=>{if(this.tasks.get(key)===entry)this.tasks.delete(key)})
   this.tasks.set(key,entry);task=entry
  }
  const shared=task;shared.waiters++
  return new Promise<T>((resolve,reject)=>{
   let settled=false
   const finish=(action:()=>void)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);shared.waiters--;action()}
   const abort=()=>finish(()=>{reject(cancelled());if(shared.waiters===0){shared.controller.abort();if(this.tasks.get(key)===shared)this.tasks.delete(key)}})
   signal?.addEventListener('abort',abort,{once:true})
   shared.promise.then(value=>{if(settled)return;try{const copy=structuredClone(value);finish(()=>resolve(copy))}catch(error){finish(()=>reject(error))}},error=>finish(()=>reject(error)))
  })
 }
}
