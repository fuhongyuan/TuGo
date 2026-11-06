import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'tugo-canvas-test-'))
await build({ entryPoints: ['scripts/fixtures/canvas-interactions.tsx'], bundle: true, outfile: join(root, 'fixture.js'), platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"test"' } })
await writeFile(join(root, 'index.html'), `<html data-theme="light"><style>${await readFile('src/styles.css', 'utf8')}html,body,#root{margin:0;width:100%;height:100%}*{animation:none!important;transition:none!important}</style><div id="root"></div><script src="fixture.js"></script></html>`)
const child = spawn(process.execPath, [resolve('node_modules/electron/cli.js'), resolve('scripts/canvas-interactions.cjs'), root], { stdio: 'inherit' })
child.on('exit', code => { process.exitCode = code || 0 })
