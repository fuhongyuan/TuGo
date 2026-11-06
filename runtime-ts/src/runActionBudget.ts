/** One serializable run-level ceiling, shared by otherwise independent layers. */
export type RunActionBudget={runId:string;limit:number;deadline:number;used:number;byLayer:Record<string,number>}
export function reserveRunAction(budget:RunActionBudget,layer:string,now:number,signal?:AbortSignal) {
 if(signal?.aborted)throw new DOMException('Cancelled','AbortError')
 if(!Number.isSafeInteger(budget.limit)||budget.limit<1||!Number.isSafeInteger(budget.used)||budget.used<0||!Number.isFinite(budget.deadline)||!Number.isFinite(now)||!layer)throw new Error('Invalid run action budget')
 if(now>=budget.deadline||budget.used>=budget.limit)throw new Error('共享运行处理预算耗尽；停止新动作，已保存操作不会重放，剩余问题未验证。')
 budget.used++;budget.byLayer[layer]=(budget.byLayer[layer]||0)+1
}
