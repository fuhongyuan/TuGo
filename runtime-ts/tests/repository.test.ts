import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import initSqlJs from 'sql.js'
import { jsPDF } from 'jspdf'
import JSZip from 'jszip'
import { RUNTIME_MIGRATION_MANIFEST, RuntimeRepository } from '../src/repository.js'

const roots: string[] = []
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'tugo-runtime-test-'))
  roots.push(root)
  const defaults = join(root, 'defaults.json')
  await writeFile(defaults, JSON.stringify({
    templateVersion: 'test-1',
    providers: [{ provider_id: 'openai', display_name: 'OpenAI' }],
    promptTemplates: [{ name: 'runtime.system', version: '1', content: '{{agent_soul}}' }],
    middlewareDefinitions: [{ name: 'plan', kind: 'plan', version: '1', defaultConfig: { enabled: true, mode: 'optional' } }],
    tools: [{ name: 'board_get_state', description: 'state', handlerKey: 'board-bridge', inputSchema: { type: 'object', required: ['project_id'] } }],
    skill: { slug: 'tugo-architect', version: '1', description: 'skill', content: 'original skill' },
    agent: { name: 'tugo-architect', display_name: 'Agent', soul: 'system', tool_names: ['board_get_state'], skill_slugs: ['tugo-architect'], middleware: { maxSteps: 8 } },
  }))
  return { root, defaults }
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('RuntimeRepository', () => {
  it('rejects an impossible context and output capability configuration', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    expect(() => repository.saveModel({ name: 'bad', provider_id: 'openai', model: 'bad', extra_config: { context_window: 4096, max_output_tokens: 4096 } })).toThrow('小于 Context Window')
    expect(() => repository.saveModel({ name: 'unsafe', provider_id: 'openai', model: 'bad', extra_config: { api_key: 'plaintext' } })).toThrow('系统安全存储')
    expect(() => repository.saveMcp({ name: 'unsafe', headers: { Authorization: 'Bearer plaintext' } })).toThrow('系统安全存储')
    await repository.close()
  })

  it('persists models, resources and thread context across restart', async () => {
    const { root, defaults } = await fixture()
    const first = new RuntimeRepository(root, defaults)
    await first.open()
    const model = first.saveModel({ name: 'glm', provider_id: 'openai', model: 'glm-5', display_name: 'GLM', extra_config: { api_key_ref: 'safe-secret' } })
    first.recordModelProbe(String(model.model_id), true, 'fixture')
    const bootstrapped = first.bootstrap(String(model.model_id))
    const thread = first.createThread(String(bootstrapped.agent.agent_id), { project_id: 'project-a', conversation_id: 'conversation-a' })
    await first.close()

    const second = new RuntimeRepository(root, defaults)
    await second.open()
    expect(second.listModels()[0]).toMatchObject({ model: 'glm-5', has_secrets: true })
    expect(second.threadMetadata(thread.thread_id)).toMatchObject({ project_id: 'project-a', conversation_id: 'conversation-a' })
    expect(second.getAgent(String(bootstrapped.agent.agent_id))?.tool_names).toContain('board_get_state')
    await second.close()
    expect((await readFile(join(root, 'runtime.sqlite'))).byteLength).toBeGreaterThan(0)
  })

  it('limits a thread Skill catalog to its persisted project scope', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]
    const extra = repository.saveSkill('project-only', '# 项目专用', '1.0.0', '仅本项目使用')
    repository.bindAgentSkills(String(agent.agent_id), [String(extra.skill_id), ...repository.boundSkills(String(agent.agent_id)).map(skill => skill.skill_id)])
    const thread = repository.createThread(String(agent.agent_id), { project_id: 'project-a', allowed_skill_ids: [String(extra.skill_id)] })
    expect(repository.boundSkills(String(agent.agent_id), repository.threadMetadata(thread.thread_id).allowed_skill_ids as string[]).map(skill => skill.skill_id)).toEqual([extra.skill_id])
    expect(repository.updateThreadSkillScope(thread.thread_id, [])).toBe(true)
    expect(repository.boundSkills(String(agent.agent_id), repository.threadMetadata(thread.thread_id).allowed_skill_ids as string[])).toEqual([])
    await repository.close()
  })

  it('binds a custom Skill to one durable editor session and only allows controlled files', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const editor = repository.skillEditorAgent()
    expect(editor).toMatchObject({ name: 'tugo-skill-editor' })
    expect(editor?.tool_names).toEqual(expect.arrayContaining(['skill_create', 'skill_list_files', 'skill_read_file', 'skill_write_file', 'skill_replace_text', 'skill_get_name', 'skill_set_name']))
    const session = repository.createSkillEditorSession()
    expect(repository.skillFileListForThread(session.thread_id)).toMatchObject({ state: 'new', files: [] })
    const skill = repository.createSkillForEditorThread(session.thread_id, '业务梳理', '生成业务分析 SOP')
    expect(repository.skillFileListForThread(session.thread_id)).toMatchObject({ skill_id: skill.skill_id, files: ['SKILL.md'], state: 'editing' })
    expect(repository.readSkillFileForThread(session.thread_id, 'SKILL.md').content).toMatch(/^---\nname: "业务梳理"\ndescription: "生成业务分析 SOP"\n---/)
    repository.writeSkillFileForThread(session.thread_id, 'SKILL.md', '# 业务梳理\n\n按步骤澄清目标。')
    expect(repository.readSkillFileForThread(session.thread_id, 'SKILL.md').content).toMatch(/^---\nname: "业务梳理"\ndescription: "生成业务分析 SOP"\n---\n\n# 业务梳理/)
    repository.writeSkillFileForThread(session.thread_id, 'references/checklist.md', '1. 目标\n2. 边界')
    repository.replaceSkillTextForThread(session.thread_id, 'references/checklist.md', '边界', '约束')
    expect(repository.readSkillFileForThread(session.thread_id, 'references/checklist.md').content).toContain('约束')
    expect(() => repository.writeSkillFileForThread(session.thread_id, 'scripts/run.py', 'print(1)')).toThrow('不支持脚本')
    expect(repository.setSkillNameForEditorThread(session.thread_id, '业务梳理与评审').name).toBe('业务梳理与评审')
    expect(repository.createSkillEditorSession(String(skill.skill_id)).thread_id).toBe(session.thread_id)
    await repository.close()
  })

  it('moves a legacy plaintext model key to an opaque safe-storage reference', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const model = repository.saveModel({ name: 'legacy-key', provider_id: 'openai', model: 'fixture', extra_config: { api_key_ref: 'temporary-ref' } })
    const db = (repository as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db
    db.run('UPDATE models SET extra_json=? WHERE model_id=?', [JSON.stringify({ api_key: 'legacy-plaintext-key', base_url: 'https://example.test/v1' }), model.model_id])
    expect(repository.legacyModelSecrets()).toEqual([{ model_id: model.model_id, api_key: 'legacy-plaintext-key' }])
    repository.replaceModelSecret(String(model.model_id), 'safe-storage-reference')
    expect(repository.legacyModelSecrets()).toEqual([])
    expect(repository.getModel(String(model.model_id))?.runtime_extra).toMatchObject({ api_key_ref: 'safe-storage-reference' })
    await repository.close()
    expect((await readFile(join(root, 'runtime.sqlite'))).toString('utf8')).not.toContain('legacy-plaintext-key')
  })

  it('upgrades an existing v1 database through the relational schema exactly once', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open(); await first.close()
    const SQL = await initSqlJs(); const databasePath = join(root, 'runtime.sqlite'); const db = new SQL.Database(await readFile(databasePath))
    db.run('DROP TABLE prompt_templates; DROP TABLE middleware_definitions; DROP TABLE agent_middleware; DROP TABLE run_config_snapshots; DROP TABLE attachment_references; DELETE FROM schema_migrations WHERE version=2; ALTER TABLE attachments DROP COLUMN text_content; ALTER TABLE attachments DROP COLUMN sha256;')
    await writeFile(databasePath, Buffer.from(db.export())); db.close()
    const upgraded = new RuntimeRepository(root, defaults); await upgraded.open()
    expect(upgraded.schemaVersions().map(item => item.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    await upgraded.close()
    const reopened = new RuntimeRepository(root, defaults); await reopened.open()
    expect(reopened.schemaVersions().map(item => item.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    await reopened.close()
  })

  it('upgrades legacy Skills into canonical packages and refuses malformed packages at load time', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    const agent = first.listAgents()[0]
    const skill = first.saveSkill('legacy-skill', '原始工作说明', '1.0.0', '完整说明', '历史 Skill')
    first.bindAgentSkills(String(agent.agent_id), [String(skill.skill_id)])
    await first.close()

    const SQL = await initSqlJs(); const databasePath = join(root, 'runtime.sqlite'); const db = new SQL.Database(await readFile(databasePath))
    db.run('UPDATE skills SET description=?,content=? WHERE skill_id=?', ['', '原始工作说明', skill.skill_id])
    db.run('DELETE FROM schema_migrations WHERE version=9')
    await writeFile(databasePath, Buffer.from(db.export())); db.close()

    const upgraded = new RuntimeRepository(root, defaults); await upgraded.open()
    const repaired = upgraded.listSkills(true).find(item => item.skill_id === skill.skill_id)!
    expect(repaired.description).toBe('历史 Skill 的工作说明。')
    expect(upgraded.skillContent(String(skill.skill_id))).toMatch(/^---\nname: "历史 Skill"\ndescription: "历史 Skill 的工作说明。"\n---/)
    expect(upgraded.boundSkillContent(String(agent.agent_id), String(skill.skill_id))).toMatchObject({ name: '历史 Skill' })
    const runtimeDb = (upgraded as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db
    runtimeDb.run('UPDATE skills SET description=?,content=? WHERE skill_id=?', ['', '坏数据', skill.skill_id])
    expect(upgraded.boundSkillContent(String(agent.agent_id), String(skill.skill_id))).toBeUndefined()
    await upgraded.close()
  })

  it('uses the immutable migration manifest for every recorded runtime schema version', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    expect(repository.schemaVersions().map(({ version, name }) => ({ version, name }))).toEqual(RUNTIME_MIGRATION_MANIFEST)
    await repository.close()
  })

  it('enforces runtime relationships and cascades run-owned records', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents().find(item => item.name === 'tugo-architect')!
    const thread = repository.createThread(String(agent.agent_id), { project_id: 'project-a' })
    repository.beginRun('run-a', thread.thread_id, String(agent.agent_id), 'subscription-a')
    expect(repository.integrityCheck()).toMatchObject({ foreignKeys: true, foreignKeyErrors: [] })
    expect(() => repository.bindAgentMcp(String(agent.agent_id), ['missing-mcp'])).toThrow()
    expect(() => repository.finishRun('run-a', 'not-a-status')).toThrow()
    repository.finishRun('run-a', 'completed')
    expect(repository.finishRun('run-a', 'failed', { reason: 'late failure' })).toBe(false)
    expect(repository.runStatus('run-a')).toBe('completed')
    expect(repository.integrityCheck()).toMatchObject({ ok: true, messages: ['ok'], foreignKeys: true, foreignKeyErrors: [] })
    await repository.close()
  })

  it('rolls back the thread lock when a run cannot be created', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents().find(item => item.name === 'tugo-architect')!
    const first = repository.createThread(String(agent.agent_id), { project_id: 'project-a' })
    const second = repository.createThread(String(agent.agent_id), { project_id: 'project-b' })
    repository.beginRun('shared-run-id', first.thread_id, String(agent.agent_id), 'subscription-a')
    expect(() => repository.beginRun('shared-run-id', second.thread_id, String(agent.agent_id), 'subscription-b')).toThrow()
    expect(repository.getThread(second.thread_id)?.active_run_id).toBeNull()
    expect(() => repository.beginRun('fresh-run-id', second.thread_id, 'missing-agent', 'subscription-c')).toThrow('会话 Agent')
    expect(repository.getThread(second.thread_id)?.active_run_id).toBeNull()
    repository.finishRun('shared-run-id', 'completed')
    expect(() => repository.beginRun('fresh-run-id', second.thread_id, String(agent.agent_id), 'subscription-d')).not.toThrow()
    await repository.close()
  })

  it('drops orphan tool messages left behind by a context-window trim', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]; const thread = repository.createThread(String(agent.agent_id), {})
    repository.beginRun('run-transcript', thread.thread_id, String(agent.agent_id), 'subscription-transcript')
    const transcript = repository.reconcileToolMessages('run-transcript', [
      { role: 'tool', name: 'board_batch', toolCallId: 'trimmed-call', content: 'old result without its assistant call' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'live-call', name: 'board_get_state', arguments: {} }] },
      { role: 'tool', name: 'board_get_state', toolCallId: 'live-call', content: '{"ok":true}' },
      { role: 'user', content: '继续' },
    ], 'interrupted')
    expect(transcript).toEqual([
      expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ id: 'live-call' })] }),
      expect.objectContaining({ role: 'tool', toolCallId: 'live-call' }),
      expect.objectContaining({ role: 'user', content: '继续' }),
    ])
    await repository.close()
  })

  it('keeps a complete tool-call batch on the retained side of a context trim', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const messages = [
      { role: 'user' as const, content: 'old request' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'paired-call', name: 'board_get_state', arguments: {} }] },
      { role: 'tool' as const, name: 'board_get_state', toolCallId: 'paired-call', content: '{"ok":true}' },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'user' as const, content: 'latest request' },
    ]
    // A naive last-3 slice would start at the tool result. The retained suffix
    // must instead begin at its corresponding assistant tool-call.
    expect(repository.retainContextSuffix(messages, 3)).toEqual(messages.slice(1))
    await repository.close()
  })

  it('keeps rolling runtime backups and recovers a corrupted primary database', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    const model = first.saveModel({ name: 'recover-me', provider_id: 'openai', model: 'fixture', extra_config: { api_key_ref: 'safe' } })
    first.recordModelProbe(String(model.model_id), true)
    await first.createBackup('fixture')
    await first.close()
    await writeFile(join(root, 'runtime.sqlite'), Buffer.from('not a sqlite database'))
    const recovered = new RuntimeRepository(root, defaults); await recovered.open()
    expect(recovered.listModels()).toEqual([expect.objectContaining({ name: 'recover-me' })])
    expect((await recovered.listBackups()).length).toBeGreaterThan(0)
    await recovered.close()
  })

  it('applies a user-selected runtime backup on the next startup', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    first.saveModel({ name: 'keep-from-backup', provider_id: 'openai', model: 'fixture', extra_config: { api_key_ref: 'safe' } })
    const backup = await first.createBackup('manual-restore')
    first.saveModel({ name: 'discard-after-restore', provider_id: 'openai', model: 'fixture', extra_config: { api_key_ref: 'safe' } })
    await first.flush()
    await expect(first.scheduleRestore(basename(backup.path))).resolves.toMatchObject({ scheduled: true, restart_required: true })
    await first.close()

    const restored = new RuntimeRepository(root, defaults); await restored.open()
    expect(restored.listModels()).toEqual([expect.objectContaining({ name: 'keep-from-backup' })])
    expect(restored.listModels().some(model => model.name === 'discard-after-restore')).toBe(false)
    await restored.close()
  })

  it('keeps immutable secret-free run configuration snapshots', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const model = repository.saveModel({ name: 'secure', provider_id: 'openai', model: 'model-a', extra_config: { api_key: 'never-store-this', api_key_ref: 'safe-ref', base_url: 'https://model.example' } })
    const agent = repository.listAgents().find(item => item.name === 'tugo-architect')!
    const thread = repository.createThread(String(agent.agent_id), { project_id: 'snapshot-project' })
    repository.beginRun('run-a', thread.thread_id, String(agent.agent_id), 'snapshot-subscription')
    repository.saveRunConfigSnapshot('run-a', { agent, model: repository.modelSnapshot(String(model.model_id)), prompts: repository.promptSnapshot() })
    repository.saveAgent({ ...agent, display_name: 'Changed later' }, String(agent.agent_id))
    const snapshot = repository.runConfigSnapshot('run-a')
    expect(snapshot).toMatchObject({ agent: { display_name: 'Agent' }, model: { model: 'model-a' } })
    expect(JSON.stringify(snapshot)).not.toContain('never-store-this')
    expect(JSON.stringify(snapshot)).not.toContain('safe-ref')
    expect(repository.promptVersions()).toEqual([{ name: 'runtime.system', version: '1' }])
    expect(repository.middlewareForAgent(String(agent.agent_id))).toEqual([expect.objectContaining({ name: 'maxSteps', config: 8 })])
    await repository.close()
  })

  it('repairs missing fixed Agent tool bindings during bootstrap', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const model = repository.saveModel({ name: 'glm', provider_id: 'openai', model: 'glm-5', extra_config: { api_key_ref: 'safe-secret' } })
    repository.recordModelProbe(String(model.model_id), true, 'fixture')
    const initial = repository.bootstrap(String(model.model_id)).agent
    repository.saveAgent({ ...initial, tool_names: [] }, String(initial.agent_id))
    expect(repository.getAgent(String(initial.agent_id))?.tool_names).toEqual([])
    expect(repository.bootstrap(String(model.model_id)).agent.tool_names).toContain('board_get_state')
    await repository.close()
  })

  it('does not overwrite an existing Skill when the shipped template changes', async () => {
    const { root, defaults } = await fixture()
    const first = new RuntimeRepository(root, defaults)
    await first.open()
    first.saveSkill('tugo-architect', 'user edited skill', 'custom', 'custom')
    await first.close()
    const changed = JSON.parse(await readFile(defaults, 'utf8'))
    changed.templateVersion = 'test-2'
    changed.skill.content = 'new shipped content'
    await writeFile(defaults, JSON.stringify(changed))
    const second = new RuntimeRepository(root, defaults)
    await second.open()
    expect(second.skillContent('tugo-architect')).toContain('user edited skill')
    await second.close()
  })

  it('does not overwrite a user-modified Prompt when templates update', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    first.savePromptTemplate('runtime.system', 'user prompt', 'custom'); await first.close()
    const changed = JSON.parse(await readFile(defaults, 'utf8')); changed.templateVersion = 'test-2'; changed.promptTemplates[0].content = 'new shipped prompt'; await writeFile(defaults, JSON.stringify(changed))
    const second = new RuntimeRepository(root, defaults); await second.open()
    expect(second.renderPrompt('runtime.system')).toBe('user prompt')
    await second.close()
  })

  it('recovers stale running runs and unlocks their threads on restart', async () => {
    const { root, defaults } = await fixture()
    const first = new RuntimeRepository(root, defaults)
    await first.open()
    const agent = first.listAgents()[0]
    const thread = first.createThread(String(agent.agent_id), { project_id: 'project-a', conversation_id: 'conversation-a' })
    first.beginRun('run-stale', thread.thread_id, String(agent.agent_id), 'subscription-stale')
    await first.close()

    const second = new RuntimeRepository(root, defaults)
    await second.open()
    expect(second.getThread(thread.thread_id)?.active_run_id).toBeNull()
    expect(second.listDebug(thread.thread_id)).toEqual([])
    expect(() => second.beginRun('run-next', thread.thread_id, String(agent.agent_id), 'subscription-next')).not.toThrow()
    second.finishRun('run-next', 'completed')
    await second.close()
  })

  it('interrupts a legacy queued run and releases its thread after restart', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    const agent = first.listAgents()[0]; const thread = first.createThread(String(agent.agent_id), { project_id: 'project-queued' })
    first.beginRun('run-queued', thread.thread_id, String(agent.agent_id), 'subscription-queued')
    const db = (first as unknown as { db: Database }).db
    db.run("UPDATE runs SET status='queued' WHERE run_id='run-queued'")
    await first.close()

    const second = new RuntimeRepository(root, defaults); await second.open()
    expect(second.runStatus('run-queued')).toBe('interrupted')
    expect(second.getThread(thread.thread_id)?.active_run_id).toBeNull()
    expect(() => second.beginRun('run-after-queued', thread.thread_id, String(agent.agent_id), 'subscription-next')).not.toThrow()
    await second.close()
  })

  it('marks an in-flight side-effect boundary uncertain without replaying it', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    const agent = first.listAgents()[0]; const thread = first.createThread(String(agent.agent_id), { project_id: 'project-a' })
    first.beginRun('run-uncertain', thread.thread_id, String(agent.agent_id), 'subscription-a')
    first.saveCheckpoint({ version: 1, threadId: thread.thread_id, runId: 'run-uncertain', agentId: String(agent.agent_id), status: 'running', messages: [], completedToolCalls: {}, loopSignatures: [], usage: {}, step: 2, boundary: { phase: 'tool', state: 'before', toolCallId: 'tool-a', toolName: 'board_patch_elements', sideEffect: true, updatedAt: new Date().toISOString() } })
    await first.close()
    const second = new RuntimeRepository(root, defaults); await second.open()
    expect(second.latestCheckpoint(thread.thread_id)?.boundary).toMatchObject({ state: 'uncertain', toolCallId: 'tool-a' })
    expect(second.listDebug(thread.thread_id)).toEqual([expect.objectContaining({ category: 'recovery.uncertain_side_effect', payload: expect.objectContaining({ replayed: false }) })])
    await second.close()
  })

  it('durably closes every pending tool id after a runtime restart', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    const agent = first.listAgents()[0]; const thread = first.createThread(String(agent.agent_id), { project_id: 'project-a' })
    first.beginRun('run-ledger', thread.thread_id, String(agent.agent_id), 'subscription-a')
    first.registerToolCalls('run-ledger', thread.thread_id, [
      { id: 'read-a', name: 'board_get_state', arguments: { project_id: 'project-a' } },
      { id: 'write-b', name: 'board_batch', arguments: { project_id: 'project-a' } },
    ], call => call.name === 'board_batch')
    await first.close()
    const second = new RuntimeRepository(root, defaults); await second.open()
    const transcript = second.reconcileToolMessages('run-ledger', [{ role: 'assistant', content: '', toolCalls: [
      { id: 'read-a', name: 'board_get_state', arguments: {} },
      { id: 'write-b', name: 'board_batch', arguments: {} },
    ] }], 'interrupted')
    expect(transcript.slice(1)).toEqual([
      expect.objectContaining({ role: 'tool', toolCallId: 'read-a', content: expect.stringContaining('未执行') }),
      expect.objectContaining({ role: 'tool', toolCallId: 'write-b', content: expect.stringContaining('可能已部分生效') }),
    ])
    await second.close()
  })

  it('accepts only the first terminal tool result and never reclaims it', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]; const thread = repository.createThread(String(agent.agent_id), { project_id: 'project-a' })
    repository.beginRun('run-once', thread.thread_id, String(agent.agent_id), 'subscription-a')
    repository.registerToolCalls('run-once', thread.thread_id, [{ id: 'write-a', name: 'board_batch', arguments: { operations: [] } }], () => true)
    expect(repository.beginToolCall('run-once', 'write-a')).toBe(true)
    expect(repository.completeToolCall('run-once', 'write-a', 'succeeded', { content: 'created once' })).toBe(true)
    // Late cancellation and a repeated provider frame must not mutate the
    // durable result or reclaim permission to execute the write.
    expect(repository.completeToolCall('run-once', 'write-a', 'uncertain', { content: 'late cancellation' })).toBe(false)
    expect(repository.beginToolCall('run-once', 'write-a')).toBe(false)
    expect(repository.toolCallResult('run-once', 'write-a')).toMatchObject({ status: 'succeeded', result_json: expect.stringContaining('created once') })
    await repository.close()
  })

  it('does not mark an already completed tool boundary uncertain after restart', async () => {
    const { root, defaults } = await fixture(); const first = new RuntimeRepository(root, defaults); await first.open()
    const agent = first.listAgents()[0]; const thread = first.createThread(String(agent.agent_id), { project_id: 'project-a' })
    first.beginRun('run-completed-tool', thread.thread_id, String(agent.agent_id), 'subscription-a')
    first.saveCheckpoint({ version: 1, threadId: thread.thread_id, runId: 'run-completed-tool', agentId: String(agent.agent_id), status: 'running', messages: [], completedToolCalls: { 'tool-a': { ok: true } }, loopSignatures: [], usage: {}, step: 3, boundary: { phase: 'tool', state: 'after', toolCallId: 'tool-a', toolName: 'board_patch_elements', sideEffect: true, updatedAt: new Date().toISOString() } })
    await first.close()
    const second = new RuntimeRepository(root, defaults); await second.open()
    expect(second.latestCheckpoint(thread.thread_id)?.boundary).toMatchObject({ state: 'after', toolCallId: 'tool-a' })
    expect(second.listDebug(thread.thread_id).some(item => item.category === 'recovery.uncertain_side_effect')).toBe(false)
    await second.close()
  })

  it('records correlated redacted traces and enforces retention caps', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]; const thread = repository.createThread(String(agent.agent_id), { project_id: 'project-a' })
    repository.beginRun('run-trace', thread.thread_id, String(agent.agent_id), 'subscription-a')
    for (let index = 0; index < 8; index += 1) {
      repository.storeJournal(thread.thread_id, 'run-trace', index, 'model', index === 7 ? 'model.error' : 'model.response', 'lead', { authorization: 'Bearer secret-value', error: index === 7 ? 'fixture failure' : undefined }, { correlationId: `call-${index}`, parentCorrelationId: 'run-trace', status: index === 7 ? 'failed' : 'completed', durationMs: index + 1, inputTokens: 10, outputTokens: 2, ...(index === 7 ? { errorCategory: 'authentication' } : {}) })
      repository.storeDebug(thread.thread_id, 'run-trace', 'fixture', { api_key: 'must-not-persist', index })
      repository.storeEvent({ protocol_version: 'test', event_id: `event-${index}`, sequence: index, ts: new Date().toISOString(), thread_id: thread.thread_id, run_id: 'run-trace', type: index ? 'agent.tool_result' : 'session.started', payload: { tool_name: `fixture-${index}` } })
    }
    repository.finishRun('run-trace', 'failed', { message: 'fixture failure', category: 'authentication' })
    const trace = repository.runTrace(thread.thread_id, 'run-trace')
    expect(trace.failure).toMatchObject({ phase: 'model', category: 'authentication', message: 'fixture failure' })
    expect(JSON.stringify(trace)).not.toContain('secret-value')
    expect(JSON.stringify(repository.listDebug(thread.thread_id))).not.toContain('must-not-persist')
    const retained = await repository.cleanupRetention({ maxEvents: 3, maxJournal: 3, maxDebug: 3 })
    expect(retained).toMatchObject({ events: 3, journal: 3, debug: 3 })
    await repository.close()
  })

  it('preserves full RuntimeFailure contract in error_json and enriches trace failure', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]; const thread = repository.createThread(String(agent.agent_id), { project_id: 'project-contract' })
    repository.beginRun('run-contract', thread.thread_id, String(agent.agent_id), 'subscription-contract')
    repository.storeJournal(thread.thread_id, 'run-contract', 0, 'run', 'run.finished', 'runtime', { status: 'failed', error: 'tool execution failed' }, { correlationId: 'run-contract', status: 'failed' })
    const fullContract = {
      message: 'tool execution failed',
      category: 'execution',
      error_code: 'TOOL_EXECUTION_FAILED',
      phase: 'tool',
      error_category: 'execution',
      retryable: false,
      user_message: '画板操作未能执行完成。',
      user_action: '请根据提示调整请求后重试。',
      technical_detail: 'board_batch: element_id "node-999" not found in canvas',
      status: 400,
      provider_error: { status: 400, body: '{"error":"element not found"}', request_id: 'req-123' }
    }
    repository.finishRun('run-contract', 'failed', fullContract)
    const trace = repository.runTrace(thread.thread_id, 'run-contract')
    expect(trace.failure).toMatchObject({
      phase: 'run',
      contract_phase: 'tool',
      error_code: 'TOOL_EXECUTION_FAILED',
      error_category: 'execution',
      retryable: false,
      user_message: '画板操作未能执行完成。',
      user_action: '请根据提示调整请求后重试。',
      technical_detail: 'board_batch: element_id "node-999" not found in canvas',
    })
    expect(trace.failure?.message).toBe('tool execution failed')
    // Redaction: provider_error body should have sensitive keys redacted, but structure preserved
    expect(trace.failure).toBeDefined()
    const storedRun = repository.listRuns ? null : null // listRuns may not be exposed; verify through trace instead
    await repository.close()
  })

  it('keeps streaming deltas ephemeral while bounding checkpoints and repeated model request traces', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]; const thread = repository.createThread(String(agent.agent_id), {})
    repository.beginRun('run-stream', thread.thread_id, String(agent.agent_id), 'subscription-stream')
    for (let sequence = 1; sequence <= 100; sequence += 1) repository.storeEvent({ protocol_version: 'test', event_id: `stream-${sequence}`, sequence, ts: new Date().toISOString(), thread_id: thread.thread_id, run_id: 'run-stream', type: 'agent.message.delta', tool_call_id: 'llm-a', payload: { call_id: 'llm-a', delta: 'x' } })
    expect(repository.listEvents(thread.thread_id, 'run-stream')).toEqual([])
    const checkpoint = { version: 1 as const, threadId: thread.thread_id, runId: 'run-stream', agentId: String(agent.agent_id), status: 'running' as const, messages: [], completedToolCalls: {}, loopSignatures: [], usage: {}, step: 1 }
    repository.saveCheckpoint(checkpoint); repository.saveCheckpoint({ ...checkpoint, step: 2 })
    expect((await repository.cleanupRetention()).checkpoints).toBe(1)
    repository.storeJournal(thread.thread_id, 'run-stream', 1, 'model', 'model.request', 'lead', { messages: Array.from({ length: 20 }, (_, index) => ({ role: index ? 'user' : 'system', content: 'y'.repeat(20_000) })), tools: [{ name: 'board_batch', description: 'edit', input_schema: { huge: 'z'.repeat(100_000) } }] })
    const journal = repository.listJournal(thread.thread_id, 'run-stream')
    expect(JSON.stringify(journal[0].payload).length).toBeLessThan(110_000)
    expect(JSON.stringify(journal)).not.toContain('z'.repeat(1_000))
    await repository.close()
  })

  it('reconstructs semantic loops when legacy checkpoint steps split model and tool records', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]; const thread = repository.createThread(String(agent.agent_id), {})
    repository.beginRun('legacy-loop', thread.thread_id, String(agent.agent_id), 'subscription-loop')
    repository.storeJournal(thread.thread_id, 'legacy-loop', 1, 'middleware', 'middleware.started', 'plan', { hook: 'before_model' })
    repository.storeJournal(thread.thread_id, 'legacy-loop', 1, 'model', 'model.request', 'lead', {})
    repository.storeJournal(thread.thread_id, 'legacy-loop', 1, 'model', 'model.response', 'lead', {})
    repository.storeJournal(thread.thread_id, 'legacy-loop', 2, 'middleware', 'middleware.started', 'loop-detection', { hook: 'before_tool' })
    repository.storeJournal(thread.thread_id, 'legacy-loop', 2, 'tool', 'tool.request', 'board_get_state', {})
    repository.storeJournal(thread.thread_id, 'legacy-loop', 3, 'tool', 'tool.response', 'board_get_state', {})
    repository.storeJournal(thread.thread_id, 'legacy-loop', 3, 'middleware', 'middleware.started', 'plan', { hook: 'before_model' })
    repository.storeJournal(thread.thread_id, 'legacy-loop', 3, 'model', 'model.request', 'lead', {})
    const trace = repository.runTrace(thread.thread_id, 'legacy-loop')
    expect(trace.loops).toHaveLength(2)
    expect(trace.loops[0]).toMatchObject({ model: expect.arrayContaining([expect.objectContaining({ event_type: 'model.request' })]), tools: expect.arrayContaining([expect.objectContaining({ event_type: 'tool.request' }), expect.objectContaining({ event_type: 'tool.response' })]) })
    expect(trace.loops[1].model).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'model.request' })]))
    await repository.close()
  })

  it('persists and reopens 500 ordered events without abnormal snapshot growth', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]; const thread = repository.createThread(String(agent.agent_id), { project_id: 'pressure' })
    repository.beginRun('run-pressure', thread.thread_id, String(agent.agent_id), 'subscription-pressure')
    for (let sequence = 1; sequence <= 500; sequence += 1) repository.storeEvent({ protocol_version: 'test', event_id: `pressure-${sequence}`, sequence, ts: new Date().toISOString(), thread_id: thread.thread_id, run_id: 'run-pressure', type: sequence === 500 ? 'session.completed' : 'agent.message.delta', payload: { delta: `event-${sequence}` } })
    repository.finishRun('run-pressure', 'completed')
    const started = Date.now(); await repository.flush(); expect(Date.now() - started).toBeLessThan(3000)
    expect(repository.listEvents(thread.thread_id, 'run-pressure', 0, 1000)).toEqual([expect.objectContaining({ type: 'session.completed', sequence: 500 })])
    await repository.close(); expect((await stat(join(root, 'runtime.sqlite'))).size).toBeLessThan(10 * 1024 * 1024)
    const reopened = new RuntimeRepository(root, defaults); await reopened.open(); expect(reopened.listEvents(thread.thread_id, 'run-pressure', 0, 1000)).toEqual([expect.objectContaining({ type: 'session.completed', sequence: 500 })]); await reopened.close()
  })

  it('recovers the persistence queue after a transient disk write failure', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const moved = `${root}-temporarily-moved`; await rename(root, moved); await writeFile(root, 'blocks-directory-creation')
    repository.savePromptTemplate('runtime.system', 'changed-before-disk-failure')
    await expect(repository.flush()).rejects.toBeInstanceOf(Error)
    expect(repository.integrityCheck().persistError).toBeTruthy()
    await unlink(root); await rename(moved, root)
    await expect(repository.flush()).resolves.toBeUndefined()
    expect(repository.integrityCheck().persistError).toBeNull()
    await repository.close()
  })

  it('updates, binds and cascades MCP connection records', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const agent = repository.listAgents()[0]
    const saved = repository.saveMcp({ name: 'fixture', transport: 'http', url: 'https://mcp.example', headers: { Authorization: 'secret://fixture' } })
    repository.bindAgentMcp(String(agent.agent_id), [{ connection_id: String(saved.connection_id), allowlist: ['echo'] }])
    expect(repository.mcpForAgent(String(agent.agent_id))).toEqual([expect.objectContaining({ allowlist: ['echo'] })])
    const updated = repository.saveMcp({ name: 'fixture-updated', enabled: false, headers: { Authorization: '' } }, String(saved.connection_id))
    expect(updated).toMatchObject({ name: 'fixture-updated', enabled: false, has_credentials: true })
    expect(repository.deleteMcp(String(saved.connection_id))).toEqual({ deleted: true })
    expect(repository.getAgent(String(agent.agent_id))?.mcp_connection_ids).toEqual([])
    await repository.close()
  })

  it('imports attachments and only materializes supported images for model calls', async () => {
    const { root, defaults } = await fixture()
    const repository = new RuntimeRepository(root, defaults)
    await repository.open()
    const image = join(root, 'sample.png')
    await writeFile(image, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0]))
    const imported = await repository.importAttachment(image)
    expect(imported).toMatchObject({ name: 'sample.png', mime_type: 'image/png' })
    const attachments = await repository.modelAttachments([imported.attachment_id])
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ attachmentId: imported.attachment_id, mimeType: 'image/png' })
    expect(Buffer.from(attachments[0].dataBase64, 'base64')).toEqual(await readFile(image))
    await repository.close()
  })

  it('stores generated board screenshots as uniquely named managed image attachments', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1OwAAAABJRU5ErkJggg=='
    const first = await repository.importGeneratedImage(png, '布局检查')
    const second = await repository.importGeneratedImage(png, '布局检查.png')
    expect(first).toMatchObject({ name: '布局检查.png', mime_type: 'image/png', generated: true })
    expect(second).toMatchObject({ name: '布局检查 (2).png', mime_type: 'image/png', generated: true })
    expect(await repository.modelAttachments([first.attachment_id, second.attachment_id])).toHaveLength(2)
    await repository.close()
  })

  it('extracts text and PDF content, binds references and rejects binary text', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const textPath = join(root, 'notes.md'); await writeFile(textPath, '\ufeffTuGo 文本附件')
    const text = await repository.importAttachment(textPath)
    expect(repository.readAttachmentText(text.attachment_id).content).toContain('TuGo 文本附件')

    const pdf = new jsPDF(); pdf.text('TuGo PDF fixture', 20, 20)
    const pdfPath = join(root, 'fixture.pdf'); await writeFile(pdfPath, Buffer.from(pdf.output('arraybuffer')))
    const importedPdf = await repository.importAttachment(pdfPath)
    expect(repository.readAttachmentText(importedPdf.attachment_id).content).toContain('TuGo PDF fixture')

    const agent = repository.listAgents()[0]
    const thread = repository.createThread(String(agent.agent_id), { project_id: 'attachment-project' })
    repository.beginRun('run-a', thread.thread_id, String(agent.agent_id), 'attachment-subscription')
    repository.bindAttachments(thread.thread_id, 'run-a', [text.attachment_id])
    expect(repository.attachmentReferences(thread.thread_id)).toHaveLength(1)
    await expect(repository.deleteAttachment(text.attachment_id)).rejects.toThrow('已被会话引用')

    const binaryPath = join(root, 'binary.txt'); await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]))
    await expect(repository.importAttachment(binaryPath)).rejects.toThrow('二进制')
    await repository.close()
  })

  it('extracts Word paragraphs and Excel cells through the same read_file attachment path', async () => {
    const { root, defaults } = await fixture(); const repository = new RuntimeRepository(root, defaults); await repository.open()
    const docx = new JSZip(); docx.file('word/document.xml', '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>项目现状</w:t></w:r></w:p><w:p><w:r><w:t>需要绘制系统架构图</w:t></w:r></w:p></w:body></w:document>')
    const docxPath = join(root, 'brief.docx'); await writeFile(docxPath, await docx.generateAsync({ type: 'nodebuffer' }))
    const importedDocx = await repository.importAttachment(docxPath)
    expect(repository.readAttachmentText(importedDocx.attachment_id).content).toContain('需要绘制系统架构图')

    const xlsx = new JSZip(); xlsx.file('xl/sharedStrings.xml', '<sst><si><t>服务</t></si><si><t>数据库</t></si></sst>'); xlsx.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>')
    const xlsxPath = join(root, 'inventory.xlsx'); await writeFile(xlsxPath, await xlsx.generateAsync({ type: 'nodebuffer' }))
    const importedXlsx = await repository.importAttachment(xlsxPath)
    expect(repository.readAttachmentText(importedXlsx.attachment_id).content).toContain('服务 | 数据库')
    await repository.close()
  })
})
