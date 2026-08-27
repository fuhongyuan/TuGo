const { app, BrowserWindow, ipcMain, Menu, shell, nativeImage, dialog } = require('electron')
const { join, resolve, basename, extname, parse, sep } = require('path')
const { existsSync } = require('fs')
const { mkdir, readFile, writeFile, access, appendFile, rename, copyFile, readdir, unlink, stat } = require('fs/promises')
const { randomUUID, createCipheriv, createDecipheriv, scryptSync, randomBytes } = require('crypto')
const os = require('os')
const initSqlJs = require('sql.js/dist/sql-asm.js')
const JSZip = require('jszip')
const { EmbeddedRuntimeClient } = require('./runtime-client.cjs')
const { AppDatabaseStorage } = require('./app-database-storage.cjs')
const { AppRepository } = require('./app-repository.cjs')
const { attachWindowLifecycle, restoreExistingWindow } = require('./window-lifecycle.cjs')

const APP_NAME = 'TuGo'
const APP_ID = 'com.agentplatform.tugo'
const CONFIG_FILE = 'tugo-config.json'
// App SQLite is durable user data. Keep its public history in one ordered
// manifest so a version cannot be reused or silently renamed during a future
// release. Migration bodies remain beside the data bootstrap they evolve.
const APP_MIGRATION_MANIFEST = Object.freeze([
  { version: 1, name: 'initial-app-schema' },
  { version: 2, name: 'multi-conversation-projects' },
  { version: 3, name: 'single-lead-template' },
  { version: 4, name: 'project-skill-bindings-and-conversation-model' },
  { version: 5, name: 'explicit-project-skill-scope' },
  { version: 6, name: 'snapshot-source-separation' },
  { version: 7, name: 'durable-project-snapshots' },
])
const appMigrationName = version => {
  const entry = APP_MIGRATION_MANIFEST.find(item => item.version === version)
  if (!entry) throw new Error(`App migration ${version} is not declared in the manifest`)
  return entry.name
}
const isDev = Boolean(process.defaultApp) || /node_modules[\\/]electron[\\/]/.test(process.execPath)
const argumentValue = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const e2eReportPath = process.env.TUGO_E2E_REPORT || argumentValue('tugo-e2e-report')
const e2eMode = process.env.TUGO_E2E_MODE || argumentValue('tugo-e2e-mode') || 'create'
const e2eStartedAt = Number(argumentValue('tugo-e2e-started-at') || 0)
const e2eProviderUrl = argumentValue('tugo-e2e-provider') || ''
const e2eAttachmentPath = argumentValue('tugo-e2e-attachment') || ''
const soakReportPath = argumentValue('tugo-soak-report') || ''
const soakDurationMs = Math.max(1_000, Number(argumentValue('tugo-soak-duration-ms') || 0))
app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
const requestedUserData = process.env.TUGO_USER_DATA || argumentValue('tugo-user-data')
if (requestedUserData) app.setPath('userData', resolve(requestedUserData))
else if (isDev) app.setPath('userData', join(app.getPath('appData'), 'TuGo-Dev'))
// Automated desktop runs always use an isolated userData directory and may
// intentionally run beside the long soak process. Production launches keep
// the normal single-instance guarantee.
const hasSingleInstanceLock = Boolean(e2eReportPath || soakReportPath) || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow = null
let database = null
let appDatabaseStorage = null
let appRepository = null
let shutdownStarted = false
let shutdownComplete = false
let startupReady = false
let runtimeClient = null
let downloadHandlerInstalled = false
let rendererRecoveryAttempts = []
let rendererCrashE2ETriggered = false
const pendingToolCalls = new Map()

// Electron's development runner otherwise exposes Electron's default Dock
// icon even though the window title is TuGo.  A nativeImage is used here
// so the dev build has the same identity as the packaged app.
const appIcon = () => nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'tugo.png'))
const isSafeExternalUrl = value => { try { return ['https:', 'http:'].includes(new URL(value).protocol) } catch { return false } }
const openSafeExternal = value => { if (isSafeExternalUrl(value)) void shell.openExternal(value) }

const configPath = () => join(app.getPath('userData'), CONFIG_FILE)
const backendLogPath = () => join(app.getPath('userData'), 'local-backend.log')
const dbPath = () => join(app.getPath('userData'), 'tugo.sqlite')
const secretsPath = () => join(app.getPath('userData'), 'runtime-secrets.json')
const localSecretKey = () => scryptSync(`tugo-local-secrets:${APP_ID}:${app.getPath('userData')}:${os.userInfo().username}`, 'tugo-local-secret-v1', 32)
const encryptLocalSecret = value => {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', localSecretKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return `local-v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`
}
const decryptLocalSecret = value => {
  const parts = String(value).split(':')
  if (parts.length !== 4 || parts[0] !== 'local-v1') return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', localSecretKey(), Buffer.from(parts[1], 'base64'))
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8')
  } catch { return null }
}
const pendingRecoveryPath = () => join(app.getPath('userData'), 'tugo-recovery.pending.sqlite')
const databaseBackupDir = () => join(app.getPath('userData'), 'database-backups')
const logBackend = async (line) => {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await appendFile(backendLogPath(), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* diagnostics must never crash the shell */ }
}
const bundledConfigCandidates = () => [
  join(process.resourcesPath || '', 'tugo-config.bundle.json'),
  join(__dirname, '..', 'tugo-config.bundle.json'),
]
const readJson = async (path, fallback = {}) => {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}
const ensureConfig = async () => {
  await mkdir(app.getPath('userData'), { recursive: true })
  const current = await readJson(configPath(), {})
  let bundled = {}
  for (const candidate of bundledConfigCandidates()) {
    try { await access(candidate); bundled = await readJson(candidate, {}); break } catch { /* next */ }
  }
  const next = {
    theme: current.theme || bundled.theme || 'system',
    language: current.language || bundled.language || 'system',
    drawingCursor: current.drawingCursor || bundled.drawingCursor || { style: 'tugo', color: '#4F46E5' },
    model: current.model ? { ...current.model, apiKey: undefined } : null,
    bootstrap: current.bootstrap || {},
  }
  await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}
const readConfig = () => readJson(configPath(), {})
let runtimeSecretsCache = null
let runtimeSecretsReadPromise = null
const readRuntimeSecrets = async () => {
  if (runtimeSecretsCache) return { ...runtimeSecretsCache }
  if (runtimeSecretsReadPromise) return { ...(await runtimeSecretsReadPromise) }
  runtimeSecretsReadPromise = (async () => {
  const encrypted = await readJson(secretsPath(), {})
  const values = {}
  // Avoid touching the OS keychain on a clean first launch. On macOS this can
  // block application startup while the security service initializes even
  // though there are no secrets to decrypt yet.
  if (!Object.keys(encrypted).length) return values
  for (const [id, value] of Object.entries(encrypted)) {
    const decrypted = decryptLocalSecret(value)
    if (decrypted !== null) values[id] = decrypted
  }
  return values
  })()
  try {
    runtimeSecretsCache = await runtimeSecretsReadPromise
    return { ...runtimeSecretsCache }
  } finally { runtimeSecretsReadPromise = null }
}
const storeRuntimeSecret = async value => {
  const id = `secret_${randomUUID()}`
  const encrypted = await readJson(secretsPath(), {})
  encrypted[id] = encryptLocalSecret(value)
  await writeFile(secretsPath(), JSON.stringify(encrypted, null, 2), { encoding: 'utf8', mode: 0o600 })
  // The next snapshot must include the newly written value, but all callers
  // in the same startup should share one decrypted snapshot. This prevents
  // repeated macOS "TuGo Safe Storage" prompts during bootstrap.
  runtimeSecretsCache = null
  runtimeSecretsReadPromise = null
  return id
}
const protectMcpCredentials = async body => {
  const next = { ...body }
  for (const field of ['headers', 'env']) {
    if (!next[field] || typeof next[field] !== 'object' || Array.isArray(next[field])) continue
    const protectedValues = {}
    for (const [key, value] of Object.entries(next[field])) {
      const sensitive = field === 'headers' ? /authorization|token|api[-_]?key|secret|cookie/i.test(key) : /token|key|secret|password|credential/i.test(key)
      protectedValues[key] = sensitive && typeof value === 'string' && value && !value.startsWith('secret://') ? `secret://${await storeRuntimeSecret(value)}` : value
    }
    next[field] = protectedValues
  }
  return next
}
const prepareRuntimeRequest = async (method, params = {}) => {
  if (method !== 'runtime.http') return params
  const path = String(params.path || '').split('?', 1)[0]
  const verb = String(params.method || 'GET').toUpperCase()
  if ((path === '/api/mcp/credentials' && verb === 'POST') || (path.startsWith('/api/mcp/credentials/') && verb === 'PUT')) {
    const body = await protectMcpCredentials({ ...(params.body || {}) })
    await runtimeClient.request('runtime.secrets.set', { secrets: await readRuntimeSecrets() })
    return { ...params, body }
  }
  if (!((path === '/api/models' && verb === 'POST') || (path.startsWith('/api/models/') && verb === 'PUT'))) return params
  const body = { ...(params.body || {}) }
  const extra = body.extra_config && typeof body.extra_config === 'object' ? { ...body.extra_config } : null
  if (extra && typeof extra.api_key === 'string' && extra.api_key) {
    extra.api_key_ref = await storeRuntimeSecret(extra.api_key)
    delete extra.api_key
    body.extra_config = extra
    await runtimeClient.request('runtime.secrets.set', { secrets: await readRuntimeSecrets() })
  }
  return { ...params, body }
}
const prepareAttachmentImport = async params => {
  if (String(params?.method || '').toUpperCase() !== 'POST' || String(params?.path || '').split('?', 1)[0] !== '/api/attachments/import') return { params }
  const source = resolve(String(params?.body?.path || '')); const extension = extname(source).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return { params: { ...params, body: { ...(params.body || {}), original_name: basename(source) } } }
  const info = await stat(source)
  if (info.size > 64 * 1024 * 1024) throw new Error('图片超过 64 MB，无法安全处理')
  const image = nativeImage.createFromPath(source); if (image.isEmpty()) throw new Error('图片无法读取或格式不受支持')
  const size = image.getSize(); const pixels = size.width * size.height
  if (pixels <= 40_000_000 && info.size <= 20 * 1024 * 1024) return { params: { ...params, body: { ...(params.body || {}), original_name: basename(source) } } }
  const scale = Math.min(1, Math.sqrt(36_000_000 / Math.max(1, pixels)), 8192 / Math.max(size.width, size.height))
  const resized = image.resize({ width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)), quality: 'best' })
  const jpeg = ['.jpg', '.jpeg'].includes(extension); const output = jpeg ? resized.toJPEG(88) : resized.toPNG()
  if (output.byteLength > 20 * 1024 * 1024) throw new Error('图片压缩后仍超过 20 MB，请手动缩小后重试')
  const temporaryDir = join(app.getPath('temp'), 'tugo-attachment-imports'); await mkdir(temporaryDir, { recursive: true })
  const temporaryPath = join(temporaryDir, `${randomUUID()}-${parse(source).name}.${jpeg ? 'jpg' : 'png'}`); await writeFile(temporaryPath, output)
  return { params: { ...params, body: { ...(params.body || {}), path: temporaryPath, original_name: basename(source) } }, temporaryPath }
}
const migrateLegacyRuntimeSecrets = async () => {
  const legacy = await runtimeClient.request('runtime.secrets.export-legacy')
  if (!Array.isArray(legacy) || !legacy.length) return
  const references = {}
  for (const item of legacy) references[String(item.model_id)] = await storeRuntimeSecret(String(item.api_key))
  await runtimeClient.request('runtime.secrets.apply-references', { references })
  await runtimeClient.request('runtime.secrets.set', { secrets: await readRuntimeSecrets() })
  await logBackend(`migrated ${legacy.length} legacy model secret(s) to local encrypted storage`)
}

