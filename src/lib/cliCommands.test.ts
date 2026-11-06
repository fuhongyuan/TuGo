import { describe, it, expect, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { runCliCommand, type CliDependencies } from './cliCommands'
import {commit,undo,redo} from './boardState'
import type {BoardDocument,BoardOperation} from '../types'
import { emptyDocument } from '../types'
import { mermaidGoldenFixtures } from './mermaidGoldenFixtures'
vi.stubGlobal('crypto', webcrypto)
function fixture() {
  const document = emptyDocument()
  const save = vi.fn()
  const deps = { bridge: {}, project: () => ({ id: 'p', name: 'test', document }), activeHistory: () => ({ id: 'p', history: { current: document, past: [], future: [] } }), save } as unknown as CliDependencies
  return { deps, save }
}
describe('CLI renderer commands', () => {
  it('reports repair receipts only after save and keeps one undo step with causal revalidation',async()=>{
    let history={current:emptyDocument(),past:[] as BoardDocument[],future:[] as BoardDocument[]}
    const save=vi.fn(async(_id:string,next:BoardDocument)=>{history=commit(history,[{op:'replace_document',document:{...next,dsl:{kind:'mermaid',source:'flowchart LR\n tiny[derived]',updatedAt:'2026-10-30T00:00:00Z'}}}])})
    const deps={bridge:{},causeId:'cli-cause',project:()=>({id:'p',name:'test',document:history.current}),activeHistory:()=>({id:'p',history}),save,undoRedo:async(_id:string,isRedo:boolean)=>{history=isRedo?redo(history):undo(history);return history.current}} as unknown as CliDependencies
    const operations:BoardOperation[]=[{op:'add_element',element:{id:'tiny',kind:'rectangle',x:0,y:0,width:120,height:20,text:'第一行\n第二行',fill:'#fff',stroke:'#000',strokeWidth:2,fontSize:16}}]
    const result=await runCliCommand('board.apply',{project:'p',operations},deps) as {observation:{observation_id:string;cause_id:string;verdict:string;automatic_fixes:Array<{state:string;persisted:boolean;verification_ref:string;after_revision:string}>};revision:string}
    expect(save).toHaveBeenCalledOnce();expect(history.past).toHaveLength(1);expect(history.current.elements[0].height).toBeGreaterThan(20)
    expect(result.observation.cause_id).toBe('cli-cause');expect(result.observation.verdict).not.toBe('stale');expect(result.observation.automatic_fixes[0]).toMatchObject({state:'applied',persisted:true,verification_ref:result.observation.observation_id,after_revision:result.revision})
    const snapshot=JSON.stringify(history.current)
    await runCliCommand('board.observe',{project:'p'},deps);expect(save).toHaveBeenCalledOnce();expect(JSON.stringify(history.current)).toBe(snapshot)
    await runCliCommand('board.undo',{project:'p'},deps);expect(history.current.elements).toHaveLength(0)
    await runCliCommand('board.redo',{project:'p'},deps);expect(JSON.stringify(history.current)).toBe(snapshot)
  })
  it('does not retry a failed persistence ACK or return an applied repair observation',async()=>{
    const {deps}=fixture();const save=vi.fn(async()=>{throw new Error('ACK lost; outcome unknown')});deps.save=save
    await expect(runCliCommand('board.apply',{project:'p',operations:[{op:'add_element',element:{id:'n',kind:'rectangle',x:0,y:0,width:120,height:20,text:'第一行\n第二行',fill:'#fff',stroke:'#000',strokeWidth:2,fontSize:16}}]},deps)).rejects.toThrow('outcome unknown')
    expect(save).toHaveBeenCalledOnce()
  })
  it('accepts the shared Mermaid corpus through the actual command boundary', async () => {
    for (const item of mermaidGoldenFixtures) {
      const { deps, save } = fixture()
      try { await runCliCommand('board.import', { project: 'p', format: 'mermaid', content: item.source }, deps) } catch (error) { throw new Error(`${item.grammar}: ${error}`) }
      expect(save, item.grammar).toHaveBeenCalledOnce()
    }
  })
  it('rejects invalid batches and destructive import without saving', async () => {
    const { deps, save } = fixture()
    await expect(runCliCommand('board.apply', { project: 'p', operations: [{ op: 'unknown' }] }, deps)).rejects.toThrow()
    await expect(runCliCommand('board.import', { project: 'p', format: 'mermaid', content: 'flowchart LR\nA --> B', replace: true }, deps)).rejects.toThrow('confirm')
    expect(save).not.toHaveBeenCalled()
  })
  it('imports JSON and PlantUML and rejects dangling edges', async () => {
    const { deps, save } = fixture()
    await runCliCommand('board.import', { project: 'p', format: 'plantuml', content: '@startuml\nAlice -> Bob: hello\n@enduml' }, deps)
    await runCliCommand('board.import', { project: 'p', format: 'json', content: JSON.stringify(emptyDocument()), replace: true, confirm: true }, deps)
    await expect(runCliCommand('board.import', { project: 'p', format: 'json', content: JSON.stringify({ ...emptyDocument(), edges: [{ id: 'e', from: 'missing', to: 'missing' }] }) }, deps)).rejects.toThrow('端点')
    expect(save).toHaveBeenCalledTimes(2)
  })
})
