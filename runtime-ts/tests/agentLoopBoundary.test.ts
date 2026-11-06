// @vitest-environment node
import {describe,it,expect} from 'vitest'
import {readFile} from 'node:fs/promises'
import {domainOnlyApplication} from '../src/runtimeApplication.js'
describe('Agent Loop application boundary',()=>{
 it('keeps product observation/materialization and native UI out of the loop source',async()=>{
  const source=await readFile(new URL('../src/agentLoop.ts',import.meta.url),'utf8')
  expect(source).not.toMatch(/board_[a-z]|pptx|PPT|画板|from ['"].*(?:\/tugo\/|\/tools\.js|\/observation\.js|localizedPrompts|electron)/)
  expect(source).not.toMatch(/HTMLElement|SVGElement|querySelector|getComputedStyle|window\./)
  const facade=await readFile(new URL('../src/runtime.ts',import.meta.url),'utf8')
  expect(facade).toContain('extends AgentRuntimeCore');expect(facade).not.toContain('while (')
 })
 it('has no implicit application tool or live observer in the generic no-UI host',async()=>{
  const assembly=domainOnlyApplication({} as never)
  expect(await assembly.tools.resolve('agent')).toEqual([]);expect(assembly.application.id).toBe('generic');expect(assembly.application.observe).toBeUndefined()
  await expect(assembly.tools.execute({} as never,{},{} as never,new AbortController().signal)).rejects.toThrow('No application tool executor registered')
 })
})
