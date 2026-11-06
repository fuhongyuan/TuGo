import { observeBoard, getObservation, observationPage, observationSummary, boardContentHash, repairNewNodes, confirmRepair } from './boardObservation'
import generatedValidate from './cliValidator.generated'
import type { ValidateFunction } from 'ajv'
import { BOARD_BATCH_SCHEMA } from '../../runtime-ts/src/boardToolSchemas'
import { applyBoardOperations, normalizeDocument, type BoardHistory } from './boardState'
import { parseDsl, insertDslDocument, toMermaid } from './dsl'
import { exportBoardFile } from './exportDocument'
import { reflectDiagram } from './diagramQuality'
import type { BoardDocument, BoardOperation, BoardProject, DslKind } from '../types'

type Params = Record<string, unknown>
export type CliDependencies = {
  causeId?:string
  bridge: NonNullable<Window['tugo']>
  project(id: string): BoardProject | undefined
  activeHistory(): { id: string; history: BoardHistory }
  refresh(): Promise<void>
  open(project: BoardProject): void
  save(id: string, next: BoardDocument, expected: BoardDocument): Promise<void>
  undoRedo(id: string, redo: boolean): Promise<BoardDocument>
}
export const CLI_METHODS = ['schema','folders.list','folders.create','folders.rename','folders.remove','projects.list','projects.get','projects.create','projects.rename','projects.move','projects.open','projects.remove','board.get','board.apply','board.import','board.export','board.undo','board.redo','board.review','board.observe','board.observation','snapshots.list','snapshots.create','snapshots.get','snapshots.restore','snapshots.remove','snapshots.export','snapshots.import']
const schema = JSON.parse(JSON.stringify(BOARD_BATCH_SCHEMA))
schema.properties.operations.maxItems = 256
const validate = generatedValidate as ValidateFunction
const required = (p: Params, key: string) => { const value = p[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 ${key}`); return value.trim() }
const confirmed = (p: Params) => { if (p.confirm !== true) throw new Error('该操作需要 --confirm') }
const file = (data: string, encoding = 'utf8') => ({ file: { data, encoding } })
export const boardRevision = boardContentHash
function validateDocument(value: unknown): BoardDocument {
  const document = value as BoardDocument
  if (!document || !Array.isArray(document.elements) || !Array.isArray(document.edges) || document.elements.length > 20000 || document.edges.length > 40000) throw new Error('无效画板 JSON 或超出规模限制')
  const ids = new Set<string>()
  for (const item of [...document.elements, ...document.edges]) { if (!item || !item.id || typeof item.id !== 'string' || ids.has(item.id)) throw new Error('对象 id 缺失或重复'); ids.add(item.id) }
  for (const item of document.elements) if (![item.x,item.y,item.width,item.height].every(Number.isFinite) || item.width <= 0 || item.height <= 0) throw new Error('图形坐标或尺寸无效')
  const nodes = new Set(document.elements.map(item => item.id))
  for (const edge of document.edges) {
    for (const point of [edge.freeStart, edge.freeEnd]) if (point && ![point.x, point.y].every(Number.isFinite)) throw new Error('连线端点坐标无效')
    if ((!nodes.has(edge.from) && !edge.freeStart) || (!nodes.has(edge.to) && !edge.freeEnd)) throw new Error('连线端点不存在')
  }
  return normalizeDocument(document)
}

export async function runCliCommand(method: string, p: Params, deps: CliDependencies): Promise<unknown> {
  const api = deps.bridge
  for (const key of ['confirm','replace','open']) if (p[key] !== undefined && typeof p[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
  if (!CLI_METHODS.includes(method)) throw new Error(`未知命令 ${method}；运行 tugo schema 查看支持的命令`)
  if (method === 'schema') return { protocol: 1, methods: CLI_METHODS, batch: schema, importFormats: ['mermaid','plantuml','drawio','json'], exportFormats: ['json','mermaid','drawio','svg','png','jpeg','webp','pdf','pptx'] }
  if (method === 'folders.list') return api.folders.list()
  if (method === 'projects.list') return (await api.projects.list()).map(({ document, ...project }) => ({ ...project, elementCount: document.elements.length }))
  if (method.startsWith('folders.')) {
    const id = method === 'folders.create' ? '' : required(p, 'id')
    if (id && !(await api.folders.list()).some(folder => folder.id === id)) throw new Error('文件夹不存在')
    let result
    if (method === 'folders.create') result = await api.folders.create(required(p, 'name'))
    else if (method === 'folders.rename') result = await api.folders.rename(id, required(p, 'name'))
    else { confirmed(p); result = await api.folders.remove(id) }
    await deps.refresh(); return result
  }
  if (method === 'projects.create') {
    const folderId = p.folder == null ? null : required(p, 'folder')
    if (folderId && !(await api.folders.list()).some(folder => folder.id === folderId)) throw new Error('文件夹不存在')
    const result = await api.projects.create({ name: required(p, 'name'), folderId })
    await deps.refresh(); if (p.open !== false) deps.open(result); return result
  }
  const id = required({ ...p, project: p.project || p.id }, 'project')
  const project = deps.project(id)
  if (!project) throw new Error('画板不存在，请先 projects list 获取 ID')
  const active = deps.activeHistory()
  const document = id === active.id ? active.history.current : project.document
  const revision = await boardRevision(document)
  if (p.ifRevision !== undefined && p.ifRevision !== revision) throw new Error('REVISION_CONFLICT：画板已发生变化，请重新读取')
  const save = async (next: BoardDocument) => {
    next = validateDocument(next)
    const causeId=deps.causeId||`cli_${crypto.randomUUID()}`
    const repair=repairNewNodes(next,method==='board.apply'?p.operations as BoardOperation[]:[],{before:document,causeId,allowRepair:method==='board.apply'})
    next=repair.document
    try{await deps.save(id,next,document)}catch(error){throw new Error(`保存回执失败，结果未知；修复候选 ${repair.id}，因果 ${causeId}。先核对状态，不要重放原操作。${error instanceof Error?error.message:String(error)}`)}
    // A host may regenerate derived DSL/cache fields during the save. Observe
    // that acknowledged shape's actual version, never an older cache snapshot.
    // A concurrent shape edit still uses `next` and is reported stale below.
    const activeAfterSave=deps.activeHistory()
    const actual=activeAfterSave.id===id?activeAfterSave.history.current:deps.project(id)?.document
    if(actual&&await boardRevision(actual)===await boardRevision(next)&&JSON.stringify(actual.presentationAreas)===JSON.stringify(next.presentationAreas))next=actual
    const observation = await observeBoard({projectId:id,document:next,before:document,current:()=>deps.activeHistory().id===id?deps.activeHistory().history.current:deps.project(id)?.document || next,directIds:[...new Set((p.operations as BoardOperation[] || []).flatMap(op=>'element' in op?[op.element.id]:'edge' in op?[op.edge.id]:'id' in op?[op.id]:'ids' in op?op.ids:[]))],fixes:await confirmRepair(repair,next,{acknowledged:true}),repairPlan:{id:repair.id,budget:repair.budget},causeId,render:false})
    return { projectId:id,revision:await boardRevision(next),elementCount:next.elements.length,edgeCount:next.edges.length,observation:observationSummary(observation) }
  }
  if (method === 'projects.get') return { ...project, document, revision }
  if (method === 'projects.open') { deps.open({ ...project, document }); return { projectId: id } }
  if (method === 'projects.remove') { confirmed(p); await api.projects.remove(id); await deps.refresh(); return { removed: id } }
  if (method === 'projects.rename' || method === 'projects.move') {
    const patch: Partial<BoardProject> = method === 'projects.rename' ? { name: required(p, 'name') } : { folderId: p.folder === null ? null : required(p, 'folder') }
    if (patch.folderId && !(await api.folders.list()).some(folder => folder.id === patch.folderId)) throw new Error('文件夹不存在')
    const result = await api.projects.update({ id, ...patch }); await deps.refresh(); return result
  }
  if (method === 'board.get') return { projectId: id, document, revision }
  if (method === 'board.observe') return {ok:true,observation:await observeBoard({projectId:id,document,current:()=>deps.activeHistory().id===id?deps.activeHistory().history.current:deps.project(id)?.document || document,waitMs:Number(p.wait_ms ?? 1200)})}
  if (method === 'board.observation') return {ok:true,observation:observationPage(getObservation(required(p,'observation_id'),id,document),p.offset,p.limit)}
  if (method === 'board.review') return { projectId: id, revision, review: reflectDiagram(document) }
  if (method === 'board.undo' || method === 'board.redo') { const next = await deps.undoRedo(id, method === 'board.redo'); return { projectId: id, revision: await boardRevision(next) } }
  if (method === 'board.apply') {
    if (!validate({ description: 'CLI edit', operations: p.operations })) throw new Error(`无效 operations: ${JSON.stringify(validate.errors)}`)
    let next = document
    for (const operation of p.operations as BoardOperation[]) {
      const ids = new Set([...next.elements, ...next.edges].map(item => item.id))
      if ('id' in operation && !ids.has(operation.id)) throw new Error(`对象不存在: ${operation.id}`)
      if ((operation.op === 'patch_element' || operation.op === 'delete_element') && !next.elements.some(item => item.id === operation.id)) throw new Error('目标不是节点')
      if ((operation.op === 'patch_edge' || operation.op === 'delete_edge') && !next.edges.some(item => item.id === operation.id)) throw new Error('目标不是连线')
      if ('ids' in operation && operation.ids.some(id => !next.elements.some(item => item.id === id))) throw new Error('选择集合含有不存在的节点')
      if (operation.op === 'add_element' && ids.has(operation.element.id) || operation.op === 'add_edge' && ids.has(operation.edge.id)) throw new Error('新增对象的 id 已存在，请使用 patch')
      if (operation.op === 'add_edge' && ((!next.elements.some(item => item.id === operation.edge.from) && !operation.edge.freeStart) || (!next.elements.some(item => item.id === operation.edge.to) && !operation.edge.freeEnd))) throw new Error('新增连线端点不存在')
      if (operation.op === 'patch_edge') {
        const edge = { ...next.edges.find(item => item.id === operation.id)!, ...operation.patch }
        if ((!next.elements.some(item => item.id === edge.from) && !edge.freeStart) || (!next.elements.some(item => item.id === edge.to) && !edge.freeEnd)) throw new Error('连线端点不存在')
      }
      next = applyBoardOperations(next, [operation])
    }
    return save(next)
  }
  if (method === 'board.import') {
    const format = required(p, 'format'), source = required(p, 'content')
    if (!['json','mermaid','plantuml','drawio'].includes(format)) throw new Error('不支持的导入格式')
    const imported = format === 'json' ? validateDocument(JSON.parse(source)) : parseDsl(format as DslKind, source)
    if (p.replace) confirmed(p)
    return save(p.replace ? imported : insertDslDocument(document, imported))
  }
  if (method === 'board.export') {
    const format = required(p, 'format')
    if (format === 'json') return file(JSON.stringify(document, null, 2))
    if (format === 'mermaid') return file(toMermaid(document))
    return exportBoardFile(document, format, p.region, project.name)
  }
  const snapshots = api.projects.snapshots
  if (method === 'snapshots.list') {
    if (p.source !== undefined && p.source !== 'agent' && p.source !== 'user') throw new Error('source 必须是 agent 或 user')
    return snapshots.list(id, Number(p.page || 1), 10, p.source === 'agent' ? 'agent' : 'user')
  }
  if (method === 'snapshots.create') {
    if (p.source !== undefined && p.source !== 'agent' && p.source !== 'user') throw new Error('source 必须是 agent 或 user')
    return snapshots.create({ projectId: id, name: required(p, 'name'), document, source: p.source === 'agent' ? 'agent' : 'user', reason: String(p.reason || ''), summary: String(p.summary || ''), notes: String(p.notes || '') })
  }
  if (method === 'snapshots.import') {
    const imported = await api.board.importSnapshotPath(id, required(p, 'path'))
    if (!imported.document) throw new Error('快照缺少画板')
    const snapshot = await snapshots.create({ projectId: id, name: String(p.name || 'CLI 导入快照'), source: 'user', document: validateDocument(imported.document) })
    return { snapshot, message: '已导入快照。使用 snapshots restore 应用到画板。' }
  }
  const snapshotId = required(p, 'snapshot')
  if (method === 'snapshots.get') return snapshots.get(id, snapshotId)
  if (method === 'snapshots.remove') { confirmed(p); return snapshots.remove(id, snapshotId) }
  if (method === 'snapshots.export') return file(JSON.stringify(await api.board.exportSnapshotData(id, snapshotId)))
  if (method === 'snapshots.restore') {
    confirmed(p)
    const target = await snapshots.get(id, snapshotId)
    // Preserve a recovery point even if restoring overwrites a manually edited board.
    const backup = await snapshots.create({ projectId: id, name: 'CLI 恢复前自动快照', source: 'user', document })
    return { ...await save(validateDocument(target.document)), recoverySnapshotId: backup.id }
  }
  throw new Error('Unsupported command')
}