// Development uses an isolated user-data directory so it never corrupts the
// installed app.  On the first dev launch, however, bring across *only* the
// previously configured model connections. Projects, conversations and other
// runtime data remain isolated.  Secrets are decrypted and re-encrypted with
// a fresh local reference instead of copying an opaque secret blob.
const importInstalledModelsForDevelopment = async () => {
  // The macOS development shell is a copied Electron.app, so Electron may
  // report it as packaged. The isolated data-directory name is the reliable
  // signal here (and custom/E2E directories must never be imported into).
  if (requestedUserData || basename(app.getPath('userData')) !== 'TuGo-Dev') return 0
  const current = await runtimeClient.request('runtime.http', { method: 'GET', path: '/api/models' })
  if (Array.isArray(current?.items) && current.items.length) return 0
  const sourceDir = join(app.getPath('appData'), APP_NAME)
  const sourceDb = join(sourceDir, 'runtime', 'runtime.sqlite')
  if (!existsSync(sourceDb)) return 0
  try {
    const SQL = await initSqlJs()
    const source = new SQL.Database(await readFile(sourceDb))
    const rows = []
    const statement = source.prepare('SELECT name,provider_id,model,display_name,enabled,is_default,extra_json FROM models ORDER BY is_default DESC, updated_at DESC')
    while (statement.step()) rows.push(statement.getAsObject())
    statement.free(); source.close()
    let imported = 0
    for (const row of rows) {
      const extra = (() => { try { return JSON.parse(String(row.extra_json || '{}')) } catch { return {} } })()
      // Installed versions may have stored an OS-keychain reference. It is
      // intentionally not read here: this single-user build never touches
      // the OS keychain. The user can re-enter that model key if needed.
      delete extra.api_key_ref
      const body = {
        name: String(row.name || `imported-${randomUUID()}`), provider_id: String(row.provider_id || 'openai'), model: String(row.model || ''),
        display_name: String(row.display_name || row.model || '已导入模型'), enabled: Number(row.enabled) !== 0, is_default: Number(row.is_default) !== 0,
        extra_config: extra,
      }
      const prepared = await prepareRuntimeRequest('runtime.http', { method: 'POST', path: '/api/models', body })
      await runtimeClient.request('runtime.http', prepared.params)
      imported += 1
    }
    if (imported) await logBackend(`imported ${imported} installed model connection(s) into development runtime`)
    return imported
  } catch (error) {
    await logBackend(`installed model import skipped: ${String(error?.message || error)}`)
    return 0
  }
}

