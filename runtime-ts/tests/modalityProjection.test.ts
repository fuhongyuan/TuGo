import {describe,it,expect} from 'vitest'
import {projectModalities,visionMode} from '../src/modalityProjection.js'
const image={attachmentId:'image',name:'i.png',mimeType:'image/png',dataBase64:'private-image-data'}
const tools=['view_image','board_capture_image','board_observe','read_file'].map(name=>({name,requiresVision:['view_image','board_capture_image'].includes(name),description:name,source:'builtin' as const,inputSchema:{type:'object'},timeoutMs:1000}))
describe('model modality projection',()=>{
 it.each([undefined,null,'true',1,{},[]])('treats undeclared or malformed capabilities as unknown (%s)',v=>expect(visionMode(v)).toBe('unknown'))
 it.each([false,undefined,null])('does not send images, invent inspection or remove structured tools (%s)',capability=>{
  const messages=[{role:'user' as const,content:'请看图',attachmentIds:['image']}]
  const result=projectModalities({capability,messages,attachments:[image],tools})
  expect(result.attachments).toEqual([]);expect(result.tools.map(t=>t.name)).toEqual(['board_observe','read_file']);expect(result.disclosure).toContain('未向模型发送');expect(result.messages.at(-1)?.content).toContain('不得声称看到了');expect(messages).toHaveLength(1);expect(JSON.stringify(result.messages)).not.toContain('private-image-data')
 })
 it('retains explicitly configured visual inputs without claiming verification passed',()=>{
  const result=projectModalities({capability:true,messages:[],attachments:[image],tools})
  expect(result.mode).toBe('vision');expect(result.attachments).toEqual([image]);expect(result.tools).toEqual(tools);expect(result.disclosure).toBe('')
 })
 it('does not add irrelevant warnings to a text-only turn with no visual input',()=>{
  const result=projectModalities({capability:null,messages:[{role:'user',content:'你好'}],attachments:[],tools})
  expect(result.messages).toHaveLength(1);expect(result.disclosure).toBe('')
 })
})
