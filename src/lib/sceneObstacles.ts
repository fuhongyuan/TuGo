import type {BoardElement} from '../types'
import {elementLayers} from './boardCommands'
import {textObstacle} from './textLayout'
/** Background bodies are traversable, but their visible headings are not.
 * Shared by routing, labels, audits and exports. */
export function sceneObstacles(elements:BoardElement[]) {
 const layers=elementLayers(elements)
 return [
  ...layers.foreground.filter(n=>(n.opacity??1)>0).map(n=>({id:n.id,...(n.kind==='text'?textObstacle(n):{x:n.x,y:n.y,width:n.width,height:n.height})})),
  ...layers.background.filter(n=>n.text?.trim()&&(n.opacity??1)>0).map(n=>({id:n.id,...textObstacle(n)})),
 ]
}
