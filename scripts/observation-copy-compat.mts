/** Offline compatibility test on a private, disposable copy. No host/provider. */
import {mkdtemp,copyFile,cp,readFile,writeFile,mkdir,chmod,rm,stat} from 'node:fs/promises'
import {join,basename} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import {RuntimeRepository} from '../runtime-ts/src/repository'
const source=process.env.TUGO_COPY_SOURCE
if(!source)throw new Error('Explicit TUGO_COPY_SOURCE required')
const root=await mkdtemp('/private/tmp/tugo-private-compat-');await chmod(root,0o700)
const digest=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex')
const report:Record<string,unknown>={scope:'offline production-data copy, no provider/host, no credentials file copied'}
try{
 const names=['tugo.sqlite','runtime/runtime.sqlite','tugo-config.json'],originals=new Map<string,string>()
 for(const name of names){const bytes=await readFile(join(source,name));originals.set(name,digest(bytes));await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),bytes,{mode:0o600})}
 await cp(join(source,'runtime/attachments'),join(root,'runtime/attachments'),{recursive:true})
 const SQL=await initSqlJs(),db=new SQL.Database(await readFile(join(root,'runtime/runtime.sqlite')))
 const rows=(sql:string)=>{const result=db.exec(sql)[0];return result?result.values.map(values=>Object.fromEntries(result.columns.map((key,i)=>[key,values[i]]))):[]}
 const referenced=rows('SELECT DISTINCT a.attachment_id,a.local_path FROM attachments a JOIN attachment_references r ON r.attachment_id=a.attachment_id')
 const files=new Map<string,string>();let missing=0
 for(const item of rows('SELECT attachment_id,local_path FROM attachments')){
  const target=join(root,'runtime/attachments',basename(String(item.local_path)))
  db.run('UPDATE attachments SET local_path=? WHERE attachment_id=?',[target,String(item.attachment_id)])
 }
 for(const item of referenced){const file=join(root,'runtime/attachments',basename(String(item.local_path)));try{files.set(file,digest(await readFile(file)))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')missing++;else throw error}}
 const tables=['models','mcp_connections','agent_mcp_connections','skills','skill_resources','prompt_templates']
 const before=Object.fromEntries(tables.map(t=>[t,rows(`SELECT * FROM ${t}${t==='prompt_templates'?' WHERE user_modified=1':''} ORDER BY 1`)]))
 await writeFile(join(root,'runtime/runtime.sqlite'),db.export());db.close()
 const repository=new RuntimeRepository(join(root,'runtime'),'templates/runtime-defaults.json');await repository.open();await repository.close()
 const afterDb=new SQL.Database(await readFile(join(root,'runtime/runtime.sqlite')))
 for(const table of tables){const result=afterDb.exec(`SELECT * FROM ${table} ORDER BY 1`)[0];const after=result?result.values.map(values=>Object.fromEntries(result.columns.map((key,i)=>[key,values[i]]))):[]
  // Shipped defaults may add new records; existing user rows must remain exact.
  const byId=new Map(after.map(row=>[String(Object.values(row)[0]),row]));for(const row of before[table])assert.equal(digest(JSON.stringify(byId.get(String(Object.values(row)[0]))??null)),digest(JSON.stringify(row)),`Existing configuration changed in ${table}`)
 }
 assert.equal(afterDb.exec('PRAGMA quick_check')[0].values[0][0],'ok');afterDb.close()
 for(const [file,hash] of files)assert.equal(digest(await readFile(file)),hash,'Referenced attachment modified or removed')
 const appDb=new SQL.Database(await readFile(join(root,'tugo.sqlite')));assert.equal(appDb.exec('PRAGMA quick_check')[0].values[0][0],'ok');appDb.close()
 for(const [name,hash] of originals)assert.equal(digest(await readFile(join(source,name))),hash,'Production file changed during offline test')
 report.passed=true;report.original_files_unchanged=true;report.existing_configuration_rows=Object.fromEntries(tables.map(t=>[t,before[t].length]));report.referenced_attachments_checked=files.size;report.preexisting_missing_referenced_attachments=missing;report.secret_files_copied=false
 console.log(JSON.stringify(report,null,2))
}finally{await rm(root,{recursive:true,force:true})}
