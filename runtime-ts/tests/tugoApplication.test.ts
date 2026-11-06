import {describe,it,expect,vi} from 'vitest'
import {TuGoRuntimeApplication} from '../src/tugo/runtimeApplication.js'
import type {RunCheckpoint} from '../src/contracts.js'
const checkpoint=()=>({version:1,threadId:'thread',runId:'run',agentId:'agent',status:'running',messages:[],completedToolCalls:{},loopSignatures:[],usage:{},step:0}) as RunCheckpoint
const services=()=>({importGeneratedImage:vi.fn(async()=>({attachment_id:'image',name:'capture.png'})),importGeneratedFile:vi.fn(async()=>({attachment_id:'deck',name:'deck.pptx'})),bindAttachment:vi.fn()})
describe('TuGo product result policy',()=>{
 it('materializes a capture but keeps it out of deliverable attachments and removes inline binary',async()=>{
  const s=services(),app=new TuGoRuntimeApplication(s as never,async()=>({})),call={id:'c',name:'board_capture_image',arguments:{name:'capture'}}
  const value=await app.materialize(checkpoint(),call,{image_base64:'png',ok:true},true)
  expect(s.importGeneratedImage).toHaveBeenCalledWith('png','capture');expect(value.exposeAttachment).toBe(false);expect(value.result).not.toHaveProperty('image_base64')
  await expect(app.materialize(checkpoint(),call,{image_base64:'png'},false)).rejects.toThrow('图片理解能力')
 })
 it('materializes a presentation once and binds the resulting artifact to the original run',async()=>{
  const s=services(),app=new TuGoRuntimeApplication(s as never,async()=>({}))
  const value=await app.materialize(checkpoint(),{id:'c',name:'board_export_pptx',arguments:{}},{pptx_base64:'deck-data',page_count:2,name:'deck.pptx'},false)
  expect(s.importGeneratedFile).toHaveBeenCalledTimes(1);expect(s.bindAttachment).toHaveBeenCalledWith('thread','run','deck','tool');expect(value.result).not.toHaveProperty('pptx_base64');expect(value.exposeAttachment).toBe(true)
 })
})
