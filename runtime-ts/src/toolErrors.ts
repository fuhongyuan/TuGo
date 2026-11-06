export type ToolErrorCategory='validation'|'timeout'|'unavailable'|'execution'
export class ToolExecutionError extends Error {
 constructor(message:string,readonly category:ToolErrorCategory,readonly repairable=false){super(message);this.name='ToolExecutionError'}
}
