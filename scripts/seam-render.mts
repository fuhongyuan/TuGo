import {readFile,writeFile} from 'node:fs/promises'
import {renderRegionSvg} from '../src/lib/exportDocument'
import {documentEdgeRoutes} from '../src/lib/edgeRoute'
import {reflectDiagram} from '../src/lib/diagramQuality'
const doc=JSON.parse(await readFile('artifacts/seam-regression/fixture.json','utf8'))
const start=performance.now()
const routes=documentEdgeRoutes(doc.elements,doc.edges)
const nodes=doc.elements.filter((n:any)=>/^[RMTDIEG]\d\d$/.test(n.id))
let hits:any[]=[]
for(const edge of doc.edges){const ps=routes.get(edge.id)?.pathPoints||[];for(const n of nodes){if(n.id===edge.from||n.id===edge.to)continue;for(let i=1;i<ps.length;i++){const a=ps[i-1],b=ps[i];const count=Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)/2);if(Array.from({length:count+1},(_,k)=>({x:a.x+(b.x-a.x)*k/count,y:a.y+(b.y-a.y)*k/count})).some(p=>p.x>n.x+1&&p.x<n.x+n.width-1&&p.y>n.y+1&&p.y<n.y+n.height-1)){hits.push([edge.id,n.id]);break}}}}
console.log(JSON.stringify({routeMs:performance.now()-start,nodes:nodes.length,edges:routes.size,hits},null,2))
await writeFile('artifacts/seam-regression/latest.svg',renderRegionSvg(doc,{x:0,y:0,width:1540,height:1024}))

const audit = reflectDiagram(doc)
await writeFile('artifacts/seam-regression/source-review.json',JSON.stringify(audit,null,2))
console.log(JSON.stringify({score:audit.score,high:audit.issues.filter(i=>i.severity==='high'),summary:audit.summary},null,2))
