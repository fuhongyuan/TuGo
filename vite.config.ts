import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import {createHash} from 'node:crypto'
import {readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
const hash = createHash('sha256')
const scan = (dir: string) => { for (const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) { const path=join(dir,entry.name); if(entry.isDirectory()) scan(path); else if(/\.(ts|tsx|css)$/.test(path)) hash.update(path).update(readFileSync(path)) } }
scan('src')

export default defineConfig({
  plugins: [react()],
  define: {__TUGO_RENDERER_BUILD_ID__:JSON.stringify(hash.digest('hex'))},
  base: './',
  build: { outDir: 'dist-web', emptyOutDir: true },
  server: {},
  test: { environment: 'jsdom', maxWorkers: 1 },
})
