import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { mkdir, readFile, rename, copyFile, stat, writeFile, unlink, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { localizedPrompt, normalizePromptLocale, type RuntimePromptLocale } from './localizedPrompts.js'
import type { JsonObject, ModelConfig, RunCheckpoint, RuntimeMessage, StructuredEvent, ToolCall, ToolDefinition } from './contracts.js'
import { digest, imageDimensions, inspectAttachment, isRasterImage } from './attachments.js'
import { canTransitionRun, isRunStatus, isTerminalRunStatus, type RunStatus } from './runState.js'
import { strictBuiltinToolSchema } from './boardToolSchemas.js'

const now = () => new Date().toISOString()

/**
 * The runtime database is durable user data.  Keep its public migration
 * history in one immutable, ordered manifest: migration bodies may live near
 * the repository code they evolve, but version allocation and names must not
 * be duplicated or silently rewritten.
 */
export const RUNTIME_MIGRATION_MANIFEST = [
  { version: 1, name: 'initial-runtime-schema' },
  { version: 2, name: 'config-snapshots-prompts-attachments' },
  { version: 3, name: 'relational-integrity-observability' },
  { version: 4, name: 'durable-tool-call-ledger' },
  { version: 5, name: 'skill-package-resources' },
  { version: 6, name: 'skill-origin' },
  { version: 7, name: 'ephemeral-streaming-deltas' },
  { version: 8, name: 'skill-editor-sessions' },
  { version: 9, name: 'canonical-skill-packages' },
] as const

const runtimeMigrationName = (version: number) => {
  const migration = RUNTIME_MIGRATION_MANIFEST.find(item => item.version === version)
  if (!migration) throw new Error(`Runtime migration ${version} is not declared in the manifest`)
  return migration.name
}

const json = <T>(value: unknown, fallback: T): T => {
  try { return value ? JSON.parse(String(value)) as T : fallback } catch { return fallback }
}
const bool = (value: unknown) => Boolean(Number(value ?? 0))
const objectValue = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
/** Keep every persisted SKILL.md portable: the catalog metadata and file header
 * are always synchronized, even when a Skill was created through chat or imported. */
const normalizeSkillMarkdown = (name: string, description: string, content: string) => {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim() || '未命名 Skill'
  const cleanDescription = String(description || '').replace(/\s+/g, ' ').trim() || `${cleanName} 的工作说明。`
  const source = String(content || '').trim()
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?/)
  const retained = match ? match[1].split(/\r?\n/).filter(line => !/^\s*(?:name|description)\s*:/.test(line)).join('\n').trim() : ''
  const body = (match ? source.slice(match[0].length) : source).trim()
  const header = ['---', `name: ${JSON.stringify(cleanName)}`, `description: ${JSON.stringify(cleanDescription)}`, ...(retained ? [retained] : []), '---'].join('\n')
  return `${header}\n\n${body || `# ${cleanName}\n\n`}`
}
/** A loadable Skill is a package, rather than arbitrary legacy text. Keep the
 * catalog metadata and the portable SKILL.md header in lockstep. */
const validSkillPackage = (name: string, description: string, content: string) => {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim()
  const cleanDescription = String(description || '').replace(/\s+/g, ' ').trim()
  const source = String(content || '').trim()
  const header = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?/)
  if (!cleanName || !cleanDescription || !header) return false
  const fields = header[1]
  const headerName = fields.match(/^\s*name\s*:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  const headerDescription = fields.match(/^\s*description\s*:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  return Boolean(headerName && headerDescription && source.slice(header[0].length).trim())
}
const sensitiveKey = /api[-_]?key|authorization|token|secret|password|cookie|credential|dataBase64|base64Data/i
const redact = (value: unknown, key = ''): unknown => {
  if (sensitiveKey.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as JsonObject).map(([childKey, child]) => [childKey, redact(child, childKey)]))
  if (typeof value === 'string') return value
    // Attachments are expanded into provider payloads as data URLs. Keep the
    // request shape visible in Run Debug, but never persist the binary body.
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_IMAGE_DATA]')
    // Gemini and a few compatible endpoints accept credentials in the query
    // string instead of an Authorization header.
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
  return value
}

const compactJournalPayload = (eventType: string, value: unknown) => {
  const shorten = (input: unknown, depth = 0): unknown => {
    if (typeof input === 'string') return input.length > 8_000 ? `${input.slice(0, 8_000)}\n…[truncated]` : input
    if (Array.isArray(input)) return input.slice(0, 60).map(item => shorten(item, depth + 1))
    if (!input || typeof input !== 'object' || depth > 8) return input
    return Object.fromEntries(Object.entries(input as JsonObject).map(([key, child]) => [key, shorten(child, depth + 1)]))
  }
  const compactMessages = (input: unknown) => {
    if (!Array.isArray(input)) return input
    const selected = input.length > 12 ? [input[0], ...input.slice(-11)] : input
    return selected.map(item => {
      const message = objectValue(item)
      return shorten({
        role: message.role, name: message.name, tool_call_id: message.tool_call_id,
        content: message.content, reasoning_content: message.reasoning_content,
        tool_calls: message.tool_calls,
      }, 0)
    })
  }
  const compactTools = (input: unknown) => Array.isArray(input) ? input.map(item => {
    const tool = objectValue(item); const fn = objectValue(tool.function)
    return fn.name ? { type: tool.type, function: { name: fn.name, description: fn.description } } : { name: tool.name, source: tool.source, description: tool.description }
  }) : input
  const safe = objectValue(redact(value))
  if (eventType === 'model.request') return shorten({ ...safe, messages: compactMessages(safe.messages), tools: compactTools(safe.tools) })
  if (eventType === 'model.http.request') {
    const body = objectValue(safe.body)
    return shorten({ ...safe, body: { ...body, messages: compactMessages(body.messages), tools: compactTools(body.tools) } })
  }
  return shorten(safe)
}

export class RuntimeRepository {
  private db!: Database
  private SQL!: SqlJsStatic
  private persistChain: Promise<void> = Promise.resolve()
  private persistTimer?: NodeJS.Timeout
  private persistError?: string
  private templateAgentTools: string[] = []
  private templateSkillSlugs: string[] = []
  readonly databasePath: string
  readonly attachmentsDir: string
  readonly backupsDir: string
  readonly pendingRecoveryPath: string

  constructor(readonly dataDir: string, readonly defaultsPath: string) {
    this.databasePath = join(dataDir, 'runtime.sqlite')
    this.attachmentsDir = join(dataDir, 'attachments')
    this.backupsDir = join(dataDir, 'runtime-backups')
    this.pendingRecoveryPath = `${this.databasePath}.recovery-pending`
  }

  async open() {
    await mkdir(this.attachmentsDir, { recursive: true })
    await mkdir(this.backupsDir, { recursive: true })
    this.SQL = await initSqlJs()
    this.db = await this.openHealthyDatabase()
    this.db.run('PRAGMA foreign_keys=ON')
    this.migrate()
    // A schema rebuild temporarily disables FK enforcement. Reopen the
    // in-memory handle after migrations: SQL.js can otherwise keep the
    // pragma disabled on the handle that performed the rebuild.
    const migrated = this.db.export()
    this.db.close()
    this.db = new this.SQL.Database(migrated)
    this.db.run('PRAGMA foreign_keys=ON')
    this.recoverInterruptedRuns()
    await this.seedDefaults()
    await this.cleanupRetention()
    await this.cleanupOrphanAttachments()
    await this.cleanupStaleSnapshots()
    await this.flush()
  }

  private async cleanupStaleSnapshots() {
    const prefix = `${basename(this.databasePath)}.tmp-`
    const names = await readdir(this.dataDir).catch(() => [] as string[])
    await Promise.all(names.filter(name => name.startsWith(prefix)).map(name => unlink(join(this.dataDir, name)).catch(() => undefined)))
  }

  private quickCheck(database: Database) {
    const statement = database.prepare('PRAGMA quick_check')
    const messages: string[] = []
    while (statement.step()) messages.push(String(statement.getAsObject().quick_check || ''))
    statement.free()
    return { ok: messages.length === 1 && messages[0] === 'ok', messages }
  }

