import {build} from 'esbuild'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {resolve} from 'node:path'
const out=resolve('artifacts/seam-regression/harness');await mkdir(out,{recursive:true})
await build({entryPoints:['scripts/fixtures/seam-canvas.tsx'],bundle:true,outfile:out+'/fixture.js',platform:'browser',format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"test"'}})
await writeFile(out+'/index.html',`<html data-theme="light"><meta charset="utf-8"><style>${await readFile('src/styles.css','utf8')}html,body,#root{margin:0;width:100%;height:100%}*{animation:none!important;transition:none!important}</style><div id="root"></div><script src="fixture.js"></script></html>`)
const child=spawn(process.execPath,[resolve('node_modules/electron/cli.js'),resolve('scripts/seam-canvas.cjs'),out],{stdio:'inherit'});child.once('exit',code=>process.exitCode=code||0)
