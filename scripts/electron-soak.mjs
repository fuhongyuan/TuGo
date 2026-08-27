import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const executable = resolve(process.env.TUGO_SOAK_EXECUTABLE || join(root, 'release/mac-arm64/TuGo.app/Contents/MacOS/TuGo'))
await access(executable)
const minutes = Math.max(0.02, Number(process.env.TUGO_SOAK_MINUTES || 240))
const testRoot = await mkdtemp(join(tmpdir(), 'tugo-soak-'))
const report = join(testRoot, 'report.json')
const child = spawn(executable, [`--tugo-user-data=${join(testRoot, 'data')}`, `--tugo-soak-report=${report}`, `--tugo-soak-duration-ms=${Math.round(minutes * 60_000)}`], { cwd: root, stdio: 'inherit' })
const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))

try {
  const deadline = Date.now() + minutes * 60_000 + 60_000
  let result
  while (Date.now() < deadline) {
    try { result = JSON.parse(await readFile(report, 'utf8')); break } catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`TuGo soak exited before report: ${JSON.stringify(await exited)}`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  }
  if (!result) throw new Error('TuGo soak report timed out')
  if (!result.ok) throw new Error(result.error || 'TuGo soak failed')
  if (Number(result.samples || 0) < 2) throw new Error(`TuGo soak collected too few memory samples: ${JSON.stringify(result)}`)
  if (Number(result.workloadIterations || 0) < 2) throw new Error(`TuGo soak did not complete enough persistence workload iterations: ${JSON.stringify(result)}`)
  if (result.mainPrivateGrowthMb > 80 || result.workingSetGrowthMb > 120) throw new Error(`TuGo soak memory growth exceeded: ${JSON.stringify(result)}`)
  await exited
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await rm(testRoot, { recursive: true, force: true })
}