  private async openHealthyDatabase() {
    let bytes: Uint8Array | undefined
    let pending: Uint8Array | undefined
    try { pending = await readFile(this.pendingRecoveryPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (pending) {
      const candidate = new this.SQL.Database(pending)
      if (!this.quickCheck(candidate).ok) { candidate.close(); throw new Error('pending runtime recovery is corrupt') }
      candidate.close(); await copyFile(this.pendingRecoveryPath, this.databasePath); await unlink(this.pendingRecoveryPath); bytes = pending
    }
    if (!bytes) try { bytes = await readFile(this.databasePath) } catch { /* first launch */ }
    if (!bytes?.length) return new this.SQL.Database()
    try {
      const database = new this.SQL.Database(bytes)
      if (!this.quickCheck(database).ok) throw new Error('runtime database integrity check failed')
      return database
    } catch (originalError) {
      const backups = await this.listBackups()
      for (const backup of backups) {
        try {
          const database = new this.SQL.Database(await readFile(backup.path))
          if (!this.quickCheck(database).ok) { database.close(); continue }
          await copyFile(backup.path, this.databasePath)
          return database
        } catch { /* try an older backup */ }
      }
      throw originalError
    }
  }

  private recoverInterruptedRuns() {
    const timestamp = now()
    const uncertain = this.rows(`SELECT c.checkpoint_id,c.state_json FROM checkpoints c
      JOIN runs r ON r.run_id=c.run_id WHERE r.status='running' AND c.checkpoint_id IN
      (SELECT MAX(checkpoint_id) FROM checkpoints WHERE run_id IS NOT NULL GROUP BY run_id)`)
    for (const row of uncertain) {
      const checkpoint = json<RunCheckpoint>(row.state_json, undefined as never)
      if (checkpoint?.boundary?.phase !== 'tool' || checkpoint.boundary.state !== 'before') continue
      checkpoint.status = 'interrupted'
      checkpoint.boundary = { ...checkpoint.boundary, state: 'uncertain', updatedAt: timestamp }
      this.db.run('UPDATE checkpoints SET state_json=? WHERE checkpoint_id=?', [JSON.stringify(checkpoint), Number(row.checkpoint_id)])
      this.db.run('INSERT INTO debug_events(thread_id,run_id,category,payload_json,created_at) VALUES(?,?,?,?,?)', [checkpoint.threadId, String(checkpoint.runId || ''), 'recovery.uncertain_side_effect', JSON.stringify(redact({ tool_name: checkpoint.boundary.toolName, tool_call_id: checkpoint.boundary.toolCallId, replayed: false })), timestamp])
    }
    // A checkpoint boundary alone cannot tell us whether every call in a
    // multi-tool turn got a response.  The ledger is the source of truth for
    // that question.  Anything left in flight after a process restart is
    // deliberately *not* replayed: side-effecting calls are uncertain and all
    // others are interrupted.  Both receive a durable synthetic result so a
    // subsequent model request can never contain a dangling tool_call_id.
    const inFlight = this.rows("SELECT run_id,tool_call_id,tool_name,side_effect FROM run_tool_calls WHERE status IN ('pending','running')")
    for (const row of inFlight) {
      const uncertainSideEffect = bool(row.side_effect)
      const status = uncertainSideEffect ? 'uncertain' : 'interrupted'
      const content = uncertainSideEffect
        ? '运行在此工具执行期间中断；该操作可能已部分生效。请先读取当前状态再决定是否继续，不要直接重放。'
        : '运行在工具执行前中断；该工具未执行。'
      this.db.run('UPDATE run_tool_calls SET status=?,result_json=?,error_json=?,updated_at=?,completed_at=? WHERE run_id=? AND tool_call_id=?', [status, JSON.stringify({ content }), JSON.stringify({ reason: 'runtime_restart' }), timestamp, timestamp, String(row.run_id), String(row.tool_call_id)])
    }
    // No durable scheduler survives a process restart. Both queued and
    // running rows have lost their executor and become interrupted.
    this.db.run("UPDATE runs SET status='interrupted',error_json=?,updated_at=?,completed_at=? WHERE status IN ('queued','running')", [JSON.stringify({ reason: 'runtime_restart' }), timestamp, timestamp])
    this.db.run("UPDATE threads SET active_run_id=NULL,updated_at=? WHERE active_run_id IS NOT NULL AND (active_run_id NOT IN (SELECT run_id FROM runs) OR active_run_id IN (SELECT run_id FROM runs WHERE status!='running'))", [timestamp])
  }

  private migrate() {
    this.db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const recorded = this.rows('SELECT version,name FROM schema_migrations').map(row => ({ version: Number(row.version), name: String(row.name) }))
    for (const migration of RUNTIME_MIGRATION_MANIFEST) {
      const existing = recorded.find(item => item.version === migration.version)
      if (existing && existing.name !== migration.name) throw new Error(`Runtime migration ${migration.version} name mismatch: expected ${migration.name}, found ${existing.name}`)
    }
    const applied = new Set(recorded.map(row => row.version))
    const recordMigration = (version: number) => this.db.run('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)', [version, runtimeMigrationName(version), now()])
    if (!applied.has(1)) {
      this.db.run('BEGIN')
      try {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (
        model_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, provider_id TEXT NOT NULL, model TEXT NOT NULL,
        display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
        extra_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, description TEXT,
        model_id TEXT, soul TEXT NOT NULL DEFAULT '', tool_groups_json TEXT NOT NULL DEFAULT '[]',
        skills_json TEXT NOT NULL DEFAULT '[]', mcp_ids_json TEXT NOT NULL DEFAULT '[]', config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        skill_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, description TEXT,
        content TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_connections (
        connection_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL, url_or_command TEXT NOT NULL,
        credentials_json TEXT NOT NULL DEFAULT '{}', description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_definitions (
        tool_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, source TEXT NOT NULL, description TEXT NOT NULL,
        input_schema_json TEXT NOT NULL, handler_key TEXT, timeout_ms INTEGER NOT NULL DEFAULT 30000,
        template_version TEXT, user_modified INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_tools (agent_id TEXT NOT NULL, tool_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(agent_id, tool_name));
      CREATE TABLE IF NOT EXISTS agent_skills (agent_id TEXT NOT NULL, skill_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id, skill_id));
      CREATE TABLE IF NOT EXISTS agent_mcp_connections (agent_id TEXT NOT NULL, connection_id TEXT NOT NULL, tool_allowlist_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(agent_id, connection_id));
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
        active_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL,
        subscription_id TEXT, error_json TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT,
        step INTEGER NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id, checkpoint_id DESC);
      CREATE TABLE IF NOT EXISTS run_events (
        event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        type TEXT NOT NULL, envelope_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS debug_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
        category TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
        loop_index INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL, event_type TEXT NOT NULL,
        actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_journal_run ON run_journal(run_id,id);
      CREATE TABLE IF NOT EXISTS attachments (
        attachment_id TEXT PRIMARY KEY, original_name TEXT NOT NULL, local_path TEXT NOT NULL,
        mime_type TEXT, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
    `)
        recordMigration(1)
        this.db.run('COMMIT')
      } catch (error) { this.db.run('ROLLBACK'); throw error }
    }
    if (!applied.has(2)) {
      this.db.run('BEGIN')
      try {
        this.db.run(`
          CREATE TABLE prompt_templates (
            prompt_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, content TEXT NOT NULL, version TEXT NOT NULL,
            user_modified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE middleware_definitions (
            middleware_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
            config_schema_json TEXT NOT NULL DEFAULT '{}', default_config_json TEXT NOT NULL DEFAULT '{}',
            version TEXT NOT NULL, user_modified INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE agent_middleware (
            agent_id TEXT NOT NULL, middleware_name TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(agent_id,middleware_name)
          );
          CREATE TABLE run_config_snapshots (
            run_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
          );
          CREATE TABLE attachment_references (
            attachment_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, message_role TEXT NOT NULL,
            created_at TEXT NOT NULL, PRIMARY KEY(attachment_id,run_id,message_role)
          );
          ALTER TABLE attachments ADD COLUMN text_content TEXT;
          ALTER TABLE attachments ADD COLUMN sha256 TEXT;
        `)
        recordMigration(2)
        this.db.run('COMMIT')
      } catch (error) { this.db.run('ROLLBACK'); throw error }
    }
    if (!applied.has(3)) {
      // SQL.js cannot add foreign keys to existing tables. Rebuild the
      // relational tables once, preserving valid rows and dropping orphans.
      this.db.run('PRAGMA foreign_keys=OFF')
      this.db.run('BEGIN')
      try {
        this.db.run(`
          CREATE TABLE agent_tools_v3 (
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
            tool_name TEXT NOT NULL REFERENCES tool_definitions(name) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), PRIMARY KEY(agent_id,tool_name)
          );
          INSERT INTO agent_tools_v3 SELECT a.agent_id,a.tool_name,a.enabled FROM agent_tools a
            JOIN agents g ON g.agent_id=a.agent_id JOIN tool_definitions t ON t.name=a.tool_name;
          CREATE TABLE agent_skills_v3 (
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
            skill_id TEXT NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
            position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0), PRIMARY KEY(agent_id,skill_id)
          );
          INSERT INTO agent_skills_v3 SELECT a.agent_id,a.skill_id,a.position FROM agent_skills a
            JOIN agents g ON g.agent_id=a.agent_id JOIN skills s ON s.skill_id=a.skill_id;
          CREATE TABLE agent_mcp_connections_v3 (
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
            connection_id TEXT NOT NULL REFERENCES mcp_connections(connection_id) ON DELETE CASCADE,
            tool_allowlist_json TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(agent_id,connection_id)
          );
          INSERT INTO agent_mcp_connections_v3 SELECT a.agent_id,a.connection_id,a.tool_allowlist_json FROM agent_mcp_connections a
            JOIN agents g ON g.agent_id=a.agent_id JOIN mcp_connections m ON m.connection_id=a.connection_id;
          CREATE TABLE agent_middleware_v3 (
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE, middleware_name TEXT NOT NULL,
            config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
            position INTEGER NOT NULL DEFAULT 0 CHECK(position>=0), PRIMARY KEY(agent_id,middleware_name)
          );
          INSERT INTO agent_middleware_v3 SELECT a.agent_id,a.middleware_name,a.config_json,a.enabled,a.position FROM agent_middleware a
            JOIN agents g ON g.agent_id=a.agent_id;
          CREATE TABLE threads_v3 (
            thread_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
            title TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', active_run_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          INSERT INTO threads_v3 SELECT t.thread_id,t.agent_id,t.title,t.metadata_json,t.active_run_id,t.created_at,t.updated_at FROM threads t
            JOIN agents a ON a.agent_id=t.agent_id;
          CREATE TABLE runs_v3 (
            run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads_v3(thread_id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
            subscription_id TEXT, error_json TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
          );
          INSERT INTO runs_v3 SELECT r.run_id,r.thread_id,r.agent_id,
            CASE WHEN r.status IN ('queued','running','completed','failed','cancelled','interrupted') THEN r.status ELSE 'failed' END,
            r.subscription_id,r.error_json,r.started_at,r.updated_at,r.completed_at FROM runs r
            JOIN threads_v3 t ON t.thread_id=r.thread_id JOIN agents a ON a.agent_id=r.agent_id;
          CREATE TABLE checkpoints_v3 (
            checkpoint_id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL REFERENCES threads_v3(thread_id) ON DELETE CASCADE,
            run_id TEXT REFERENCES runs_v3(run_id) ON DELETE CASCADE,
            step INTEGER NOT NULL CHECK(step>=0), state_json TEXT NOT NULL, created_at TEXT NOT NULL
          );
          INSERT INTO checkpoints_v3(checkpoint_id,thread_id,run_id,step,state_json,created_at)
            SELECT c.checkpoint_id,c.thread_id,c.run_id,c.step,c.state_json,c.created_at FROM checkpoints c
            JOIN threads_v3 t ON t.thread_id=c.thread_id LEFT JOIN runs_v3 r ON r.run_id=c.run_id
            WHERE c.run_id IS NULL OR r.run_id IS NOT NULL;
          CREATE TABLE run_events_v3 (
            event_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads_v3(thread_id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs_v3(run_id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK(sequence>=0),
            type TEXT NOT NULL, envelope_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,sequence)
          );
          INSERT INTO run_events_v3 SELECT e.event_id,e.thread_id,e.run_id,e.sequence,e.type,e.envelope_json,e.created_at FROM run_events e
            JOIN threads_v3 t ON t.thread_id=e.thread_id JOIN runs_v3 r ON r.run_id=e.run_id;
          CREATE TABLE debug_events_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads_v3(thread_id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs_v3(run_id) ON DELETE CASCADE,
            category TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
          );
          INSERT INTO debug_events_v3 SELECT d.id,d.thread_id,d.run_id,d.category,d.payload_json,d.created_at FROM debug_events d
            JOIN threads_v3 t ON t.thread_id=d.thread_id JOIN runs_v3 r ON r.run_id=d.run_id;
          CREATE TABLE run_journal_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads_v3(thread_id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs_v3(run_id) ON DELETE CASCADE, loop_index INTEGER NOT NULL DEFAULT 0 CHECK(loop_index>=0),
            phase TEXT NOT NULL, event_type TEXT NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL,
            correlation_id TEXT, parent_correlation_id TEXT, status TEXT, started_at TEXT, finished_at TEXT,
            duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, error_category TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO run_journal_v3(id,thread_id,run_id,loop_index,phase,event_type,actor,payload_json,created_at)
            SELECT j.id,j.thread_id,j.run_id,j.loop_index,j.phase,j.event_type,j.actor,j.payload_json,j.created_at FROM run_journal j
            JOIN threads_v3 t ON t.thread_id=j.thread_id JOIN runs_v3 r ON r.run_id=j.run_id;
          CREATE TABLE run_config_snapshots_v3 (
            run_id TEXT PRIMARY KEY REFERENCES runs_v3(run_id) ON DELETE CASCADE, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
          );
          INSERT INTO run_config_snapshots_v3 SELECT s.run_id,s.snapshot_json,s.created_at FROM run_config_snapshots s
            JOIN runs_v3 r ON r.run_id=s.run_id;
          CREATE TABLE attachment_references_v3 (
            attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES threads_v3(thread_id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs_v3(run_id) ON DELETE CASCADE,
            message_role TEXT NOT NULL CHECK(message_role IN ('user','assistant','tool')),
            created_at TEXT NOT NULL, PRIMARY KEY(attachment_id,run_id,message_role)
          );
          INSERT INTO attachment_references_v3 SELECT x.attachment_id,x.thread_id,x.run_id,x.message_role,x.created_at FROM attachment_references x
            JOIN attachments a ON a.attachment_id=x.attachment_id JOIN threads_v3 t ON t.thread_id=x.thread_id JOIN runs_v3 r ON r.run_id=x.run_id
            WHERE x.message_role IN ('user','assistant','tool');

          DROP TABLE agent_tools; DROP TABLE agent_skills; DROP TABLE agent_mcp_connections; DROP TABLE agent_middleware;
          DROP TABLE checkpoints; DROP TABLE run_events; DROP TABLE debug_events; DROP TABLE run_journal;
          DROP TABLE run_config_snapshots; DROP TABLE attachment_references; DROP TABLE runs; DROP TABLE threads;
          ALTER TABLE agent_tools_v3 RENAME TO agent_tools; ALTER TABLE agent_skills_v3 RENAME TO agent_skills;
          ALTER TABLE agent_mcp_connections_v3 RENAME TO agent_mcp_connections; ALTER TABLE agent_middleware_v3 RENAME TO agent_middleware;
          ALTER TABLE threads_v3 RENAME TO threads; ALTER TABLE runs_v3 RENAME TO runs;
          ALTER TABLE checkpoints_v3 RENAME TO checkpoints; ALTER TABLE run_events_v3 RENAME TO run_events;
          ALTER TABLE debug_events_v3 RENAME TO debug_events; ALTER TABLE run_journal_v3 RENAME TO run_journal;
          ALTER TABLE run_config_snapshots_v3 RENAME TO run_config_snapshots;
          ALTER TABLE attachment_references_v3 RENAME TO attachment_references;
          CREATE INDEX idx_runs_thread_status ON runs(thread_id,status,updated_at DESC);
          CREATE INDEX idx_checkpoints_thread ON checkpoints(thread_id,checkpoint_id DESC);
          CREATE INDEX idx_checkpoints_run ON checkpoints(run_id,checkpoint_id DESC);
          CREATE INDEX idx_run_events_thread_time ON run_events(thread_id,created_at);
          CREATE INDEX idx_run_events_run_sequence ON run_events(run_id,sequence);
          CREATE INDEX idx_debug_events_run ON debug_events(run_id,id);
          CREATE INDEX idx_run_journal_run ON run_journal(run_id,id);
          CREATE INDEX idx_run_journal_trace ON run_journal(run_id,loop_index,correlation_id,id);
          CREATE INDEX idx_attachment_references_thread ON attachment_references(thread_id,created_at);
        `)
        recordMigration(3)
        this.db.run('COMMIT')
      } catch (error) { this.db.run('ROLLBACK'); throw error }
      finally { this.db.run('PRAGMA foreign_keys=ON') }
    }
    if (!applied.has(4)) {
      this.db.run('BEGIN')
      try {
        this.db.run(`
          CREATE TABLE run_tool_calls (
            run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
            thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            arguments_json TEXT NOT NULL,
            side_effect INTEGER NOT NULL DEFAULT 0 CHECK(side_effect IN (0,1)),
            status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','interrupted','uncertain')),
            result_json TEXT,
            error_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            PRIMARY KEY(run_id,tool_call_id)
          );
          CREATE INDEX idx_run_tool_calls_run ON run_tool_calls(run_id,status,created_at);
          CREATE INDEX idx_run_tool_calls_call ON run_tool_calls(tool_call_id,updated_at DESC);
        `)
        recordMigration(4)
        this.db.run('COMMIT')
      } catch (error) { this.db.run('ROLLBACK'); throw error }
    }
    if (!applied.has(5)) {
      this.db.run('CREATE TABLE IF NOT EXISTS skill_resources (skill_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(skill_id,path), FOREIGN KEY(skill_id) REFERENCES skills(skill_id) ON DELETE CASCADE)')
      recordMigration(5)
    }
    if (!applied.has(6)) {
      this.db.run('ALTER TABLE skills ADD COLUMN built_in INTEGER NOT NULL DEFAULT 0')
      recordMigration(6)
    }
    if (!applied.has(7)) {
      // Streaming deltas are ephemeral IPC frames. Completed model output is
      // already stored by agent.message.completed and in the thread
      // checkpoint, so retaining token fragments only duplicates content.
      this.db.run('BEGIN')
      try {
        this.db.run("DELETE FROM run_events WHERE type='agent.message.delta'")
        const removed = this.db.getRowsModified()
        recordMigration(7)
        this.db.run('COMMIT')
        if (removed) this.db.run('VACUUM')
      } catch (error) { this.db.run('ROLLBACK'); throw error }
    }
    if (!applied.has(8)) {
      // A custom Skill is edited through its own durable Agent thread. Keeping
      // the relation in Runtime SQLite makes it survive renderer restarts and
      // prevents an arbitrary thread from selecting a filesystem scope.
      this.db.run('CREATE TABLE IF NOT EXISTS skill_editor_sessions (thread_id TEXT PRIMARY KEY, skill_id TEXT REFERENCES skills(skill_id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)')
      this.db.run('CREATE INDEX IF NOT EXISTS idx_skill_editor_sessions_skill ON skill_editor_sessions(skill_id)')
      recordMigration(8)
    }
    if (!applied.has(9)) {
      // Early releases accepted plain text as a Skill and did not require
      // catalog descriptions.  Upgrade every existing record once so there
      // is no second, malformed Skill format that happens to be executable.
      // Resources, bindings and enablement deliberately remain untouched.
      this.db.run('BEGIN')
      try {
        const rows = this.rows('SELECT skill_id,name,slug,description,content FROM skills')
        for (const row of rows) {
          const slug = String(row.slug || '').trim()
          const name = String(row.name || '').replace(/\s+/g, ' ').trim() || slug || '未命名 Skill'
          const description = String(row.description || '').replace(/\s+/g, ' ').trim() || `${name} 的工作说明。`
          const content = normalizeSkillMarkdown(name, description, String(row.content || ''))
          this.db.run('UPDATE skills SET name=?,description=?,content=?,updated_at=? WHERE skill_id=?', [name, description, content, now(), String(row.skill_id)])
        }
        recordMigration(9)
        this.db.run('COMMIT')
      } catch (error) { this.db.run('ROLLBACK'); throw error }
    }
  }

  private async seedDefaults() {
    const defaults = JSON.parse(await readFile(this.defaultsPath, 'utf8')) as JsonObject
    const version = String(defaults.templateVersion || '1')
    this.run('INSERT INTO runtime_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', ['providers', JSON.stringify(defaults.providers || []), now()])
    for (const prompt of Array.isArray(defaults.promptTemplates) ? defaults.promptTemplates as JsonObject[] : []) {
      const existing = this.get('SELECT user_modified FROM prompt_templates WHERE name=?', [prompt.name])
      if (existing && bool(existing.user_modified)) continue
      const timestamp = now()
      this.run(`INSERT INTO prompt_templates(prompt_id,name,content,version,user_modified,created_at,updated_at) VALUES(?,?,?,?,0,?,?)
        ON CONFLICT(name) DO UPDATE SET content=excluded.content,version=excluded.version,updated_at=excluded.updated_at`,
      [`prompt_${String(prompt.name).replace(/[^A-Za-z0-9_-]/g, '_')}`, prompt.name, prompt.content, prompt.version || version, timestamp, timestamp])
    }
    for (const definition of Array.isArray(defaults.middlewareDefinitions) ? defaults.middlewareDefinitions as JsonObject[] : []) {
      const existing = this.get('SELECT user_modified FROM middleware_definitions WHERE name=?', [definition.name])
      if (existing && bool(existing.user_modified)) continue
      const timestamp = now()
      this.run(`INSERT INTO middleware_definitions(middleware_id,name,kind,config_schema_json,default_config_json,version,user_modified,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,?,0,1,?,?) ON CONFLICT(name) DO UPDATE SET kind=excluded.kind,config_schema_json=excluded.config_schema_json,
        default_config_json=excluded.default_config_json,version=excluded.version,updated_at=excluded.updated_at`,
      [`middleware_${String(definition.name).replace(/[^A-Za-z0-9_-]/g, '_')}`, definition.name, definition.kind || definition.name, JSON.stringify(definition.configSchema || {}), JSON.stringify(definition.defaultConfig || {}), definition.version || version, timestamp, timestamp])
    }
    const tools = Array.isArray(defaults.tools) ? defaults.tools as JsonObject[] : []
    for (const tool of tools) {
      const existing = this.get('SELECT user_modified FROM tool_definitions WHERE name=?', [tool.name])
      if (existing && bool(existing.user_modified)) continue
      const timestamp = now()
      this.run(`INSERT INTO tool_definitions(tool_id,name,source,description,input_schema_json,handler_key,timeout_ms,template_version,user_modified,enabled,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,0,1,?,?) ON CONFLICT(name) DO UPDATE SET description=excluded.description,input_schema_json=excluded.input_schema_json,
        handler_key=excluded.handler_key,timeout_ms=excluded.timeout_ms,template_version=excluded.template_version,updated_at=excluded.updated_at`,
      [`tool_${String(tool.name)}`, tool.name, 'builtin', tool.description, JSON.stringify(strictBuiltinToolSchema(String(tool.name), objectValue(tool.inputSchema))), tool.handlerKey || null, Number(tool.timeoutMs || 30000), version, timestamp, timestamp])
    }
    const legacySkill = defaults.skill as JsonObject | undefined
    const skills = Array.isArray(defaults.skills) ? defaults.skills as JsonObject[] : legacySkill ? [legacySkill] : []
    // Defaults are installation templates, not an authority over user edits.
    // Existing Skills may also have been edited through an older application,
    // so retain their content unless we can identify the exact shipped legacy
    // TuGo Architect body below.
    for (const skill of skills) {
      const existing = this.get('SELECT skill_id,content FROM skills WHERE slug=?', [skill.slug])
      if (!existing) this.saveSkill(String(skill.slug), String(skill.content), String(skill.version), String(skill.description || ''), String(skill.name || skill.slug), undefined, true)
      else {
        const legacyArchitect = '# TuGo Architect\n\n负责统筹任务与最终质量。先判断是否需要实际改图；编辑既有画板前先读取状态。复杂任务使用 plan，执行后核对结果。保持已有内容，避免凭空声称修改成功。'
        if (String(skill.slug) === 'tugo-architect' && String(existing.content || '') === legacyArchitect) this.saveSkill(String(skill.slug), String(skill.content), String(skill.version), String(skill.description || ''), String(skill.name || skill.slug), String(existing.skill_id), true)
        else this.run('UPDATE skills SET built_in=1 WHERE skill_id=?', [existing.skill_id])
      }
    }
    const agentTemplate = defaults.agent as JsonObject | undefined
    this.templateAgentTools = Array.isArray(agentTemplate?.tool_names) ? agentTemplate.tool_names.map(String) : []
    this.templateSkillSlugs = (Array.isArray(agentTemplate?.skill_slugs) ? agentTemplate.skill_slugs : skills.map(skill => skill.slug)).map(String).filter(Boolean)
    if (agentTemplate && !this.get('SELECT agent_id FROM agents WHERE name=?', [agentTemplate.name])) {
      const agent = this.saveAgent({ ...agentTemplate, tool_names: agentTemplate.tool_names, skills: this.templateSkillSlugs })
      this.bindAgentTools(String(agent.agent_id), (agentTemplate.tool_names as string[]) || [])
      this.bindAgentSkills(String(agent.agent_id), this.templateSkillSlugs)
    }
    const seededAgent = agentTemplate ? this.get('SELECT agent_id,config_json FROM agents WHERE name=?', [agentTemplate.name]) : undefined
    // Upgrade the previously shipped system-facing instruction that asked the
    // model to carry project_id. Custom agent wording is left untouched.
    const seededSoul = String(seededAgent && this.get('SELECT soul FROM agents WHERE agent_id=?', [seededAgent.agent_id])?.soul || '')
    if (seededAgent && (seededSoul.includes('project_id') || (seededSoul.includes('画板操作由当前会话自动作用') && (!seededSoul.includes('版本快照是保护有效成果') || (seededSoul.includes('写清名称、保存理由') && !seededSoul.includes('该工具保存的都是 AI 快照')))))) {
      this.run('UPDATE agents SET soul=?,description=?,updated_at=? WHERE agent_id=?', [String(agentTemplate?.soul || ''), String(agentTemplate?.description || ''), now(), seededAgent.agent_id])
    }
    if (seededAgent && !this.get('SELECT agent_id FROM agent_middleware WHERE agent_id=? LIMIT 1', [seededAgent.agent_id])) {
      const config = json<JsonObject>(seededAgent.config_json, {})
      this.bindAgentMiddleware(String(seededAgent.agent_id), objectValue(config.middleware || agentTemplate?.middleware))
    }
    // Upgrade the original safety budget for the shipped Lead Agent without
    // touching installations that deliberately chose another value.
    if (seededAgent) {
      const middleware = objectValue(this.getAgent(String(seededAgent.agent_id))?.middleware)
      if (Number(middleware.maxLoops) === 40) {
        this.bindAgentMiddleware(String(seededAgent.agent_id), {
          ...middleware,
          maxLoops: 200,
          ...(Number(middleware.maxToolCalls) === 80 ? { maxToolCalls: 400 } : {}),
          ...(Number(middleware.maxRunMs) === 600000 ? { maxRunMs: 1800000 } : {}),
        })
      }
    }
    // System capabilities added after first launch must be available to the
    // shipped Lead Agent without replacing a user's existing tool bindings.
    for (const toolName of ['diagram_set_brief', 'diagram_get_brief', 'diagram_review_content', 'diagram_acceptance_check', 'board_optimize_layout', 'board_review_quality', 'board_capture_image', 'board_export_pptx']) if (seededAgent && this.get('SELECT tool_id FROM tool_definitions WHERE name=?', [toolName])) {
      this.run('INSERT OR IGNORE INTO agent_tools(agent_id,tool_name,enabled) VALUES(?,?,1)', [seededAgent.agent_id, toolName])
    }
    // Built-in skills introduced by a shipped template are capabilities, not
    // user-authored configuration. Bind the new PPT workflow for existing
    // installations as well as first-run databases.
    if (seededAgent) {
      const pptSkill = this.get('SELECT skill_id FROM skills WHERE slug=? AND built_in=1', ['ppt-storyboard'])
      if (pptSkill) this.run('INSERT OR IGNORE INTO agent_skills(agent_id,skill_id,position) VALUES(?,?,?)', [seededAgent.agent_id, pptSkill.skill_id, 999])
    }
    this.run('INSERT INTO runtime_meta(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', ['template_version', JSON.stringify(version), now()])
    this.ensureSkillEditorAgent()
  }

  private ensureSkillEditorAgent() {
    const definitions: Array<{ name: string; description: string; handler: string; schema: JsonObject }> = [
      { name: 'skill_create', description: '创建一个新的自定义 Skill，并将当前编辑会话绑定到它。创建前先确认名称、用途和一句话简介。', handler: 'skill-create', schema: { type: 'object', required: ['description', 'name', 'summary'], properties: { description: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1, maxLength: 80 }, summary: { type: 'string', minLength: 1, maxLength: 500 }, content: { type: 'string' } }, additionalProperties: false } },
      { name: 'skill_get_name', description: '读取当前编辑会话所绑定 Skill 的名称和简介。', handler: 'skill-get-name', schema: { type: 'object', required: ['description'], properties: { description: { type: 'string', minLength: 1 } }, additionalProperties: false } },
      { name: 'skill_set_name', description: '修改当前编辑会话所绑定 Skill 的名称和可选简介。', handler: 'skill-set-name', schema: { type: 'object', required: ['description', 'name'], properties: { description: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1, maxLength: 80 }, summary: { type: 'string' } }, additionalProperties: false } },
      { name: 'skill_list_files', description: '列出当前编辑会话绑定 Skill 的全部目录和文件。新建会话尚未创建 Skill 时会明确返回该状态。', handler: 'skill-list-files', schema: { type: 'object', required: ['description'], properties: { description: { type: 'string', minLength: 1 } }, additionalProperties: false } },
      { name: 'skill_read_file', description: '读取当前 Skill 中的 SKILL.md 或指定资源文件。', handler: 'skill-read-file', schema: { type: 'object', required: ['description', 'path'], properties: { description: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 } }, additionalProperties: false } },
      { name: 'skill_write_file', description: '创建或完整写入当前 Skill 的 SKILL.md 或资源文件；不能写脚本或可执行文件。', handler: 'skill-write-file', schema: { type: 'object', required: ['description', 'path', 'content'], properties: { description: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, content: { type: 'string' } }, additionalProperties: false } },
      { name: 'skill_replace_text', description: '在当前 Skill 指定文件中精确替换一段文本。', handler: 'skill-replace-text', schema: { type: 'object', required: ['description', 'path', 'old_text', 'new_text'], properties: { description: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 }, old_text: { type: 'string' }, new_text: { type: 'string' } }, additionalProperties: false } },
      { name: 'skill_delete_file', description: '删除当前 Skill 的一个资源文件；不能删除 SKILL.md。', handler: 'skill-delete-file', schema: { type: 'object', required: ['description', 'path'], properties: { description: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 } }, additionalProperties: false } },
    ]
    for (const tool of definitions) {
      const existing = this.get('SELECT tool_id FROM tool_definitions WHERE name=?', [tool.name]); const timestamp = now()
      if (!existing) this.run('INSERT INTO tool_definitions(tool_id,name,source,description,input_schema_json,handler_key,timeout_ms,template_version,user_modified,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,1,?,?)', [`tool_${tool.name}`, tool.name, 'builtin', tool.description, JSON.stringify(tool.schema), tool.handler, 10000, 'skill-editor-v1', timestamp, timestamp])
      else this.run('UPDATE tool_definitions SET description=?,input_schema_json=?,handler_key=?,updated_at=? WHERE tool_id=?', [tool.description, JSON.stringify(tool.schema), tool.handler, timestamp, existing.tool_id])
    }
    const editor = this.get('SELECT agent_id FROM agents WHERE name=?', ['tugo-skill-editor'])
    const defaultModel = this.get('SELECT model_id FROM models WHERE is_default=1 ORDER BY updated_at DESC LIMIT 1')
    const body = {
      name: 'tugo-skill-editor', display_name: 'Skill 编辑助手', description: '通过对话创建和维护 TuGo 自定义 Skill 文件包。', model_id: defaultModel?.model_id,
      soul: '你是 TuGo 的 Skill 编辑助手。当前会话专门创建或编辑一个自定义 Skill。新建会话尚无 Skill 时，先澄清目标，再调用 skill_create；必须给出名称和一句话简介 summary。Skill 的主说明必须写入 SKILL.md，且第一行必须是 YAML frontmatter：---、name:、description:、---；name 和 description 必须与 Skill 元数据一致。创建后先写入完整 SKILL.md，再按需补充 references/ 等参考资料。已有 Skill 时先调用 skill_list_files，再按需读取文件。只能操作当前会话绑定的 Skill，不能使用 Shell、任意磁盘读写或画板工具；禁止创建或写入脚本、可执行文件。每次修改后简洁说明写入了哪些文件。',
      tool_names: definitions.map(item => item.name), skills: [], middleware: { plan: { enabled: false }, summarization: { enabled: true, triggerRatio: .72, keepRecentMessages: 20 }, loopDetection: { enabled: true, warnAfter: 3, stopAfter: 6 }, modelRetry: { enabled: true, maxAttempts: 3 }, toolRepair: { enabled: true, maxAttempts: 2 }, maxLoops: 200 },
    }
    if (!editor) this.saveAgent(body)
    else {
      // This is a normal persisted Agent record after provisioning. Do not
      // overwrite a user-adjusted prompt/model/middleware on every launch;
      // only add newly shipped controlled tools to its binding table.
      const existing = this.getAgent(String(editor.agent_id))
      this.bindAgentTools(String(editor.agent_id), [...new Set([...(existing?.tool_names || []), ...definitions.map(item => item.name)])])
      this.run('UPDATE agents SET soul=?,description=?,updated_at=? WHERE agent_id=?', [String(body.soul), String(body.description), now(), editor.agent_id])
    }
  }

  private rows(sql: string, params: unknown[] = []): JsonObject[] {
    const statement = this.db.prepare(sql)
    statement.bind(params as never[])
    const result: JsonObject[] = []
    while (statement.step()) result.push(statement.getAsObject() as JsonObject)
    statement.free()
    return result
  }
  private get(sql: string, params: unknown[] = []) { return this.rows(sql, params)[0] }
  private run(sql: string, params: unknown[] = []) { this.db.run(sql, params as never[]); this.scheduleFlush() }
  private scheduleFlush() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.flush().catch(() => undefined) }, 1_000)
  }
  async flush() {
    if (!this.db) return
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined }
    const snapshot = Buffer.from(this.db.export())
    // sql.js export() reopens its internal SQLite handle and resets
    // connection-local pragmas, including foreign_keys.
    this.db.run('PRAGMA foreign_keys=ON')
    const target = this.databasePath
    const write = this.persistChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
      try {
        await writeFile(temporary, snapshot, { flush: true })
        await rename(temporary, target)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    })
    this.persistChain = write
    try { await write; this.persistError = undefined }
    catch (error) { this.persistError = error instanceof Error ? error.message : String(error); throw error }
  }
  async createBackup(reason = 'manual') {
    await this.flush()
    const safeReason = reason.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || 'manual'
    const path = join(this.backupsDir, `runtime-${new Date().toISOString().replace(/[:.]/g, '-')}-${safeReason}.sqlite`)
    await copyFile(this.databasePath, path)
    const backups = await this.listBackups()
    await Promise.all(backups.slice(8).map(item => unlink(item.path).catch(() => undefined)))
    return { path, created_at: new Date().toISOString(), reason: safeReason }
  }
  async listBackups() {
    const names = (await readdir(this.backupsDir).catch(() => [] as string[])).filter(name => /^runtime-.*\.sqlite$/.test(name)).sort().reverse()
    return Promise.all(names.map(async name => { const path = join(this.backupsDir, name); const info = await stat(path); return { name, path, size: info.size, created_at: info.mtime.toISOString() } }))
  }
  async scheduleRestore(name: string) {
    const backup = (await this.listBackups()).find(item => item.name === name)
    if (!backup) throw new Error('Runtime backup not found')
    const candidate = new this.SQL.Database(await readFile(backup.path)); const health = this.quickCheck(candidate); candidate.close()
    if (!health.ok) throw new Error('Runtime backup failed integrity check')
    await copyFile(backup.path, this.pendingRecoveryPath)
    return { scheduled: true, restart_required: true, name: backup.name }
  }
  integrityCheck() {
    const quick = this.quickCheck(this.db)
    const foreignKeysRow = this.get('PRAGMA foreign_keys')
    const foreignKeys = Number(foreignKeysRow?.foreign_keys || 0) === 1
    const foreignKeyErrors = this.rows('PRAGMA foreign_key_check')
    return { ...quick, foreignKeys, foreignKeyErrors, foreignKeysRow, persistError: this.persistError || null }
  }

  async cleanupRetention(options: { eventDays?: number; diagnosticDays?: number; checkpointDays?: number; maxEvents?: number; maxJournal?: number; maxDebug?: number } = {}) {
    const eventCutoff = new Date(Date.now() - (options.eventDays ?? 90) * 86_400_000).toISOString()
    const diagnosticCutoff = new Date(Date.now() - (options.diagnosticDays ?? 30) * 86_400_000).toISOString()
    // Also enforce this outside the migration so a database restored from an
    // older backup, or briefly opened by an older build, cannot reintroduce
    // durable token fragments.
    this.run("DELETE FROM run_events WHERE type='agent.message.delta'", [])
    this.run("DELETE FROM run_events WHERE created_at<? AND run_id IN (SELECT run_id FROM runs WHERE status!='running')", [eventCutoff])
    this.run("DELETE FROM run_journal WHERE created_at<? AND run_id IN (SELECT run_id FROM runs WHERE status!='running')", [diagnosticCutoff])
    this.run("DELETE FROM debug_events WHERE created_at<? AND run_id IN (SELECT run_id FROM runs WHERE status!='running')", [diagnosticCutoff])
    // A checkpoint is the latest durable state of a thread, not an execution
    // log. Keeping every full message snapshot made the in-memory SQL.js file
    // grow by hundreds of MB and multiplied startup memory use.
    this.run(`DELETE FROM checkpoints WHERE checkpoint_id NOT IN
      (SELECT MAX(checkpoint_id) FROM checkpoints GROUP BY thread_id)`, [])
    for (const [table, max] of [['run_events', options.maxEvents ?? 10_000], ['run_journal', options.maxJournal ?? 5_000], ['debug_events', options.maxDebug ?? 5_000]] as const) {
      const count = Number(this.get(`SELECT COUNT(*) AS count FROM ${table}`)?.count || 0)
      if (count > max) this.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY rowid ASC LIMIT ?)`, [count - max])
    }
    const oversized = this.rows("SELECT id FROM run_journal WHERE length(payload_json)>32000 AND event_type IN ('model.request','model.http.request')")
    for (const item of oversized) {
      const row = this.get('SELECT event_type,payload_json FROM run_journal WHERE id=?', [item.id])
      if (!row) continue
      this.db.run('UPDATE run_journal SET payload_json=? WHERE id=?', [JSON.stringify(compactJournalPayload(String(row.event_type), json(row.payload_json, {}))), Number(item.id)])
    }
    if (oversized.length) this.scheduleFlush()
    const existingSize = await stat(this.databasePath).then(info => info.size).catch(() => 0)
    if (existingSize > 128 * 1024 * 1024) this.db.run('VACUUM')
    return { events: Number(this.get('SELECT COUNT(*) AS count FROM run_events')?.count || 0), journal: Number(this.get('SELECT COUNT(*) AS count FROM run_journal')?.count || 0), debug: Number(this.get('SELECT COUNT(*) AS count FROM debug_events')?.count || 0), checkpoints: Number(this.get('SELECT COUNT(*) AS count FROM checkpoints')?.count || 0) }
  }
  async close() { await this.createBackup('shutdown'); this.db.close() }

  listProviders() { return json<JsonObject[]>(this.get('SELECT value_json FROM runtime_meta WHERE key=?', ['providers'])?.value_json, []) }
  schemaVersions() { return this.rows('SELECT version,name,applied_at FROM schema_migrations ORDER BY version') }
  promptVersions() { return this.rows('SELECT name,version FROM prompt_templates ORDER BY name') }
  listPromptTemplates() { return this.rows('SELECT prompt_id,name,content,version,user_modified,updated_at FROM prompt_templates ORDER BY name').map(row => ({ prompt_id: String(row.prompt_id), name: String(row.name), content: String(row.content), version: String(row.version), user_modified: bool(row.user_modified), updated_at: String(row.updated_at) })) }
  savePromptTemplate(name: string, content: string, version = 'custom') {
    const existing = this.get('SELECT prompt_id,created_at FROM prompt_templates WHERE name=?', [name]); const timestamp = now(); const id = String(existing?.prompt_id || `prompt_${randomUUID()}`)
    this.run(`INSERT INTO prompt_templates(prompt_id,name,content,version,user_modified,created_at,updated_at) VALUES(?,?,?,?,1,?,?)
      ON CONFLICT(name) DO UPDATE SET content=excluded.content,version=excluded.version,user_modified=1,updated_at=excluded.updated_at`, [id, name, content, version, existing?.created_at || timestamp, timestamp])
    return this.listPromptTemplates().find(item => item.name === name)
  }
  listMiddlewareDefinitions() { return this.rows('SELECT middleware_id,name,kind,config_schema_json,default_config_json,version,user_modified,enabled,updated_at FROM middleware_definitions ORDER BY name').map(row => ({ middleware_id: row.middleware_id, name: row.name, kind: row.kind, config_schema: json(row.config_schema_json, {}), default_config: json(row.default_config_json, {}), version: row.version, user_modified: bool(row.user_modified), enabled: bool(row.enabled), updated_at: row.updated_at })) }
  promptSnapshot() { return this.rows('SELECT name,version,content FROM prompt_templates ORDER BY name') }
  renderPrompt(name: string, variables: Record<string, unknown> = {}, locale: RuntimePromptLocale = 'zh-CN') {
    const row = this.get('SELECT content FROM prompt_templates WHERE name=?', [name])
    if (!row) throw new Error(`Prompt template not found: ${name}`)
    const content = localizedPrompt(name, normalizePromptLocale(locale)) || String(row.content)
    return content.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => String(variables[key] ?? ''))
  }
  listModels() { return this.rows('SELECT * FROM models ORDER BY is_default DESC, updated_at DESC').map(row => this.publicModel(row)) }
  private publicModel(row: JsonObject) {
    const extra = json<JsonObject>(row.extra_json, {})
    const { api_key: _secret, api_key_ref: _secretRef, ...publicExtra } = extra
    return { model_id: row.model_id, name: row.name, provider_id: row.provider_id, model: row.model, display_name: row.display_name, enabled: bool(row.enabled), is_default: bool(row.is_default), extra_config: publicExtra, has_secrets: Boolean(extra.api_key || extra.api_key_ref) }
  }
  getModel(modelId: string): ModelConfig | undefined {
    const row = this.get('SELECT * FROM models WHERE model_id=?', [modelId]); if (!row) return
    return { model_id: String(row.model_id), provider_id: String(row.provider_id), model: String(row.model), display_name: String(row.display_name), runtime_extra: json<JsonObject>(row.extra_json, {}) }
  }
  defaultModel() {
    const row = this.get('SELECT model_id FROM models WHERE enabled=1 ORDER BY is_default DESC,updated_at DESC LIMIT 1')
    return row ? this.getModel(String(row.model_id)) : undefined
  }
  modelSnapshot(modelId: string) { const row = this.get('SELECT * FROM models WHERE model_id=?', [modelId]); return row ? this.publicModel(row) : undefined }
  saveModel(body: JsonObject, modelId?: string) {
    const existing = modelId ? this.get('SELECT * FROM models WHERE model_id=?', [modelId]) : undefined
    const id = modelId || `model_${randomUUID()}`
    const previous = json<JsonObject>(existing?.extra_json, {})
    const incoming = typeof body.extra_config === 'object' && body.extra_config ? { ...(body.extra_config as JsonObject) } : {}
    if (typeof incoming.api_key === 'string' && incoming.api_key) {
      if (!incoming.api_key_ref) throw new Error('模型密钥必须先写入系统安全存储，再以 api_key_ref 保存')
      delete incoming.api_key
    }
    const identityChanged = !existing || String(existing.provider_id) !== String(body.provider_id || 'openai') || String(existing.model) !== String(body.model || '') || JSON.stringify({ base_url: previous.base_url, api_key_ref: previous.api_key_ref }) !== JSON.stringify({ base_url: incoming.base_url ?? previous.base_url, api_key_ref: incoming.api_key_ref ?? previous.api_key_ref })
    const extra: JsonObject = { ...previous, ...incoming, ...(identityChanged ? { probe_status: 'pending', probe_at: null } : {}) }
    const contextWindow = Number(extra.context_window || 128_000); const maxOutputTokens = Number(extra.max_output_tokens || extra.max_tokens || 32_768)
    if (!Number.isFinite(contextWindow) || contextWindow < 4096) throw new Error('模型 Context Window 至少为 4096')
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens >= contextWindow) throw new Error('模型最大输出必须大于等于 256 且小于 Context Window')
    extra.context_window = contextWindow; extra.max_output_tokens = maxOutputTokens; extra.vision_capable = extra.vision_capable !== false
    if (body.is_default !== false) this.run('UPDATE models SET is_default=0')
    const timestamp = now()
    this.run(`INSERT INTO models(model_id,name,provider_id,model,display_name,enabled,is_default,extra_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(model_id) DO UPDATE SET name=excluded.name,provider_id=excluded.provider_id,model=excluded.model,display_name=excluded.display_name,
      enabled=excluded.enabled,is_default=excluded.is_default,extra_json=excluded.extra_json,updated_at=excluded.updated_at`,
    [id, String(body.name || id), String(body.provider_id || 'openai'), String(body.model || ''), String(body.display_name || body.model || 'Model'), body.enabled === false ? 0 : 1, body.is_default === false ? 0 : 1, JSON.stringify(extra), existing?.created_at || timestamp, timestamp])
    return this.publicModel(this.get('SELECT * FROM models WHERE model_id=?', [id]))
  }
  recordModelProbe(modelId: string, ok: boolean, detail = '') {
    const row = this.get('SELECT extra_json FROM models WHERE model_id=?', [modelId])
    if (!row) throw new Error('Model not found')
    const extra = json<JsonObject>(row.extra_json, {})
    extra.probe_status = ok ? 'success' : 'failed'
    extra.probe_at = now()
    extra.probe_detail = detail.slice(0, 500)
    this.run('UPDATE models SET extra_json=?,updated_at=? WHERE model_id=?', [JSON.stringify(extra), now(), modelId])
  }
  recordModelVisionCapability(modelId: string, capable: boolean, detail = '') {
    const row = this.get('SELECT extra_json FROM models WHERE model_id=?', [modelId]); if (!row) return
    const extra = json<JsonObject>(row.extra_json, {}); extra.vision_capable = capable; extra.vision_probe_detail = detail.slice(0, 500)
    this.run('UPDATE models SET extra_json=?,updated_at=? WHERE model_id=?', [JSON.stringify(extra), now(), modelId])
  }
  deleteModel(modelId: string) {
    const row = this.get('SELECT is_default FROM models WHERE model_id=?', [modelId]); if (!row) return { deleted: false }
    this.run('DELETE FROM models WHERE model_id=?', [modelId])
    if (bool(row.is_default)) this.run('UPDATE models SET is_default=1 WHERE model_id=(SELECT model_id FROM models WHERE enabled=1 ORDER BY updated_at DESC LIMIT 1)')
    return { deleted: true }
  }
  isModelEnabled(modelId: string) { return bool(this.get('SELECT enabled FROM models WHERE model_id=?', [modelId])?.enabled) }
  legacyModelSecrets() {
    return this.rows('SELECT model_id,extra_json FROM models').flatMap(row => {
      const extra = json<JsonObject>(row.extra_json, {})
      return typeof extra.api_key === 'string' && extra.api_key ? [{ model_id: String(row.model_id), api_key: extra.api_key }] : []
    })
  }
  replaceModelSecret(modelId: string, reference: string) {
    const row = this.get('SELECT extra_json FROM models WHERE model_id=?', [modelId])
    if (!row) throw new Error('Model not found')
    const extra = json<JsonObject>(row.extra_json, {})
    delete extra.api_key
    extra.api_key_ref = reference
    this.run('UPDATE models SET extra_json=?,updated_at=? WHERE model_id=?', [JSON.stringify(extra), now(), modelId])
  }

  listAgents() { return this.rows('SELECT * FROM agents ORDER BY updated_at DESC').map(row => this.agentRecord(row)) }
  private agentRecord(row: JsonObject) {
    const config = json<JsonObject>(row.config_json, {})
    const tools = this.rows('SELECT tool_name FROM agent_tools WHERE agent_id=? AND enabled=1 ORDER BY tool_name', [row.agent_id]).map(item => String(item.tool_name))
    const skills = this.rows('SELECT s.skill_id FROM skills s JOIN agent_skills a ON a.skill_id=s.skill_id WHERE a.agent_id=? ORDER BY a.position', [row.agent_id]).map(item => String(item.skill_id))
    const mcpBindings = this.rows('SELECT connection_id,tool_allowlist_json FROM agent_mcp_connections WHERE agent_id=?', [row.agent_id]).map(item => ({ connection_id: String(item.connection_id), allowlist: json<string[]>(item.tool_allowlist_json, []) }))
    const mcps = mcpBindings.map(item => item.connection_id)
    const normalizedMiddleware = Object.fromEntries(this.rows('SELECT middleware_name,config_json,enabled FROM agent_middleware WHERE agent_id=? ORDER BY position', [row.agent_id]).map(item => {
      const value = json<unknown>(item.config_json, {})
      return [String(item.middleware_name), value && typeof value === 'object' && !Array.isArray(value) ? { ...value, enabled: bool(item.enabled) } : value]
    }))
    return { agent_id: row.agent_id, name: row.name, display_name: row.display_name, description: row.description, model_id: row.model_id, soul: row.soul, tool_groups: json(row.tool_groups_json, []), tool_names: tools, skills: skills.length ? skills : json(row.skills_json, []), mcp_connection_ids: mcps.length ? mcps : json(row.mcp_ids_json, []), mcp_bindings: mcpBindings, mcp_endpoints: config.mcp_endpoints || [], middleware: Object.keys(normalizedMiddleware).length ? normalizedMiddleware : config.middleware || {} }
  }
  getAgent(agentId: string) { const row = this.get('SELECT * FROM agents WHERE agent_id=?', [agentId]); return row ? this.agentRecord(row) : undefined }
  bootstrap(modelId: string) {
    const model = this.getModel(modelId)
    if (!model) throw new Error('Model not found')
    if (!this.isModelEnabled(modelId)) throw new Error('模型已停用，请先在设置中启用')
    const row = this.get('SELECT agent_id FROM agents WHERE name=?', ['tugo-architect'])
    if (!row) throw new Error('TuGo Agent template is missing')
    this.run('UPDATE agents SET model_id=?,updated_at=? WHERE agent_id=?', [modelId, now(), row.agent_id])
    const skills = this.listSkills().filter(item => this.templateSkillSlugs.includes(String(item.slug || '')))
    if (skills.length !== this.templateSkillSlugs.length) throw new Error('TuGo Skill template is missing')
    // The canvas tool set is a product invariant. Older databases can retain
    // the Agent row while losing its join-table bindings during migrations;
    // repair those bindings from the versioned template on every bootstrap.
    this.bindAgentTools(String(row.agent_id), this.templateAgentTools)
    if (this.templateSkillSlugs.length) this.bindAgentSkills(String(row.agent_id), this.templateSkillSlugs)
    const agent = this.getAgent(String(row.agent_id))!
    return { agent, skill: skills[0], skills }
  }
  saveAgent(body: JsonObject, agentId?: string) {
    const existing = agentId ? this.get('SELECT * FROM agents WHERE agent_id=?', [agentId]) : undefined
    const id = agentId || `agent_${randomUUID()}`; const timestamp = now()
    const previousConfig = json<JsonObject>(existing?.config_json, {})
    const config = { ...previousConfig, ...(body.middleware ? { middleware: body.middleware } : {}) }
    this.run(`INSERT INTO agents(agent_id,name,display_name,description,model_id,soul,tool_groups_json,skills_json,mcp_ids_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET name=excluded.name,display_name=excluded.display_name,description=excluded.description,model_id=excluded.model_id,soul=excluded.soul,
      tool_groups_json=excluded.tool_groups_json,skills_json=excluded.skills_json,mcp_ids_json=excluded.mcp_ids_json,config_json=excluded.config_json,updated_at=excluded.updated_at`,
    [id, String(body.name || id), String(body.display_name || body.name || 'Agent'), String(body.description || ''), body.model_id || existing?.model_id || null, String(body.soul || existing?.soul || ''), JSON.stringify(body.tool_groups || []), JSON.stringify(body.skills || []), JSON.stringify(body.mcp_connection_ids || []), JSON.stringify(config), existing?.created_at || timestamp, timestamp])
    if (Array.isArray(body.tool_names)) this.bindAgentTools(id, body.tool_names.map(String))
    if (Array.isArray(body.skills)) this.bindAgentSkills(id, body.skills.map(String))
    if (Array.isArray(body.mcp_connection_ids)) this.bindAgentMcp(id, body.mcp_connection_ids.map(String))
    if (body.middleware && typeof body.middleware === 'object') this.bindAgentMiddleware(id, body.middleware as JsonObject)
    return this.getAgent(id)!
  }
  bindAgentTools(agentId: string, names: string[]) { this.run('DELETE FROM agent_tools WHERE agent_id=?', [agentId]); for (const name of names) this.run('INSERT OR IGNORE INTO agent_tools(agent_id,tool_name,enabled) VALUES(?,?,1)', [agentId, name]) }
  bindAgentSkills(agentId: string, ids: string[]) { this.run('DELETE FROM agent_skills WHERE agent_id=?', [agentId]); ids.forEach((value, position) => { const row = this.get('SELECT skill_id FROM skills WHERE skill_id=? OR slug=?', [value, value]); if (row) this.run('INSERT OR IGNORE INTO agent_skills(agent_id,skill_id,position) VALUES(?,?,?)', [agentId, row.skill_id, position]) }) }
  bindAgentMcp(agentId: string, bindings: Array<string | { connection_id: string; allowlist?: string[] }>) {
    this.run('DELETE FROM agent_mcp_connections WHERE agent_id=?', [agentId])
    bindings.forEach(binding => {
      const id = typeof binding === 'string' ? binding : binding.connection_id
      const allowlist = typeof binding === 'string' ? [] : Array.isArray(binding.allowlist) ? binding.allowlist.map(String) : []
      this.run('INSERT INTO agent_mcp_connections(agent_id,connection_id,tool_allowlist_json) VALUES(?,?,?)', [agentId, id, JSON.stringify(allowlist)])
    })
  }
  bindAgentMiddleware(agentId: string, config: JsonObject) {
    this.run('DELETE FROM agent_middleware WHERE agent_id=?', [agentId])
    Object.entries(config).forEach(([name, value], position) => this.run('INSERT INTO agent_middleware(agent_id,middleware_name,config_json,enabled,position) VALUES(?,?,?,?,?)', [agentId, name, JSON.stringify(value), objectValue(value).enabled === false ? 0 : 1, position]))
  }
  middlewareForAgent(agentId: string) { return this.rows('SELECT middleware_name,config_json,enabled,position FROM agent_middleware WHERE agent_id=? ORDER BY position', [agentId]).map(row => ({ name: String(row.middleware_name), config: json<JsonObject>(row.config_json, {}), enabled: bool(row.enabled), position: Number(row.position) })) }

  isBuiltinSkill(id: string) { return bool(this.get('SELECT built_in FROM skills WHERE skill_id=? OR slug=?', [id, id])?.built_in) }
  skillEditorAgent() { return this.listAgents().find(agent => String(agent.name) === 'tugo-skill-editor') }
  createSkillEditorSession(skillId?: string) {
    if (skillId && (this.isBuiltinSkill(skillId) || !this.get('SELECT skill_id FROM skills WHERE skill_id=?', [skillId]))) throw new Error('只能编辑自己的 Skill')
    const agent = this.skillEditorAgent(); if (!agent) throw new Error('Skill 编辑助手尚未初始化')
    if (skillId) {
      const existing = this.get('SELECT thread_id FROM skill_editor_sessions WHERE skill_id=? ORDER BY updated_at DESC LIMIT 1', [skillId])
      if (existing) return { thread_id: String(existing.thread_id), agent_id: String(agent.agent_id), skill_id: skillId }
    }
    const thread = this.createThread(String(agent.agent_id), { source: 'tugo-skill-editor', title: skillId ? '编辑 Skill' : '新建 Skill', skill_editor: true })
    this.run('INSERT INTO skill_editor_sessions(thread_id,skill_id,created_at,updated_at) VALUES(?,?,?,?)', [thread.thread_id, skillId || null, now(), now()])
    return { ...thread, agent_id: String(agent.agent_id), skill_id: skillId || null }
  }
  skillEditorSession(threadId: string) {
    const row = this.get('SELECT s.thread_id,s.skill_id,k.name,k.description,k.enabled FROM skill_editor_sessions s LEFT JOIN skills k ON k.skill_id=s.skill_id WHERE s.thread_id=?', [threadId])
    return row ? { thread_id: String(row.thread_id), skill_id: row.skill_id ? String(row.skill_id) : null, name: row.name ? String(row.name) : undefined, description: row.description ? String(row.description) : undefined, enabled: row.enabled === undefined ? undefined : bool(row.enabled) } : undefined
  }
  skillEditorMessages(threadId: string) {
    const checkpoint = this.latestCheckpoint(threadId)
    return (checkpoint?.messages || []).filter(message => message.role === 'user' || message.role === 'assistant').map(message => ({ role: message.role, content: message.content }))
  }
  bindSkillEditorSession(threadId: string, skillId: string) {
    if (!this.get('SELECT thread_id FROM skill_editor_sessions WHERE thread_id=?', [threadId])) throw new Error('当前会话不是 Skill 编辑会话')
    if (this.isBuiltinSkill(skillId)) throw new Error('内置 Skill 不可由编辑助手修改')
    this.run('UPDATE skill_editor_sessions SET skill_id=?,updated_at=? WHERE thread_id=?', [skillId, now(), threadId])
  }
  skillFileListForThread(threadId: string) {
    const session = this.skillEditorSession(threadId); if (!session?.skill_id) return { skill_id: null, files: [], state: 'new' }
    const resources = this.skillResources(session.skill_id).map(item => item.path)
    return { skill_id: session.skill_id, files: ['SKILL.md', ...resources], state: 'editing' }
  }
  private skillFilePath(path: string) {
    const normalized = String(path || '').replaceAll('\\', '/').replace(/^\/+/, '')
    if (!normalized || normalized.includes('..') || /(^|\/)(?:scripts?|bin)(\/|$)|\.(?:js|mjs|cjs|ts|tsx|py|sh|bash|exe|app|dll)$/i.test(normalized)) throw new Error('Skill 不支持脚本或不安全路径')
    return normalized === 'SKILL.md' ? normalized : normalized
  }
  private skillIdForEditorThread(threadId: string) {
    const session = this.skillEditorSession(threadId); if (!session?.skill_id) throw new Error('当前会话尚未创建 Skill，请先调用 skill_create')
    return session.skill_id
  }
  readSkillFileForThread(threadId: string, path: string) {
    const skillId = this.skillIdForEditorThread(threadId); const safe = this.skillFilePath(path)
    if (safe === 'SKILL.md') return { path: safe, content: this.skillContent(skillId) || '' }
    const item = this.skillResources(skillId).find(resource => resource.path === safe); if (!item) throw new Error(`文件不存在：${safe}`)
    return item
  }
  writeSkillFileForThread(threadId: string, path: string, content: string) {
    const skillId = this.skillIdForEditorThread(threadId); const safe = this.skillFilePath(path); const text = String(content || '')
    if (text.length > 512 * 1024) throw new Error('单个 Skill 文件不能超过 512KB')
    if (safe === 'SKILL.md') {
      const row = this.get('SELECT name,slug,description FROM skills WHERE skill_id=?', [skillId]); this.saveSkill(String(row.slug), text, '1.0.0', String(row.description || ''), String(row.name), skillId)
    } else {
      const resources = this.skillResources(skillId).filter(item => item.path !== safe); this.saveSkillResources(skillId, [...resources, { path: safe, content: text }])
    }
    return { skill_id: skillId, path: safe, bytes: text.length }
  }
  replaceSkillTextForThread(threadId: string, path: string, oldText: string, newText: string) {
    const file = this.readSkillFileForThread(threadId, path); const count = file.content.split(oldText).length - 1
    if (!oldText || count !== 1) throw new Error(count ? '旧文本出现多次，请提供更精确的 old_text' : '未找到要替换的旧文本')
    return this.writeSkillFileForThread(threadId, file.path, file.content.replace(oldText, newText))
  }
  deleteSkillFileForThread(threadId: string, path: string) {
    const skillId = this.skillIdForEditorThread(threadId); const safe = this.skillFilePath(path); if (safe === 'SKILL.md') throw new Error('SKILL.md 是 Skill 主文件，不能删除')
    const resources = this.skillResources(skillId); if (!resources.some(item => item.path === safe)) throw new Error(`文件不存在：${safe}`)
    this.saveSkillResources(skillId, resources.filter(item => item.path !== safe)); return { skill_id: skillId, path: safe, deleted: true }
  }
  createSkillForEditorThread(threadId: string, name: string, summary = '', content = '') {
    if (this.skillEditorSession(threadId)?.skill_id) throw new Error('当前会话已经绑定 Skill，请直接编辑文件')
    const cleanName = String(name || '').trim(); if (!cleanName) throw new Error('Skill 名称不能为空')
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `skill-${randomUUID().slice(0, 8)}`
    const skill = this.saveSkill(slug, content || `# ${cleanName}\n\n`, '1.0.0', String(summary || ''), cleanName)
    this.bindSkillEditorSession(threadId, String(skill.skill_id))
    const lead = this.listAgents().find(agent => String(agent.name) === 'tugo-architect')
    if (lead) this.bindAgentSkills(String(lead.agent_id), [...new Set([...(lead.skills as string[]), String(skill.skill_id)])])
    return skill
  }
  skillNameForEditorThread(threadId: string) {
    const skillId = this.skillIdForEditorThread(threadId)
    const item = this.listSkills(true).find(skill => String(skill.skill_id) === skillId)
    if (!item) throw new Error('Skill 不存在')
    return item
  }
  setSkillNameForEditorThread(threadId: string, name: string, summary?: string) {
    const skillId = this.skillIdForEditorThread(threadId)
    const item = this.listSkills(true).find(skill => String(skill.skill_id) === skillId)
    const cleanName = String(name || '').trim()
    if (!item || !cleanName) throw new Error('Skill 名称不能为空')
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || String(item.slug)
    return this.saveSkill(slug, this.skillContent(skillId) || '', String(item.version || '1.0.0'), summary === undefined ? String(item.description || '') : String(summary), cleanName, skillId)
  }
  renameSkill(id: string, name: string) {
    if (this.isBuiltinSkill(id)) throw new Error('内置 Skill 不能重命名')
    const item = this.listSkills(true).find(skill => String(skill.skill_id) === id || String(skill.slug) === id)
    if (!item) throw new Error('Skill 不存在')
    const cleanName = String(name || '').trim(); if (!cleanName) throw new Error('Skill 名称不能为空')
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || String(item.slug)
    return this.saveSkill(slug, this.skillContent(String(item.skill_id)) || '', String(item.version || '1.0.0'), String(item.description || ''), cleanName, String(item.skill_id))
  }
  listSkills(includeDisabled = false) { return this.rows(`SELECT s.*,(SELECT COUNT(*) FROM skill_resources r WHERE r.skill_id=s.skill_id) resource_count FROM skills s ${includeDisabled ? '' : 'WHERE s.enabled=1'} ORDER BY s.built_in DESC,s.updated_at DESC`).map(row => ({ skill_id: row.skill_id, name: row.name, slug: row.slug, description: row.description, published_version_id: row.skill_id, version: row.version, enabled: bool(row.enabled), resource_count: Number(row.resource_count || 0), built_in: bool(row.built_in) })) }
  saveSkill(slug: string, content: string, version: string, description: string, name = slug, skillId?: string, builtIn = false) { const existing = skillId ? this.get('SELECT * FROM skills WHERE skill_id=?', [skillId]) : this.get('SELECT * FROM skills WHERE slug=?', [slug]); const id = String(existing?.skill_id || skillId || `skill_${randomUUID()}`); const timestamp = now(); const cleanName = String(name || slug).replace(/\s+/g, ' ').trim() || slug; const cleanDescription = String(description || '').replace(/\s+/g, ' ').trim() || `${cleanName} 的工作说明。`; const normalizedContent = normalizeSkillMarkdown(cleanName, cleanDescription, content); this.run(`INSERT INTO skills(skill_id,name,slug,description,content,version,enabled,built_in,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET name=excluded.name,slug=excluded.slug,description=excluded.description,content=excluded.content,version=excluded.version,enabled=1,updated_at=excluded.updated_at`, [id, cleanName, slug, cleanDescription, normalizedContent, version, builtIn ? 1 : 0, existing?.created_at || timestamp, timestamp]); return this.listSkills(true).find(item => item.skill_id === id)! }
  setSkillEnabled(id: string, enabled: boolean) { const row = this.get('SELECT skill_id FROM skills WHERE skill_id=? OR slug=?', [id, id]); if (!row) throw new Error('Skill 不存在'); this.run('UPDATE skills SET enabled=?,updated_at=? WHERE skill_id=?', [enabled ? 1 : 0, now(), row.skill_id]); return this.listSkills(true).find(item => item.skill_id === row.skill_id)! }
  skillResources(id: string) { const row = this.get('SELECT skill_id FROM skills WHERE skill_id=? OR slug=?', [id, id]); return row ? this.rows('SELECT path,content FROM skill_resources WHERE skill_id=? ORDER BY path', [row.skill_id]).map(item => ({ path: String(item.path), content: String(item.content) })) : [] }
  saveSkillResources(id: string, resources: Array<{ path: string; content: string }>) { this.run('DELETE FROM skill_resources WHERE skill_id=?', [id]); for (const resource of resources.slice(0, 64)) { const path = String(resource.path || '').replaceAll('\\', '/').replace(/^\/+/, ''); const content = String(resource.content || ''); if (!path || path.includes('..') || content.length > 512 * 1024) continue; this.run('INSERT INTO skill_resources(skill_id,path,content,updated_at) VALUES(?,?,?,?)', [id, path, content, now()]) } }
  deleteSkill(id: string) { const row = this.get('SELECT skill_id FROM skills WHERE skill_id=? OR slug=?', [id, id]); if (!row) return { deleted: false }; if (this.isBuiltinSkill(String(row.skill_id))) throw new Error('内置 Skill 不能删除'); this.run('DELETE FROM skills WHERE skill_id=?', [row.skill_id]); return { deleted: true } }
  skillContent(id: string) { return this.get('SELECT content FROM skills WHERE skill_id=? OR slug=?', [id, id])?.content as string | undefined }
  boundSkillContent(agentId: string, id: string) { const row = this.get('SELECT s.skill_id,s.name,s.slug,s.description,s.content FROM skills s JOIN agent_skills a ON a.skill_id=s.skill_id WHERE a.agent_id=? AND (s.skill_id=? OR s.slug=?) AND s.enabled=1', [agentId, id, id]); if (!row || !validSkillPackage(String(row.name || ''), String(row.description || ''), String(row.content || ''))) return undefined; return { name: String(row.name), slug: String(row.slug), content: String(row.content), resources: this.skillResources(String(row.skill_id)) } }
  boundSkills(agentId: string, allowedSkillIds?: string[]) {
    const allowed = allowedSkillIds === undefined ? undefined : [...new Set(allowedSkillIds.map(String).filter(Boolean))]
    if (allowed && !allowed.length) return []
    const scoped = allowed ? ` AND s.skill_id IN (${allowed.map(() => '?').join(',')})` : ''
    return this.rows(`SELECT s.skill_id,s.name,s.slug,s.description,s.version,s.content FROM skills s JOIN agent_skills a ON a.skill_id=s.skill_id WHERE a.agent_id=? AND s.enabled=1${scoped} ORDER BY a.position`, [agentId, ...(allowed || [])]).map(row => ({ skill_id: String(row.skill_id), name: String(row.name), slug: String(row.slug), description: String(row.description || ''), version: String(row.version), content: String(row.content || '') }))
  }

  listMcp() { return this.rows(`SELECT m.*,(SELECT COUNT(*) FROM agent_mcp_connections a WHERE a.connection_id=m.connection_id) AS binding_count FROM mcp_connections m ORDER BY updated_at DESC`).map(row => { const credentials = json<JsonObject>(row.credentials_json, {}); return { credential_id: row.connection_id, connection_id: row.connection_id, name: row.name, url: row.url_or_command, transport: row.transport, description: row.description, credential_type: 'inline', enabled: bool(row.enabled), has_credentials: Object.keys(objectValue(credentials.headers)).length > 0 || Object.keys(objectValue(credentials.env)).length > 0, header_names: Object.keys(objectValue(credentials.headers)), env_names: Object.keys(objectValue(credentials.env)), args: Array.isArray(credentials.args) ? credentials.args : [], binding_count: Number(row.binding_count || 0) } }) }
  saveMcp(body: JsonObject, connectionId?: string) {
    for (const [group, pattern] of [['headers', /authorization|token|api[-_]?key|secret|cookie/i], ['env', /token|key|secret|password|credential/i]] as const) {
      for (const [key, value] of Object.entries(objectValue(body[group]))) if (pattern.test(key) && typeof value === 'string' && value && !value.startsWith('secret://')) throw new Error(`MCP ${group}.${key} 必须先写入系统安全存储`)
    }
    const existing = connectionId ? this.get('SELECT * FROM mcp_connections WHERE connection_id=?', [connectionId]) : this.get('SELECT * FROM mcp_connections WHERE name=?', [body.name])
    const id = String(existing?.connection_id || connectionId || `mcp_${randomUUID()}`); const timestamp = now(); const previous = json<JsonObject>(existing?.credentials_json, {})
    const mergeGroup = (name: 'headers' | 'env') => {
      if (!(name in body)) return objectValue(previous[name])
      const incoming = objectValue(body[name]); const prior = objectValue(previous[name])
      return Object.fromEntries(Object.entries(incoming).map(([key, value]) => [key, value === '' && typeof prior[key] === 'string' && String(prior[key]).startsWith('secret://') ? prior[key] : value]))
    }
    const credentials = { headers: mergeGroup('headers'), env: mergeGroup('env'), args: Array.isArray(body.args) ? body.args.map(String) : Array.isArray(previous.args) ? previous.args : [] }
    this.run(`INSERT INTO mcp_connections(connection_id,name,transport,url_or_command,credentials_json,description,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET name=excluded.name,transport=excluded.transport,url_or_command=excluded.url_or_command,credentials_json=excluded.credentials_json,description=excluded.description,enabled=excluded.enabled,updated_at=excluded.updated_at`, [id, String(body.name || existing?.name || id), String(body.transport || existing?.transport || 'http'), String(body.url || body.command || body.url_or_command || existing?.url_or_command || ''), JSON.stringify(credentials), String(body.description ?? existing?.description ?? ''), body.enabled === false ? 0 : 1, existing?.created_at || timestamp, timestamp]); return this.listMcp().find(item => item.connection_id === id)!
  }
  deleteMcp(id: string) { const existing = this.get('SELECT connection_id FROM mcp_connections WHERE connection_id=?', [id]); if (!existing) return { deleted: false }; this.run('DELETE FROM mcp_connections WHERE connection_id=?', [id]); return { deleted: true } }
  mcpConnection(id: string) { const row = this.get('SELECT * FROM mcp_connections WHERE connection_id=?', [id]); return row ? { ...row, connection_id: String(row.connection_id), name: String(row.name), transport: String(row.transport), url_or_command: String(row.url_or_command), credentials: json<JsonObject>(row.credentials_json, {}), allowlist: [] as string[] } : undefined }
  mcpForAgent(agentId: string) { return this.rows(`SELECT m.*,a.tool_allowlist_json FROM mcp_connections m JOIN agent_mcp_connections a ON a.connection_id=m.connection_id WHERE a.agent_id=? AND m.enabled=1`, [agentId]).map(row => ({ ...row, credentials: json<JsonObject>(row.credentials_json, {}), allowlist: json<string[]>(row.tool_allowlist_json, []) })) }

  toolsForAgent(agentId: string): ToolDefinition[] { return this.rows(`SELECT t.* FROM tool_definitions t JOIN agent_tools a ON a.tool_name=t.name WHERE a.agent_id=? AND a.enabled=1 AND t.enabled=1 ORDER BY t.name`, [agentId]).map(row => ({ name: String(row.name), description: String(row.description), inputSchema: json<JsonObject>(row.input_schema_json, {}), source: 'builtin', handlerKey: String(row.handler_key || ''), timeoutMs: Number(row.timeout_ms || 30000) })) }

  createThread(agentId: string, metadata: JsonObject) { const id = `thread_${randomUUID()}`; const timestamp = now(); this.run('INSERT INTO threads(thread_id,agent_id,title,metadata_json,active_run_id,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)', [id, agentId, String(metadata.title || metadata.display_name || '新会话'), JSON.stringify(metadata), timestamp, timestamp]); return { thread_id: id } }
  threadRunStatus(threadId: string) {
    const row = this.get('SELECT t.thread_id,t.active_run_id,r.subscription_id,r.status FROM threads t LEFT JOIN runs r ON r.run_id=t.active_run_id WHERE t.thread_id=?', [threadId])
    return row ? { thread_id: String(row.thread_id), active_run_id: row.active_run_id ? String(row.active_run_id) : undefined, subscription_id: row.subscription_id ? String(row.subscription_id) : undefined, status: row.status ? String(row.status) : undefined } : undefined
  }
  activeRunForProject(projectId: string) {
    const target = String(projectId || '').trim()
    if (!target) return undefined
    for (const row of this.rows("SELECT t.thread_id,t.metadata_json,r.run_id FROM threads t JOIN runs r ON r.run_id=t.active_run_id WHERE r.status='running'")) {
      if (String(json<JsonObject>(row.metadata_json, {}).project_id || '') === target) return { thread_id: String(row.thread_id), run_id: String(row.run_id) }
    }
    return undefined
  }
  runStatus(runId: string): RunStatus | undefined {
    const value = this.get('SELECT status FROM runs WHERE run_id=?', [runId])?.status
    return isRunStatus(value) ? value : undefined
  }
  getThread(id: string) { return this.get('SELECT * FROM threads WHERE thread_id=?', [id]) }
  threadMetadata(id: string) { return json<JsonObject>(this.get('SELECT metadata_json FROM threads WHERE thread_id=?', [id])?.metadata_json, {}) }
  updateThreadSkillScope(id: string, allowedSkillIds: string[]) {
    const row = this.get('SELECT metadata_json FROM threads WHERE thread_id=?', [id]); if (!row) return false
    const metadata = json<JsonObject>(row.metadata_json, {})
    metadata.allowed_skill_ids = [...new Set(allowedSkillIds.map(String).filter(Boolean))]
    this.run('UPDATE threads SET metadata_json=?,updated_at=? WHERE thread_id=?', [JSON.stringify(metadata), now(), id])
    return true
  }
  claimAutomaticTitle(id: string, title: string) {
    const row = this.get('SELECT metadata_json FROM threads WHERE thread_id=?', [id]); if (!row) return false
    const metadata = json<JsonObject>(row.metadata_json, {})
    if (metadata.automatic_title_generated === true) return false
    metadata.automatic_title_generated = true
    this.run('UPDATE threads SET title=?,metadata_json=?,updated_at=? WHERE thread_id=?', [title, JSON.stringify(metadata), now(), id])
    return true
  }
  beginRun(runId: string, threadId: string, agentId: string, subscriptionId: string) {
    const timestamp = now()
    // Acquiring the active-run lock and creating its durable row is one state
    // transition.  If insertion fails (duplicate ID, stale agent, disk error)
    // the thread must not be left permanently locked by a half transition.
    this.db.run('BEGIN')
    try {
      const thread = this.get('SELECT agent_id,active_run_id FROM threads WHERE thread_id=?', [threadId])
      if (!thread) throw new Error('会话不存在')
      if (String(thread.agent_id) !== agentId) throw new Error('会话 Agent 与运行 Agent 不一致')
      if (thread.active_run_id) throw new Error('当前会话仍有运行中的任务')
      this.db.run('UPDATE threads SET active_run_id=?,updated_at=? WHERE thread_id=? AND active_run_id IS NULL', [runId, timestamp, threadId])
      if (this.db.getRowsModified() !== 1) throw new Error('当前会话仍有运行中的任务')
      this.db.run('INSERT INTO runs(run_id,thread_id,agent_id,status,subscription_id,started_at,updated_at) VALUES(?,?,?,?,?,?,?)', [runId, threadId, agentId, 'running', subscriptionId, timestamp, timestamp])
      this.db.run('COMMIT')
      this.scheduleFlush()
    } catch (error) {
      try { this.db.run('ROLLBACK') } catch { /* transaction may already be closed */ }
      throw error
    }
  }
  registerToolCalls(runId: string, threadId: string, calls: ToolCall[], sideEffect: (call: ToolCall) => boolean) {
    const timestamp = now()
    for (const call of calls) this.run(`INSERT OR IGNORE INTO run_tool_calls(run_id,thread_id,tool_call_id,tool_name,arguments_json,side_effect,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, [runId, threadId, call.id, call.name, JSON.stringify(call.arguments), sideEffect(call) ? 1 : 0, 'pending', timestamp, timestamp])
  }
  // Claiming is deliberately conditional.  A provider can occasionally
  // repeat a tool_call_id after a stream retry; executing it twice would turn
  // a harmless transport duplicate into a duplicated canvas mutation.
  beginToolCall(runId: string, toolCallId: string) {
    this.run("UPDATE run_tool_calls SET status='running',updated_at=? WHERE run_id=? AND tool_call_id=? AND status='pending'", [now(), runId, toolCallId])
    return this.db.getRowsModified() === 1
  }
  completeToolCall(runId: string, toolCallId: string, status: 'succeeded' | 'failed' | 'interrupted' | 'uncertain', result: unknown, error?: unknown) {
    const timestamp = now()
    // The first terminal result is authoritative.  In particular a late
    // cancellation must not turn a successful side-effect into "uncertain",
    // and a late IPC error must not overwrite a persisted success.
    this.run("UPDATE run_tool_calls SET status=?,result_json=?,error_json=?,updated_at=?,completed_at=? WHERE run_id=? AND tool_call_id=? AND status IN ('pending','running')", [status, JSON.stringify(redact(result)), error === undefined ? null : JSON.stringify(redact(error)), timestamp, timestamp, runId, toolCallId])
    return this.db.getRowsModified() === 1
  }
  toolCallResult(runId: string, toolCallId: string) { return this.get('SELECT tool_name,side_effect,status,result_json,error_json FROM run_tool_calls WHERE run_id=? AND tool_call_id=?', [runId, toolCallId]) }
  // Context summarization is allowed to remove an entire historical tool
  // exchange, never just one side of it. If the requested suffix begins at a
  // tool result, pull its owning assistant tool-call batch into the suffix as
  // well. This can retain a few extra messages, but preserves the provider's
  // strict assistant(tool_calls) -> tool(result) transcript contract.
  retainContextSuffix(messages: RuntimeMessage[], keep: number) {
    let start = Math.max(0, messages.length - Math.max(1, keep))
    while (start > 0 && messages[start]?.role === 'tool') {
      const toolCallId = messages[start].toolCallId
      let owner = -1
      if (toolCallId) {
        for (let index = start - 1; index >= 0; index -= 1) {
          const candidate = messages[index]
          if (candidate.role === 'assistant' && candidate.toolCalls?.some(call => call.id === toolCallId)) { owner = index; break }
        }
      }
      // An unmatched result can only come from an already-corrupted legacy
      // checkpoint. It cannot be made valid because its assistant call no
      // longer exists; skip it once, while new checkpoints never take this
      // branch thanks to the owner alignment above.
      if (owner < 0) { start += 1; continue }
      start = owner
    }
    return messages.slice(start)
  }
  // SQLite is the truth source.  Before every provider call compile a legal
  // transcript: one assistant tool-call batch, followed immediately by one
  // result per id.  It also repairs older checkpoints that had warnings
  // inserted between the assistant call and its result.
  reconcileToolMessages(runId: string, messages: RuntimeMessage[], interruptedContent: string) {
    const output: RuntimeMessage[] = []
    for (let index = 0; index < messages.length; index += 1) {
      const assistant = messages[index]
      // This is a legacy-corruption guard. New context compression keeps the
      // entire assistant/tool batch via retainContextSuffix above, so this
      // branch only repairs checkpoints written by older builds.
      if (assistant.role === 'tool') continue
      output.push(assistant)
      if (assistant.role !== 'assistant' || !assistant.toolCalls?.length) continue
      const remaining = new Set(assistant.toolCalls.map(call => call.id)); const found = new Map<string, RuntimeMessage>(); const deferred: RuntimeMessage[] = []
      let cursor = index + 1
      while (cursor < messages.length && remaining.size) {
        const candidate = messages[cursor]
        if (candidate.role === 'tool' && candidate.toolCallId && remaining.has(candidate.toolCallId)) { found.set(candidate.toolCallId, candidate); remaining.delete(candidate.toolCallId); cursor += 1; continue }
        // An unmatched tool result is stale/orphaned. Do not defer it: doing
        // so would again create an invalid provider transcript.
        if (candidate.role === 'tool') { cursor += 1; continue }
        if (candidate.role === 'assistant') break
        deferred.push(candidate); cursor += 1
      }
      for (const call of assistant.toolCalls) {
        const existing = found.get(call.id); if (existing) { output.push(existing); continue }
        let row = this.toolCallResult(runId, call.id)
        if (row && ['pending', 'running'].includes(String(row.status))) {
          this.completeToolCall(runId, call.id, bool(row.side_effect) ? 'uncertain' : 'interrupted', { content: interruptedContent }, { reason: 'transcript_reconciliation' })
          row = this.toolCallResult(runId, call.id)
        }
        const result = json<JsonObject>(row?.result_json, {})
        output.push({ role: 'tool', name: String(row?.tool_name || call.name), toolCallId: call.id, content: String(result.content || interruptedContent) })
      }
      output.push(...deferred); index = cursor - 1
    }
    return output
  }
  interruptOrphanedActiveRun(threadId: string) {
    const thread = this.getThread(threadId)
    const runId = String(thread?.active_run_id || '')
    if (!runId) return false
    const run = this.get('SELECT status FROM runs WHERE run_id=?', [runId])
    if (!run || String(run.status) !== 'running') {
      this.run('UPDATE threads SET active_run_id=NULL,updated_at=? WHERE thread_id=?', [now(), threadId])
      return true
    }
    // The Runtime has no in-memory controller for this run. It therefore
    // cannot still be doing useful work and must not block a new user turn.
    this.finishRun(runId, 'interrupted', { reason: 'orphaned_runtime_run' })
    return true
  }
  finishRun(runId: string, status: string, error?: unknown) {
    if (!isTerminalRunStatus(status)) throw new Error(`Invalid terminal run status: ${status}`)
    const current = this.runStatus(runId)
    if (!current || !canTransitionRun(current, status)) return false
    const timestamp = now()
    // A late failure/cancel event must never rewrite a completed run (or the
    // inverse). The first terminal transition wins and clears the active run.
    this.run('UPDATE runs SET status=?,error_json=?,updated_at=?,completed_at=? WHERE run_id=? AND status=?', [status, error ? JSON.stringify(error) : null, timestamp, timestamp, runId, current])
    if (this.db.getRowsModified() !== 1) return false
    const run = this.get('SELECT thread_id FROM runs WHERE run_id=?', [runId])
    if (run) this.run('UPDATE threads SET active_run_id=NULL,updated_at=? WHERE thread_id=? AND active_run_id=?', [timestamp, run.thread_id, runId])
    return true
  }
  saveRunConfigSnapshot(runId: string, snapshot: JsonObject) { this.run('INSERT OR REPLACE INTO run_config_snapshots(run_id,snapshot_json,created_at) VALUES(?,?,?)', [runId, JSON.stringify(snapshot), now()]) }
  runConfigSnapshot(runId: string) { const row = this.get('SELECT snapshot_json FROM run_config_snapshots WHERE run_id=?', [runId]); return row ? json<JsonObject>(row.snapshot_json, {}) : undefined }
  saveCheckpoint(state: RunCheckpoint) {
    this.db.run('BEGIN')
    try {
      this.db.run('DELETE FROM checkpoints WHERE thread_id=?', [state.threadId])
      this.db.run('INSERT INTO checkpoints(thread_id,run_id,step,state_json,created_at) VALUES(?,?,?,?,?)', [state.threadId, state.runId || null, state.step, JSON.stringify(state), now()])
      this.db.run('COMMIT')
      this.scheduleFlush()
    } catch (error) { this.db.run('ROLLBACK'); throw error }
  }
  latestCheckpoint(threadId: string): RunCheckpoint | undefined { const row = this.get('SELECT state_json FROM checkpoints WHERE thread_id=? ORDER BY checkpoint_id DESC LIMIT 1', [threadId]); return row ? json<RunCheckpoint>(row.state_json, undefined as never) : undefined }
  storeEvent(event: StructuredEvent) {
    // Keep this guard even though Runtime.emit already separates transport
    // from persistence. It prevents tests, migrations or future callers from
    // accidentally turning high-frequency stream frames back into SQL rows.
    if (event.type === 'agent.message.delta') return
    this.run('INSERT INTO run_events(event_id,thread_id,run_id,sequence,type,envelope_json,created_at) VALUES(?,?,?,?,?,?,?)', [event.event_id, event.thread_id, event.run_id, event.sequence, event.type, JSON.stringify(event), now()])
  }
  listEvents(threadId: string, runId?: string, afterSequence = 0, limit = 1000) { const values: unknown[] = [threadId]; let where = 'thread_id=?'; if (runId) { where += ' AND run_id=?'; values.push(runId) } where += ' AND sequence>?'; values.push(Math.max(0, afterSequence), Math.max(1, Math.min(limit, 5000))); return this.rows(`SELECT envelope_json FROM run_events WHERE ${where} ORDER BY run_id,sequence LIMIT ?`, values).map(row => json<StructuredEvent>(row.envelope_json, undefined as never)) }
  storeDebug(threadId: string, runId: string, category: string, payload: unknown) { this.run('INSERT INTO debug_events(thread_id,run_id,category,payload_json,created_at) VALUES(?,?,?,?,?)', [threadId, runId, category, JSON.stringify(redact(payload)), now()]) }
  listDebug(threadId?: string, runId?: string, limit = 500) { const clauses: string[] = []; const values: unknown[] = []; if (threadId) { clauses.push('thread_id=?'); values.push(threadId) } if (runId) { clauses.push('run_id=?'); values.push(runId) } values.push(Math.max(1, Math.min(limit, 2000))); return this.rows(`SELECT * FROM debug_events${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, values).map(row => ({ ...row, payload: json(row.payload_json, row.payload_json) })) }
  storeJournal(threadId: string, runId: string, loopIndex: number, phase: string, eventType: string, actor: string, payload: unknown, metadata: { correlationId?: string; parentCorrelationId?: string; status?: string; startedAt?: string; finishedAt?: string; durationMs?: number; inputTokens?: number; outputTokens?: number; errorCategory?: string } = {}) {
    const safePayload = compactJournalPayload(eventType, payload)
    this.run(`INSERT INTO run_journal(thread_id,run_id,loop_index,phase,event_type,actor,payload_json,correlation_id,parent_correlation_id,status,started_at,finished_at,duration_ms,input_tokens,output_tokens,error_category,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [threadId, runId, loopIndex, phase, eventType, actor, JSON.stringify(safePayload), metadata.correlationId || null, metadata.parentCorrelationId || null, metadata.status || null, metadata.startedAt || null, metadata.finishedAt || null, metadata.durationMs ?? null, metadata.inputTokens ?? null, metadata.outputTokens ?? null, metadata.errorCategory || null, now()])
  }
  listJournal(threadId?: string, runId?: string, limit = 1000) { const clauses: string[] = []; const values: unknown[] = []; if (threadId) { clauses.push('thread_id=?'); values.push(threadId) } if (runId) { clauses.push('run_id=?'); values.push(runId) } values.push(Math.max(1, Math.min(limit, 5000))); return this.rows(`SELECT * FROM run_journal${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id ASC LIMIT ?`, values).map(row => ({ ...row, payload: json(row.payload_json, row.payload_json) })) }
  runTrace(threadId?: string, runId?: string) {
    const items = this.listJournal(threadId, runId, 5000) as Array<JsonObject & { payload: unknown }>
    // Reconstruct semantic agent loops from the chronological journal. Older
    // builds used checkpoint.step as loop_index, which split a model call and
    // its tools across adjacent loops. A new before_model lifecycle starts the
    // next loop; retries stay in the current loop because they do not rerun it.
    const loops: Array<{ loop_index: number; model: JsonObject[]; middleware: JsonObject[]; tools: JsonObject[]; run: JsonObject[] }> = []
    let loop = { loop_index: 1, model: [] as JsonObject[], middleware: [] as JsonObject[], tools: [] as JsonObject[], run: [] as JsonObject[] }
    const hasModel = () => loop.model.some(item => String(item.event_type) === 'model.request' || String(item.event_type) === 'model.http.request')
    for (const item of items) {
      const phase = String(item.phase)
      const payload = objectValue(item.payload)
      const startsNextLoop = phase === 'middleware' && String(item.event_type) === 'middleware.started' && String(payload.hook) === 'before_model' && hasModel()
      if (startsNextLoop) { loops.push(loop); loop = { loop_index: loops.length + 1, model: [], middleware: [], tools: [], run: [] } }
      if (phase === 'model') loop.model.push(item)
      else if (phase === 'middleware') loop.middleware.push(item)
      else if (phase === 'tool') loop.tools.push(item)
      else loop.run.push(item)
    }
    if (loop.model.length || loop.middleware.length || loop.tools.length || loop.run.length) loops.push(loop)
    const resolvedRunId = runId || String(items[0]?.run_id || '')
    const run = resolvedRunId ? this.get('SELECT status,error_json FROM runs WHERE run_id=?', [resolvedRunId]) : undefined
    const failed = run?.status === 'failed' || run?.status === 'interrupted' ? [...items].reverse().find(item => item.status === 'failed' || item.status === 'interrupted' || String(item.event_type).endsWith('.error')) : undefined
    const runError = json<JsonObject>(run?.error_json, {})
    return { run_id: resolvedRunId || null, status: run?.status || null, failure: failed ? { phase: failed.phase, actor: failed.actor, event_type: failed.event_type, category: failed.error_category || objectValue(failed.payload).category || runError.category || null, message: objectValue(failed.payload).error || objectValue(failed.payload).message || runError.message || runError.reason || null, correlation_id: failed.correlation_id || null } : null, loops }
  }

  async importAttachment(sourcePath: string, originalName?: string) {
    const source = resolve(sourcePath); const info = await stat(source)
    if (!info.isFile()) throw new Error('Attachment source does not exist')
    const inspected = await inspectAttachment(source)
    const id = `attachment_${randomUUID()}`; const extension = extname(source).toLowerCase().slice(0, 16); const target = join(this.attachmentsDir, `${id}${extension}`)
    await copyFile(source, target)
    const displayName = String(originalName || source.split(sep).at(-1) || id)
    this.run('INSERT INTO attachments(attachment_id,original_name,local_path,mime_type,size,text_content,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)', [id, displayName, target, inspected.mimeType, info.size, inspected.textContent || null, inspected.sha256, now()])
    return { attachment_id: id, name: displayName, size: info.size, mime_type: inspected.mimeType, ...(inspected.dimensions || {}) }
  }
  private nextGeneratedImageName(requestedName: string) {
    const raw = basename(requestedName || '画布截图').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 100) || '画布截图'
    const suppliedExtension = extname(raw).toLowerCase()
    const extension = suppliedExtension === '.png' ? '.png' : '.png'
    const stem = (suppliedExtension ? raw.slice(0, -suppliedExtension.length) : raw).trim() || '画布截图'
    let candidate = `${stem}${extension}`; let copy = 2
    while (this.get('SELECT attachment_id FROM attachments WHERE lower(original_name)=lower(?) LIMIT 1', [candidate])) candidate = `${stem} (${copy++})${extension}`
    return candidate
  }
  async importGeneratedImage(base64: string, requestedName?: string) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) throw new Error('画布截图数据无效')
    const data = Buffer.from(base64, 'base64')
    if (!data.length || data.byteLength > 8 * 1024 * 1024) throw new Error('画布截图无效或过大，请缩小截图范围后重试')
    const dimensions = imageDimensions(data, 'image/png')
    if (dimensions.width * dimensions.height > 40_000_000) throw new Error('画布截图像素过大，请缩小截图范围后重试')
    const id = `attachment_${randomUUID()}`; const target = join(this.attachmentsDir, `${id}.png`); const name = this.nextGeneratedImageName(String(requestedName || '画布截图'))
    await writeFile(target, data)
    try {
      this.run('INSERT INTO attachments(attachment_id,original_name,local_path,mime_type,size,text_content,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)', [id, name, target, 'image/png', data.byteLength, null, digest(data), now()])
    } catch (error) { await unlink(target).catch(() => undefined); throw error }
    return { attachment_id: id, name, size: data.byteLength, mime_type: 'image/png', ...dimensions, generated: true }
  }
  async importGeneratedFile(base64: string, requestedName: string, mimeType: string) {
    if (mimeType !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation') throw new Error('不支持的生成文件类型')
    const data = Buffer.from(base64, 'base64')
    if (!data.byteLength || data.byteLength > 40 * 1024 * 1024) throw new Error('生成的 PPT 文件无效或过大')
    const id = `attachment_${randomUUID()}`
    const requested = String(requestedName || 'TuGo 演示稿.pptx').trim()
    const stem = basename(requested, extname(requested)) || 'TuGo 演示稿'
    let name = `${stem}.pptx`; let copy = 2
    while (this.get('SELECT attachment_id FROM attachments WHERE lower(original_name)=lower(?) LIMIT 1', [name])) name = `${stem} (${copy++}).pptx`
    const target = join(this.attachmentsDir, `${id}.pptx`)
    await writeFile(target, data)
    this.run('INSERT INTO attachments(attachment_id,original_name,local_path,mime_type,size,text_content,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)', [id, name, target, mimeType, data.byteLength, null, digest(data), now()])
    return { attachment_id: id, name, mime_type: mimeType, size: data.byteLength }
  }
  async attachmentDataUrl(id: string) {
    const row = this.get('SELECT original_name,mime_type,size FROM attachments WHERE attachment_id=?', [id]); const path = this.attachmentPath(id)
    if (!row || !path) throw new Error('Attachment not found')
    if (Number(row.size || 0) > 40 * 1024 * 1024) throw new Error('文件过大，无法下载')
    const data = await readFile(path)
    return { attachment_id: id, name: String(row.original_name), mime_type: String(row.mime_type), data_url: `data:${String(row.mime_type)};base64,${data.toString('base64')}` }
  }
  bindAttachment(threadId: string, runId: string, id: string, role: 'user' | 'tool' = 'user') {
    if (!this.get('SELECT attachment_id FROM attachments WHERE attachment_id=?', [id])) throw new Error(`Attachment not found: ${id}`)
    this.run('INSERT OR IGNORE INTO attachment_references(attachment_id,thread_id,run_id,message_role,created_at) VALUES(?,?,?,?,?)', [id, threadId, runId, role, now()])
  }
  bindAttachments(threadId: string, runId: string, ids: string[]) {
    for (const id of [...new Set(ids)].slice(0, 8)) this.bindAttachment(threadId, runId, id, 'user')
  }
  attachmentReferences(threadId: string) { return this.rows('SELECT attachment_id,thread_id,run_id,message_role,created_at FROM attachment_references WHERE thread_id=? ORDER BY created_at', [threadId]) }
  async modelAttachments(ids: string[], messageIndex?: number) {
    const result: Array<{ attachmentId: string; name: string; mimeType: string; dataBase64: string; messageIndex?: number }> = []
    for (const id of [...new Set(ids)].slice(-8)) {
      const row = this.get('SELECT original_name,local_path,size,mime_type FROM attachments WHERE attachment_id=?', [id])
      if (!row || Number(row.size || 0) > 20 * 1024 * 1024) continue
      const path = this.attachmentPath(id); if (!path) continue
      const data = await readFile(path); const mimeType = String(row.mime_type || '')
      if (isRasterImage(mimeType)) result.push({ attachmentId: id, name: String(row.original_name || id), mimeType, dataBase64: data.toString('base64'), ...(messageIndex === undefined ? {} : { messageIndex }) })
    }
    return result
  }
  readAttachmentText(id: string) {
    const row = this.get('SELECT original_name,mime_type,text_content FROM attachments WHERE attachment_id=?', [id])
    if (!row) throw new Error('Attachment not found')
    if (typeof row.text_content !== 'string') throw new Error(`附件 ${String(row.original_name)} 是二进制类型，不能作为文本读取`)
    return { attachment_id: id, name: String(row.original_name), mime_type: String(row.mime_type), content: String(row.text_content) }
  }
  async inspectImage(id: string) {
    const row = this.get('SELECT original_name,mime_type,size FROM attachments WHERE attachment_id=?', [id]); const path = this.attachmentPath(id)
    if (!row || !path || !isRasterImage(String(row.mime_type))) throw new Error('Image attachment not found')
    const data = await readFile(path); const dimensions = imageDimensions(data, String(row.mime_type))
    return { attachment_id: id, name: String(row.original_name), mime_type: String(row.mime_type), size: Number(row.size), ...dimensions, visual_input_available: true }
  }
  async imageDataUrl(id: string) {
    const row = this.get('SELECT original_name,mime_type,size FROM attachments WHERE attachment_id=?', [id]); const path = this.attachmentPath(id)
    if (!row || !path || !isRasterImage(String(row.mime_type))) throw new Error('Image attachment not found')
    if (Number(row.size || 0) > 20 * 1024 * 1024) throw new Error('图片过大，无法载入画布')
    const data = await readFile(path)
    return { attachment_id: id, name: String(row.original_name), mime_type: String(row.mime_type), data_url: `data:${String(row.mime_type)};base64,${data.toString('base64')}` }
  }
  async deleteAttachment(id: string) {
    const row = this.get('SELECT local_path FROM attachments WHERE attachment_id=?', [id])
    if (!row) return { deleted: false }
    const references = Number(this.get('SELECT COUNT(*) AS count FROM attachment_references WHERE attachment_id=?', [id])?.count || 0)
    if (references) throw new Error('附件已被会话引用，不能删除')
    const path = this.attachmentPath(id); this.run('DELETE FROM attachments WHERE attachment_id=?', [id])
    if (path) await unlink(path).catch(() => undefined)
    return { deleted: true }
  }
  async cleanupOrphanAttachments(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    const rows = this.rows('SELECT attachment_id FROM attachments WHERE created_at<? AND attachment_id NOT IN (SELECT attachment_id FROM attachment_references)', [cutoff])
    for (const row of rows) await this.deleteAttachment(String(row.attachment_id))
    return rows.length
  }
  attachmentPath(id: string) { const value = this.get('SELECT local_path FROM attachments WHERE attachment_id=?', [id])?.local_path; if (!value) return; const path = resolve(String(value)); return path.startsWith(resolve(this.attachmentsDir) + sep) ? path : undefined }
}
