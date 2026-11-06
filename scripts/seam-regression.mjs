import {mkdir,writeFile} from 'node:fs/promises'
const groups=[
['C1','运行与编排','#ed2142','#fff1f2',24,104,1490,108,['Task Runtime','Agent Factory','Workflow Engine','Subagent Runtime','Background Jobs'],'R'],
['C2','模型与认知','#245bff','#eef7ff',24,224,650,216,['Model Invocation','Model Routing','Model Catalog','Context Assembly','Context Compaction','Memory Store','Instruction Assembly','Speech Processing'],'M'],
['C3','工具与资源操作','#00a65b','#effff3',688,224,826,216,['Tool Invocation','Tool Registry','Shell Execution','Process Execution','Terminal Session','Sandbox Environment','File System','Workspace Search','Workspace Change\nTracking','Working Directory','Spill Store','LSP Service'],'T'],
['C4','数据与持久化','#c38100','#fffbea',24,454,504,176,['Session Persistence','Session Query','Attachment Store'],'D'],
['C5','交互与连接','#e40094','#fff0f8',556,454,478,176,['Event Delivery','Message Stream','User Interaction','Approval Interaction','MCP Connector'],'I'],
['C6','扩展机制','#00a1cd','#edfcff',1060,454,454,176,['Skill Registry','Plugin Lifecycle','Plugin Catalog','Hook Runtime'],'E'],
['C7','平台控制与支持','#6533ed','#f4f1ff',24,640,1490,104,['Credential Store','Authentication','Authorization','Quota Management','Usage Metering','Configuration','Feature Flags','Telemetry','Runtime Diagnostics'],'G']]
const elements=[],edges=[]
function box(id,x,y,width,height,text,fill,stroke,fontSize=13,kind='rounded_rectangle',extra={}){elements.push({id,x,y,width,height,text,fill,stroke,strokeWidth:.8,fontSize,textColor:'#101a44',kind,borderRadius:6,...extra})}
function text(id,x,y,w,h,value,size=13,color='#101a44',extra={}){box(id,x,y,w,h,value,'transparent','transparent',size,'text',{strokeWidth:0,textColor:color,...extra})}
text('title',16,0,1020,48,'AgentFoundation 46 Seam 能力依赖关系图 (Definition - Consumer)',32,'#080b36',{fontWeight:'bold',textAlign:'left'})
text('subtitle',16,46,1020,38,'基于 46 个 Seam 的 Definition-Consumer 关系，展示各能力之间的消费依赖关系（不涉及具体 Provider 实现）',16,'#19366b',{textAlign:'left'})
box('legend',1062,7,244,88,'','#f7f8fc','#b7c9df',12,'frame')
text('legend-title',1070,9,230,25,'依赖关系类型（边）',15,'#11183d',{fontWeight:'bold',textAlign:'left'})
for(const [i,label,color,dash] of [[0,'必需依赖 (Required)','#f02838','solid'],[1,'条件依赖 (Conditional)','#345bff','dashed'],[2,'可选依赖 (Optional)','#405774','dotted']]){edges.push({id:'legend-'+i,from:'',to:'',freeStart:{x:1078,y:44+i*19},freeEnd:{x:1140,y:44+i*19},routing:'straight',stroke:color,strokeWidth:1.2,strokeStyle:dash,endArrow:'triangle'});text('legend-text-'+i,1145,32+i*19,154,25,label,12, color,{textAlign:'left'})}
box('node-legend',1320,7,196,88,'','#f7f8fc','#b7c9df',12,'frame')
text('node-legend-title',1324,9,188,25,'节点说明（Seam）',15,'#11183d',{fontWeight:'bold',textAlign:'left'})
box('node-legend-example',1338,43,62,39,'Sxx','#e9f2ff','#345bff',17,'rounded_rectangle',{fontWeight:'bold'})
text('node-legend-label',1406,39,108,48,'Seam ID\nSeam 名称',13,'#19366b',{textAlign:'left'})
for(const [g,name,color,fill,x,y,w,h,names,prefix] of groups){box(g,x,y,w,h,'',fill,color,13,'frame',{strokeStyle:'dashed'});text(g+'-title',x+2,y+2,w-12,33,`${g} ${name}（${names.length}）`,21,color,{fontWeight:'bold',textAlign:'left'});names.forEach((name,i)=>{let cols=g==='C1'?5:g==='C2'?4:g==='C3'?6:g==='C5'?3:g==='C6'?4:g==='C7'?9:3;const row=Math.floor(i/cols),col=i%cols;let nw=(w-48-(cols-1)*18)/cols, nx=x+24+col*(nw+18),ny=y+47+row*(g==='C5'?70:94);if(g==='C1'){nw=180;nx=x+154+i*249;ny=y+38}if(g==='C5'&&row){nw=168;nx=x+62+col*204;ny=y+116}if(g==='C7'){ny=y+46;nw=(w-56-8*24)/9;nx=x+28+col*(nw+24)}box(prefix+String(i+1).padStart(2,'0'),nx,ny,nw,g==='C1'?52:48,`${prefix}${String(i+1).padStart(2,'0')}\n${name}`, '#ffffff',color,g==='C3'?12:13,'rounded_rectangle',{groupId:g})})}
// The supplied raster has ambiguous dense crossings: this explicit relation set
// is a visual stress reconstruction, not an authoritative dependency manifest.
const pairs=`R01>R02 R02>R03 R03>R04 R04>R05 M01>M02 M02>M03 M03>M04 M05>M06 M06>M07 T01>T02 T02>T03 T03>T04 T04>T05 T05>T06 T07>T08 T08>T09 T09>T10 T10>T11 T11>T12 D01>D02 D02>D03 I01>I02 I02>I03 I04>I05 E01>E02 E02>E03 E03>E04 G01>G02 G02>G03 G03>G04 G04>G05 G05>G06 G06>G07 G07>G08 G08>G09 M01>M05 M02>M06 M03>M07 M04>M08 T01>T07 T02>T08 T03>T09 T04>T10 T05>T11 T06>T12 R01>M01 R01>M02 R01>M03 R02>M04 M01>R01 M02>R02 M04>R03 R03>T01 R04>T03 R05>T04 R05>T05 R05>T06 T01>R03 T04>R04 T05>R05 T06>R05 D01>G01 D02>G02 D03>G03 M06>D02 M07>D03 T07>I02 T08>I03 T10>E01 T11>E03 T12>E04 I01>I04 I02>I04 I03>I05 I04>G05 I05>G06 T01>I05 M01>G03 M06>G06 R01>G04 R02>G05 R03>G06 R04>G07 R05>G09 E01>G07 E02>G08 E03>G09 E04>G09 M04>I01 T04>I02 T07>D02`.split(' ')
for(const [i,pair] of pairs.entries()){const[from,to]=pair.split('>');const a=elements.find(n=>n.id===from),b=elements.find(n=>n.id===to);const required=i%7===0,optional=i%5===0;edges.push({id:'dep-'+i,from,to,routing:'elbow',stroke:required?'#f02838':optional?'#405774':'#345bff',strokeWidth:required?1.1:.8,strokeStyle:required?'solid':optional?'dotted':'dashed',endArrow:'arrow',opacity:required?.9:.7,metadata:{referenceCertainty:'visual-reconstruction'}})}
text('inventory-heading',24,750,1490,27,'46 个 Seam 列表（按类别分组）',17,'#101a44',{textAlign:'left',fontWeight:'bold'})
const widths=[174,196,364,174,182,172,186];let tx=24
for(const [j,g] of groups.entries()){const [id,name,color,fill,,,,,names,prefix]=g;const w=widths[j];box('table-'+id,tx,782,w,213,'',fill,color,12,'frame');text('table-head-'+id,tx,782,w,29,`${id} ${name} (${names.length})`,15,color,{fontWeight:'bold',textAlign:'left'});names.forEach((n,i)=>{let c=id==='C3'?Math.floor(i/6):0,r=id==='C3'?i%6:i; text('table-row-'+id+i,tx+c*w/2+4,813+r*20,id==='C3'?w/2-8:w-8,23,`${prefix}${String(i+1).padStart(2,'0')}   ${n.replace('\n',' ')}`,11,'#233858',{textAlign:'left'})});tx+=w+8}
const doc={version:1,elements,edges,viewport:{x:0,y:0,zoom:1}}
await mkdir('artifacts/seam-regression',{recursive:true})
await writeFile('artifacts/seam-regression/fixture.json',JSON.stringify(doc,null,2))
console.log(JSON.stringify({elements:elements.length,nodes:46,edges:edges.length}))
