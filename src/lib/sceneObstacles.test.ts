import {describe,it,expect} from 'vitest'
import type {BoardElement} from '../types'
import {sceneObstacles} from './sceneObstacles'
import {placeEdgeLabel} from './canvasGeometry'
import {renderRegionSvg} from './exportDocument'
import {documentEdgeRoutes} from './edgeRoute'
const box=(id:string,x:number,y:number,width=120,height=60):BoardElement=>({id,x,y,width,height,kind:'rectangle',text:id,fill:'#fff',stroke:'#000',strokeWidth:1,fontSize:16})
describe('shared scene obstacles',()=>{
 it('protects background titles without treating the whole container body as blocked',()=>{
  const title={...box('container',0,0,600,300),text:'Container heading',textAlign:'left' as const,verticalAlign:'top' as const,metadata:{container:true}}
  const nodes=[title,box('a',30,100),box('b',400,100)],before=JSON.stringify(nodes)
  const obstacles=sceneObstacles(nodes),heading=obstacles.find(n=>n.id==='container')!
  expect(heading.height).toBeLessThan(40);expect(heading.width).toBeLessThan(600)
  const placed=placeEdgeLabel([{x:20,y:12},{x:300,y:12}],'link',obstacles)
  expect(placed.y-placed.height/2>=heading.y+heading.height||placed.y+placed.height/2<=heading.y||placed.x-placed.width/2>=heading.x+heading.width||placed.x+placed.width/2<=heading.x).toBe(true)
  expect(JSON.stringify(nodes)).toBe(before)
 })
 it('uses identical heading-aware label placement in SVG export, and ignores invisible headings',()=>{
  const nodes=[{...box('container',0,0,600,300),text:'Heading',textAlign:'left' as const,verticalAlign:'top' as const,metadata:{container:true}},box('a',20,100),box('b',220,100)]
  const edge={id:'e',from:'a',to:'b',label:'link',routing:'elbow' as const,stroke:'#000',strokeWidth:1}
  const routes=documentEdgeRoutes(nodes,[edge]),label=placeEdgeLabel(routes.get('e')!.pathPoints,'link',sceneObstacles(nodes))
  const svg=renderRegionSvg({version:1,elements:nodes,edges:[edge],paletteId:'default',viewport:{x:0,y:0,zoom:1}},{x:0,y:0,width:600,height:300})
  expect(svg).toContain(`<rect x="${label.x-label.width/2}" y="${label.y-label.height/2}" width="${label.width}"`)
  expect(sceneObstacles([{...nodes[0],opacity:0},...nodes.slice(1)]).some(n=>n.id==='container')).toBe(false)
 })
})
