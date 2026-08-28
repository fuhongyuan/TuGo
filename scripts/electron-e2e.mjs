import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareMacDevShell } from './mac-dev-shell.mjs'

const root = resolve(import.meta.dirname, '..')
const electronCli = join(root, 'node_modules', 'electron', 'cli.js')
await access(electronCli)
const packagedExecutable = process.env.TUGO_E2E_EXECUTABLE ? resolve(process.env.TUGO_E2E_EXECUTABLE) : ''
if (packagedExecutable) await access(packagedExecutable)
const testRoot = await mkdtemp(join(tmpdir(), 'tugo-electron-e2e-'))
const dataDir = join(testRoot, 'data')
const attachmentPath = join(testRoot, 'fixture.md')
await writeFile(attachmentPath, '# E2E attachment\nTuGo fixture.', 'utf8')
const provider = createServer((request, response) => {
  // Keep legacy discovery available, while the product probe below verifies
  // the actual configured model through streaming structured tool calling.
  if (request.method === 'GET' && request.url?.replace(/\?.*$/, '').endsWith('/models')) {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] }))
    return
  }
  if (request.method !== 'POST') { response.writeHead(404).end(); return }
  let raw = ''
  request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    // The Runtime sends the conversation history on every model call. Inspect
    // the last user turn instead of searching the whole body, otherwise a
    // cancelled turn would accidentally make every queued follow-up hang too.
    let latestUserContent = ''
    let parsedBody = {}
    try {
      parsedBody = JSON.parse(raw)
      const messages = parsedBody?.messages
      if (Array.isArray(messages)) latestUserContent = String([...messages].reverse().find(message => message?.role === 'user')?.content || '')
    } catch { /* fixture falls back to a normal successful response */ }
    if (Array.isArray(parsedBody?.tools) && parsedBody.tools.some(tool => tool?.function?.name === 'tugo_probe')) {
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"probe","function":{"name":"tugo_probe","arguments":"{\\"value\\":\\"ok\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n')
      response.end('data: [DONE]\n\n')
      return
    }
    if (latestUserContent.includes('E2E_CANCEL')) {
      response.write('data: {"choices":[{"delta":{"reasoning_content":"working"},"finish_reason":null}]}\n\n')
      return
    }
    response.write('data: {"choices":[{"delta":{"content":"E2E fixture ready"},"finish_reason":null}]}\n\n')
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\n')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((resolveListen, rejectListen) => { provider.once('error', rejectListen); provider.listen(0, '127.0.0.1', resolveListen) })
const providerUrl = `http://127.0.0.1:${provider.address().port}`

const waitForReport = async path => {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try { const value = JSON.parse(await readFile(path, 'utf8')); if (!value.ok) throw new Error(value.error || 'Electron E2E failed'); return value } catch (error) {
      if (error instanceof SyntaxError || error?.code === 'ENOENT') { await new Promise(resolveDelay => setTimeout(resolveDelay, 100)); continue }
      throw error
    }
  }
  throw new Error(`Electron E2E report timed out: ${path}`)
}

