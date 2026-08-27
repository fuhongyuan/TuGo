import { readFile, writeFile } from 'node:fs/promises'
import initSqlJs from 'sql.js/dist/sql-asm.js'

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]] : null).filter(Boolean))
for (const required of ['source-db', 'events', 'runs', 'output']) if (!args[required]) throw new Error(`Missing --${required}`)

const events = JSON.parse(await readFile(args.events, 'utf8'))
const runs = JSON.parse(await readFile(args.runs, 'utf8'))
const parseJson = value => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return null } }
const validDocument = value => value && typeof value === 'object' && Array.isArray(value.elements) && Array.isArray(value.edges)
const projectSnapshots = new Map()
const threadProjects = new Map()

for (const event of events) {
  const payload = parseJson(event.payload)
  if (!payload || !String(payload.tool_name || '').includes('board_')) continue
  const inputProjectId = String(payload.input?.project_id || '').trim()
  if (inputProjectId) threadProjects.set(event.thread_id, inputProjectId)
  if (event.event_type !== 'agent.tool_result' || payload.status !== 'success') continue
  for (const item of payload.content || []) {
    const result = item?.type === 'text' ? parseJson(item.text) : null
    if (!result?.ok || !String(result.projectId || '').startsWith('project_') || !validDocument(result.document)) continue
    threadProjects.set(event.thread_id, result.projectId)
    const previous = projectSnapshots.get(result.projectId)
    const timestamp = event.ts || new Date().toISOString()
    if (!previous || timestamp >= previous.updatedAt) projectSnapshots.set(result.projectId, { document: result.document, updatedAt: timestamp, threadId: event.thread_id })
  }
}

const names = new Map()
const projectRunTimes = new Map()
for (const run of runs) {
  const match = String(run.first_human_message || '').match(/^当前项目：(.*?)。画布项目 ID：(project_[0-9a-f-]+)/s)
  const projectId = match?.[2] || threadProjects.get(run.thread_id)
  if (!projectId) continue
  threadProjects.set(run.thread_id, projectId)
  if (match?.[1] && match[1] !== '未命名画板') names.set(projectId, match[1])
  const times = projectRunTimes.get(projectId) || []
  times.push(run.created_at, run.updated_at)
  projectRunTimes.set(projectId, times.filter(Boolean))
}

const fallbackName = (projectId, document) => {
  const title = document.elements.find(item => item.id === 'title' && String(item.text || '').trim()) || document.elements.find(item => String(item.text || '').trim())
  const text = String(title?.text || '').split('\n')[0].trim()
  return text && text.length <= 80 ? text : `恢复画板 ${projectId.slice(-6)}`
}
const messageText = value => {
  const text = String(value || '')
  const marker = '\n\n用户请求：'
  return text.includes(marker) ? text.slice(text.lastIndexOf(marker) + marker.length).trim() : text.trim()
}

const SQL = await initSqlJs()
const database = new SQL.Database(await readFile(args['source-db']))
database.run('BEGIN')
for (const [projectId, snapshot] of projectSnapshots) {
  const times = projectRunTimes.get(projectId) || []
  const createdAt = [...times, snapshot.updatedAt].sort()[0] || snapshot.updatedAt
  const updatedAt = [...times, snapshot.updatedAt].sort().at(-1) || snapshot.updatedAt
  const name = names.get(projectId) || fallbackName(projectId, snapshot.document)
  database.run('INSERT INTO projects (id, folder_id, name, document_json, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, document_json=excluded.document_json, updated_at=excluded.updated_at', [projectId, name, JSON.stringify(snapshot.document), createdAt, updatedAt])
}

const conversations = new Map()
for (const run of runs) {
  const projectId = threadProjects.get(run.thread_id)
  if (!projectId || !projectSnapshots.has(projectId)) continue
  const id = `conversation_${run.thread_id}`
  const current = conversations.get(id) || { id, projectId, threadId: run.thread_id, title: names.get(projectId) || '恢复会话', messages: [], createdAt: run.created_at, updatedAt: run.updated_at }
  const userText = messageText(run.first_human_message)
  if (userText) current.messages.push({ id: `recovered_${run.run_id}_user`, role: 'user', content: userText, createdAt: run.created_at })
  if (String(run.last_ai_message || '').trim()) current.messages.push({ id: `recovered_${run.run_id}_assistant`, role: 'assistant', content: run.last_ai_message, createdAt: run.updated_at })
  current.createdAt = [current.createdAt, run.created_at].filter(Boolean).sort()[0]
  current.updatedAt = [current.updatedAt, run.updated_at].filter(Boolean).sort().at(-1)
  conversations.set(id, current)
}
for (const conversation of conversations.values()) {
  database.run('INSERT OR REPLACE INTO project_conversations (id, project_id, thread_id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [conversation.id, conversation.projectId, conversation.threadId, conversation.title, JSON.stringify(conversation.messages), conversation.createdAt, conversation.updatedAt])
}
for (const projectId of projectSnapshots.keys()) {
  const latest = [...conversations.values()].filter(item => item.projectId === projectId).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).at(-1)
  if (latest) database.run('INSERT OR REPLACE INTO project_active_conversations (project_id, conversation_id) VALUES (?, ?)', [projectId, latest.id])
}
database.run('COMMIT')
await writeFile(args.output, Buffer.from(database.export()))
database.close()
console.log(JSON.stringify({ recoveredProjects: projectSnapshots.size, recoveredConversations: conversations.size, output: args.output }, null, 2))
