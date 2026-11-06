import {extractFile,listPackage} from '@electron/asar'
import {readdir,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
const root=resolve(import.meta.dirname,'..'),archive=join(root,'release/mac-arm64/TuGo.app/Contents/Resources/app.asar'),files=[]
async function collect(path){for(const entry of await readdir(join(root,path),{withFileTypes:true})){const next=path+'/'+entry.name;if(entry.isDirectory())await collect(next);else if(path==='dist-web'||path.startsWith('dist-web/')||next.endsWith('.js')||next.endsWith('.cjs'))files.push(next)}}
for(const path of ['dist-web','runtime-ts/dist','electron'])await collect(path)
const expected=new Set(files),actual=listPackage(archive).map(path=>path.replace(/^\//,''))
for(const path of actual)if((path.startsWith('dist-web/')||path.startsWith('runtime-ts/dist/'))&&/\.(js|css|html)$/.test(path)&&!expected.has(path))throw new Error('Unexpected compiled package file '+path)
const rows=[]
for(const path of files){const packaged=await extractFile(archive,path),source=await readFile(join(root,path));if(!packaged.equals(source))throw new Error('Package source mismatch '+path);rows.push({path,sha256:createHash('sha256').update(packaged).digest('hex')})}
console.log(JSON.stringify({passed:true,files:rows},null,2))
