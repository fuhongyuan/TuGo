#!/usr/bin/env node
const { readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { homedir } = require('node:os')
const { randomUUID } = require('node:crypto')

const usage = `TuGo CLI — local desktop drawing automation (Node.js >= 18)
Usage: tugo <resource> <action> [options]
  tugo status
  tugo schema
  tugo folders list|create|rename|remove
  tugo projects list|create|get|rename|move|open|remove
  tugo board get|apply|import|export|undo|redo|review|observe|observation
  tugo snapshots list|create|get|restore|remove|export|import

Options:
  --json '{...}'        Command parameters (or --json - for stdin)
  --project ID         Target project; never inferred for writes
  --id ID              Folder/project identifier
  --snapshot ID        Snapshot identifier
  --name NAME          Folder/project/snapshot name
  --folder ID          Folder ID ("null" moves to root)
  --format FORMAT      Import: mermaid, plantuml, drawio, json
                       Export: json, mermaid, drawio, svg, png, jpeg, webp, pdf, pptx
  --file PATH          Import source or board operation array; '-' reads stdin
  --out PATH           Export target, fails if present unless --force
  --replace            Replace board on import (requires --confirm)
  --confirm            Confirm deletion or restore/replacement
  --if-revision HASH   Reject stale board edits (from board get)
  --data-dir PATH      TuGo profile (or TUGO_USER_DATA); default installed TuGo
  --request-id ID      Replay same request safely while app is running (last 256)
All commands return JSON; failures use nonzero exit codes. Start TuGo first.
Examples:
  tugo projects create --name "API architecture"
  tugo board import --project PROJECT_ID --format mermaid --file diagram.mmd
  tugo board apply --project PROJECT_ID --file operations.json
  tugo board export --project PROJECT_ID --format png --out diagram.png
`
const profile = () => process.env.TUGO_USER_DATA || (process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/TuGo') : process.platform === 'win32' ? join(process.env.APPDATA || homedir(), 'TuGo') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'TuGo'))
async function main(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage); return }
  const options = {}, positionals = []
  const booleans = new Set(['force', 'confirm', 'replace'])
  const allowed = new Set(['json','project','id','snapshot','name','folder','format','file','out','if-revision','data-dir','request-id','page','source','notes','reason','summary'])
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positionals.push(argv[i]); continue }
    const key = argv[i].slice(2)
    if (key in options) throw new Error(`重复参数 --${key}`)
    if (booleans.has(key)) options[key] = true
    else { if (!allowed.has(key) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`无效参数 --${key}`); options[key] = argv[++i] }
  }
  const method = positionals.join('.')
  if (options.out && !['board.export', 'snapshots.export'].includes(method)) throw new Error('--out 仅用于导出命令')
  if (positionals.length > 2) throw new Error('命令最多包含 resource 和 action')
  let stdin
  const input = async path => path === '-' ? (stdin ??= await new Promise((res, rej) => { let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { data+=c; if(data.length>16*1024*1024) rej(new Error('stdin too large')) }); process.stdin.on('end',()=>res(data)); process.stdin.on('error',rej) })) : readFile(resolve(path), 'utf8')
  const params = options.json ? JSON.parse(options.json === '-' ? await input('-') : options.json) : {}
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('--json 必须是对象')
  for (const key of ['project','id','snapshot','name','format','page','source','notes','reason','summary']) if (options[key] !== undefined) params[key] = options[key]
  if (options.folder !== undefined) params.folder = options.folder === 'null' ? null : options.folder
  if (options.confirm) params.confirm = true
  if (options.replace) params.replace = true
  if (options['if-revision']) params.ifRevision = options['if-revision']
  if (options.file) {
    if (method === 'snapshots.import') { if (options.file === '-') throw new Error('快照导入需要文件路径'); params.path = resolve(options.file) }
    else if (method === 'board.apply') params.operations = JSON.parse(await input(options.file))
    else if (method === 'board.import') params.content = await input(options.file)
    else throw new Error('--file 仅用于 board apply/import 或 snapshots import')
  }
  if ((method === 'board.export' || method === 'snapshots.export') && !options.out) throw new Error('导出必须指定 --out')
  let endpoint
  try { endpoint = JSON.parse(await readFile(join(resolve(options['data-dir'] || profile()), 'cli-endpoint.json'), 'utf8')) }
  catch { throw new Error('找不到 TuGo CLI 接口。请打开新版 TuGo；开发版使用 --data-dir 指定 TuGo-Dev。') }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('无效的本机接口凭证')
  const id = options['request-id'] || randomUUID()
  let result
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/command`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, method, params }), signal: AbortSignal.timeout(120_000), redirect: 'error' })
    result = await response.json()
  } catch (error) { throw new Error(`TuGo 连接失败或超时（执行结果未知，不要盲目重试）。request-id=${id}: ${error.message}`) }
  if (result.ok && options.out) {
    if (!result.result?.file || typeof result.result.file.data !== 'string') throw new Error('命令没有返回文件')
    const { data, encoding } = result.result.file
    const path = resolve(options.out)
    await writeFile(path, encoding === 'base64' ? Buffer.from(data, 'base64') : data, { flag: options.force ? 'w' : 'wx' })
    result.result = { path, bytes: Buffer.byteLength(data, encoding === 'base64' ? 'base64' : 'utf8') }
  }
  process.stdout.write(JSON.stringify({ ...result, requestId: id }) + '\n')
  if (!result.ok) process.exitCode = 1
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stdout.write(JSON.stringify({ ok:false,error:{code:'CLI_ERROR',message:String(error.message || error)} })+'\n'); process.exitCode=1 })
module.exports = { main }