const emptyDocument = () => JSON.stringify({ version: 1, elements: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })
const welcomeDocument = () => JSON.stringify({
  version: 3,
  viewport: { x: 80, y: 95, zoom: 0.88 },
  elements: [
    { id: 'idea', kind: 'ellipse', x: 80, y: 190, width: 170, height: 92, text: '描述你的想法', fill: '#ede9fe', stroke: '#6457c7', strokeWidth: 2, fontSize: 16 },
    { id: 'canvas', kind: 'rectangle', x: 690, y: 90, width: 210, height: 92, text: '无限画布', fill: '#dcfce7', stroke: '#3a8f65', strokeWidth: 2, fontSize: 16 },
    { id: 'dsl', kind: 'note', x: 690, y: 280, width: 210, height: 105, text: 'Mermaid · PlantUML\ndraw.io XML', fill: '#fef3c7', stroke: '#b68126', strokeWidth: 2, fontSize: 15 },
    { id: 'result', kind: 'diamond', x: 1010, y: 174, width: 190, height: 132, text: '清晰、可编辑\n可持续演进', fill: '#fce7f3', stroke: '#b65381', strokeWidth: 2, fontSize: 16 }
  ],
  edges: [
    { id: 'e1', from: 'idea', to: 'canvas', label: '自动绘制', stroke: '#6b7280', strokeWidth: 2, arrowEnd: true },
    { id: 'e4', from: 'canvas', to: 'result', stroke: '#6b7280', strokeWidth: 2, arrowEnd: true },
    { id: 'e5', from: 'dsl', to: 'result', stroke: '#6b7280', strokeWidth: 2, arrowEnd: true }
  ]
})
const simplifyWelcomeDocument = value => {
  try {
    const document = JSON.parse(value)
    const demoAgent = document.elements?.find(item => item.id === 'agent' && /TuGo (AI|Agent)/.test(String(item.text || '')))
    if (!demoAgent) return null
    document.elements = document.elements.filter(item => item !== demoAgent)
    document.edges = document.edges.filter(edge => edge.from !== demoAgent.id && edge.to !== demoAgent.id)
    document.edges.unshift({ id: 'e1', from: 'idea', to: 'canvas', label: '自动绘制', stroke: '#6b7280', strokeWidth: 2, arrowEnd: true })
    document.version = 3
    return JSON.stringify(document)
  } catch { return null }
}
const backupCurrentDatabase = async (force = false) => appDatabaseStorage?.backup(force)
const persistDatabase = () => appDatabaseStorage && database ? appDatabaseStorage.persist(database) : Promise.resolve()
const dbAll = (sql, params = []) => {
  const statement = database.prepare(sql); statement.bind(params); const rows = []
  while (statement.step()) rows.push(statement.getAsObject())
  statement.free(); return rows
}
const dbGet = (sql, params = []) => dbAll(sql, params)[0]
const dbRun = (sql, params = []) => { database.run(sql, params); return persistDatabase() }
const initDatabase = async () => {
  const SQL = await initSqlJs()
  appDatabaseStorage = new AppDatabaseStorage({ userDataPath: app.getPath('userData'), databasePath: dbPath(), backupDirectory: databaseBackupDir(), pendingRecoveryPath: pendingRecoveryPath(), log: logBackend })
  database = await appDatabaseStorage.open(SQL)
  database.run('PRAGMA foreign_keys=ON')
  database.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, folder_id TEXT, name TEXT NOT NULL, document_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, template_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_sessions (
      project_id TEXT PRIMARY KEY, thread_id TEXT, messages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT, title TEXT NOT NULL,
      messages_json TEXT NOT NULL, model_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_skills (
      project_id TEXT NOT NULL, skill_id TEXT NOT NULL,
      PRIMARY KEY(project_id, skill_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_skill_scopes (
      project_id TEXT PRIMARY KEY, configured_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_active_conversations (
      project_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(conversation_id) REFERENCES project_conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS project_snapshots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      reason TEXT NOT NULL, summary TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      document_json TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_snapshots_project_created ON project_snapshots(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    );
  `)
  const recordedMigrations = dbAll('SELECT version, name FROM app_schema_migrations').map(row => ({ version: Number(row.version), name: String(row.name) }))
  for (const migration of APP_MIGRATION_MANIFEST) {
    const existing = recordedMigrations.find(row => row.version === migration.version)
    if (existing && existing.name !== migration.name) throw new Error(`App migration ${migration.version} name mismatch: expected ${migration.name}, found ${existing.name}`)
  }
  const recordMigration = version => database.run('INSERT INTO app_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', [version, appMigrationName(version), new Date().toISOString()])
  if (!dbGet('SELECT version FROM app_schema_migrations WHERE version = 1')) recordMigration(1)
  const count = Number(dbGet('SELECT COUNT(*) AS count FROM projects').count || 0)
  if (!count) {
    const now = new Date().toISOString()
    await dbRun('INSERT INTO projects (id, folder_id, name, document_json, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)', [`project_${randomUUID()}`, '欢迎来到 TuGo', welcomeDocument(), now, now])
  }
  const welcomeRow = dbGet("SELECT id, document_json FROM projects WHERE name = '欢迎来到 TuGo' ORDER BY created_at LIMIT 1")
  const simplifiedWelcome = welcomeRow ? simplifyWelcomeDocument(welcomeRow.document_json) : null
  if (welcomeRow && simplifiedWelcome) await dbRun('UPDATE projects SET document_json = ?, updated_at = ? WHERE id = ?', [simplifiedWelcome, new Date().toISOString(), welcomeRow.id])
  if (!dbGet('SELECT version FROM app_schema_migrations WHERE version = 2')) {
    database.run('BEGIN')
    try {
      for (const row of dbAll('SELECT * FROM project_sessions')) {
        const id = `conversation_${row.project_id}`
        const createdAt = row.updated_at || new Date().toISOString()
        database.run('INSERT OR IGNORE INTO project_conversations (id, project_id, thread_id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, row.project_id, row.thread_id || null, '会话', row.messages_json || '[]', createdAt, createdAt])
        database.run('INSERT OR IGNORE INTO project_active_conversations (project_id, conversation_id) VALUES (?, ?)', [row.project_id, id])
      }
      recordMigration(2)
      database.run('COMMIT')
    } catch (error) { database.run('ROLLBACK'); throw error }
  }
  if (!dbGet('SELECT version FROM app_schema_migrations WHERE version = 6')) {
    database.run('BEGIN')
    try {
      // Snapshots created before source separation were all user initiated.
      // The column is added separately because CREATE TABLE IF NOT EXISTS does
      // not alter an existing desktop database.
      if (!dbAll('PRAGMA table_info(project_snapshots)').some(column => String(column.name) === 'source')) database.run("ALTER TABLE project_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'user'")
      database.run("CREATE INDEX IF NOT EXISTS idx_project_snapshots_project_source_created ON project_snapshots(project_id, source, created_at DESC)")
      recordMigration(6)
      database.run('COMMIT')
    } catch (error) { database.run('ROLLBACK'); throw error }
  }
  const template = {
    lead: {
      name: 'tugo_architect', display_name: 'TuGo 画图助手',
      description: '理解业务意图并直接操作当前无限画布的通用视觉架构师。',
      tool_groups: ['web'], skills: ['tugo-architect'],
    },
  }
  await dbRun('INSERT OR REPLACE INTO templates (id, kind, name, template_json, updated_at) VALUES (?, ?, ?, ?, ?)', ['tugo-default-agent', 'agent', 'TuGo 默认 Agent', JSON.stringify(template), new Date().toISOString()])
  if (!dbGet('SELECT version FROM app_schema_migrations WHERE version = 3')) await dbRun('INSERT INTO app_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', [3, appMigrationName(3), new Date().toISOString()])
  if (!dbGet('SELECT version FROM app_schema_migrations WHERE version = 4')) {
    // Existing installations predate the per-conversation model selection.
    // SQLite has no ADD COLUMN IF NOT EXISTS, so probe first.
    const columns = dbAll('PRAGMA table_info(project_conversations)').map(row => String(row.name))
    if (!columns.includes('model_id')) database.run('ALTER TABLE project_conversations ADD COLUMN model_id TEXT')
    recordMigration(4)
  }
  if (!dbGet('SELECT version FROM app_schema_migrations WHERE version = 5')) {
    // Version 4 stored explicit non-empty selections in project_skills but had
    // no separate marker. Preserve those selections when introducing the
    // "not configured yet = all enabled" default in version 5.
    database.run('INSERT OR IGNORE INTO project_skill_scopes(project_id, configured_at) SELECT DISTINCT project_id, ? FROM project_skills', [new Date().toISOString()])
    recordMigration(5)
  }
  if (!dbGet('SELECT version FROM app_schema_migrations WHERE version = 7')) {
    // Version 5 is already reserved for project skill scope. The former
    // duplicate version made this migration permanently unreachable. The
    // table itself is created above for old databases; this marker keeps the
    // migration history accurate for later upgrades.
    recordMigration(7)
  }
  await persistDatabase()
  appRepository = new AppRepository({ database: () => database, persist: persistDatabase, emptyDocument, rowToFolder, rowToProject, rowToConversation })
}
const rowToFolder = row => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at })
const rowToProject = row => ({ id: row.id, folderId: row.folder_id, name: row.name, document: JSON.parse(row.document_json), createdAt: row.created_at, updatedAt: row.updated_at })
const rowToConversation = row => ({ id: row.id, projectId: row.project_id, threadId: row.thread_id || undefined, modelId: row.model_id || undefined, title: row.title || '新会话', messages: JSON.parse(row.messages_json || '[]'), createdAt: row.created_at, updatedAt: row.updated_at })

const reconcileConversationThreads = async () => {
  const rows = dbAll("SELECT id,thread_id FROM project_conversations WHERE thread_id IS NOT NULL AND thread_id != ''")
  let cleared = 0
  for (const row of rows) {
    try { await runtimeClient.request('runtime.http', { method: 'GET', path: `/api/threads/${encodeURIComponent(String(row.thread_id))}?include_values=false` }) }
    catch (error) {
      // Do not erase a link when Runtime is merely unavailable: only a
      // definite missing-thread response is a safe reconciliation signal.
      const message = String(error?.message || error)
      if (!/thread not found|\b404\b/i.test(message)) { await logBackend(`conversation thread check deferred id=${row.id} error=${message}`); continue }
      database.run('UPDATE project_conversations SET thread_id=NULL,updated_at=? WHERE id=?', [new Date().toISOString(), row.id])
      cleared += 1
    }
  }
  if (cleared) { await persistDatabase(); await logBackend(`cleared ${cleared} stale conversation thread reference(s)`) }
  return cleared
}

const registerIpc = () => {
  ipcMain.handle('tugo:config:read', readConfig)
  ipcMain.handle('tugo:config:write', async (_, value) => {
    const current = await readConfig()
    const next = { ...current, ...value }
    await writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8')
    return next
  })
  ipcMain.handle('tugo:system:app-name', () => APP_NAME)
  ipcMain.handle('tugo:system:backend-log', async () => { try { return await readFile(backendLogPath(), 'utf8') } catch { return '' } })
  ipcMain.handle('tugo:system:choose-attachments', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要交给 AI 的文件', properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片与文档', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'docx', 'xlsx', 'txt', 'md', 'markdown', 'json', 'csv', 'svg', 'xml', 'mmd', 'mermaid', 'puml', 'plantuml'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('tugo:system:choose-skill', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择 Skill', properties: ['openFile', 'openDirectory'], filters: [{ name: 'Skill 文件', extensions: ['md', 'markdown'] }, { name: '所有文件', extensions: ['*'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const target = resolve(result.filePaths[0]); const info = await stat(target)
    const skillPath = info.isDirectory() ? join(target, 'SKILL.md') : target
    if (!/\.md$/i.test(skillPath) || !existsSync(skillPath)) throw new Error('请选择 SKILL.md 或包含它的 Skill 文件夹')
    const resources = []
    if (info.isDirectory()) {
      const entries = await readdir(target, { recursive: true }); if (entries.some(name => /(^|\/)(scripts?|[^/]+\.(?:js|mjs|cjs|ts|py|sh|bash))$/i.test(String(name)))) throw new Error('该 Skill 包含脚本，TuGo 不支持上传')
      for (const entry of entries) { const relative = String(entry).replaceAll('\\', '/'); const file = join(target, relative); const entryInfo = await stat(file); if (!entryInfo.isFile() || /^SKILL\.md$/i.test(relative) || !/\.(md|markdown|txt|json|ya?ml|csv|xml|mmd|mermaid|puml|plantuml)$/i.test(relative)) continue; if (entryInfo.size > 512 * 1024) throw new Error(`资源文件过大：${relative}`); resources.push({ path: relative, content: await readFile(file, 'utf8') }) }
    }
    return { name: basename(info.isDirectory() ? target : skillPath).replace(/\.md$/i, ''), content: await readFile(skillPath, 'utf8'), resources }
  })
  ipcMain.handle('tugo:system:open-data-directory', () => shell.openPath(app.getPath('userData')))
  ipcMain.handle('tugo:system:open-backend-log', async () => { await access(backendLogPath()); return shell.openPath(backendLogPath()) })
  ipcMain.handle('tugo:system:open-downloaded-file', (_, path) => {
    const target = resolve(String(path || '')); const downloads = resolve(app.getPath('downloads'))
    if (!target.startsWith(downloads + sep)) throw new Error('只能打开 TuGo 下载目录中的文件')
    return shell.openPath(target)
  })
  ipcMain.handle('tugo:data:status', async () => {
    const integrity = database?.exec('PRAGMA integrity_check')?.[0]?.values?.[0]?.[0] || 'unavailable'
    const appBackups = await Promise.all((await readdir(databaseBackupDir()).catch(() => [])).filter(name => /^tugo-.*\.sqlite$/.test(name)).sort().reverse().map(async name => { const info = await stat(join(databaseBackupDir(), name)); return { name, size: info.size, createdAt: info.mtime.toISOString() } }))
    const runtime = runtimeClient ? await runtimeClient.request('runtime.http', { method: 'GET', path: '/api/runtime/data/status' }).catch(error => ({ error: String(error?.message || error), backups: [] })) : { error: 'Runtime unavailable', backups: [] }
    return { dataDir: app.getPath('userData'), logPath: backendLogPath(), app: { integrity, backups: appBackups }, runtime }
  })
  ipcMain.handle('tugo:data:backup', async () => {
    await persistDatabase(); const appBackup = await backupCurrentDatabase(true)
    const runtime = await runtimeClient.request('runtime.http', { method: 'POST', path: '/api/runtime/data/backup', body: {} })
    return { ok: true, app: appBackup, runtime }
  })
  ipcMain.handle('tugo:data:export-package', async (_, kind = 'backup') => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const zip = new JSZip()
    const manifest = { product: APP_NAME, format_version: 1, kind, created_at: new Date().toISOString(), platform: process.platform, app_version: app.getVersion() }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))
    if (kind === 'backup') {
      await persistDatabase(); const appBackup = await backupCurrentDatabase(true)
      const runtimeBackup = await runtimeClient.request('runtime.http', { method: 'POST', path: '/api/runtime/data/backup', body: {} })
      zip.file('data/tugo.sqlite', await readFile(appBackup?.path || dbPath()))
      zip.file('data/runtime.sqlite', await readFile(runtimeBackup.path))
    } else {
      const redactText = value => String(value || '')
        .replaceAll(app.getPath('home'), '[HOME]')
        .replaceAll(app.getPath('userData'), '[USER_DATA]')
        .replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[^\s"']+)/g, '[REDACTED]')
      const redactJson = (key, value) => /(?:api[_-]?key|authorization|token|secret|password|credential)/i.test(key) ? '[REDACTED]' : typeof value === 'string' ? redactText(value) : value
      const status = {
        app_integrity: database?.exec('PRAGMA integrity_check')?.[0]?.values?.[0]?.[0] || 'unavailable',
        runtime: await runtimeClient.request('runtime.http', { method: 'GET', path: '/api/runtime/data/status' }).catch(error => ({ error: String(error?.message || error) })),
      }
      zip.file('diagnostics/status.json', JSON.stringify(status, redactJson, 2))
      zip.file('diagnostics/local-backend.log', redactText(await readFile(backendLogPath(), 'utf8').catch(() => '')))
      const config = await readConfig(); zip.file('diagnostics/config.json', JSON.stringify({ ...config, model: config.model ? { ...config.model, apiKey: undefined } : null }, redactJson, 2))
    }
    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    const suggested = join(app.getPath('downloads'), `TuGo-${kind === 'backup' ? '完整备份' : '诊断包'}-${stamp}.zip`)
    const selected = await dialog.showSaveDialog(mainWindow, { title: kind === 'backup' ? '导出完整备份' : '导出诊断包', defaultPath: suggested, filters: [{ name: 'ZIP', extensions: ['zip'] }] })
    if (selected.canceled || !selected.filePath) return { cancelled: true }
    await writeFile(selected.filePath, output, { flush: true })
    return { ok: true, path: selected.filePath }
  })
  ipcMain.handle('tugo:data:restore', async (_, { scope, name } = {}) => {
    if (scope === 'app') {
      const match = (await readdir(databaseBackupDir()).catch(() => [])).find(item => item === name && /^tugo-.*\.sqlite$/.test(item))
      if (!match) throw new Error('找不到应用数据备份')
      const source = join(databaseBackupDir(), match); const bytes = await readFile(source); const SQL = await initSqlJs(); const candidate = new SQL.Database(bytes)
      const integrity = candidate.exec('PRAGMA integrity_check')?.[0]?.values?.[0]?.[0]; candidate.close(); if (integrity !== 'ok') throw new Error('备份完整性检查失败')
      await copyFile(source, pendingRecoveryPath())
    } else if (scope === 'runtime') await runtimeClient.request('runtime.http', { method: 'POST', path: '/api/runtime/data/restore', body: { name } })
    else throw new Error('未知的备份类型')
    setTimeout(() => { app.relaunch(); app.exit(0) }, 350)
    return { scheduled: true }
  })
  ipcMain.handle('tugo:runtime:request', async (_, method, params) => {
    // Renderer effects can finish during the short interval between the user
    // choosing Quit and Chromium tearing down the window. They must not revive
    // a Runtime Worker that shutdown has already stopped.
    if (shutdownStarted) return null
    if (!runtimeClient) throw new Error('Embedded Runtime 尚未启动')
    const cleanMethod = String(method || '')
    const prepared = await prepareAttachmentImport(await prepareRuntimeRequest(cleanMethod, params || {}))
    try { return await runtimeClient.request(cleanMethod, prepared.params) }
    catch (error) {
      // A request which was already in the IPC queue when quit started races
      // the worker shutdown. It is no longer user-visible work, so avoid
      // surfacing an Electron handler error during an otherwise clean exit.
      if (shutdownStarted) return null
      throw error
    }
    finally { if (prepared.temporaryPath) await unlink(prepared.temporaryPath).catch(() => undefined) }
  })
  ipcMain.handle('tugo:folders:list', () => appRepository.folders())
  ipcMain.handle('tugo:folders:create', (_, name) => appRepository.createFolder(name))
  ipcMain.handle('tugo:folders:rename', (_, payload) => appRepository.renameFolder(payload))
  ipcMain.handle('tugo:folders:remove', (_, id) => appRepository.removeFolder(id))
  ipcMain.handle('tugo:projects:list', () => appRepository.projects())
  ipcMain.handle('tugo:projects:get', (_, id) => appRepository.project(id))
  ipcMain.handle('tugo:projects:create', (_, payload = {}) => appRepository.createProject(payload))
  ipcMain.handle('tugo:projects:update', (_, payload) => appRepository.updateProject(payload))
  ipcMain.handle('tugo:projects:snapshots:create', async (_, payload = {}) => {
    const projectId = String(payload.projectId || '').trim()
    if (!projectId || !dbGet('SELECT id FROM projects WHERE id = ?', [projectId])) throw new Error('项目不存在')
    const document = payload.document && typeof payload.document === 'object' ? payload.document : null
    if (!document) throw new Error('快照缺少画布内容')
    const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
    const source = payload.source === 'agent' ? 'agent' : payload.source === 'user' || payload.source === undefined ? 'user' : ''
    const name = clean(payload.name, 80); const reason = clean(payload.reason, 500); const summary = clean(payload.summary, 1_500); const notes = clean(payload.notes, 3_000)
    if (!source) throw new Error('快照来源必须是 user 或 agent')
    if (!name || (source === 'agent' && (!reason || !summary))) throw new Error(source === 'agent' ? 'AI 快照需要名称、保存理由和内容摘要' : '快照需要名称')
    const id = `snapshot_${randomUUID()}`; const createdAt = new Date().toISOString()
    await dbRun('INSERT INTO project_snapshots(id,project_id,name,reason,summary,notes,source,document_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [id, projectId, name, reason, summary, notes, source, JSON.stringify(document), createdAt])
    return { id, projectId, name, reason, summary, notes, source, createdAt }
  })
  ipcMain.handle('tugo:projects:snapshots:list', (_, { projectId, page = 1, pageSize = 10, source = 'user' } = {}) => {
    const id = String(projectId || '').trim(); if (!id || !dbGet('SELECT id FROM projects WHERE id = ?', [id])) throw new Error('项目不存在')
    const snapshotSource = source === 'agent' ? 'agent' : source === 'user' ? 'user' : ''
    if (!snapshotSource) throw new Error('快照来源必须是 user 或 agent')
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 10, 10)); const safePage = Math.max(1, Number(page) || 1)
    const total = Number(dbGet('SELECT COUNT(*) AS count FROM project_snapshots WHERE project_id = ? AND source = ?', [id, snapshotSource]).count || 0)
    const items = dbAll('SELECT id,name,reason,summary,notes,source,created_at FROM project_snapshots WHERE project_id = ? AND source = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [id, snapshotSource, safePageSize, (safePage - 1) * safePageSize]).map(row => ({ id: String(row.id), name: String(row.name), reason: String(row.reason), summary: String(row.summary), notes: String(row.notes || ''), source: String(row.source || 'user'), createdAt: String(row.created_at) }))
    const hasMore = safePage * safePageSize < total
    return { projectId: id, source: snapshotSource, items, total, page: safePage, pageSize: safePageSize, hasMore, message: hasMore ? `已返回第 ${safePage} 页 ${items.length} 个${snapshotSource === 'agent' ? ' AI' : '用户'}快照；当前共 ${total} 个。如需更早版本，请使用 page=${safePage + 1} 继续查看。` : `已返回 ${items.length} 个${snapshotSource === 'agent' ? ' AI' : '用户'}快照；当前共 ${total} 个。` }
  })
  ipcMain.handle('tugo:projects:snapshots:get', (_, { projectId, snapshotId } = {}) => {
    const id = String(projectId || '').trim(); const snapshotIdValue = String(snapshotId || '').trim()
    const row = dbGet('SELECT * FROM project_snapshots WHERE project_id = ? AND id = ?', [id, snapshotIdValue])
    if (!row) throw new Error('未找到该画布快照')
    return { id: String(row.id), projectId: String(row.project_id), name: String(row.name), reason: String(row.reason), summary: String(row.summary), notes: String(row.notes || ''), source: String(row.source || 'user'), createdAt: String(row.created_at), document: JSON.parse(String(row.document_json)) }
  })
  ipcMain.handle('tugo:projects:snapshots:export', async (_, { projectId, snapshotId } = {}) => {
    const id = String(projectId || '').trim(); const snapshotIdValue = String(snapshotId || '').trim()
    const project = dbGet('SELECT name FROM projects WHERE id = ?', [id])
    const row = dbGet('SELECT * FROM project_snapshots WHERE project_id = ? AND id = ?', [id, snapshotIdValue])
    if (!project || !row) throw new Error('未找到要导出的画布快照')
    const document = JSON.parse(String(row.document_json)); const assets = []
    const attachmentIds = [...new Set((Array.isArray(document?.elements) ? document.elements : []).map(element => String(element?.metadata?.attachmentId || '')).filter(Boolean))]
    for (const attachmentId of attachmentIds) {
      const asset = await runtimeClient.request('runtime.http', { method: 'GET', path: `/api/attachments/${encodeURIComponent(attachmentId)}/download`, body: {} })
      if (!asset?.data_url) throw new Error(`无法读取快照中的图片：${attachmentId}`)
      assets.push({ attachment_id: attachmentId, name: String(asset.name || 'image.png'), mime_type: String(asset.mime_type || 'application/octet-stream'), data_url: String(asset.data_url) })
    }
    const payload = { product: APP_NAME, kind: 'board_snapshot', format_version: 1, exported_at: new Date().toISOString(), app_version: app.getVersion(), project: { name: String(project.name || '画板') }, snapshot: { name: String(row.name), reason: String(row.reason || ''), summary: String(row.summary || ''), notes: String(row.notes || ''), source: String(row.source || 'user'), created_at: String(row.created_at), document }, assets }
    const safeName = String(row.name || '画板快照').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 80) || '画板快照'
    const selected = await dialog.showSaveDialog(mainWindow, { title: '导出 TuGo 快照', defaultPath: join(app.getPath('downloads'), `${safeName}.tugo-snapshot`), filters: [{ name: 'TuGo 快照', extensions: ['tugo-snapshot'] }] })
    if (selected.canceled || !selected.filePath) return { cancelled: true }
    await writeFile(selected.filePath, JSON.stringify(payload), { encoding: 'utf8', flush: true })
    return { ok: true, path: selected.filePath }
  })
  ipcMain.handle('tugo:projects:snapshots:import', async (_, { projectId, path: requestedPath } = {}) => {
    const id = String(projectId || '').trim(); if (!id || !dbGet('SELECT id FROM projects WHERE id = ?', [id])) throw new Error('项目不存在')
    let selectedPath = String(requestedPath || '')
    if (!selectedPath) {
      const selected = await dialog.showOpenDialog(mainWindow, { title: '导入 TuGo 快照', properties: ['openFile'], filters: [{ name: 'TuGo 快照', extensions: ['tugo-snapshot', 'json'] }] })
      if (selected.canceled || !selected.filePaths[0]) return { cancelled: true }
      selectedPath = selected.filePaths[0]
    }
    const path = resolve(selectedPath); const info = await stat(path)
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('快照文件无效或超过 128 MB')
    let payload
    try { payload = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('无法解析快照文件') }
    if (payload?.product !== APP_NAME || payload?.kind !== 'board_snapshot' || payload?.format_version !== 1) throw new Error('这不是受支持的 TuGo 快照文件')
    const snapshot = payload.snapshot; const document = snapshot?.document
    if (!snapshot || !document || ![1, 2, 3].includes(Number(document.version)) || !Array.isArray(document.elements) || !Array.isArray(document.edges)) throw new Error('快照缺少有效的画板内容')
    if (document.elements.length > 20_000 || document.edges.length > 40_000) throw new Error('快照内容过大，无法安全导入')
    const assetMap = new Map(); const importedImageSources = {}; const temporaryPaths = []
    try {
      for (const asset of Array.isArray(payload.assets) ? payload.assets : []) {
        const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(asset?.data_url || ''))
        if (!match) continue
        const bytes = Buffer.from(match[2], 'base64'); if (!bytes.length || bytes.byteLength > 64 * 1024 * 1024) throw new Error('快照中的图片无效或过大')
        const extension = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(String(asset?.name || '')).toLowerCase()) ? extname(String(asset.name)).toLowerCase() : match[1] === 'image/jpeg' ? '.jpg' : match[1] === 'image/webp' ? '.webp' : match[1] === 'image/gif' ? '.gif' : '.png'
        const temporaryDir = join(app.getPath('temp'), 'tugo-snapshot-imports'); await mkdir(temporaryDir, { recursive: true })
        const temporaryPath = join(temporaryDir, `${randomUUID()}${extension}`); temporaryPaths.push(temporaryPath); await writeFile(temporaryPath, bytes)
        const imported = await runtimeClient.request('runtime.http', { method: 'POST', path: '/api/attachments/import', body: { path: temporaryPath, original_name: basename(String(asset?.name || `image${extension}`)) } })
        assetMap.set(String(asset?.attachment_id || ''), String(imported.attachment_id || ''))
        importedImageSources[String(imported.attachment_id || '')] = String(asset.data_url)
      }
      const importedDocument = JSON.parse(JSON.stringify(document))
      for (const element of importedDocument.elements) {
        if (!element?.metadata || typeof element.metadata !== 'object') continue
        const originalAttachmentId = String(element.metadata.attachmentId || '')
        const replacement = assetMap.get(originalAttachmentId)
        if (element.kind === 'image' && originalAttachmentId && !replacement) throw new Error(`快照缺少图片资源：${originalAttachmentId}`)
        if (replacement) element.metadata.attachmentId = replacement
        element.metadata.projectId = id
      }
      return { ok: true, name: String(snapshot.name || basename(path)), fileName: basename(path), document: importedDocument, imageSources: importedImageSources }
    } finally { await Promise.all(temporaryPaths.map(temporaryPath => unlink(temporaryPath).catch(() => undefined))) }
  })
  ipcMain.handle('tugo:projects:snapshots:latest', (_, projectId) => {
    const id = String(projectId || '').trim(); if (!id || !dbGet('SELECT id FROM projects WHERE id = ?', [id])) throw new Error('项目不存在')
    const row = dbGet('SELECT id,name,source,created_at FROM project_snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', [id])
    return row ? { id: String(row.id), name: String(row.name), source: String(row.source || 'user'), createdAt: String(row.created_at) } : null
  })
  ipcMain.handle('tugo:projects:snapshots:remove', async (_, { projectId, snapshotId } = {}) => {
    const id = String(projectId || '').trim(); const snapshotIdValue = String(snapshotId || '').trim()
    if (!id || !snapshotIdValue || !dbGet('SELECT id FROM projects WHERE id = ?', [id])) throw new Error('项目不存在')
    const exists = dbGet('SELECT id FROM project_snapshots WHERE project_id = ? AND id = ?', [id, snapshotIdValue])
    if (!exists) throw new Error('未找到该画布快照')
    await dbRun('DELETE FROM project_snapshots WHERE project_id = ? AND id = ?', [id, snapshotIdValue])
    return true
  })
  ipcMain.handle('tugo:projects:skills:get', (_, projectId) => {
    const id = String(projectId || '')
    return { configured: Boolean(dbGet('SELECT project_id FROM project_skill_scopes WHERE project_id = ?', [id])), skillIds: dbAll('SELECT skill_id FROM project_skills WHERE project_id = ? ORDER BY skill_id', [id]).map(row => String(row.skill_id)) }
  })
  ipcMain.handle('tugo:projects:skills:set', async (_, { projectId, skillIds } = {}) => {
    const id = String(projectId || '').trim()
    if (!id || !dbGet('SELECT id FROM projects WHERE id = ?', [id])) throw new Error('项目不存在')
    const ids = [...new Set((Array.isArray(skillIds) ? skillIds : []).map(value => String(value || '').trim()).filter(Boolean))]
    database.run('BEGIN')
    try {
      database.run('DELETE FROM project_skills WHERE project_id = ?', [id])
      for (const skillId of ids) database.run('INSERT INTO project_skills(project_id, skill_id) VALUES (?, ?)', [id, skillId])
      database.run('INSERT INTO project_skill_scopes(project_id, configured_at) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET configured_at = excluded.configured_at', [id, new Date().toISOString()])
      database.run('COMMIT')
    } catch (error) { database.run('ROLLBACK'); throw error }
    await persistDatabase(); return ids
  })
  ipcMain.handle('tugo:projects:remove', (_, id) => appRepository.removeProject(id))
  ipcMain.handle('tugo:conversations:list', () => appRepository.conversations())
  ipcMain.handle('tugo:conversations:create', (_, projectId) => appRepository.createConversation(projectId))
  ipcMain.handle('tugo:conversations:save', (_, value = {}) => appRepository.saveConversation(value))
  ipcMain.handle('tugo:conversations:activate', (_, payload = {}) => appRepository.activateConversation(payload))
  ipcMain.handle('tugo:conversations:remove-for-project', (_, projectId) => appRepository.removeConversationsForProject(projectId))
  ipcMain.on('tugo:board-tool-result', (_, payload) => {
    const pending = pendingToolCalls.get(payload.id)
    if (!pending) { void logBackend(`board tool late-or-unknown response id=${String(payload.id || '')}`); return }
    pendingToolCalls.delete(payload.id)
    payload.error ? pending.reject(new Error(payload.error)) : pending.resolve(payload.result)
  })
}

const requestRendererTool = (name, args, context = {}) => new Promise((resolvePromise, rejectPromise) => {
  // A macOS activate/close sequence can replace the BrowserWindow while an
  // active Run is still alive.  Do not trust a stale module-level reference:
  // use the current live window if one exists.  This keeps an in-flight Run
  // attached to the visible application rather than silently sending all
  // canvas calls into a null window.
  const win = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow
    : BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed())
  if (!win) {
    void logBackend(`board tool unavailable name=${name}: no live renderer window`)
    return rejectPromise(new Error('TuGo 窗口不可用'))
  }
  mainWindow = win
  const id = randomUUID()
  const startedAt = Date.now()
  void logBackend(`board tool requested id=${id} name=${name} project=${String(args?.project_id || '')}`)
  const timeoutMs = Math.max(1, Number(context.tool_timeout_ms || 30000))
  const timer = setTimeout(() => { pendingToolCalls.delete(id); void logBackend(`board tool timeout id=${id} name=${name} elapsed_ms=${Date.now() - startedAt}`); rejectPromise(new Error(`工具 ${name} 执行超时（${timeoutMs}ms）`)) }, timeoutMs)
  pendingToolCalls.set(id, {
    resolve: value => { clearTimeout(timer); void logBackend(`board tool completed id=${id} name=${name} elapsed_ms=${Date.now() - startedAt}`); resolvePromise(value) },
    reject: error => { clearTimeout(timer); void logBackend(`board tool failed id=${id} name=${name} elapsed_ms=${Date.now() - startedAt} error=${String(error?.message || error)}`); rejectPromise(error) },
  })
  win.webContents.send('tugo:board-tool-call', { id, name, args, context })
})
const rejectPendingRendererTools = reason => {
  for (const [id, pending] of pendingToolCalls) {
    pendingToolCalls.delete(id)
    pending.reject(new Error(reason))
  }
}
runtimeClient = new EmbeddedRuntimeClient({
  app,
  projectRoot: resolve(__dirname, '..'),
  log: logBackend,
  onEvent: (subscriptionId, event) => mainWindow?.webContents.send('tugo:runtime-event', { subscriptionId, event }),
  onStreamEnd: (subscriptionId, runId) => mainWindow?.webContents.send('tugo:runtime-stream-end', { subscriptionId, runId }),
  onToolCall: requestRendererTool,
})

const createWindow = () => {
  const existing = restoreExistingWindow(BrowserWindow, mainWindow)
  if (existing) {
    mainWindow = existing
    return existing
  }
  const win = new BrowserWindow({
    title: APP_NAME, width: 1540, height: 960, minWidth: 1120, minHeight: 700,
    show: false,
    backgroundColor: '#f8fafc', icon: process.platform === 'win32' ? appIcon() : undefined,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: isDev, webviewTag: false, additionalArguments: e2eReportPath ? ['--tugo-e2e-renderer'] : [] },
  })
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show() })
  mainWindow = win
  if (e2eReportPath) ipcMain.handle('tugo:e2e:emit-download', (_event, state) => {
    const payload = state && typeof state === 'object' ? state : {}
    win.webContents.send('tugo:download-state', payload)
    return true
  })
  attachWindowLifecycle(win, {
    BrowserWindow, app, dialog, isDev, log: logBackend, openExternal: openSafeExternal,
    onRendererLoss: reason => { rejectPendingRendererTools(reason); void runtimeClient?.cancelRunsForRendererLoss() },
    getMainWindow: () => mainWindow, setMainWindow: value => { mainWindow = value },
    getRecoveryAttempts: () => rendererRecoveryAttempts, setRecoveryAttempts: value => { rendererRecoveryAttempts = value },
    distPath: join(__dirname, '..', 'dist-web'),
  })
  if (isDev && process.env.TUGO_DEV_URL) win.loadURL(process.env.TUGO_DEV_URL)
  else win.loadFile(join(__dirname, '..', 'dist-web', 'index.html'))
  if (e2eReportPath && ['worker-crash', 'renderer-crash'].includes(e2eMode)) {
    win.webContents.on('did-finish-load', () => {
      void (async () => {
        try {
          await win.webContents.executeJavaScript(`(async () => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (window.tugo && document.querySelector('.app-shell')) return true; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('E2E UI wait timed out') })()`)
          if (e2eMode === 'renderer-crash' && !rendererCrashE2ETriggered) {
            rendererCrashE2ETriggered = true
            win.webContents.forcefullyCrashRenderer()
            return
          }
          if (e2eMode === 'worker-crash') {
            await runtimeClient.request('runtime.http', { method: 'GET', path: '/health' })
            await new Promise(resolveDelay => setTimeout(resolveDelay, 750))
            const previous = runtimeClient.worker
            if (!previous) throw new Error('Runtime Worker missing before crash exercise')
            await previous.terminate()
            const deadline = Date.now() + 15_000
            while (Date.now() < deadline) {
              if (runtimeClient.worker && runtimeClient.worker !== previous) {
                const health = await runtimeClient.request('runtime.http', { method: 'GET', path: '/health' })
                if (health?.status === 'ok') {
                  await writeFile(resolve(e2eReportPath), JSON.stringify({ ok: true, result: { mode: e2eMode, recovered: true, health } }, null, 2), 'utf8')
                  app.quit(); return
                }
              }
              await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
            }
            throw new Error('Runtime Worker did not recover after forced exit')
          }
          await writeFile(resolve(e2eReportPath), JSON.stringify({ ok: true, result: { mode: e2eMode, recovered: true } }, null, 2), 'utf8')
          app.quit()
        } catch (error) {
          await writeFile(resolve(e2eReportPath), JSON.stringify({ ok: false, error: String(error?.stack || error) }, null, 2), 'utf8')
          app.quit()
        }
      })()
    })
  }
  if (e2eReportPath && !['worker-crash', 'renderer-crash'].includes(e2eMode)) win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        const result = await win.webContents.executeJavaScript(`(async () => {
          const waitFor = async predicate => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('E2E UI wait timed out') }
          await waitFor(() => window.tugo && document.querySelector('.app-shell'))
          const mode = ${JSON.stringify(e2eMode)}
          const health = await window.tugo.runtime.request('runtime.http', { method: 'GET', path: '/health' })
          if (mode === 'create') {
            const folder = await window.tugo.folders.create('E2E Folder')
            const project = await window.tugo.projects.create({ name: 'E2E Board', folderId: folder.id })
            const conversation = await window.tugo.conversations.create(project.id)
            conversation.messages = [{ id: 'e2e-user', role: 'user', content: 'persisted', createdAt: new Date().toISOString() }]
            await window.tugo.conversations.save(conversation)
            await window.tugo.config.write({ theme: 'dark' })
            const model = await window.tugo.runtime.request('runtime.http', { method: 'POST', path: '/api/models', body: { name: 'e2e-model', provider_id: 'openai', model: 'fixture', display_name: 'E2E Model', enabled: true, is_default: true, extra_config: { base_url: ${JSON.stringify(e2eProviderUrl)}, context_window: 32768, max_output_tokens: 4096, vision_capable: false } } })
            await window.tugo.runtime.request('runtime.http', { method: 'POST', path: '/api/models/test', body: { model_id: model.model_id } })
            const boot = await window.tugo.runtime.request('runtime.http', { method: 'POST', path: '/api/runtime/bootstrap', body: { model_id: model.model_id } })
            const thread = await window.tugo.runtime.request('runtime.http', { method: 'POST', path: '/api/threads', body: { assistant_id: boot.agent.agent_id, metadata: { project_id: project.id, conversation_id: conversation.id } } })
            conversation.threadId = thread.thread_id
            await window.tugo.conversations.save(conversation)
            const attachment = await window.tugo.runtime.request('runtime.http', { method: 'POST', path: '/api/attachments/import', body: { path: ${JSON.stringify(e2eAttachmentPath)} } })
            const ended = new Promise(resolveEnd => { const dispose = window.tugo.runtime.onStreamEnd(value => { dispose(); resolveEnd(value) }) })
            const run = await window.tugo.runtime.request('run.start', { thread_id: thread.thread_id, agent_id: boot.agent.agent_id, content: 'E2E_CANCEL', attachment_ids: [attachment.attachment_id], subscription_id: 'e2e-cancel' })
            await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
            await window.tugo.runtime.request('run.cancel', { run_id: run.run_id })
            await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel stream timeout')), 5000))])
            const events = await window.tugo.runtime.request('runtime.http', { method: 'POST', path: '/api/runtime/events', body: { thread_id: thread.thread_id, run_id: run.run_id, limit: 100 } })
            const trace = await window.tugo.runtime.request('runtime.http', { method: 'POST', path: '/api/runtime/trace', body: { thread_id: thread.thread_id, run_id: run.run_id } })
            if (!events.items.some(item => item.type === 'session.interrupted') || !trace.loops?.length) throw new Error('cancel/debug E2E mismatch')
            return { mode, health, folderId: folder.id, projectId: project.id, conversationId: conversation.id, modelProbe: true, attachment: true, cancel: true, debug: true }
          }
          if (mode === 'ui') {
            // This deliberately goes through React's rendered controls instead
            // of calling preload CRUD methods. It is the first smoke layer for
            // user-visible desktop flows; richer pointer/drag coverage belongs
            // in the dedicated WP-04 suite.
            const click = selector => {
              const element = document.querySelector(selector)
              if (!(element instanceof HTMLElement)) throw new Error('E2E UI control missing: ' + selector)
              element.click()
            }
            const setInput = (selector, value) => {
              const element = document.querySelector(selector)
              if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('E2E UI input missing: ' + selector)
              const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
              setter?.call(element, value)
              element.dispatchEvent(new Event('input', { bubbles: true }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
            }
            const waitStage = async (name, predicate) => {
              try { return await waitFor(predicate) }
              catch (error) { throw new Error('UI stage ' + name + ' failed: ' + String(error?.message || error)) }
            }
            click('button[title="模型设置"]')
            await waitStage('open settings', () => document.querySelector('.product-settings-modal'))
            const settingsText = document.querySelector('.product-settings-modal')?.textContent || ''
            for (const label of ['模型', 'MCP', 'Skills', '外观', '数据与恢复']) if (!settingsText.includes(label)) throw new Error('missing settings tab: ' + label)
            click('.product-settings-modal button[aria-label="关闭设置"]')
            await waitStage('close settings', () => !document.querySelector('.product-settings-modal'))
            click('button[aria-label="打开版本快照"]')
            await waitStage('open snapshot history', () => document.querySelector('.snapshot-browser-modal'))
            click('.snapshot-browser-modal .snapshot-create-action .primary-btn')
            await waitStage('open snapshot save', () => document.querySelector('.snapshot-save-modal'))
            setInput('.snapshot-save-form input', 'UI E2E 快照')
            click('.snapshot-save-modal .primary-btn')
            await waitStage('load saved snapshot', () => document.querySelector('.snapshot-browser-modal')?.textContent?.includes('UI E2E 快照'))
            click('.snapshot-browser-modal button[aria-label="关闭版本快照"]')
            await waitStage('close snapshot history', () => !document.querySelector('.snapshot-browser-modal'))
            const submitTextDialog = async (value) => {
              await waitStage('open text dialog for ' + value, () => document.querySelector('.text-input-modal'))
              setInput('.text-input-modal input', value)
              click('.text-input-modal .primary-btn')
              await waitStage('submit text dialog for ' + value, () => !document.querySelector('.text-input-modal'))
            }
            // Project and folder mutations must also traverse the visible
            // dialogs. Destructive native-confirmation flows are covered by
            // the repository/Electron recovery suite; this smoke focuses on
            // the product's non-destructive create, rename and nesting path.
            click('.project-panel .panel-actions > button:first-child')
            await submitTextDialog('UI E2E 根画板')
            await waitStage('create root project', () => [...document.querySelectorAll('.project-row')].some(row => row.textContent?.includes('UI E2E 根画板')))
            click('.project-title button')
            await submitTextDialog('UI E2E 已重命名画板')
            await waitStage('rename root project', () => document.querySelector('.project-title button')?.textContent?.includes('UI E2E 已重命名画板'))
            click('.project-panel .panel-actions > button[title="新建文件夹"]')
            await submitTextDialog('UI E2E 文件夹')
            const folder = await waitStage('create folder', () => [...document.querySelectorAll('.folder-group')].find(section => section.textContent?.includes('UI E2E 文件夹')))
            const folderCreate = folder.querySelector('.folder-title button')
            if (!(folderCreate instanceof HTMLElement)) throw new Error('folder create control missing')
            folderCreate.click()
            await submitTextDialog('UI E2E 文件夹画板')
            await waitStage('create nested project', () => folder.textContent?.includes('UI E2E 文件夹画板'))
            const canvas = document.querySelector('.canvas-root')
            if (!(canvas instanceof HTMLElement)) throw new Error('canvas root missing')
            // Synthetic pointer events have no browser-managed capture token.
            // Keep the test focused on the renderer handlers and visual state.
            canvas.setPointerCapture = () => undefined
            canvas.releasePointerCapture = () => undefined
            // React state updates from pointer-down need one renderer turn before
            // the following move is handled. A real user naturally provides that
            // gap; making it explicit keeps this DOM smoke deterministic rather
            // than testing a synthetic same-tick edge case.
            const nextRendererTurn = () => new Promise(resolveTick => setTimeout(resolveTick, 0))
            const pointer = async (target, type, x, y, modifiers = {}) => {
              target.dispatchEvent(new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 41,
                button: 0,
                buttons: type === 'pointerup' ? 0 : 1,
                isPrimary: true,
                pointerType: 'mouse',
                clientX: x,
                clientY: y,
                ...modifiers,
              }))
              await nextRendererTurn()
            }
            const canvasRect = canvas.getBoundingClientRect()
            const origin = { x: canvasRect.left + 120, y: canvasRect.top + 190 }
            const end = { x: origin.x + 190, y: origin.y + 90 }
            click('button[aria-label="矩形 R"]')
            await nextRendererTurn()
            await pointer(canvas, 'pointerdown', origin.x, origin.y)
            await pointer(canvas, 'pointermove', end.x, end.y)
            await pointer(canvas, 'pointerup', end.x, end.y)
            const node = await waitStage('draw rectangle', () => document.querySelector('.board-element'))
            const initialTransform = node.getAttribute('transform')
            node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: origin.x + 30, clientY: origin.y + 30 }))
            await waitStage('open text editor', () => document.querySelector('.element-text-editor'))
            setInput('.element-text-editor', 'UI E2E 节点')
            document.querySelector('.element-text-editor')?.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
            await waitStage('save node text', () => document.querySelector('.board-element')?.textContent?.includes('UI E2E 节点'))
            // Query again after edit commit: React replaces the SVG element.
            const movableNode = document.querySelector('.board-element')
            if (!(movableNode instanceof SVGElement)) throw new Error('drawn node disappeared before move')
            await pointer(movableNode, 'pointerdown', origin.x + 30, origin.y + 30)
            await pointer(canvas, 'pointermove', origin.x + 130, origin.y + 80)
            await pointer(canvas, 'pointerup', origin.x + 130, origin.y + 80)
            await waitStage('move node', () => document.querySelector('.board-element')?.getAttribute('transform') !== initialTransform)
            click('.canvas-toolbar button[title="撤销"]')
            await waitStage('undo node move', () => document.querySelector('.board-element')?.getAttribute('transform') === initialTransform)
            click('.canvas-toolbar button[title="重做"]')
            await waitStage('redo node move', () => document.querySelector('.board-element')?.getAttribute('transform') !== initialTransform)
            // Create a second node through the same canvas tool path, then
            // connect the two cards through the connector tool. This verifies
            // the user-facing selection/edge state machine rather than merely
            // asserting edge geometry in a pure-function test.
            const secondStart = { x: end.x + 120, y: end.y + 90 }
            const secondEnd = { x: secondStart.x + 150, y: secondStart.y + 80 }
            click('button[aria-label="矩形 R"]')
            await nextRendererTurn()
            await pointer(canvas, 'pointerdown', secondStart.x, secondStart.y)
            await pointer(canvas, 'pointermove', secondEnd.x, secondEnd.y)
            await pointer(canvas, 'pointerup', secondEnd.x, secondEnd.y)
            const nodes = await waitStage('draw second rectangle', () => {
              const values = [...document.querySelectorAll('.board-element')]
              return values.length === 2 ? values : null
            })
            if (!(nodes[0] instanceof SVGElement) || !(nodes[1] instanceof SVGElement)) throw new Error('drawn nodes are not SVG elements')
            click('button[aria-label="连线 C"]')
            await nextRendererTurn()
            await pointer(nodes[0], 'pointerdown', origin.x + 130, origin.y + 80)
            await pointer(nodes[1], 'pointerdown', secondStart.x + 75, secondStart.y + 40)
            await waitStage('connect nodes', () => document.querySelector('.board-edge'))
            const selectableNodes = [...document.querySelectorAll('.board-element')]
            if (!(selectableNodes[0] instanceof SVGElement) || !(selectableNodes[1] instanceof SVGElement)) throw new Error('connected nodes disappeared before multi-select')
            await pointer(selectableNodes[0], 'pointerdown', origin.x + 130, origin.y + 80)
            await pointer(canvas, 'pointerup', origin.x + 130, origin.y + 80)
            await pointer(selectableNodes[1], 'pointerdown', secondStart.x + 75, secondStart.y + 40, { shiftKey: true })
            await pointer(canvas, 'pointerup', secondStart.x + 75, secondStart.y + 40, { shiftKey: true })
            await waitStage('multi-select nodes', () => document.querySelectorAll('.board-element.selected').length === 2)
            const beforeKeyboardMove = [...document.querySelectorAll('.board-element.selected')].map(item => item.getAttribute('transform'))
            window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
            await waitStage('keyboard move multi-select', () => [...document.querySelectorAll('.board-element.selected')].every((item, index) => item.getAttribute('transform') !== beforeKeyboardMove[index]))
            const zoomBefore = document.querySelector('.zoom-value')?.textContent
            click('.zoom-controls button:last-child')
            await waitStage('zoom canvas', () => document.querySelector('.zoom-value')?.textContent !== zoomBefore)
            const messageHas = (selector, text) => [...document.querySelectorAll(selector)].some(item => item.textContent?.includes(text))
            const existingNodeCount = document.querySelectorAll('.board-element').length
            const importButton = [...document.querySelectorAll('.topbar-actions .soft-btn')].find(button => button.textContent?.includes('导入'))
            if (!(importButton instanceof HTMLElement)) throw new Error('DSL import control missing')
            importButton.click()
            await waitStage('open Mermaid import', () => document.querySelector('.dsl-modal .code-editor'))
            setInput('.dsl-modal .code-editor', 'flowchart LR\\n  e2e_start[Mermaid 导入起点] --> e2e_end[Mermaid 导入终点]')
            await waitStage('preview Mermaid import', () => document.querySelector('.dsl-preview')?.textContent?.includes('2 个元素 · 1 条连线'))
            click('.dsl-modal .primary-btn')
            await waitStage('insert Mermaid without replacing canvas', () => document.querySelectorAll('.board-element').length >= existingNodeCount + 2 && messageHas('.canvas-root', 'Mermaid 导入起点'))
            // The visible importer owns three DSL adapters. Exercise every
            // tab through the real dialog: each import must append native
            // canvas objects and must never replace the existing board.
            const importDsl = async (tabLabel, source, expectedText) => {
              importButton.click()
              await waitStage('reopen ' + tabLabel + ' import', () => document.querySelector('.dsl-modal .code-editor'))
              const tab = [...document.querySelectorAll('.dsl-modal .dsl-tabs button')].find(button => button.textContent?.trim() === tabLabel)
              if (!(tab instanceof HTMLElement)) throw new Error('DSL tab missing: ' + tabLabel)
              tab.click()
              await nextRendererTurn()
              setInput('.dsl-modal .code-editor', source)
              click('.dsl-modal .primary-btn')
              await waitStage('insert ' + tabLabel + ' without replacing canvas', () => messageHas('.canvas-root', expectedText))
            }
            await importDsl('PlantUML', '@startuml\\ncomponent "PlantUML 客户端" as client\\ncomponent "PlantUML 服务" as service\\nclient --> service : HTTP\\n@enduml', 'PlantUML 客户端')
            await importDsl('draw.io XML', '<mxGraphModel><root><mxCell id="drawio-a" vertex="1" value="draw.io 节点"><mxGeometry x="760" y="360" width="160" height="72"/></mxCell></root></mxGraphModel>', 'draw.io 节点')
            const emitDownload = window.tugo.system.e2eEmitDownload
            if (typeof emitDownload !== 'function') throw new Error('download E2E bridge missing')
            await emitDownload({ id: 'download-progress', fileName: 'TuGo.png', path: '/tmp/TuGo.png', status: 'downloading', received: 25, total: 100 })
            await waitStage('show download progress', () => messageHas('.download-tray', '正在下载 25%'))
            await emitDownload({ id: 'download-progress', fileName: 'TuGo.png', path: '/tmp/TuGo.png', status: 'completed', received: 100, total: 100 })
            await waitStage('show completed download', () => messageHas('.download-tray', '下载完成') && [...document.querySelectorAll('.download-item.is-completed button')].some(button => button.textContent === '打开'))
            await emitDownload({ id: 'download-failed', fileName: 'TuGo-2.png', path: '/tmp/TuGo-2.png', status: 'interrupted', received: 30, total: 100 })
            await waitStage('show failed download', () => messageHas('.download-tray', '下载未完成') && document.querySelectorAll('.download-item').length >= 2)
            // Chat must be exercised through the rendered composer as well:
            // a normal completion, then an intentionally long request with a
            // queued follow-up and user cancellation. The provider fixture
            // keeps only the E2E_CANCEL request open, so this covers the
            // visible run state without a timing-dependent real model.
            const submitChat = async content => {
              setInput('.chat-composer textarea', content)
              // React applies controlled-input state and refreshes the form
              // handler on the next renderer turn. Submitting in the same
              // tick can observe stale value/running state and turn a
              // queued follow-up into a second run.
              await nextRendererTurn()
              const form = document.querySelector('.chat-composer')
              if (!(form instanceof HTMLFormElement)) throw new Error('chat composer missing')
              form.requestSubmit()
              await nextRendererTurn()
            }
            await submitChat('E2E UI chat completion')
            await waitStage('send completed chat', () => messageHas('.chat-message.user', 'E2E UI chat completion'))
            await waitStage('receive completed chat', () => messageHas('.chat-message.assistant', 'E2E fixture ready'))
            await submitChat('E2E_CANCEL')
            await waitStage('show running chat controls', () => document.querySelector('.chat-composer .cancel-run'))
            await submitChat('E2E queued UI message')
            await waitStage('queue follow-up chat', () => messageHas('.chat-queue-item', 'E2E queued UI message'))
            click('.chat-composer .cancel-run')
            // Cancelling immediately dispatches the queued message. The
            // composer can therefore keep showing a cancel button for that
            // *new* run, so its momentary absence is not evidence that the
            // original request was cancelled. Assert the terminal message of
            // the original run instead, then independently prove the queued
            // message was dispatched and completed.
            await waitStage('cancel original running chat', () => messageHas('.chat-message.assistant .message-content', '已取消本次 AI 操作'))
            await waitStage('dispatch queued chat', () => messageHas('.chat-message.user', 'E2E queued UI message'))
            await waitStage('complete queued chat', () => [...document.querySelectorAll('.chat-message.assistant .message-content.assistant-state.is-complete')].filter(item => item.textContent?.includes('E2E fixture ready')).length >= 2)
            await waitStage('settle queued chat', () => !document.querySelector('.chat-composer .cancel-run'))
            return { mode, health, settingsTabs: true, snapshotFlow: true, projectFolderFlow: true, canvasFlow: true, edgeFlow: true, selectionFlow: true, zoomFlow: true, mermaidImportFlow: true, plantUmlImportFlow: true, drawIoImportFlow: true, downloadTrayFlow: true, chatFlow: true }
          }
          if (mode === 'conversation') {
            // Exercise the multi-conversation UX through the rendered chat
            // controls.  Do not create records through preload here: a + click
            // is deliberately only a draft until its first sent message.
            const click = selector => {
              const element = document.querySelector(selector)
              if (!(element instanceof HTMLElement)) throw new Error('conversation UI control missing: ' + selector)
              element.click()
            }
            const setInput = (selector, value) => {
              const element = document.querySelector(selector)
              if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) throw new Error('conversation input missing: ' + selector)
              const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
              setter?.call(element, value)
              element.dispatchEvent(new Event('input', { bubbles: true }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
            }
            const messageHas = (selector, text) => [...document.querySelectorAll(selector)].some(item => item.textContent?.includes(text))
            const waitStage = async (name, predicate) => {
              try { return await waitFor(predicate) }
              catch (error) { throw new Error('conversation stage ' + name + ' failed: ' + String(error?.message || error)) }
            }
            // Set up a fresh project through the visible UI. This makes the
            // conversation scenario self-contained instead of depending on
            // whether a preceding smoke window has flushed its final render.
            const targetName = 'Conversation UI E2E 画板'
            click('.project-panel .panel-actions > button:first-child')
            await waitStage('open conversation project dialog', () => document.querySelector('.text-input-modal input'))
            setInput('.text-input-modal input', targetName)
            click('.text-input-modal .primary-btn')
            await waitStage('create conversation target project', () => [...document.querySelectorAll('.project-row')].some(item => item.textContent?.includes(targetName)))
            const targetProjectRow = [...document.querySelectorAll('.project-row')].find(item => item.textContent?.includes(targetName))
            if (!(targetProjectRow instanceof HTMLElement)) throw new Error('conversation target project missing')
            targetProjectRow.click()
            await waitStage('open conversation target project', () => document.querySelector('.project-title button')?.textContent?.includes(targetName))
            await new Promise(resolve => setTimeout(resolve, 120))
            const targetProject = (await window.tugo.projects.list()).find(item => item.name === targetName)
            if (!targetProject) throw new Error('conversation target project persistence missing')
            const countBefore = (await window.tugo.conversations.list()).conversations.filter(item => item.projectId === targetProject.id).length
            click('button[title="新建会话"]')
            await new Promise(resolve => setTimeout(resolve, 120))
            if ((await window.tugo.conversations.list()).conversations.filter(item => item.projectId === targetProject.id).length !== countBefore) throw new Error('new conversation created a persisted record before first send')
            const submit = async content => {
              setInput('.chat-composer textarea', content)
              const form = document.querySelector('.chat-composer')
              if (!(form instanceof HTMLFormElement)) throw new Error('conversation composer missing')
              form.requestSubmit()
              await waitStage('send ' + content, () => messageHas('.chat-message.user', content))
              await waitStage('complete ' + content, () => messageHas('.chat-message.assistant .message-content.assistant-state.is-complete', 'E2E fixture ready'))
            }
            await submit('E2E conversation one')
            await new Promise(resolve => setTimeout(resolve, 120))
            if ((await window.tugo.conversations.list()).conversations.filter(item => item.projectId === targetProject.id && item.messages.some(message => message.content === 'E2E conversation one')).length !== 1) throw new Error('first conversation was not persisted')
            click('button[title="新建会话"]')
            await submit('E2E conversation two')
            const afterTwo = await window.tugo.conversations.list()
            if (afterTwo.conversations.filter(item => item.projectId === targetProject.id && item.messages.some(message => /^E2E conversation (one|two)$/.test(message.content))).length !== 2) throw new Error('first sends did not create two independent conversations')
            click('button[title="会话历史"]')
            await waitStage('open conversation history', () => document.querySelector('.conversation-popover'))
            // The compact history UI intentionally previews the last assistant
            // response rather than the user's first prompt. The persistence
            // assertion above identifies both conversations; selecting the
            // older rendered entry verifies the actual switch affordance.
            const historyEntries = [...document.querySelectorAll('.conversation-popover button')]
            const firstConversationEntry = historyEntries[1]
            if (!(firstConversationEntry instanceof HTMLElement)) throw new Error('first conversation missing from history UI')
            firstConversationEntry.click()
            await waitStage('switch conversation history', () => messageHas('.chat-message.user', 'E2E conversation one') && !messageHas('.chat-message.user', 'E2E conversation two'))
            const branchButton = document.querySelector('.chat-message.user [aria-label="从此处创建独立分支"]')
            if (!(branchButton instanceof HTMLElement)) throw new Error('conversation branch action missing')
            const projectCountBeforeBranch = (await window.tugo.projects.list()).length
            branchButton.click()
            await waitStage('create independent branch', () => document.querySelector('.project-title button')?.textContent?.includes('分支'))
            if ((await window.tugo.projects.list()).length !== projectCountBeforeBranch + 1) throw new Error('conversation branch did not persist a separate project')
            return { mode, health, draftCreatesNoRecord: true, historySwitch: true, branch: true }
          }
          const projects = await window.tugo.projects.list(); const folders = await window.tugo.folders.list(); const index = await window.tugo.conversations.list(); const config = await window.tugo.config.read()
          if (mode === 'migrate') {
            const project = projects.find(item => item.id === 'legacy-project'); const folder = folders.find(item => item.id === 'legacy-folder'); const conversation = index.conversations.find(item => item.id === 'conversation_legacy-project')
            if (!project || project.folderId !== folder?.id || project.name !== 'Legacy Board' || conversation?.messages?.[0]?.content !== 'legacy persisted' || config.theme !== 'dark') throw new Error('0.1.0 app database migration mismatch')
            return { mode, health, migrated: true, projectId: project.id, conversationId: conversation.id }
          }
          if (mode === 'stale-thread') {
            const project = projects.find(item => item.name === 'E2E Board'); const conversation = index.conversations.find(item => item.projectId === project?.id)
            if (!conversation || conversation.threadId) throw new Error('stale Runtime thread was not reconciled at startup')
            return { mode, health, staleThreadReconciled: true }
          }
          if (mode === 'recover-app') {
            const project = projects.find(item => item.name === 'E2E Board'); const folder = folders.find(item => item.name === 'E2E Folder'); const conversation = index.conversations.find(item => item.projectId === project?.id)
            if (!project || !folder || !conversation || conversation.messages?.[0]?.content !== 'persisted') throw new Error('app database did not recover from the older healthy backup')
            return { mode, health, recoveredFromBackup: true }
          }
          if (mode === 'recover-pending') {
            const project = projects.find(item => item.name === 'E2E Board'); const folder = folders.find(item => item.name === 'E2E Folder'); const conversation = index.conversations.find(item => item.projectId === project?.id)
            if (!project || !folder || !conversation || conversation.messages?.[0]?.content !== 'persisted') throw new Error('scheduled app database recovery was not applied at startup')
            return { mode, health, recoveredPendingSnapshot: true }
          }
          const project = projects.find(item => item.name === 'E2E Board'); const folder = folders.find(item => item.name === 'E2E Folder'); const conversation = index.conversations.find(item => item.projectId === project?.id)
          if (!project || !folder || !conversation || conversation.messages?.[0]?.content !== 'persisted' || config.theme !== 'dark') throw new Error('E2E persisted state mismatch')
          const renamedUiProject = projects.find(item => item.name === 'UI E2E 已重命名画板')
          const movedUiProject = projects.find(item => item.name === 'UI E2E 文件夹画板')
          const uiFolder = folders.find(item => item.name === 'UI E2E 文件夹')
          if (!renamedUiProject || !movedUiProject || !uiFolder || movedUiProject.folderId !== uiFolder.id) throw new Error('project/folder UI mutations did not persist after restart')
          document.querySelector('button[title="模型设置"]')?.click(); await waitFor(() => document.querySelector('.product-settings-modal'))
          const settingsText = document.querySelector('.product-settings-modal')?.textContent || ''
          for (const label of ['模型','MCP','外观','数据与恢复']) if (!settingsText.includes(label)) throw new Error('missing settings tab: ' + label)
          await window.tugo.projects.remove(project.id); await window.tugo.folders.remove(folder.id)
          return { mode, health, persisted: true, settingsTabs: true, projectCount: projects.length }
        })()`)
        if (app.isPackaged) {
          win.webContents.openDevTools({ mode: 'detach' })
          await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
        }
        const metrics = app.getAppMetrics()
        const mainMemory = await process.getProcessMemoryInfo()
        result.desktop = {
          packaged: app.isPackaged,
          devToolsOpened: win.webContents.isDevToolsOpened(),
          interactiveMs: e2eStartedAt ? Date.now() - e2eStartedAt : null,
          workingSetMb: Math.round(metrics.reduce((sum, item) => sum + Number(item.memory?.workingSetSize || 0), 0) / 1024),
          totalPrivateMb: process.platform === 'win32' ? Math.round(metrics.reduce((sum, item) => sum + Number(item.memory?.privateBytes || 0), 0) / 1024) : null,
          mainPrivateMb: Math.round(Number(mainMemory.private || 0) / 1024),
          processCount: metrics.length,
        }
        await writeFile(resolve(e2eReportPath), JSON.stringify({ ok: true, result }, null, 2), 'utf8')
      } catch (error) {
        await writeFile(resolve(e2eReportPath), JSON.stringify({ ok: false, error: String(error?.stack || error) }, null, 2), 'utf8')
      } finally { app.quit() }
    })()
  })
  if (soakReportPath && !e2eReportPath) win.webContents.once('did-finish-load', () => {
    void (async () => {
      const startedAt = Date.now(); const samples = []; let workloadIterations = 0
      try {
        // Exercise the same privileged persistence bridge used by the product:
        // a rotating board document, its conversation projection and Runtime
        // health must all remain usable for the entire soak period. This is
        // deliberately local/deterministic; real-provider Agent runs remain a
        // separate credentialed release check.
        const workload = await win.webContents.executeJavaScript(`(async () => {
          const makeDocument = tick => ({ version: 3, viewport: { x: 0, y: 0, zoom: 1 }, elements: Array.from({ length: 48 }, (_, i) => ({ id: 'soak-node-' + i, kind: i % 2 ? 'rounded_rectangle' : 'ellipse', x: (i % 8) * 210, y: Math.floor(i / 8) * 115, width: 160, height: 70, text: 'Soak ' + tick + ' / ' + i, fill: '#ffffff', stroke: '#475569', strokeWidth: 2, fontSize: 15 })), edges: Array.from({ length: 47 }, (_, i) => ({ id: 'soak-edge-' + i, from: 'soak-node-' + i, to: 'soak-node-' + (i + 1), stroke: '#64748b', strokeWidth: 2, routing: i % 3 ? 'straight' : 'elbow', endArrow: 'arrow' })) })
          const project = await window.tugo.projects.create({ name: 'Automated soak workload', document: makeDocument(0) })
          const conversation = await window.tugo.conversations.create(project.id)
          await window.tugo.conversations.save({ ...conversation, messages: [{ id: 'soak-seed', role: 'user', content: 'automated soak seed', createdAt: new Date().toISOString() }] })
          return { projectId: project.id }
        })()`)
        while (Date.now() - startedAt < soakDurationMs) {
          const health = await runtimeClient.request('runtime.http', { method: 'GET', path: '/health' })
          if (health?.status !== 'ok' || win.isDestroyed() || win.webContents.isCrashed()) throw new Error('desktop health check failed')
          workloadIterations += 1
          await win.webContents.executeJavaScript(`window.tugo.projects.update({ id: ${JSON.stringify(workload.projectId)}, name: 'Automated soak workload · ${workloadIterations}' })`)
          const memory = await process.getProcessMemoryInfo(); const metrics = app.getAppMetrics()
          samples.push({ atMs: Date.now() - startedAt, mainPrivateMb: Math.round(Number(memory.private || 0) / 1024), totalPrivateMb: process.platform === 'win32' ? Math.round(metrics.reduce((sum, item) => sum + Number(item.memory?.privateBytes || 0), 0) / 1024) : null, workingSetMb: Math.round(metrics.reduce((sum, item) => sum + Number(item.memory?.workingSetSize || 0), 0) / 1024), processes: metrics.length })
          // Keep the production four-hour cadence bounded at 30 seconds, but
          // also collect several samples during a short CI smoke. A single
          // sample cannot establish either memory growth or process health.
          const elapsedMs = Date.now() - startedAt
          const intervalMs = Math.min(30_000, Math.max(1_000, Math.floor(soakDurationMs / 4)))
          await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(intervalMs, Math.max(0, soakDurationMs - elapsedMs))))
        }
        const first = samples[0]; const last = samples.at(-1)
        await writeFile(resolve(soakReportPath), JSON.stringify({ ok: true, durationMs: Date.now() - startedAt, samples: samples.length, workloadIterations, first, last, mainPrivateGrowthMb: Number(last?.mainPrivateMb || 0) - Number(first?.mainPrivateMb || 0), workingSetGrowthMb: Number(last?.workingSetMb || 0) - Number(first?.workingSetMb || 0) }, null, 2), 'utf8')
      } catch (error) {
        await writeFile(resolve(soakReportPath), JSON.stringify({ ok: false, error: String(error?.stack || error), durationMs: Date.now() - startedAt, samples }, null, 2), 'utf8')
      } finally { app.quit() }
    })()
  })
  return win
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show(); mainWindow.focus()
  }
})

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(appIcon())
  await ensureConfig()
  await initDatabase()
  registerIpc()
  try {
    await runtimeClient.start()
    await migrateLegacyRuntimeSecrets()
    await runtimeClient.request('runtime.secrets.set', { secrets: await readRuntimeSecrets() })
    await importInstalledModelsForDevelopment()
    await reconcileConversationThreads()
  } catch (error) { await logBackend(`embedded runtime startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`) }
  startupReady = true
  createWindow()
})
app.on('activate', () => {
  // macOS exposes the Dock icon before the async database/Runtime bootstrap
  // finishes. Clicking it in that interval must not create a provisional
  // window that `whenReady` would duplicate a moment later.
  if (!startupReady || shutdownStarted) return
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void (async () => {
    try { await runtimeClient?.stop() } catch (error) { await logBackend(`embedded runtime shutdown failed: ${String(error?.message || error)}`) }
    try {
      await persistDatabase()
      await appDatabaseStorage?.persistQueue
      await backupCurrentDatabase(true)
      database?.close()
      database = null
    } catch (error) {
      await logBackend(`database shutdown save failed: ${String(error?.stack || error)}`)
    } finally {
      shutdownComplete = true
      app.quit()
    }
  })()
})
process.once('SIGTERM', () => app.quit())
process.once('SIGINT', () => app.quit())
