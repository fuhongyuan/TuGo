import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const electronCache = join(root, '.electron-cache')
// electron-builder 26 downloads a CommonJS icon helper. Keeping that helper
// below this ESM package makes Node inherit `type: module` and crash before
// packaging, so use an OS cache outside the project package boundary.
const builderCache = join(tmpdir(), 'tugo-electron-builder-cache')
await mkdir(electronCache, { recursive: true })
await mkdir(builderCache, { recursive: true })

const cli = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_CACHE: electronCache,
    ELECTRON_BUILDER_CACHE: builderCache,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  },
})

child.once('error', error => { throw error })
child.once('exit', code => { process.exitCode = code ?? 1 })
