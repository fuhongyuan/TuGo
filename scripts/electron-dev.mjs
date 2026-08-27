import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { prepareMacDevShell } from './mac-dev-shell.mjs'

const root = resolve(import.meta.dirname, '..')
const isWindows = process.platform === 'win32'
const npmCommand = isWindows ? 'npm.cmd' : 'npm'

const exists = async path => {
  try { await access(path); return true } catch { return false }
}

const localElectronCli = resolve(root, 'node_modules', 'electron', 'cli.js')
const fallbackElectronCli = resolve(root, '..', 'mybuddy', 'node_modules', 'electron', 'cli.js')
const electronCli = await exists(resolve(root, 'node_modules', 'electron', 'dist'))
  ? localElectronCli
  : fallbackElectronCli

if (!(await exists(electronCli))) {
  throw new Error('未找到 Electron 运行时。请先执行 npm install。')
}

const children = new Set()
const run = (command, args, options = {}) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

const stop = () => {
  // macOS launches the prepared executable directly, so this set contains the
  // real Electron process rather than an `open -W` proxy. Ctrl-C can therefore
  // stop the exact development instance without AppleScript or a broad pkill.
  for (const child of children) {
    try { child.kill('SIGTERM') } catch { /* process already exited */ }
  }
}

process.once('SIGINT', () => { stop(); process.exit(130) })
process.once('SIGTERM', () => { stop(); process.exit(143) })
process.once('exit', stop)

// Reuse an already-running TuGo Vite instance. This is common after an
// Electron crash: the renderer server survives while the desktop process dies.
// Starting a second strict-port server would only produce "5189 is already in
// use" and hide the actual Electron error.
let vite = null

const waitForVite = async () => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (vite && vite.exitCode !== null) throw new Error(`Vite 启动失败，退出码 ${vite.exitCode}`)
    try {
      const response = await fetch('http://127.0.0.1:5189/')
      if (response.ok) return
    } catch { /* keep waiting */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  }
  throw new Error('等待 TuGo 前端启动超时。')
}

try {
  // The Runtime Worker is a separately compiled artifact. Building it here
  // prevents Electron dev from silently using an older worker after a source
  // edit (for example missing a newly-added RunDebug route).
  const runtimeBuild = run(npmCommand, ['run', 'runtime:ts:build'])
  const runtimeExit = await new Promise(resolveExit => runtimeBuild.once('exit', code => resolveExit(code ?? 1)))
  if (runtimeExit !== 0) throw new Error(`Embedded Runtime 编译失败，退出码 ${runtimeExit}`)
  try {
    const existing = await fetch('http://127.0.0.1:5189/')
    if (!existing.ok) throw new Error(`HTTP ${existing.status}`)
  } catch {
    vite = run(npmCommand, ['run', 'dev:web'])
  }
  await waitForVite()
  // Use the scoped, ad-hoc signed development shell so Ctrl-C can close the
  // exact TuGo instance instead of leaving a generic Electron process.
  const devExecutable = process.platform === 'darwin' ? await prepareMacDevShell(root, electronCli) : null
  const electron = process.platform === 'darwin'
    ? run(devExecutable, [root], { env: { ...process.env, TUGO_DEV_URL: 'http://127.0.0.1:5189/' } })
    : run(process.execPath, [electronCli, '.'], {
      env: { ...process.env, TUGO_DEV_URL: 'http://127.0.0.1:5189/' },
    })
  const exitCode = await new Promise(resolveExit => electron.once('exit', code => resolveExit(code ?? 0)))
  stop()
  process.exitCode = exitCode
} catch (error) {
  stop()
  throw error
}
