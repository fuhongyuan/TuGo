#!/usr/bin/env node
const { mkdir, copyFile, chmod, readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log('node install.cjs [--bin-dir DIR] [--skill-dir DIR] [--force]\nInstalls tugo executable and a self-contained Codex skill. Never modifies Codex config.toml.'); return }
  const opts = {}
  for (let i=0;i<args.length;i++) { if(args[i]==='--force') opts.force=true; else if(['--bin-dir','--skill-dir'].includes(args[i]) && args[i+1]) opts[args[i].slice(2)]=args[++i]; else throw new Error(`Unknown option ${args[i]}`) }
  const bin = resolve(opts['bin-dir'] || join(homedir(), '.local/bin'))
  const skill = resolve(opts['skill-dir'] || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills/tugo-draw'))
  const destinations = [join(bin,'tugo.cjs'), join(bin,process.platform==='win32'?'tugo.cmd':'tugo'), join(skill,'SKILL.md'), join(skill,'scripts/tugo.cjs')]
  if (!opts.force) for (const path of destinations) { try { await readFile(path); throw new Error(`Already exists: ${path}; use --force to replace`) } catch(error) { if(error.code!=='ENOENT') throw error } }
  await mkdir(bin,{recursive:true}); await mkdir(join(skill,'scripts'),{recursive:true})
  await copyFile(join(__dirname,'tugo.cjs'),destinations[0]); await copyFile(join(__dirname,'tugo.cjs'),destinations[3])
  await copyFile(join(__dirname,'skills/tugo-draw/SKILL.md'),destinations[2])
  if(process.platform==='win32') await writeFile(destinations[1], '@echo off\r\nnode "%~dp0tugo.cjs" %*\r\n')
  else { await copyFile(join(__dirname,'tugo.cjs'),destinations[1]); await chmod(destinations[1],0o755) }
  console.log(JSON.stringify({ok:true,bin:destinations[1],skill,message:'Add bin directory to PATH if necessary; reopen/start a Codex task to discover the skill.'}))
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
