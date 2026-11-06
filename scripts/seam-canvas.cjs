const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path'); const assert=require('node:assert/strict');
app.setPath('userData','/tmp/tugo-seam-live-harness');app.whenReady().then(async()=>{
const w=new BrowserWindow({width:1280,height:920,show:false});w.webContents.on('console-message',(_e,...args)=>console.log(...args));await w.loadFile(path.join(process.argv[2],'index.html'));await w.webContents.executeJavaScript('document.fonts.ready');await new Promise(r=>setTimeout(r,500));
const report=await w.webContents.executeJavaScript(`(()=>{
const nodes=[...document.querySelectorAll('.board-element')];
const overflow=nodes.map((g,index)=>{const span=g.querySelector('.element-text-hit');if(!span)return null;const a=span.getBoundingClientRect(),b=g.querySelector('foreignObject').getBoundingClientRect();return a.top<b.top-1||a.bottom>b.bottom+1||a.left<b.left-1||a.right>b.right+1 ? {index,text:span.textContent,a:{top:a.top,bottom:a.bottom},b:{top:b.top,bottom:b.bottom}}:null}).filter(Boolean);
const labels=[...document.querySelectorAll('.edge-label-group')].map(g=>{const text=g.querySelector('text').getBBox(),bg=g.querySelector('rect').getBBox();return {text:g.textContent,inside:text.x>=bg.x-1&&text.y>=bg.y-1&&text.x+text.width<=bg.x+bg.width+1&&text.y+text.height<=bg.y+bg.height+1,lines:g.querySelectorAll('tspan').length, overlaps:[...document.querySelectorAll('.element-text-hit')].filter(span=>{const a=g.querySelector('rect').getBoundingClientRect(),b=span.getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top}).map(span=>span.textContent)}});
return {elements:nodes.length,edges:document.querySelectorAll('.board-edge').length,overflow,labels};})()`);
fs.writeFileSync('artifacts/seam-regression/live-report.json',JSON.stringify(report,null,2));fs.writeFileSync('artifacts/seam-regression/live-canvas.png',(await w.webContents.capturePage()).toPNG());fs.writeFileSync('artifacts/seam-regression/labelled.svg',await w.webContents.executeJavaScript('window.seamSvg()'));
const observation=await w.webContents.executeJavaScript('window.seamObserve()');
fs.writeFileSync('artifacts/seam-regression/observation.json',JSON.stringify(observation,null,2));
assert.equal(observation.checks.render,'passed',JSON.stringify(observation.render));
const faults=await w.webContents.executeJavaScript(`(async()=>{
 const path=document.querySelector('[data-edge-id] > path'),id=path.parentElement.dataset.edgeId;
 const last=Array.from(document.querySelectorAll('[data-element-id]')).at(-1);
 const point=path.getPointAtLength(path.getTotalLength()/2);
 const screen=new DOMPoint(point.x,point.y).matrixTransform(path.getScreenCTM());
 const p=screen.matrixTransform(last.getScreenCTM().inverse());
 const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
 rect.setAttribute('x',p.x-8);rect.setAttribute('y',p.y-8);rect.setAttribute('width','16');rect.setAttribute('height','16');rect.setAttribute('fill','#fff');last.append(rect);
 const covered=await window.seamObserve();rect.remove();
 const span=Array.from(document.querySelectorAll('.element-text-hit')).find(s=>s.textContent.trim()),prior=span.style.fontSize;span.style.fontSize='300px';
 const clipped=await window.seamObserve();span.style.fontSize=prior;
 const marker=path.style.markerEnd;path.style.markerEnd='none';
 const arrow=await window.seamObserve();path.style.markerEnd=marker;
 const stroke=path.style.stroke;path.style.stroke='none';
 const invisible=await window.seamObserve();path.style.stroke=stroke;
 const invisibleVariants=[];
 for(const [key,value] of [['strokeOpacity','0'],['strokeWidth','0px'],['stroke','rgba(0, 0, 0, 0)']]){const prior=path.style[key];path.style[key]=value;const o=await window.seamObserve();invisibleVariants.push({key,findings:o.findings.filter(f=>f.type==='edge_invisible')});path.style[key]=prior}
 const parent=path.parentElement,opacity=parent.style.opacity;parent.style.opacity='0';const o=await window.seamObserve();invisibleVariants.push({key:'ancestorOpacity',findings:o.findings.filter(f=>f.type==='edge_invisible')});parent.style.opacity=opacity;
 if(invisibleVariants.some(v=>!v.findings.length))throw new Error('Invisible variants missed: '+JSON.stringify(invisibleVariants));
 return {invisibleVariants,edge:id,covered:covered.findings.filter(f=>f.type==='edge_occluded'),clipped:clipped.findings.filter(f=>f.type==='text_clipped'),arrow:arrow.findings.filter(f=>f.type==='arrow_missing'),invisible:invisible.findings.filter(f=>f.type==='edge_invisible')};
})()`);
fs.writeFileSync('artifacts/seam-regression/observation-faults.json',JSON.stringify(faults,null,2));
assert.ok(faults.covered.length,'must detect paint-order occlusion');assert.ok(faults.clipped.length,'must detect real text overflow');assert.ok(faults.arrow.length,'must detect missing arrow');assert.ok(faults.invisible.length,'must detect invisible stroke');
const lifecycle=await w.webContents.executeJavaScript(`(async()=>{
 const pause=()=>new Promise(r=>setTimeout(r,100));
 window.seamPlayback(true);await pause();const playback=await window.seamObserve();
 window.seamPlayback(false);await pause();
 window.seamProject('other-board');await pause();const switched=await window.seamObserve();
 window.seamProject('seam-fixture');await pause();const restored=await window.seamObserve();
 if(playback.checks.render==='passed'||switched.checks.render==='passed'||restored.checks.render!=='passed')throw new Error('Actual component lifecycle failed');
 return {playback:playback.checks.render,switched:switched.checks.render,restored:restored.checks.render};
})()`);fs.writeFileSync('artifacts/seam-regression/observation-lifecycle.json',JSON.stringify(lifecycle,null,2));
const overlap=await w.webContents.executeJavaScript('window.seamOverlap()');fs.writeFileSync('artifacts/seam-regression/observation-overlap.json',JSON.stringify(overlap,null,2));console.log('TEXT FRAGMENT OVERLAP PASSED',overlap);
const stability=await w.webContents.executeJavaScript('window.seamStability()');fs.writeFileSync('artifacts/seam-regression/observation-stability.json',JSON.stringify(stability,null,2));console.log('OBSERVATION STABILITY PASSED',stability);
if(process.env.TUGO_OBSERVATION_PERFORMANCE==='1'){const performance=await w.webContents.executeJavaScript(process.env.TUGO_OBSERVATION_PROFILE==='1'?'window.seamPerformance(1)':'window.seamPerformance()');fs.writeFileSync('artifacts/seam-regression/observation-performance.json',JSON.stringify({...performance,process_metrics:app.getAppMetrics().map(m=>({type:m.type,memory:m.memory}))},null,2));console.log('OBSERVATION PERFORMANCE PASSED',performance)}
console.log('OBSERVATION DOM AND FOUR FAULT INJECTIONS PASSED',observation.blocking_count,'geometry blockers',observation.warning_count,'warnings');
console.log(JSON.stringify(report,null,2));assert.equal(report.overflow.length,0);assert.equal(report.labels.length,3);assert.ok(report.labels.every(l=>l.inside&&l.lines===2&&l.overlaps.length===0));app.quit();
}).catch(e=>{console.error(e);app.exit(1)})
