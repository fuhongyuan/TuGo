import {observationPerformance} from './observation-performance'
import {observationStability} from './observation-stability'
import {observationOverlap} from './observation-overlap'
import React from 'react'
import {createRoot} from 'react-dom/client'
import {InfiniteCanvas} from '../../src/components/InfiniteCanvas'
import fixture from '../../artifacts/seam-regression/fixture.json'
import {renderRegionSvg} from '../../src/lib/exportDocument'
import {observeBoard,getObservation} from '../../src/lib/boardObservation'
import type {BoardDocument} from '../../src/types'
const document = fixture as BoardDocument
const labelled = structuredClone(document)
for (const [id,label] of [['dep-20','写入\n持久化'],['dep-24','交互\n通知'],['dep-52','调用\n工具']]) {
  const edge = labelled.edges.find(e=>e.id===id)!; edge.label=label
}
const noop=()=>{}
const renderer=createRoot(globalThis.document.getElementById('root')!)
function show(doc: BoardDocument,projectId="seam-fixture",playback=false) {
 renderer.render(<InfiniteCanvas projectId={projectId} aiPlayback={playback?{id:'stability-playback',projectId,base:doc,operations:[]}:null} document={{...doc,viewport:{x:0,y:12,zoom:.78}}} selectedIds={[]} onSelect={noop} onCommit={noop} onUndo={noop} onRedo={noop} canUndo={false} canRedo={false} onAddImage={noop} onDropImages={noop} onExportRegion={noop} onBatchExportRegions={noop} onAddToChat={noop}/>)
}
Object.assign(window,{seamPerformance:(iterations?:number)=>observationPerformance(labelled,iterations),seamProject:(id:string)=>show(labelled,id),seamPlayback:(active:boolean)=>show(labelled,'seam-fixture',active),seamStability:()=>observationStability(labelled),seamObserve:()=>observeBoard({projectId:"seam-fixture",document:labelled}),seamFixture:document,seamLabels:labelled,seamSvg:()=>renderRegionSvg(labelled,{x:0,y:0,width:1540,height:1024})})
Object.assign(window,{seamOverlap:observationOverlap,seamShow:show,seamObserveDocument:(doc:BoardDocument,projectId:string)=>observeBoard({projectId,document:doc})})
show(labelled)
