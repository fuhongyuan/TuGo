import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareMacDevShell } from './mac-dev-shell.mjs'
const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const directory = await mkdtemp(join(tmpdir(), 'tugo-cli-e2e-'))
const packaged = process.env.TUGO_E2E_EXECUTABLE
const cliDirectory = packaged ? resolve(packaged, '../../Resources/cli') : join(root, 'cli')
const cli = join(cliDirectory, 'tugo.cjs')
const executable = packaged ? resolve(packaged) : await prepareMacDevShell(root, join(root, 'node_modules/electron/cli.js'), { variant: 'cli' })
let child, exited
const call = async (method, params = {}, extra = [], failure = false) => {
  let output
  try { output = (await exec(process.execPath, [cli, ...method.split('.'), '--data-dir', directory, '--json', JSON.stringify(params), ...extra], { maxBuffer: 20 * 1024 * 1024 })).stdout }
  catch (error) { if (!failure) throw error; output = error.stdout }
  const response = JSON.parse(output)
  assert.equal(response.ok, !failure, JSON.stringify(response)); return failure ? response.error : response.result
}
const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } } }
const launch = async () => {
  child = spawn(executable, [...(packaged ? [] : [root]), `--tugo-user-data=${directory}`, `--tugo-e2e-report=${join(directory, 'unused.json')}`, '--tugo-e2e-mode=cli'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', data => process.stderr.write(data))
  exited = new Promise(r => child.once('exit', r))
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    try { if ((await call('status')).ready) return } catch { /* startup */ }
    if (child.exitCode !== null) throw new Error('App exited during startup')
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`App not ready: ${directory}`)
}
try {
  await launch()
  assert.ok((await call('schema')).methods.includes('board.apply'))
  const folder = await call('folders.create', { name: 'CLI 测试目录' })
  const project = await call('projects.create', { name: 'CLI 测试画板', folder: folder.id })
  const p = { project: project.id }
  await call('board.import', { ...p, format: 'mermaid', content: 'flowchart LR\n A[开始] -->|流程| B[完成]' })
  const before = await call('board.get', p)
  assert.equal(before.document.elements.length, 2); assert.equal(before.document.edges.length, 1)
  const node = before.document.elements[0], edge = before.document.edges[0]
  await call('board.apply', { ...p, ifRevision: before.revision, operations: [{ op: 'patch_element', id: node.id, patch: { text: '已修改', stroke: '#a5b4fc', strokeWidth: 6, strokeStyle: 'dashed', fillOpacity: 0 } }, { op: 'patch_edge', id: edge.id, patch: { label: '已改连线' } }] })
  const edited = await call('board.get', p)
  await call('projects.open',p)
  const observed=(await call('board.observe',p)).observation
  assert.equal(observed.project_id,project.id)
  assert.equal(observed.checks.render,'passed',JSON.stringify(observed.render))
  assert.equal(observed.render.measured_elements,2)
  const savedEvidence=await call('board.observation',{...p,observation_id:observed.observation_id,offset:0,limit:2})
  assert.equal(savedEvidence.observation.verdict,observed.verdict)

  assert.equal(edited.document.elements[0].text, '已修改'); assert.equal(edited.document.edges[0].label, '已改连线')
  await call('board.apply', { ...p, ifRevision: before.revision, operations: [{ op: 'delete_element', id: node.id }] }, [], true)
  await call('board.apply', { ...p, operations: [{ op: 'patch_element', id: node.id, patch: { text: '不应保存' } }, { op: 'delete_element', id: 'missing' }] }, [], true)
  assert.equal((await call('board.get', p)).revision, edited.revision)
  const snapshot = await call('snapshots.create', { ...p, name: '测试快照' })
  await call('board.apply', { ...p, operations: [{ op: 'delete_element', id: node.id }] })
  assert.equal((await call('board.observation',{...p,observation_id:observed.observation_id})).observation.verdict,'stale')
  await call('board.undo', p); assert.equal((await call('board.get', p)).document.elements.length, 2)
  await call('board.redo', p); assert.equal((await call('board.get', p)).document.elements.length, 1)
  await call('snapshots.restore', { ...p, snapshot: snapshot.id }, [], true)
  const restored = await call('snapshots.restore', { ...p, snapshot: snapshot.id, confirm: true })
  assert.ok(restored.recoverySnapshotId)
  for (const format of ['json', 'mermaid', 'drawio', 'svg', 'png', 'jpeg', 'webp', 'pdf', 'pptx']) {
    const path = join(directory, `export.${format}`)
    await call('board.export', { ...p, format }, ['--out', path])
    assert.ok((await stat(path)).size > 20)
    await call('board.export', { ...p, format }, ['--out', path], true)
  }
  const snapshotPath = join(directory, 'portable.tugo-snapshot')
  assert.match(await readFile(join(directory, 'export.svg'), 'utf8'), /fill-opacity="1" stroke="none" stroke-width="0" stroke-dasharray="none"/)
  await call('snapshots.export', { ...p, snapshot: snapshot.id }, ['--out', snapshotPath])
  const second = await call('projects.create', { name: '导入目标' })
  await call('board.import', { project: second.id, format: 'drawio' }, ['--file', join(directory, 'export.drawio')])
  assert.equal((await call('board.get', { project: second.id })).document.elements.length, 2)
  await call('projects.move', { project: second.id, folder: folder.id })
  assert.equal((await call('projects.get', { project: second.id })).folderId, folder.id)
  const imported = await call('snapshots.import', { project: second.id }, ['--file', snapshotPath])
  await call('snapshots.restore', { project: second.id, snapshot: imported.snapshot.id, confirm: true })
  assert.equal((await call('board.get', { project: second.id })).document.elements.length, 2)
  assert.ok(await call('board.review', p))
  assert.ok(await call('snapshots.list', p))
  assert.equal((await call('snapshots.get', { ...p, snapshot: snapshot.id })).id, snapshot.id)
  await call('snapshots.remove', { ...p, snapshot: restored.recoverySnapshotId, confirm: true })
  await call('projects.rename', { ...p, name: '持久化画板' })
  await call('projects.open', p)
  await call('folders.rename', { id: folder.id, name: '已改目录' })
  // Repair is a proposal until the actual save ACK, then one undoable commit.
  const repairProject=await call('projects.create',{name:'修复回执与撤销测试'})
  const rp={project:repairProject.id}
  const repairResult=await call('board.apply',{...rp,operations:[{op:'add_element',element:{id:'repair-node',kind:'rectangle',x:100,y:100,width:120,height:20,text:'第一行\n第二行',fill:'#fff',stroke:'#000',strokeWidth:2,fontSize:16}}]})
  const repaired=await call('board.get',rp),actions=repairResult.observation.automatic_fixes
  assert.ok(repaired.document.elements[0].height>20)
  assert.equal(actions.filter(a=>a.persisted&&a.state==='applied').length,1)
  assert.equal(actions[0].cause_id,repairResult.observation.cause_id)
  assert.equal(actions[0].after_revision,repaired.revision)
  assert.equal(actions[0].verification_ref,repairResult.observation.observation_id)
  assert.equal(actions[0].verification.render,'not_checked')
  assert.notEqual(repairResult.observation.verdict,'stale')
  await call('board.observe',rp);assert.equal((await call('board.get',rp)).revision,repaired.revision)
  await call('board.undo',rp);assert.equal((await call('board.get',rp)).document.elements.length,0)
  await call('board.redo',rp);assert.equal((await call('board.get',rp)).document.elements[0].height,repaired.document.elements[0].height)
  assert.equal((await call('board.observation',{...rp,observation_id:repairResult.observation.observation_id})).observation.verdict,'stale')
  const lockedResult=await call('board.apply',{...rp,operations:[{op:'add_element',element:{id:'repair-locked',kind:'rectangle',x:400,y:100,width:120,height:20,text:'第一行\n第二行',fill:'#fff',stroke:'#000',strokeWidth:2,fontSize:16,locked:true}}]})
  assert.equal((await call('board.get',rp)).document.elements.find(n=>n.id==='repair-locked').height,20)
  assert.ok(lockedResult.observation.automatic_fixes.every(a=>!a.persisted))
  await call('projects.remove',{...rp,confirm:true});await call('projects.open',p)
  await stop(); await launch()
  assert.equal((await call('projects.get', p)).name, '持久化画板')
  assert.equal((await call('board.get', p)).revision, edited.revision)
  await call('projects.remove', p, [], true)
  await call('projects.remove', { project: second.id, confirm: true })
  await call('folders.remove', { id: folder.id, confirm: true })
  assert.equal((await call('projects.get', p)).folderId, null)
  const bin = join(directory, 'bin'), skill = join(directory, 'skill')
  await exec(process.execPath, [join(cliDirectory, 'install.cjs'), '--bin-dir', bin, '--skill-dir', skill])
  assert.match(await readFile(join(skill, 'SKILL.md'), 'utf8'), /tugo-draw/)
  await exec(process.execPath, [join(skill, 'scripts/tugo.cjs'), '--help'])
  console.log(JSON.stringify({ ok: true, directory, packaged: Boolean(packaged), checked: 'drawing, editing, revision conflicts, atomic rejection, undo/redo, snapshot transfer, drawio import, 9 export formats, persistence, repair receipts/read-only/lock/atomic undo and revalidation, folders, installation' }))
} finally { await stop() }
