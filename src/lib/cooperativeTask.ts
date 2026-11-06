/** Yield CPU-heavy pure calculations without changing their deterministic order. */
export async function runCooperatively<T>(steps:Generator<void,T,unknown>,signal?:AbortSignal):Promise<T> {
 let last=performance.now()
 try{while(true){
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError')
  const next=steps.next();if(next.done)return next.value
  if(performance.now()-last>=8){await new Promise(resolve=>setTimeout(resolve,0));last=performance.now()}
 }}finally{steps.return(undefined as never)}
}