const launch = async (mode, launchDataDir = dataDir) => {
  const report = join(testRoot, `${mode}.json`)
  // Keep the UI locale deterministic. The smoke assertions exercise visible
  // controls whose labels are localized, so a runner's host language must not
  // decide whether the test can find them.
  const flags = ['--lang=zh-CN', `--tugo-user-data=${launchDataDir}`, `--tugo-e2e-report=${report}`, `--tugo-e2e-mode=${mode}`, `--tugo-e2e-started-at=${Date.now()}`, `--tugo-e2e-provider=${providerUrl}`, `--tugo-e2e-attachment=${attachmentPath}`]
  const args = packagedExecutable ? flags : [root, ...flags]
  let child
  if (process.platform === 'darwin') {
    const executable = packagedExecutable || await prepareMacDevShell(root, electronCli, { variant: 'e2e' })
    // Launch the prepared executable directly. `open --args` routes through
    // LaunchServices and can silently deliver arguments to an already-running
    // app instance, which makes an isolated E2E run miss its report path.
    child = spawn(executable, args, { cwd: root, stdio: 'inherit' })
  } else child = spawn(process.execPath, [electronCli, ...args], { cwd: root, stdio: 'inherit' })
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  try {
    const result = await Promise.race([
      waitForReport(report),
      exited.then(result => { throw new Error(`Electron exited before E2E report: ${JSON.stringify(result)} mode=${mode} data=${launchDataDir}`) }),
    ])
    await exited
    return result
  } catch (error) {
    const backendLog = await readFile(join(launchDataDir, 'local-backend.log'), 'utf8').catch(() => '')
    throw new Error(`${error instanceof Error ? error.message : String(error)}${backendLog ? `\n--- local-backend.log ---\n${backendLog.slice(-12_000)}` : ''}`)
  } finally {
    // A failed test must never leave a hidden Electron/Worker process behind.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resolveDelay => setTimeout(resolveDelay, 6_000))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
}

try {
  const created = await launch('create')
  const ui = await launch('ui')
  const conversation = await launch('conversation')
  // Recovery must choose the newest *healthy* backup, not merely the newest
  // filename. Keep an older valid copy and a newer corrupt copy, then corrupt
  // the primary database before booting a real Electron instance.
  const recoveryDataDir = join(testRoot, 'recovery-data')
  await mkdir(join(recoveryDataDir, 'database-backups'), { recursive: true })
  const savedAppDatabase = await readFile(join(dataDir, 'tugo.sqlite'))
  await writeFile(join(recoveryDataDir, 'tugo.sqlite'), Buffer.from('corrupt primary database'))
  await writeFile(join(recoveryDataDir, 'tugo-config.json'), await readFile(join(dataDir, 'tugo-config.json')))
  await writeFile(join(recoveryDataDir, 'database-backups', 'tugo-2026-08-01T00-00-00-000Z.sqlite'), savedAppDatabase)
  await writeFile(join(recoveryDataDir, 'database-backups', 'tugo-2026-08-02T00-00-00-000Z.sqlite'), Buffer.from('corrupt newest backup'))
  const appRecovery = await launch('recover-app', recoveryDataDir)
  const pendingRecoveryDataDir = join(testRoot, 'pending-recovery-data')
  await mkdir(pendingRecoveryDataDir, { recursive: true })
  await writeFile(join(pendingRecoveryDataDir, 'tugo.sqlite'), Buffer.from('corrupt primary database'))
  await writeFile(join(pendingRecoveryDataDir, 'tugo-recovery.pending.sqlite'), savedAppDatabase)
  await writeFile(join(pendingRecoveryDataDir, 'tugo-config.json'), await readFile(join(dataDir, 'tugo-config.json')))
  const pendingRecovery = await launch('recover-pending', pendingRecoveryDataDir)
  // Keep the App database, but deliberately omit Runtime's database. This
  // reproduces a restore/reset where saved conversations point to gone threads.
  const staleThreadDataDir = join(testRoot, 'stale-thread-data')
  await mkdir(staleThreadDataDir, { recursive: true })
  await writeFile(join(staleThreadDataDir, 'tugo.sqlite'), await readFile(join(dataDir, 'tugo.sqlite')))
  await writeFile(join(staleThreadDataDir, 'tugo-config.json'), await readFile(join(dataDir, 'tugo-config.json')))
  const verified = await launch('verify')
  const staleThread = await launch('stale-thread', staleThreadDataDir)
  const workerCrash = await launch('worker-crash')
  const rendererCrash = await launch('renderer-crash')
  const migrationDataDir = join(testRoot, 'migration-data')
  await mkdir(migrationDataDir, { recursive: true })
  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default
  const SQL = await initSqlJs(); const legacy = new SQL.Database(); const now = '2026-08-01T00:00:00.000Z'
  legacy.run(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, folder_id TEXT, name TEXT NOT NULL, document_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE templates (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, template_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE project_sessions (project_id TEXT PRIMARY KEY, thread_id TEXT, messages_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  legacy.run('INSERT INTO folders VALUES (?, ?, ?, ?)', ['legacy-folder', 'Legacy Folder', now, now])
  legacy.run('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)', ['legacy-project', 'legacy-folder', 'Legacy Board', JSON.stringify({ version: 1, elements: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), now, now])
  legacy.run('INSERT INTO project_sessions VALUES (?, ?, ?, ?)', ['legacy-project', 'legacy-thread', JSON.stringify([{ id: 'legacy-message', role: 'user', content: 'legacy persisted', createdAt: now }]), now])
  await writeFile(join(migrationDataDir, 'tugo.sqlite'), Buffer.from(legacy.export())); legacy.close()
  await writeFile(join(migrationDataDir, 'tugo-config.json'), JSON.stringify({ theme: 'dark', bootstrap: { legacy: true } }, null, 2))
  const migrated = await launch('migrate', migrationDataDir)
  const migratedDatabase = new SQL.Database(await readFile(join(migrationDataDir, 'tugo.sqlite')))
  const migrationRows = migratedDatabase.exec('SELECT version, name FROM app_schema_migrations ORDER BY version')?.[0]?.values || []
  migratedDatabase.close()
  const expectedAppMigrationManifest = [
    [1, 'initial-app-schema'], [2, 'multi-conversation-projects'], [3, 'single-lead-template'],
    [4, 'project-skill-bindings-and-conversation-model'], [5, 'explicit-project-skill-scope'],
    [6, 'snapshot-source-separation'], [7, 'durable-project-snapshots'],
  ]
  if (JSON.stringify(migrationRows.map(([version, name]) => [Number(version), String(name)])) !== JSON.stringify(expectedAppMigrationManifest)) {
    throw new Error(`app migration manifest mismatch: ${JSON.stringify(migrationRows)}`)
  }
  process.stdout.write(`${JSON.stringify({ created: created.result, ui: ui.result, conversation: conversation.result, appRecovery: appRecovery.result, pendingRecovery: pendingRecovery.result, verified: verified.result, staleThread: staleThread.result, workerCrash: workerCrash.result, rendererCrash: rendererCrash.result, migrated: migrated.result }, null, 2)}\n`)
} finally {
  await new Promise(resolveClose => provider.close(resolveClose))
  await rm(testRoot, { recursive: true, force: true })
}
